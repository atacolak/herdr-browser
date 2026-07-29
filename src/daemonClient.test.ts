import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import {
  automation,
  daemonConfigMatches,
  heartbeatView,
  isDaemonGoneError,
  metrics,
  removeStaleLock,
  resetBrowserConfigAppliedForTest,
  status,
  stopDaemon,
} from "./daemonClient";
import type { DaemonState } from "./daemonProtocol";
import { chromeProfileDir } from "./paths";

const state: DaemonState = {
  instanceId: "test",
  pid: 1,
  baseUrl: "http://127.0.0.1:1",
  token: "test",
  startedAt: "2026-01-01T00:00:00.000Z",
  captureBackend: "screencast",
  profileDir: chromeProfileDir(),
};

test("daemon cadence defaults to one when caller env is unset", () => {
  const previous = process.env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME;
  delete process.env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME;
  try {
    expect(daemonConfigMatches({ ...state, screencastEveryNthFrame: 1 })).toBe(true);
    expect(daemonConfigMatches({ ...state, screencastEveryNthFrame: 2 })).toBe(false);
    expect(daemonConfigMatches({ ...state, screencastEveryNthFrame: undefined })).toBe(true);
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME;
    } else {
      process.env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME = previous;
    }
  }
});

test("daemon profile must match the configured per-session directory", () => {
  expect(daemonConfigMatches({ ...state, profileDir: "/tmp/stale-profile" })).toBe(false);
  expect(daemonConfigMatches({ ...state, profileDir: undefined })).toBe(false);
});

test("daemon external CDP url must match the configured endpoint", () => {
  const previous = process.env.HERDR_BROWSER_CDP_URL;
  try {
    delete process.env.HERDR_BROWSER_CDP_URL;
    expect(daemonConfigMatches({
      ...state,
      chromeOwnership: "owned",
      cdpUrl: null,
    })).toBe(true);

    process.env.HERDR_BROWSER_CDP_URL = "http://127.0.0.1:9222";
    // Owned daemon cannot be reused when the env asks for external attach.
    expect(daemonConfigMatches({
      ...state,
      chromeOwnership: "owned",
      cdpUrl: null,
    })).toBe(false);

    // localhost and trailing slash are equivalent under strict normalization.
    expect(daemonConfigMatches({
      ...state,
      chromeOwnership: "external",
      cdpUrl: "http://localhost:9222/",
      profileDir: null,
    })).toBe(true);

    expect(daemonConfigMatches({
      ...state,
      chromeOwnership: "external",
      cdpUrl: "http://127.0.0.1:9333",
      profileDir: null,
    })).toBe(false);
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_BROWSER_CDP_URL;
    } else {
      process.env.HERDR_BROWSER_CDP_URL = previous;
    }
  }
});

test("automation discovery does not start a missing daemon", async () => {
  const previous = process.env.HERDR_BROWSER_DAEMON_STATE;
  process.env.HERDR_BROWSER_DAEMON_STATE = `/tmp/herdr-browser-missing-${crypto.randomUUID()}.json`;
  try {
    await expect(automation("view-1")).rejects.toThrow("browser daemon is not running");
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_BROWSER_DAEMON_STATE;
    } else {
      process.env.HERDR_BROWSER_DAEMON_STATE = previous;
    }
  }
});

test("heartbeatView, status, and metrics do not spawn a missing daemon", async () => {
  const previous = process.env.HERDR_BROWSER_DAEMON_STATE;
  process.env.HERDR_BROWSER_DAEMON_STATE = `/tmp/herdr-browser-missing-${crypto.randomUUID()}.json`;
  try {
    await expect(heartbeatView("view-1")).rejects.toThrow("browser daemon is not running");
    await expect(status()).rejects.toThrow("browser daemon is not running");
    await expect(metrics()).rejects.toThrow("browser daemon is not running");
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_BROWSER_DAEMON_STATE;
    } else {
      process.env.HERDR_BROWSER_DAEMON_STATE = previous;
    }
  }
});

test("non-spawning commands apply browser.json cdpUrl before state lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-browser-config-state-"));
  const configPath = join(dir, "browser.json");
  const explicitState = join(dir, "missing-external-state.json");
  const previousConfig = process.env.HERDR_BROWSER_CONFIG;
  const previousState = process.env.HERDR_BROWSER_DAEMON_STATE;
  const previousCdp = process.env.HERDR_BROWSER_CDP_URL;
  try {
    await writeFile(configPath, JSON.stringify({ cdpUrl: "http://localhost:9222/" }));
    process.env.HERDR_BROWSER_CONFIG = configPath;
    process.env.HERDR_BROWSER_DAEMON_STATE = explicitState;
    delete process.env.HERDR_BROWSER_CDP_URL;
    resetBrowserConfigAppliedForTest();

    await expect(status()).rejects.toThrow("browser daemon is not running");
    expect(String(process.env.HERDR_BROWSER_CDP_URL)).toBe("http://127.0.0.1:9222");
    expect(await stopDaemon()).toBe(false);
  } finally {
    resetBrowserConfigAppliedForTest();
    if (previousConfig === undefined) delete process.env.HERDR_BROWSER_CONFIG;
    else process.env.HERDR_BROWSER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.HERDR_BROWSER_DAEMON_STATE;
    else process.env.HERDR_BROWSER_DAEMON_STATE = previousState;
    if (previousCdp === undefined) delete process.env.HERDR_BROWSER_CDP_URL;
    else process.env.HERDR_BROWSER_CDP_URL = previousCdp;
    await rm(dir, { recursive: true, force: true });
  }
});

test("isDaemonGoneError recognizes no-daemon and missing-view errors only", () => {
  expect(isDaemonGoneError(new Error("browser daemon is not running"))).toBe(true);
  expect(isDaemonGoneError(new Error("browser view is missing or closed"))).toBe(true);
  expect(isDaemonGoneError(new Error("some other failure"))).toBe(false);
  expect(isDaemonGoneError("not an error")).toBe(false);
});

test("removeStaleLock leaves a lock owned by a live process alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-browser-lock-"));
  const lockFile = join(dir, "daemon.json.lock");
  try {
    await writeFile(lockFile, String(process.pid));
    expect(await removeStaleLock(lockFile)).toBe(false);
    await expect(readFile(lockFile, "utf8")).resolves.toBe(String(process.pid));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeStaleLock removes a lock owned by a dead process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-browser-lock-"));
  const lockFile = join(dir, "daemon.json.lock");
  try {
    const deadPid = await findUnusedPid();
    await writeFile(lockFile, String(deadPid));
    expect(await removeStaleLock(lockFile)).toBe(true);
    await expect(readFile(lockFile, "utf8")).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeStaleLock leaves a lock with unparsable contents alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-browser-lock-"));
  const lockFile = join(dir, "daemon.json.lock");
  try {
    await writeFile(lockFile, "not-a-pid");
    expect(await removeStaleLock(lockFile)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function findUnusedPid(): Promise<number> {
  // Pids this high are unreachable under the default Linux pid_max (32768)
  // and macOS's PID_MAX (99999); fall back to a short scan if one happens
  // to be in use in an unusual namespace configuration.
  for (let pid = 3_000_000; pid < 3_001_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as { code?: string }).code === "ESRCH") {
        return pid;
      }
    }
  }
  throw new Error("could not find an unused pid for the test");
}
