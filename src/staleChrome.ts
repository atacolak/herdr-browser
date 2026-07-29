import { readFile } from "node:fs/promises";

import type { DaemonState } from "./daemonProtocol";

// A daemon that died without running its shutdown path (crash, kill -9)
// leaves Chrome running and holding the profile SingletonLock, which breaks
// the next launch. If the previous state file names a daemon pid that's dead
// and a Chrome pid that's still alive, reap that Chrome before launching a
// fresh one. Shared between the daemon (startup) and the client, which must
// run it before it deletes the state file — the only record of that pid.
//
// External CDP mode never owns Chrome: chromeOwnership === "external" must
// never kill the browser, even if a chromePid was somehow recorded.
export async function reapStaleChrome(stateFilePath: string): Promise<void> {
  let previous: Partial<DaemonState> | null = null;
  try {
    previous = JSON.parse(await readFile(stateFilePath, "utf8")) as Partial<DaemonState>;
  } catch {
    return;
  }
  if (previous.chromeOwnership === "external") {
    return;
  }
  if (typeof previous.pid !== "number" || isProcessAlive(previous.pid)) {
    return;
  }
  const chromePid = previous.chromePid;
  if (typeof chromePid !== "number" || !isProcessAlive(chromePid)) {
    return;
  }
  // Verify the pid still looks like Chrome/Chromium before killing it; pids
  // are reused by the OS, and this pid could belong to an unrelated process
  // by the time we get here.
  if (!await looksLikeChromeProcess(chromePid)) {
    return;
  }
  await killStaleProcess(chromePid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function looksLikeChromeProcess(pid: number): Promise<boolean> {
  try {
    const command = process.platform === "darwin"
      ? new TextDecoder().decode(Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]).stdout).trim()
      : (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0")[0] ?? "";
    return /chrom(e|ium)/i.test(command);
  } catch {
    return false;
  }
}

async function killStaleProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const started = Date.now();
  while (Date.now() - started < 1_500) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}
