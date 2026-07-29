import { describe, expect, test } from "bun:test";

import {
  cachedPageInfo,
  cachedTabs,
  closeTab,
  createBrowserRuntime,
  createBrowserView,
  createTab,
  onScreencastFrame,
  setViewport,
  startScreencast,
  stopScreencast,
  type BrowserRuntime,
} from "./browser";
import type { ChromeInstance } from "./chrome";
import type { CdpClient } from "./cdp";

describe("browser view ownership", () => {
  test("roots stay isolated and popup descendants inherit their opener view", async () => {
    const cdp = new FakeCdp();
    const runtime = await fakeRuntime(cdp);
    const a = await createBrowserView(runtime, "view-a");
    const b = await createBrowserView(runtime, "view-b");
    const aRoot = a.targetId;

    cdp.emit("Target.targetCreated", targetCreated("popup-a", aRoot));
    await tick();
    cdp.emit("Target.targetCreated", targetCreated("nested-a", "popup-a"));
    await tick();

    expect([...a.tabs.keys()]).toEqual([aRoot, "popup-a", "nested-a"]);
    expect([...b.tabs.keys()]).toEqual([b.targetId]);
    expect(a.targetId).toBe("nested-a");

    const aTargets = [...a.tabs.keys()];
    const bTarget = b.targetId;
    await a.close();

    expect(cdp.closedTargets.sort()).toEqual(aTargets.sort());
    expect(runtime.views.has("view-b")).toBe(true);
    expect(b.tabs.has(bTarget)).toBe(true);
    await runtime.close();
  });

  test("closing a view contains a popup attachment already in flight", async () => {
    const cdp = new FakeCdp();
    const runtime = await fakeRuntime(cdp);
    const view = await createBrowserView(runtime, "view-a");
    cdp.deferAttach("popup-a");
    cdp.emit("Target.targetCreated", targetCreated("popup-a", view.targetId));
    await tick();

    await view.close();
    cdp.releaseAttach("popup-a");
    await tick();

    expect(view.tabs.has("popup-a")).toBe(false);
    expect(runtime.targetOwners.has("popup-a")).toBe(false);
    expect(cdp.closedTargets).toContain("popup-a");
    await runtime.close();
  });

  test("tabs can be created, activated, and closed without emptying the view", async () => {
    const cdp = new FakeCdp();
    const runtime = await fakeRuntime(cdp);
    const view = await createBrowserView(runtime, "view-a");
    const rootTarget = view.targetId;

    const created = await createTab(view);
    expect(view.targetId).toBe(created.targetId);
    expect([...view.tabs.keys()]).toEqual([rootTarget, created.targetId]);

    const activeAfterClose = await closeTab(view, created.targetId);
    expect(activeAfterClose.targetId).toBe(rootTarget);
    expect(view.tabs.has(created.targetId)).toBe(false);
    expect(cdp.closedTargets).toContain(created.targetId);

    const replacement = await closeTab(view, rootTarget);
    expect(view.tabs.size).toBe(1);
    expect(replacement.targetId).not.toBe(rootTarget);
    expect(view.targetId).toBe(replacement.targetId);
    await runtime.close();
  });

  test("external destruction of the final target creates a replacement tab", async () => {
    const cdp = new FakeCdp();
    const runtime = await fakeRuntime(cdp);
    const view = await createBrowserView(runtime, "view-a");
    const original = view.targetId;

    cdp.emit("Target.targetDestroyed", { targetId: original });
    await tick();

    expect(view.tabs.size).toBe(1);
    expect(view.targetId).not.toBe(original);
    expect(runtime.targetOwners.get(view.targetId)).toBe("view-a");
    await runtime.close();
  });

  test("failed tab attachment closes the unowned target", async () => {
    const cdp = new FakeCdp();
    const runtime = await fakeRuntime(cdp);
    const view = await createBrowserView(runtime, "view-a");
    cdp.failAttach("root-2");

    await expect(createTab(view)).rejects.toThrow("attach failed");
    await tick();

    expect(runtime.targetOwners.has("root-2")).toBe(false);
    expect(view.tabs.has("root-2")).toBe(false);
    expect(cdp.closedTargets).toContain("root-2");
    await runtime.close();
  });

  test("failed tab setup removes local state after publication", async () => {
    const cdp = new FakeCdp();
    const runtime = await fakeRuntime(cdp);
    const view = await createBrowserView(runtime, "view-a");
    cdp.failEnable("root-2");

    await expect(createTab(view)).rejects.toThrow("enable failed");
    await tick();

    expect(view.tabs.has("root-2")).toBe(false);
    expect(runtime.targetOwners.has("root-2")).toBe(false);
    expect(cdp.closedTargets).toContain("root-2");
    await runtime.close();
  });

  test("failed create rollback retains ownership for view cleanup", async () => {
    const cdp = new FakeCdp();
    const runtime = await fakeRuntime(cdp);
    const view = await createBrowserView(runtime, "view-a");
    cdp.failEnable("root-2");
    cdp.failClose("root-2");

    await expect(createTab(view)).rejects.toThrow("enable failed");
    await tick();

    expect(view.tabs.has("root-2")).toBe(false);
    expect(runtime.targetOwners.get("root-2")).toBe("view-a");
    expect(cdp.closedTargets).not.toContain("root-2");
    await runtime.close();
  });

  test("failed tab close retains target ownership and local state", async () => {
    const cdp = new FakeCdp();
    const runtime = await fakeRuntime(cdp);
    const view = await createBrowserView(runtime, "view-a");
    const created = await createTab(view);
    cdp.failClose(created.targetId);

    await expect(closeTab(view, created.targetId)).rejects.toThrow("failed to close browser tab");
    await tick();

    expect(runtime.targetOwners.get(created.targetId)).toBe("view-a");
    expect(view.tabs.has(created.targetId)).toBe(true);
    await runtime.close();
  });

  test("screencast events deliver immediately and stop flushes paced acknowledgements", async () => {
    const cdp = new FakeCdp();
    const runtime = await fakeRuntime(cdp);
    const view = await createBrowserView(runtime, "view-a");
    const received: string[] = [];
    const unsubscribe = onScreencastFrame(view, (data) => {
      received.push(data);
    });
    await startScreencast(view);
    cdp.sendCalls.length = 0;

    const event = `${view.sessionId}:Page.screencastFrame`;
    const ackRoutes = () => cdp.sendCalls
      .filter((call) => call.method === "Page.screencastFrameAck")
      .map((call) => [call.params.sessionId, call.sessionId]);
    cdp.emit(event, { data: "frame-1", sessionId: 101 });
    cdp.emit(event, { data: "frame-2", sessionId: 102 });
    cdp.emit(event, { data: "frame-3", sessionId: 103 });

    expect(received).toEqual(["frame-1", "frame-2", "frame-3"]);
    expect(ackRoutes()).toEqual([[101, view.sessionId]]);

    await stopScreencast(view);

    expect(ackRoutes()).toEqual([
      [101, view.sessionId],
      [102, view.sessionId],
      [103, view.sessionId],
    ]);
    const methods = cdp.sendCalls.map((call) => call.method);
    expect(methods.indexOf("Page.stopScreencast"))
      .toBeGreaterThan(methods.lastIndexOf("Page.screencastFrameAck"));

    unsubscribe();
    await runtime.close();
  });

  test("page scale is restored after the active page loads", async () => {
    const cdp = new FakeCdp();
    const runtime = await fakeRuntime(cdp);
    const view = await createBrowserView(runtime, "view-a");
    await setViewport(view, {
      width: 1200,
      height: 900,
      deviceScaleFactor: 1,
      pageScaleFactor: 1.5,
    });
    cdp.sendCalls.length = 0;

    cdp.emit(`${view.sessionId}:Page.loadEventFired`, {});
    await tick();

    expect(cdp.sendCalls).toContainEqual({
      method: "Emulation.setPageScaleFactor",
      params: { pageScaleFactor: 1.5 },
      sessionId: view.sessionId,
    });
    await runtime.close();
  });

  test("cachedPageInfo and cachedTabs read locally tracked target state without any CDP calls", async () => {
    const cdp = new FakeCdp();
    const runtime = await fakeRuntime(cdp);
    const view = await createBrowserView(runtime, "view-a");
    const rootTarget = view.targetId;

    expect(cachedPageInfo(view)).toEqual({ url: "about:blank", title: "" });
    expect(cachedTabs(view)).toEqual([
      { targetId: rootTarget, title: "", url: "about:blank", active: true },
    ]);

    cdp.sendCalls.length = 0;
    cdp.emit("Target.targetInfoChanged", {
      targetInfo: {
        targetId: rootTarget,
        type: "page",
        title: "Updated title",
        url: "https://updated.test",
      },
    });

    expect(cachedPageInfo(view)).toEqual({ url: "https://updated.test", title: "Updated title" });
    expect(cachedTabs(view)).toEqual([
      { targetId: rootTarget, title: "Updated title", url: "https://updated.test", active: true },
    ]);
    // No Page.getNavigationHistory / Runtime.evaluate / /json/list round trip:
    // the cache is served purely from the Target.targetInfoChanged listener.
    expect(cdp.sendCalls).toEqual([]);

    await runtime.close();
  });
});

async function fakeRuntime(cdp: FakeCdp): Promise<BrowserRuntime> {
  const chrome = {
    ownership: "owned",
    executable: "fake-chrome",
    port: 9222,
    profileDir: "/tmp/fake-profile",
    child: { pid: 1234, on() {}, once() {}, off() {} },
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
  private deferredAttaches = new Map<string, Promise<void>>();
  private attachResolvers = new Map<string, () => void>();
  private failedAttaches = new Set<string>();
  private failedCloses = new Set<string>();
  private failedEnables = new Set<string>();
  closedTargets: string[] = [];
  sendCalls: Array<{
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }> = [];

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

  deferAttach(targetId: string): void {
    this.deferredAttaches.set(targetId, new Promise((resolve) => {
      this.attachResolvers.set(targetId, resolve);
    }));
  }

  releaseAttach(targetId: string): void {
    this.attachResolvers.get(targetId)?.();
  }

  failAttach(targetId: string): void {
    this.failedAttaches.add(targetId);
  }

  failClose(targetId: string): void {
    this.failedCloses.add(targetId);
  }

  failEnable(targetId: string): void {
    this.failedEnables.add(targetId);
  }

  async send<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    this.sendCalls.push({ method, params, sessionId });
    if (method === "Target.createTarget") {
      const targetId = `root-${++this.nextTarget}`;
      this.emit("Target.targetCreated", targetCreated(targetId));
      return { targetId } as T;
    }
    if (method === "Target.attachToTarget") {
      if (this.failedAttaches.has(String(params.targetId))) {
        throw new Error("attach failed");
      }
      await this.deferredAttaches.get(String(params.targetId));
      return { sessionId: `session-${params.targetId}` } as T;
    }
    if (method === "Runtime.enable" && this.failedEnables.has(String(sessionId).replace(/^session-/, ""))) {
      throw new Error("enable failed");
    }
    if (method === "Target.closeTarget") {
      if (this.failedCloses.has(String(params.targetId))) {
        return { success: false } as T;
      }
      this.closedTargets.push(String(params.targetId));
      return { success: true } as T;
    }
    return {} as T;
  }

  close(): void {}
}

function targetCreated(targetId: string, openerId?: string): unknown {
  return {
    targetInfo: {
      targetId,
      type: "page",
      title: targetId,
      url: "about:blank",
      openerId,
    },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
