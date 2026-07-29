import { chmod, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configuredBrowserCdpUrl, normalizeCdpHttpUrl } from "./cdpUrl";

export function projectRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function daemonStateFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_BROWSER_DAEMON_STATE) {
    return env.HERDR_BROWSER_DAEMON_STATE;
  }
  const stateDir = browserStateDir(env);
  const namespace = daemonStateNamespace(env);
  if (namespace) {
    return join(stateDir, `daemon-${namespace}.json`);
  }
  return join(stateDir, "daemon.json");
}

/**
 * Filename-safe namespace under the plugin state dir so distinct Herdr sessions
 * never share a daemon, and multiple external CDP endpoints within one session
 * do not collide on the state file. Owned launch keeps the legacy session-only
 * path. Profile directories are intentionally not namespaced by CDP — external
 * mode does not own a local Chrome profile.
 */
export function daemonStateNamespace(env: NodeJS.ProcessEnv = process.env): string | null {
  const session = env.HERDR_SESSION?.trim();
  const cdpUrl = externalCdpUrlForNamespace(env);
  if (!session && !cdpUrl) {
    return null;
  }
  if (session && !cdpUrl) {
    return safeFilenamePart(session);
  }
  if (!session && cdpUrl) {
    return safeFilenamePart(`cdp-${cdpEndpointKey(cdpUrl)}`);
  }
  return safeFilenamePart(`${session}__cdp-${cdpEndpointKey(cdpUrl!)}`);
}

/** Stable short key for a canonical external CDP HTTP endpoint. */
export function cdpEndpointKey(cdpUrl: string): string {
  const normalized = normalizeCdpHttpUrl(cdpUrl);
  const parsed = new URL(normalized);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return safeFilenamePart(`${parsed.hostname}:${port}`);
}

function externalCdpUrlForNamespace(env: NodeJS.ProcessEnv): string | null {
  // configuredBrowserCdpUrl throws on invalid input — fail before any spawn path
  // can use a colliding or non-loopback state file.
  return configuredBrowserCdpUrl(env);
}

function herdrPluginStateDir(env: NodeJS.ProcessEnv): string {
  const herdrStateDir = env.XDG_STATE_HOME?.trim()
    ? join(env.XDG_STATE_HOME.trim(), "herdr")
    : join(homedir(), ".local", "state", "herdr");
  return join(herdrStateDir, "plugins", "official.browser");
}

export function chromeProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  const configuredRoot = env.HERDR_BROWSER_PROFILE_ROOT?.trim();
  const root = configuredRoot
    ? resolve(configuredRoot)
    : join(browserStateDir(env), "chrome-profiles");
  const session = safeFilenamePart(env.HERDR_SESSION?.trim() || "default");
  return join(root, session);
}

function browserStateDir(env: NodeJS.ProcessEnv): string {
  return env.HERDR_PLUGIN_STATE_DIR || (
    env.HERDR_ENV === "1" ? herdrPluginStateDir(env) : standaloneStateDir(env)
  );
}

function standaloneStateDir(env: NodeJS.ProcessEnv): string {
  return join(
    env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"),
    "herdr-browser",
  );
}

function safeFilenamePart(value: string): string {
  const prefix = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48) || "session";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}

export async function ensurePrivateParentDir(path: string): Promise<void> {
  await ensurePrivateDir(dirname(path));
}

export async function ensurePrivateDir(path: string): Promise<void> {
  const existed = await exists(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const pathStat = await stat(path);
  if (!pathStat.isDirectory()) {
    throw new Error(`state path is not a directory: ${path}`);
  }
  if (!existed && (!process.getuid || pathStat.uid === process.getuid())) {
    await chmod(path, 0o700);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function daemonScriptPath(): string {
  return join(projectRoot(), "src", "daemon.ts");
}
