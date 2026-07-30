import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertTargetStateGenerations,
  configuredBrowserMode,
  configuredTargetStatePath,
  followBrowserActiveTargetState,
  parseBrowserActiveTargetState,
  readBrowserActiveTargetState,
  TARGET_STATE_SCHEMA_VERSION,
} from "./targetState";

const sample = {
  version: TARGET_STATE_SCHEMA_VERSION,
  seq: 3,
  updated_at: "2026-07-28T12:00:00Z",
  source_id: "controller-1",
  active_target_id: "T-abc",
  cdp_url: "http://127.0.0.1:9222/",
  browser_generation: "gen-1",
  page: { url: "https://example.test", title: "Example" },
};

test("configuredBrowserMode reads HERDR_BROWSER_MODE", () => {
  expect(configuredBrowserMode({})).toBe("default");
  expect(configuredBrowserMode({ HERDR_BROWSER_MODE: "observe_mirror" })).toBe("observe_mirror");
  expect(configuredBrowserMode({ HERDR_BROWSER_MODE: "observe-mirror" })).toBe("observe_mirror");
  expect(configuredBrowserMode({ HERDR_BROWSER_MODE: "owned" })).toBe("default");
});

test("configuredTargetStatePath trims empty values", () => {
  expect(configuredTargetStatePath({})).toBeNull();
  expect(configuredTargetStatePath({ HERDR_BROWSER_TARGET_STATE: "  " })).toBeNull();
  expect(configuredTargetStatePath({
    HERDR_BROWSER_TARGET_STATE: " /tmp/active-target.json ",
  })).toBe("/tmp/active-target.json");
});

test("parseBrowserActiveTargetState accepts publisher-neutral schema", () => {
  const state = parseBrowserActiveTargetState(sample);
  expect(state).toEqual({
    version: 1,
    seq: 3,
    updated_at: "2026-07-28T12:00:00Z",
    source_id: "controller-1",
    active_target_id: "T-abc",
    cdp_url: "http://127.0.0.1:9222",
    browser_generation: "gen-1",
    page: { url: "https://example.test", title: "Example" },
  });
});

test("parseBrowserActiveTargetState allows null active_target_id", () => {
  const state = parseBrowserActiveTargetState({
    ...sample,
    active_target_id: null,
  });
  expect(state.active_target_id).toBeNull();
});

test("parseBrowserActiveTargetState rejects bad version/seq", () => {
  expect(() => parseBrowserActiveTargetState({ ...sample, version: 2 }))
    .toThrow(/unsupported target state version/);
  expect(() => parseBrowserActiveTargetState({ ...sample, seq: -1 }))
    .toThrow(/seq must be a non-negative integer/);
  expect(() => parseBrowserActiveTargetState({ ...sample, source_id: "" }))
    .toThrow(/source_id/);
});

test("parseBrowserActiveTargetState accepts legacy worker aliases", () => {
  const state = parseBrowserActiveTargetState({
    ...sample,
    source_id: undefined,
    source_generation: undefined,
    worker_id: "legacy-worker",
    worker_generation: "legacy-generation",
  });
  expect(state.source_id).toBe("legacy-worker");
  expect(state.source_generation).toBe("legacy-generation");
});

test("assertTargetStateGenerations compares when both sides present", () => {
  expect(() => assertTargetStateGenerations(
    parseBrowserActiveTargetState(sample),
    { browser_generation: "gen-1" },
  )).not.toThrow();
  expect(() => assertTargetStateGenerations(
    parseBrowserActiveTargetState(sample),
    { browser_generation: "other" },
  )).toThrow(/browser_generation mismatch/);
});

test("readBrowserActiveTargetState loads atomic file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-target-state-"));
  const path = join(dir, "active-target.json");
  writeFileSync(path, `${JSON.stringify(sample, null, 2)}\n`);
  const state = await readBrowserActiveTargetState(path);
  expect(state.active_target_id).toBe("T-abc");
  expect(state.seq).toBe(3);
});

test("followBrowserActiveTargetState emits on seq advance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-target-follow-"));
  const path = join(dir, "active-target.json");
  writeFileSync(path, `${JSON.stringify(sample, null, 2)}\n`);

  const seen: number[] = [];
  const follower = followBrowserActiveTargetState(path, {
    onState: (state) => {
      seen.push(state.seq);
    },
  }, { intervalMs: 30 });

  await waitFor(() => seen.includes(3), 1_000);

  const next = { ...sample, seq: 4, active_target_id: "T-next" };
  const tmp = join(dir, ".active-target.json.tmp");
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);

  await waitFor(() => seen.includes(4), 1_000);
  follower.stop();
  expect(seen).toContain(3);
  expect(seen).toContain(4);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}
