import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reapStaleChrome } from "./staleChrome";

async function withStateFile(
  state: unknown,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "stale-chrome-"));
  const path = join(dir, "daemon.json");
  try {
    await writeFile(path, JSON.stringify(state));
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("missing state file is a no-op", async () => {
  await reapStaleChrome(join(tmpdir(), "stale-chrome-does-not-exist.json"));
});

test("live daemon pid is left alone", async () => {
  // Our own pid is alive, so the reap must not touch the chrome pid.
  await withStateFile({ pid: process.pid, chromePid: process.pid }, async (path) => {
    await reapStaleChrome(path);
  });
});

test("dead daemon with dead chrome is a no-op", async () => {
  const deadPid = 2 ** 22 - 7;
  await withStateFile({ pid: deadPid, chromePid: deadPid }, async (path) => {
    await reapStaleChrome(path);
  });
});

test("dead daemon with a live non-chrome process does not kill it", async () => {
  // A dead daemon pid alongside a live pid that is NOT Chrome exercises the
  // pid-reuse guard. Not process.pid: the runner's own command line contains
  // this test file's name, and "staleChrome.test.ts" matches /chrom(e|ium)/i.
  const decoy = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const deadPid = 2 ** 22 - 7;
  try {
    await withStateFile({ pid: deadPid, chromePid: decoy.pid }, async (path) => {
      await reapStaleChrome(path);
    });
    const exited = await Promise.race([
      decoy.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    expect(exited).toBe(false);
  } finally {
    decoy.kill("SIGKILL");
  }
});

test("dead daemon with a live chrome-named process reaps it", async () => {
  // Production matcher inspects argv0 only. Copy a real binary to a path that
  // contains "chromium" so argv0 matches without widening the kill surface.
  const decoy = await spawnArgv0ChromeDecoy("fake-chromium-decoy");
  const deadPid = 2 ** 22 - 7;
  try {
    await withStateFile({ pid: deadPid, chromePid: decoy.pid }, async (path) => {
      await reapStaleChrome(path);
    });
    const exited = await Promise.race([
      decoy.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    expect(exited).toBe(true);
  } finally {
    decoy.kill("SIGKILL");
    await decoy.cleanup();
  }
});

test("external ownership never reaps chrome even when a chrome pid is present", async () => {
  const decoy = await spawnArgv0ChromeDecoy("fake-chromium-external");
  const deadPid = 2 ** 22 - 7;
  try {
    await withStateFile({
      pid: deadPid,
      chromePid: decoy.pid,
      chromeOwnership: "external",
      cdpUrl: "http://127.0.0.1:9222",
    }, async (path) => {
      await reapStaleChrome(path);
    });
    const exited = await Promise.race([
      decoy.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    expect(exited).toBe(false);
  } finally {
    decoy.kill("SIGKILL");
    await decoy.cleanup();
  }
});

test("owned ownership still reaps chrome-named processes", async () => {
  const decoy = await spawnArgv0ChromeDecoy("fake-chromium-owned");
  const deadPid = 2 ** 22 - 7;
  try {
    await withStateFile({
      pid: deadPid,
      chromePid: decoy.pid,
      chromeOwnership: "owned",
    }, async (path) => {
      await reapStaleChrome(path);
    });
    const exited = await Promise.race([
      decoy.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    expect(exited).toBe(true);
  } finally {
    decoy.kill("SIGKILL");
    await decoy.cleanup();
  }
});

async function spawnArgv0ChromeDecoy(name: string): Promise<{
  pid: number;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => void;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "stale-chrome-decoy-"));
  const binary = join(dir, name);
  // sleep is a real ELF binary; shell scripts would keep argv0 as /bin/sh.
  await copyFile("/bin/sleep", binary);
  const child = Bun.spawn([binary, "30"], { stdout: "ignore", stderr: "ignore" });
  if (typeof child.pid !== "number") {
    await rm(dir, { recursive: true, force: true });
    throw new Error("failed to spawn decoy");
  }
  return {
    pid: child.pid,
    exited: child.exited,
    kill: (signal) => child.kill(signal),
    cleanup: async () => {
      child.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    },
  };
}
