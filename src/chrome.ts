import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";

import { configuredBrowserCdpUrl, normalizeCdpHttpUrl } from "./cdpUrl";
import { chromeProfileDir, ensurePrivateDir } from "./paths";

export { configuredBrowserCdpUrl, normalizeCdpHttpUrl } from "./cdpUrl";

const CHROME_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "chrome",
];

export type ChromeOwnership = "owned" | "external";

type OwnedChromeProcess = ChildProcessByStdio<null, null, Readable>;

type ChromeBase = {
  ownership: ChromeOwnership;
  executable: string;
  port: number;
  browserWebSocketUrl: string;
  /** Recent stderr lines kept for crash diagnostics; empty for external attach. */
  recentStderr: () => string;
  /** Owned mode kills Chrome. External mode is disconnect-only. */
  close: () => Promise<void>;
};

/** Plugin-launched Chrome: real child process and local profile. */
export type OwnedChromeInstance = ChromeBase & {
  ownership: "owned";
  profileDir: string;
  child: OwnedChromeProcess;
};

/** Externally owned CDP endpoint: no child, no local profile, never killed. */
export type ExternalChromeInstance = ChromeBase & {
  ownership: "external";
  /** Canonical loopback CDP HTTP base used for attach. */
  cdpUrl: string;
  profileDir: null;
  child: null;
};

export type ChromeInstance = OwnedChromeInstance | ExternalChromeInstance;

const STDERR_RING_BUFFER_MAX_LINES = 20;

/** Launch owned Chrome, or attach when HERDR_BROWSER_CDP_URL is set. */
export async function resolveChrome(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChromeInstance> {
  const cdpUrl = configuredBrowserCdpUrl(env);
  if (cdpUrl) {
    return await connectExternalChrome(cdpUrl);
  }
  return await launchChrome();
}

export async function launchChrome(): Promise<OwnedChromeInstance> {
  const executable = await findChromeExecutable();
  const port = await findFreePort();
  const profileDir = chromeProfileDir();
  await ensurePrivateDir(profileDir);
  const chrome = spawn(executable, [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    // ElasticOverscroll: macOS trackpad momentum keeps delivering wheel notches
    // for ~2s after the fingers lift. At a scroll boundary each one rubber-bands
    // the page, which is a repaint with scrollY pinned, so the pane visibly
    // jitters while nothing is actually scrolling.
    "--disable-features=Translate,ElasticOverscroll",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    // Synthetic CDP wheel events carry non-precise deltas, so Chromium smooth-
    // scroll animates each one. A terminal delivers scrolling as a stream of
    // fixed notches; overlapping per-notch animations rubber-band visibly at
    // scroll boundaries. Instant application matches trackpad expectations.
    "--disable-smooth-scrolling",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  async function close() {
    if (!chrome.killed && !hasChromeExited(chrome)) {
      chrome.kill("SIGTERM");
    }
    if (await waitForChromeExit(chrome, 1_500)) {
      return;
    }
    chrome.kill("SIGKILL");
    if (!await waitForChromeExit(chrome, 5_000)) {
      throw new Error(`Chrome did not exit and may still hold profile lock: ${profileDir}`);
    }
  }

  let browserWebSocketUrl: string;
  try {
    browserWebSocketUrl = await waitForBrowserWebSocketUrl(port, chrome);
  } catch (error) {
    await close();
    throw error;
  }

  // The startup accumulator is detached once Chrome is up; this ring buffer
  // takes over so stderr doesn't grow unboundedly for the daemon's lifetime
  // while still keeping recent lines for crash diagnostics.
  const stderrRing = createStderrRingBuffer(STDERR_RING_BUFFER_MAX_LINES);
  chrome.stderr.on("data", (chunk: Buffer) => stderrRing.append(chunk.toString()));

  return {
    ownership: "owned",
    executable,
    port,
    profileDir,
    child: chrome,
    browserWebSocketUrl,
    recentStderr: () => stderrRing.snapshot(),
    close,
  };
}

/**
 * Attach to a browser that already exposes CDP HTTP (`/json/version`).
 * Never launches or kills the remote browser. Death is observed via the
 * browser websocket `onClose` path after connect, not via process polling.
 */
export async function connectExternalChrome(
  cdpHttpUrl: string,
): Promise<ExternalChromeInstance> {
  const baseUrl = normalizeCdpHttpUrl(cdpHttpUrl);
  const version = await fetchBrowserVersion(baseUrl);
  const advertisedWebSocketUrl = version.webSocketDebuggerUrl;
  if (!advertisedWebSocketUrl) {
    throw new Error(`external CDP endpoint did not advertise webSocketDebuggerUrl: ${baseUrl}`);
  }
  const browserWebSocketUrl = externalBrowserWebSocketUrl(baseUrl, advertisedWebSocketUrl);

  return {
    ownership: "external",
    executable: version.Browser ?? "external-chrome",
    port: portFromUrl(baseUrl),
    cdpUrl: baseUrl,
    profileDir: null,
    child: null,
    browserWebSocketUrl,
    recentStderr: () => "",
    close: async () => {
      // External browsers are not owned; never kill them.
    },
  };
}

/**
 * HTTP base used for Chrome `/json/*` upstreams (list refresh, view gateway).
 * External attach preserves the canonical configured endpoint (host + scheme);
 * owned launch always talks to the local debugging port on 127.0.0.1.
 */
export function externalBrowserWebSocketUrl(
  configuredCdpUrl: string,
  advertisedWebSocketUrl: string,
): string {
  const configured = new URL(normalizeCdpHttpUrl(configuredCdpUrl));
  let advertised: URL;
  try {
    advertised = new URL(advertisedWebSocketUrl);
  } catch {
    throw new Error(
      `external CDP endpoint advertised an invalid webSocketDebuggerUrl: ${advertisedWebSocketUrl}`,
    );
  }
  if (advertised.protocol !== "ws:" && advertised.protocol !== "wss:") {
    throw new Error(
      `external CDP endpoint advertised a non-WebSocket debugger URL: ${advertisedWebSocketUrl}`,
    );
  }
  if (!advertised.pathname.startsWith("/devtools/browser/")) {
    throw new Error(
      `external CDP endpoint advertised an invalid browser WebSocket path: ${advertised.pathname}`,
    );
  }

  // Trust only the browser path returned by Chrome. The configured endpoint is
  // the authority boundary: an internal, stale, or malicious advertised host
  // must not redirect the client away from the validated CDP host and port.
  configured.protocol = "ws:";
  configured.pathname = advertised.pathname;
  configured.search = "";
  configured.hash = "";
  return configured.toString();
}

export function chromeCdpHttpUrl(chrome: ChromeInstance): string {
  if (chrome.ownership === "external") {
    return chrome.cdpUrl;
  }
  return `http://127.0.0.1:${chrome.port}`;
}

function portFromUrl(url: string): number {
  const parsed = new URL(url);
  if (parsed.port) {
    return Number.parseInt(parsed.port, 10);
  }
  return parsed.protocol === "https:" ? 443 : 80;
}

async function fetchBrowserVersion(baseUrl: string): Promise<{
  webSocketDebuggerUrl?: string;
  Browser?: string;
}> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(`${baseUrl}/json/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return await response.json() as {
          webSocketDebuggerUrl?: string;
          Browser?: string;
        };
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for external CDP endpoint ${baseUrl}/json/version: ${
      lastError instanceof Error ? lastError.message : String(lastError ?? "")
    }`,
  );
}

function createStderrRingBuffer(maxLines: number): { append: (chunk: string) => void; snapshot: () => string } {
  const lines: string[] = [];
  let partial = "";
  return {
    append(chunk: string) {
      partial += chunk;
      const segments = partial.split("\n");
      partial = segments.pop() ?? "";
      for (const line of segments) {
        lines.push(line);
        if (lines.length > maxLines) {
          lines.shift();
        }
      }
    },
    snapshot() {
      return [...lines, ...(partial ? [partial] : [])].join("\n");
    },
  };
}

async function waitForChromeExit(chrome: OwnedChromeProcess, timeoutMs: number): Promise<boolean> {
  if (hasChromeExited(chrome)) {
    return true;
  }
  return await new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      chrome.off("exit", onExit);
      resolve(hasChromeExited(chrome));
    }, timeoutMs);
    chrome.once("exit", onExit);
  });
}

export function hasChromeExited(
  chrome: Pick<OwnedChromeProcess, "exitCode" | "signalCode">,
): boolean {
  return chrome.exitCode !== null || chrome.signalCode !== null;
}

async function findChromeExecutable(): Promise<string> {
  if (process.env.HERDR_BROWSER_CHROME) {
    return process.env.HERDR_BROWSER_CHROME;
  }

  if (process.platform === "darwin") {
    const applicationExecutables = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      join(homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium"),
    ];
    for (const executable of applicationExecutables) {
      try {
        await access(executable);
        return executable;
      } catch {
        // Try the next standard application location.
      }
    }
  }

  for (const candidate of CHROME_CANDIDATES) {
    const result = Bun.spawnSync(["which", candidate], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode === 0) {
      const path = new TextDecoder().decode(result.stdout).trim();
      if (path.length > 0) {
        return path;
      }
    }
  }

  throw new Error(
    "could not find Chrome/Chromium; set HERDR_BROWSER_CHROME to the executable path",
  );
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close();
      if (address && typeof address === "object") {
        resolve(address.port);
      } else {
        reject(new Error("failed to allocate a local port"));
      }
    });
    server.on("error", reject);
  });
}

async function waitForBrowserWebSocketUrl(
  port: number,
  chrome: OwnedChromeProcess,
): Promise<string> {
  let stderr = "";
  const onData = (chunk: Buffer) => {
    stderr += chunk.toString();
  };
  chrome.stderr.on("data", onData);

  try {
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      if (hasChromeExited(chrome)) {
        throw new Error(`Chrome exited early: ${stderr.trim()}`);
      }

      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          const body = await response.json() as { webSocketDebuggerUrl?: string };
          if (body.webSocketDebuggerUrl) {
            return body.webSocketDebuggerUrl;
          }
        }
      } catch {
        // Chrome is still starting.
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`timed out waiting for Chrome CDP endpoint: ${stderr.trim()}`);
  } finally {
    // Startup accumulation stops here regardless of outcome; the caller
    // attaches a small ring buffer for ongoing crash diagnostics on success.
    chrome.stderr.off("data", onData);
  }
}
