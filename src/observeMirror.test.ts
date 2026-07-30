import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cachedPageInfo,
  closeBrowserView,
  createBrowserRuntime,
  createBrowserView,
  createTab,
  navigate,
  setViewport,
  type BrowserRuntime,
} from "./browser";
import { browserCapabilities } from "./daemonProtocol";
import type { ChromeInstance } from "./chrome";
import type { CdpClient } from "./cdp";
import { TARGET_STATE_SCHEMA_VERSION } from "./targetState";

const originalMode = process.env.HERDR_BROWSER_MODE;
const originalTargetState = process.env.HERDR_BROWSER_TARGET_STATE;

afterEach(() => {
  if (originalMode === undefined) {
    delete process.env.HERDR_BROWSER_MODE;
  } else {
    process.env.HERDR_BROWSER_MODE = originalMode;
  }
  if (originalTargetState === undefined) {
    delete process.env.HERDR_BROWSER_TARGET_STATE;
  } else {
    process.env.HERDR_BROWSER_TARGET_STATE = originalTargetState;
  }
});

describe("observe_mirror mode", () => {
  test("attaches without Target.createTarget and leaves target count unchanged on close", async () => {
    const cdp = new FakeCdp(["T-existing"]);
    const runtime = await fakeExternalRuntime(cdp);
    const statePath = writeTargetState({
      seq: 1,
      active_target_id: "T-existing",
      browser_generation: "g1",
    });

    process.env.HERDR_BROWSER_MODE = "observe_mirror";
    process.env.HERDR_BROWSER_TARGET_STATE = statePath;

    const beforeCreates = cdp.createCount;
    const beforeCloses = cdp.closedTargets.length;
    const beforeTargets = cdp.knownTargets.size;

    const view = await createBrowserView(runtime, "mirror-a");
    expect(view.mode).toBe("observe_mirror");
    expect(view.targetId).toBe("T-existing");
    expect(cdp.createCount).toBe(beforeCreates);
    expect(cdp.attachCalls).toContain("T-existing");
    expect(cdp.sendCalls.some((call) => call.method === "Target.createTarget")).toBe(false);

    await closeBrowserView(view);

    expect(cdp.createCount).toBe(beforeCreates);
    expect(cdp.closedTargets.length).toBe(beforeCloses);
    expect(cdp.knownTargets.size).toBe(beforeTargets);
    expect(cdp.detachedTargets).toContain("T-existing");
    expect(cdp.sendCalls.some((call) => call.method === "Target.closeTarget")).toBe(false);
    // Browser runtime still alive after pane/view close.
    expect(runtime.closed).toBe(false);
    await runtime.close();
  });

  test("follows seq changes and reattaches without create/close", async () => {
    const cdp = new FakeCdp(["T-one", "T-two"]);
    const runtime = await fakeExternalRuntime(cdp);
    const dir = mkdtempSync(join(tmpdir(), "herdr-observe-follow-"));
    const statePath = join(dir, "active-target.json");
    atomicWrite(statePath, {
      seq: 1,
      active_target_id: "T-one",
      browser_generation: "g1",
    });

    process.env.HERDR_BROWSER_MODE = "observe_mirror";
    process.env.HERDR_BROWSER_TARGET_STATE = statePath;

    const view = await createBrowserView(runtime, "mirror-b");
    expect(view.targetId).toBe("T-one");

    atomicWrite(statePath, {
      seq: 2,
      active_target_id: "T-two",
      browser_generation: "g1",
      page: { url: "https://two.test", title: "Two" },
    });

    await waitFor(() => view.targetId === "T-two", 2_000);
    expect(view.tabs.has("T-two")).toBe(true);
    expect(view.tabs.has("T-one")).toBe(false);
    expect(cdp.attachCalls).toContain("T-two");
    expect(cdp.detachedTargets).toContain("T-one");
    expect(cdp.createCount).toBe(0);
    expect(cdp.closedTargets).toEqual([]);
    expect(cdp.knownTargets.size).toBe(2);

    await view.close();
    expect(cdp.closedTargets).toEqual([]);
    await runtime.close();
  });

  test("rejects browser_generation mismatch and mutation helpers", async () => {
    const cdp = new FakeCdp(["T-a", "T-b"]);
    const runtime = await fakeExternalRuntime(cdp);
    const dir = mkdtempSync(join(tmpdir(), "herdr-observe-gen-"));
    const statePath = join(dir, "active-target.json");
    atomicWrite(statePath, {
      seq: 1,
      active_target_id: "T-a",
      browser_generation: "gen-a",
    });

    process.env.HERDR_BROWSER_MODE = "observe_mirror";
    process.env.HERDR_BROWSER_TARGET_STATE = statePath;

    const view = await createBrowserView(runtime, "mirror-c");
    expect(view.targetId).toBe("T-a");

    await expect(createTab(view)).rejects.toThrow(/observe_mirror mode is read-only/);
    await expect(navigate(view, "https://nope.test")).rejects.toThrow(/observe_mirror mode is read-only/);

    atomicWrite(statePath, {
      seq: 2,
      active_target_id: "T-b",
      browser_generation: "gen-b",
    });

    // Generation mismatch must not steal the attach.
    await sleep(400);
    expect(view.targetId).toBe("T-a");
    expect(cdp.attachCalls.filter((id) => id === "T-b")).toEqual([]);

    await view.close();
    await runtime.close();
  });

  test("same-target navigation updates mirror status URL/title without reattach", async () => {
    const cdp = new FakeCdp(["T-nav"]);
    cdp.setTargetInfo("T-nav", { url: "about:blank", title: "Blank" });
    const runtime = await fakeExternalRuntime(cdp);
    const dir = mkdtempSync(join(tmpdir(), "herdr-observe-nav-"));
    const statePath = join(dir, "active-target.json");
    atomicWrite(statePath, {
      seq: 1,
      active_target_id: "T-nav",
      browser_generation: "g1",
      page: { url: "about:blank", title: "Blank" },
    });

    process.env.HERDR_BROWSER_MODE = "observe_mirror";
    process.env.HERDR_BROWSER_TARGET_STATE = statePath;

    const view = await createBrowserView(runtime, "mirror-nav");
    expect(view.targetId).toBe("T-nav");
    expect(cachedPageInfo(view)).toEqual({ url: "about:blank", title: "Blank" });
    const attachesBefore = cdp.attachCalls.filter((id) => id === "T-nav").length;

    // 1) Publisher bumps seq with same target + new page metadata.
    atomicWrite(statePath, {
      seq: 2,
      active_target_id: "T-nav",
      browser_generation: "g1",
      page: { url: "https://example.test/path", title: "Example" },
    });
    await waitFor(() => cachedPageInfo(view).url === "https://example.test/path", 2_000);
    expect(cachedPageInfo(view)).toEqual({
      url: "https://example.test/path",
      title: "Example",
    });
    expect(view.targetId).toBe("T-nav");
    expect(cdp.attachCalls.filter((id) => id === "T-nav").length).toBe(attachesBefore);
    expect(cdp.createCount).toBe(0);
    expect(cdp.closedTargets).toEqual([]);

    // 2) CDP Target.targetInfoChanged on the same target updates cache.
    cdp.setTargetInfo("T-nav", {
      url: "https://example.test/from-cdp",
      title: "From CDP",
    });
    cdp.emit("Target.targetInfoChanged", {
      targetInfo: {
        targetId: "T-nav",
        type: "page",
        title: "From CDP",
        url: "https://example.test/from-cdp",
      },
    });
    expect(cachedPageInfo(view)).toEqual({
      url: "https://example.test/from-cdp",
      title: "From CDP",
    });

    // 3) In-session Page.frameNavigated (main frame) updates URL without target change.
    const sessionId = view.sessionId;
    cdp.emit(`${sessionId}:Page.frameNavigated`, {
      frame: {
        id: "main",
        url: "https://example.test/frame-nav",
      },
    });
    expect(cachedPageInfo(view).url).toBe("https://example.test/frame-nav");
    expect(view.targetId).toBe("T-nav");
    expect(cdp.createCount).toBe(0);
    expect(cdp.closedTargets).toEqual([]);

    await view.close();
    await runtime.close();
  });

  test("setViewport does not send Emulation device metrics in observe_mirror", async () => {
    const cdp = new FakeCdp(["T-layout"]);
    const runtime = await fakeExternalRuntime(cdp);
    const statePath = writeTargetState({
      seq: 1,
      active_target_id: "T-layout",
      browser_generation: "g1",
    });

    process.env.HERDR_BROWSER_MODE = "observe_mirror";
    process.env.HERDR_BROWSER_TARGET_STATE = statePath;

    const view = await createBrowserView(runtime, "mirror-viewport");
    const before = cdp.sendCalls.length;

    await setViewport(view, {
      width: 1280,
      height: 720,
      deviceScaleFactor: 2,
      pageScaleFactor: 1.25,
    });

    // Local capture geometry is retained for screencast sizing only.
    expect(view.viewport).toEqual({
      width: 1280,
      height: 720,
      deviceScaleFactor: 2,
      pageScaleFactor: 1.25,
    });

    const afterCalls = cdp.sendCalls.slice(before);
    expect(afterCalls.some((call) => call.method === "Emulation.setDeviceMetricsOverride")).toBe(false);
    expect(afterCalls.some((call) => call.method === "Emulation.setPageScaleFactor")).toBe(false);
    expect(afterCalls.some((call) => call.method.startsWith("Emulation."))).toBe(false);

    await view.close();
    await runtime.close();
  });

  test("capabilities contract advertises observe_mirror without viewport mutation", () => {
    const caps = browserCapabilities();
    expect(caps.modes).toContain("observe_mirror");
    expect(caps.observe_mirror.read_only).toBe(true);
    expect(caps.observe_mirror.mutates_viewport).toBe(false);
    expect(caps.observe_mirror.creates_targets).toBe(false);
    expect(caps.observe_mirror.closes_targets).toBe(false);
    expect(caps.observe_mirror.env.mode).toBe("HERDR_BROWSER_MODE");
    expect(caps.observe_mirror.env.target_state).toBe("HERDR_BROWSER_TARGET_STATE");
    expect(caps.target_state_schema_version).toBe(1);
  });

  test("default mode still creates a sibling target on external chrome", async () => {
    const cdp = new FakeCdp(["T-preexisting"]);
    const runtime = await fakeExternalRuntime(cdp);
    delete process.env.HERDR_BROWSER_MODE;
    delete process.env.HERDR_BROWSER_TARGET_STATE;

    const view = await createBrowserView(runtime, "sidecar");
    expect(view.mode).toBe("default");
    expect(cdp.createCount).toBe(1);
    const createdId = view.targetId;
    expect(createdId.startsWith("root-")).toBe(true);
    await view.close();
    expect(cdp.closedTargets).toContain(createdId);
    await runtime.close();
  });
});

function writeTargetState(fields: {
  seq: number;
  active_target_id: string | null;
  browser_generation?: string;
  page?: { url?: string; title?: string };
}): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-observe-state-"));
  const path = join(dir, "active-target.json");
  atomicWrite(path, fields);
  return path;
}

function atomicWrite(path: string, fields: {
  seq: number;
  active_target_id: string | null;
  browser_generation?: string;
  page?: { url?: string; title?: string };
}): void {
  const doc = {
    version: TARGET_STATE_SCHEMA_VERSION,
    worker_id: "worker-test",
    updated_at: new Date().toISOString(),
    cdp_url: "http://127.0.0.1:9222",
    ...fields,
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, path);
}

async function fakeExternalRuntime(cdp: FakeCdp): Promise<BrowserRuntime> {
  const chrome = {
    ownership: "external",
    executable: "external-chrome",
    port: 9222,
    profileDir: "/tmp/fake-external-profile",
    process: { pid: null, on() {}, once() {}, off() {} },
    browserWebSocketUrl: "ws://fake",
    recentStderr: () => "",
    close: async () => {},
  } as unknown as ChromeInstance;
  return await createBrowserRuntime({
    launch: async () => chrome,
    connect: async () => cdp as unknown as CdpClient,
  });
}

class FakeCdp {
  private handlers = new Map<string, Set<(params: unknown) => void>>();
  private nextTarget = 0;
  private targetMeta = new Map<string, { url: string; title: string }>();
  knownTargets = new Set<string>();
  createCount = 0;
  closedTargets: string[] = [];
  detachedTargets: string[] = [];
  attachCalls: string[] = [];
  sendCalls: Array<{
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }> = [];

  constructor(existing: string[] = []) {
    for (const id of existing) {
      this.knownTargets.add(id);
      this.targetMeta.set(id, { url: "about:blank", title: id });
    }
  }

  setTargetInfo(targetId: string, info: { url: string; title: string }): void {
    this.knownTargets.add(targetId);
    this.targetMeta.set(targetId, info);
  }

  on(method: string, handler: (params: unknown) => void): () => void {
    const handlers = this.handlers.get(method) ?? new Set();
    handlers.add(handler);
    this.handlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  emit(method: string, params: unknown): void {
    for (const handler of this.handlers.get(method) ?? []) {
      handler(params);
    }
  }

  async send<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    this.sendCalls.push({ method, params, sessionId });
    if (method === "Target.setDiscoverTargets") {
      return {} as T;
    }
    if (method === "Target.createTarget") {
      this.createCount += 1;
      const targetId = `root-${++this.nextTarget}`;
      this.knownTargets.add(targetId);
      this.targetMeta.set(targetId, { url: "about:blank", title: targetId });
      return { targetId } as T;
    }
    if (method === "Target.getTargetInfo") {
      const targetId = String(params.targetId);
      if (!this.knownTargets.has(targetId)) {
        throw new Error(`No target with given id: ${targetId}`);
      }
      const meta = this.targetMeta.get(targetId) ?? { url: "about:blank", title: targetId };
      return {
        targetInfo: {
          targetId,
          type: "page",
          title: meta.title,
          url: meta.url,
        },
      } as T;
    }
    if (method === "Target.attachToTarget") {
      const targetId = String(params.targetId);
      this.attachCalls.push(targetId);
      return { sessionId: `session-${targetId}` } as T;
    }
    if (method === "Target.closeTarget") {
      const targetId = String(params.targetId);
      this.closedTargets.push(targetId);
      this.knownTargets.delete(targetId);
      return { success: true } as T;
    }
    if (method === "Target.detachFromTarget") {
      this.detachedTargets.push(String(params.targetId));
      return {} as T;
    }
    return {} as T;
  }

  close(): void {}
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error("timed out waiting for condition");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
