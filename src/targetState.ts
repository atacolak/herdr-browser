import { readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";

/**
 * Publisher-neutral state contract for observe-mirror mode.
 *
 * An external browser controller atomically publishes this JSON (temp + rename)
 * whenever its active CDP page target changes. Herdr tails the file and
 * reattaches to `active_target_id` without creating or closing targets.
 *
 * Schema (version = 1):
 *
 * {
 *   "version": 1,
 *   "seq": <monotonic uint>,
 *   "updated_at": "<ISO-8601>",
 *   "source_id": "<publisher id>",                // optional
 *   "active_target_id": "<CDP target id>" | null,
 *   "cdp_url": "http://127.0.0.1:PORT",          // optional
 *   "browser_generation": <number|string>,       // optional
 *   "source_generation": <number|string>,        // optional
 *   "page": { "url"?, "title"?, "target_id"? }   // optional, no secrets
 * }
 *
 * `worker_id` and `worker_generation` remain accepted as compatibility aliases.
 *
 * Env coordination:
 *   HERDR_BROWSER_MODE=observe_mirror
 *   HERDR_BROWSER_TARGET_STATE=<path>
 *   HERDR_BROWSER_CDP_URL=http://127.0.0.1:<port>
 */
export const TARGET_STATE_SCHEMA_VERSION = 1 as const;

export type BrowserActiveTargetState = {
  version: typeof TARGET_STATE_SCHEMA_VERSION;
  seq: number;
  updated_at: string;
  source_id?: string;
  active_target_id: string | null;
  cdp_url?: string;
  browser_generation?: number | string;
  source_generation?: number | string;
  page?: {
    url?: string;
    title?: string;
    target_id?: string;
  };
};

export type BrowserMode = "default" | "observe_mirror";

export function configuredBrowserMode(
  env: NodeJS.ProcessEnv = process.env,
): BrowserMode {
  const raw = env.HERDR_BROWSER_MODE?.trim().toLowerCase();
  if (raw === "observe_mirror" || raw === "observe-mirror") {
    return "observe_mirror";
  }
  return "default";
}

export function configuredTargetStatePath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.HERDR_BROWSER_TARGET_STATE?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export function parseBrowserActiveTargetState(raw: unknown): BrowserActiveTargetState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("target state must be a JSON object");
  }
  const source = raw as Record<string, unknown>;

  // Tolerate early draft aliases so existing publishers remain compatible.
  const version = source.version ?? source.schema_version;
  if (version !== TARGET_STATE_SCHEMA_VERSION) {
    throw new Error(
      `unsupported target state version: ${String(version)} (expected ${TARGET_STATE_SCHEMA_VERSION})`,
    );
  }

  const seqRaw = source.seq ?? source.sequence;
  if (!Number.isInteger(seqRaw) || (seqRaw as number) < 0) {
    throw new Error("target state seq must be a non-negative integer");
  }

  if (typeof source.updated_at !== "string" || source.updated_at.trim().length === 0) {
    throw new Error("target state updated_at must be a non-empty string");
  }

  const sourceIdRaw = source.source_id ?? source.worker_id;
  let sourceId: string | undefined;
  if (sourceIdRaw !== undefined) {
    if (typeof sourceIdRaw !== "string" || sourceIdRaw.trim().length === 0) {
      throw new Error("target state source_id must be a non-empty string when present");
    }
    sourceId = sourceIdRaw.trim();
  }

  const activeRaw = source.active_target_id;
  let activeTargetId: string | null;
  if (activeRaw === null || activeRaw === undefined) {
    activeTargetId = null;
  } else if (typeof activeRaw === "string" && activeRaw.trim().length > 0) {
    activeTargetId = activeRaw.trim();
  } else {
    throw new Error("target state active_target_id must be a non-empty string or null");
  }

  const state: BrowserActiveTargetState = {
    version: TARGET_STATE_SCHEMA_VERSION,
    seq: seqRaw as number,
    updated_at: source.updated_at.trim(),
    active_target_id: activeTargetId,
    ...(sourceId ? { source_id: sourceId } : {}),
  };

  const cdpUrl = source.cdp_url ?? source.cdp_http_url;
  if (typeof cdpUrl === "string" && cdpUrl.trim().length > 0) {
    state.cdp_url = cdpUrl.trim().replace(/\/$/, "");
  }

  const sourceGeneration = source.source_generation ?? source.worker_generation;
  if (sourceGeneration !== undefined) {
    state.source_generation = parseGeneration(sourceGeneration, "source_generation");
  }
  if (source.browser_generation !== undefined) {
    state.browser_generation = parseGeneration(source.browser_generation, "browser_generation");
  }

  const page = source.page;
  if (page && typeof page === "object" && !Array.isArray(page)) {
    const pageSource = page as Record<string, unknown>;
    const clean: NonNullable<BrowserActiveTargetState["page"]> = {};
    if (typeof pageSource.url === "string") {
      clean.url = pageSource.url;
    }
    if (typeof pageSource.title === "string") {
      clean.title = pageSource.title;
    }
    if (typeof pageSource.target_id === "string" && pageSource.target_id.trim()) {
      clean.target_id = pageSource.target_id.trim();
    }
    // Flat url/title aliases (draft publishers).
    if (clean.url === undefined && typeof source.url === "string") {
      clean.url = source.url;
    }
    if (clean.title === undefined && typeof source.title === "string") {
      clean.title = source.title;
    }
    if (Object.keys(clean).length > 0) {
      state.page = clean;
    }
  } else if (typeof source.url === "string" || typeof source.title === "string") {
    state.page = {
      ...(typeof source.url === "string" ? { url: source.url } : {}),
      ...(typeof source.title === "string" ? { title: source.title } : {}),
    };
  }

  return state;
}

function parseGeneration(value: unknown, field: string): number | string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new Error(`target state ${field} must be a number or non-empty string`);
}

export async function readBrowserActiveTargetState(
  path: string,
): Promise<BrowserActiveTargetState> {
  const text = await readFile(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `invalid target state JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseBrowserActiveTargetState(raw);
}

export type GenerationBound = {
  source_generation?: number | string;
  browser_generation?: number | string;
};

/**
 * When the consumer was started with expected generations (from the first
 * accepted state snapshot), a published state that carries different generation
 * values is rejected so we do not silently follow a recycled worker/browser.
 *
 * Missing generation fields on either side are ignored (backward compatible).
 */
export function assertTargetStateGenerations(
  state: BrowserActiveTargetState,
  bound: GenerationBound,
): void {
  if (
    state.source_generation !== undefined &&
    bound.source_generation !== undefined &&
    String(state.source_generation) !== String(bound.source_generation)
  ) {
    throw new Error(
      `target state source_generation mismatch: got ${String(state.source_generation)}, bound ${String(bound.source_generation)}`,
    );
  }
  if (
    state.browser_generation !== undefined &&
    bound.browser_generation !== undefined &&
    String(state.browser_generation) !== String(bound.browser_generation)
  ) {
    throw new Error(
      `target state browser_generation mismatch: got ${String(state.browser_generation)}, bound ${String(bound.browser_generation)}`,
    );
  }
}

export function generationBoundFromState(
  state: BrowserActiveTargetState,
): GenerationBound {
  const bound: GenerationBound = {};
  if (state.source_generation !== undefined) {
    bound.source_generation = state.source_generation;
  }
  if (state.browser_generation !== undefined) {
    bound.browser_generation = state.browser_generation;
  }
  return bound;
}

export type TargetStateFollowerHandlers = {
  onState: (state: BrowserActiveTargetState) => void | Promise<void>;
  onError?: (error: Error) => void;
};

/**
 * Poll + fs.watch hybrid follower. Atomic publishers (temp + rename) are
 * visible via watch; poll covers platforms/editors that mutate in place.
 */
export function followBrowserActiveTargetState(
  path: string,
  handlers: TargetStateFollowerHandlers,
  options: { intervalMs?: number } = {},
): { stop: () => void } {
  const intervalMs = options.intervalMs ?? 250;
  let stopped = false;
  let lastSeq = -1;
  let lastMtimeMs = -1;
  let lastSize = -1;
  let inFlight: Promise<void> | null = null;
  let watcher: FSWatcher | null = null;

  const tick = () => {
    if (stopped) {
      return;
    }
    if (inFlight) {
      return;
    }
    inFlight = (async () => {
      try {
        const info = await stat(path);
        const mtimeMs = info.mtimeMs;
        const size = info.size;
        if (mtimeMs === lastMtimeMs && size === lastSize && lastSeq >= 0) {
          return;
        }
        const state = await readBrowserActiveTargetState(path);
        lastMtimeMs = mtimeMs;
        lastSize = size;
        if (state.seq === lastSeq) {
          return;
        }
        // Ignore stale / out-of-order snapshots after a rename race.
        if (state.seq < lastSeq) {
          return;
        }
        lastSeq = state.seq;
        await handlers.onState(state);
      } catch (error) {
        handlers.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      } finally {
        inFlight = null;
      }
    })();
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  try {
    watcher = watch(path, () => tick());
    watcher.unref?.();
  } catch {
    // Path may not exist yet; poll will pick it up.
  }

  // Immediate first read.
  tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      watcher?.close();
      watcher = null;
    },
  };
}
