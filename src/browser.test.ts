import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  automationDescriptor,
  captureFrameData,
  currentPageInfo,
  goBack,
  listTabs,
  moveMouse,
  navigate,
  nativeSelectAtPoint,
  reloadPage,
  setViewport,
  startScreencast,
  stopLoading,
  switchTab,
  type BrowserSession,
} from "./browser";
import type { ChromeInstance } from "./chrome";
import { ScreencastAckPacer } from "./screencastAckPacer";

const originalFetch = globalThis.fetch;
const originalCaptureBackend = process.env.HERDR_BROWSER_CAPTURE_BACKEND;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCaptureBackend === undefined) {
    delete process.env.HERDR_BROWSER_CAPTURE_BACKEND;
  } else {
    process.env.HERDR_BROWSER_CAPTURE_BACKEND = originalCaptureBackend;
  }
});

describe("browser navigation helpers", () => {
  test("navigate reports timeout instead of throwing when load does not settle", async () => {
    const session = fakeSession({
      history: {
        currentIndex: 0,
        entries: [{ id: 1, url: "http://127.0.0.1:5174/slow", title: "Slow" }],
      },
      title: "Slow",
      loadTimesOut: true,
    });

    await expect(navigate(session, "http://127.0.0.1:5174/slow")).resolves.toEqual({
      navigated: true,
      timed_out: true,
      url: "http://127.0.0.1:5174/slow",
      title: "Slow",
    });
  });

  test("goBack reports no navigation when history has no previous entry", async () => {
    const session = fakeSession({
      history: {
        currentIndex: 0,
        entries: [{ id: 1, url: "http://127.0.0.1:5174/", title: "Only" }],
      },
      title: "Only",
    });

    await expect(goBack(session)).resolves.toEqual({
      navigated: false,
      timed_out: false,
      url: "http://127.0.0.1:5174/",
      title: "Only",
    });
  });

  test("goBack invalidates cached screencast frames after history navigation", async () => {
    const session = fakeSession({
      history: {
        currentIndex: 1,
        entries: [
          { id: 1, url: "http://127.0.0.1:5174/one", title: "One" },
          { id: 2, url: "http://127.0.0.1:5174/two", title: "Two" },
        ],
      },
      title: "Two",
      screencastData: "stale-frame",
    });
    session.screencast.frameCount = 7;
    session.screencast.invalidatedFrameCount = 2;

    await goBack(session);

    expect(session.screencast.invalidatedFrameCount).toBe(7);
  });

  test("reload exposes load timeout state", async () => {
    const session = fakeSession({
      history: {
        currentIndex: 0,
        entries: [{ id: 1, url: "http://127.0.0.1:5174/slow", title: "Slow" }],
      },
      title: "Slow",
      loadTimesOut: true,
    });

    await expect(reloadPage(session)).resolves.toEqual({
      navigated: true,
      timed_out: true,
      url: "http://127.0.0.1:5174/slow",
      title: "Slow",
    });
  });

  test("stopLoading reports a stopped load, not a navigation", async () => {
    const session = fakeSession({
      history: {
        currentIndex: 0,
        entries: [{ id: 1, url: "http://127.0.0.1:5174/slow", title: "Slow" }],
      },
      title: "Slow",
    });

    await expect(stopLoading(session)).resolves.toEqual({
      navigated: false,
      timed_out: false,
      url: "http://127.0.0.1:5174/slow",
      title: "Slow",
    });
  });
});

describe("automationDescriptor", () => {
  test("returns CDP endpoints, rendered target, and live viewport", async () => {
    const descriptor = await automationDescriptor(fakeSession({
      history: {
        currentIndex: 0,
        entries: [{ id: 1, url: "http://127.0.0.1:5174/", title: "Click Test" }],
      },
      title: "Click Test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1.5 },
    }), {
      cdpHttpUrl: "http://127.0.0.1:4444",
      browserWebSocketUrl: "ws://127.0.0.1:4444/devtools/browser/view-1",
      pageWebSocketUrl: (targetId) => `ws://127.0.0.1:4444/devtools/page/${targetId}`,
    });

    expect(descriptor).toMatchObject({
      contract_version: 1,
      view_id: "view-1",
      cdp_scope: "view",
      tab_authority: "external-cdp",
      cdp_http_url: "http://127.0.0.1:4444",
      browser_ws_url: "ws://127.0.0.1:4444/devtools/browser/view-1",
      active_target_id: "target-1",
      active_page_ws_url: "ws://127.0.0.1:4444/devtools/page/target-1",
      url: "http://127.0.0.1:5174/",
      title: "Click Test",
      chrome_pid: 1234,
      chrome_executable: "/usr/bin/chromium-browser",
      chrome_profile_dir: "/tmp/herdr-browser-test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1.5 },
    });
    expect(descriptor.snippets.playwright_connect_over_cdp).toContain("http://127.0.0.1:4444");
  });
});

test("setViewport forwards device scale factor to CDP", async () => {
  const calls: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
  const session = fakeSession({
    history: {
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    },
    title: "",
    calls,
  });

  await setViewport(session, {
    width: 800,
    height: 600,
    deviceScaleFactor: 2,
  });

  expect(calls).toContainEqual({
    method: "Emulation.setDeviceMetricsOverride",
    params: {
      width: 800,
      height: 600,
      deviceScaleFactor: 2,
      mobile: false,
    },
    sessionId: "session-1",
  });
});

test("setViewport applies page scale without changing raster geometry", async () => {
  const calls: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
  const session = fakeSession({
    history: {
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    },
    title: "",
    calls,
  });

  await setViewport(session, {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    pageScaleFactor: 1.5,
  });

  expect(calls).toContainEqual({
    method: "Emulation.setDeviceMetricsOverride",
    params: {
      width: 1200,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    },
    sessionId: "session-1",
  });
  expect(calls).toContainEqual({
    method: "Emulation.setPageScaleFactor",
    params: { pageScaleFactor: 1.5 },
    sessionId: "session-1",
  });
});

test("screencast bounds do not alter full browser viewport geometry", async () => {
  const calls: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
  const session = fakeSession({
    history: {
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    },
    title: "",
    calls,
  });

  await setViewport(session, {
    width: 1068,
    height: 1188,
    deviceScaleFactor: 1,
  });
  await startScreencast(session, { maxWidth: 534, maxHeight: 594 });

  expect(session.viewport).toEqual({ width: 1068, height: 1188, deviceScaleFactor: 1 });
  expect(calls).toEqual(expect.arrayContaining([
    {
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: 1068,
        height: 1188,
        deviceScaleFactor: 1,
        mobile: false,
      },
      sessionId: "session-1",
    },
    {
      method: "Page.startScreencast",
      params: {
        format: "png",
        everyNthFrame: 1,
        maxWidth: 534,
        maxHeight: 594,
      },
      sessionId: "session-1",
    },
  ]));
});

test("screencast cadence is applied to initial and restarted capture", async () => {
  const previous = process.env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME;
  process.env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME = "2";
  try {
    const calls: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
    const session = fakeSession({
      history: {
        currentIndex: 0,
        entries: [{ id: 1, url: "about:blank", title: "" }],
      },
      title: "",
      calls,
    });

    await startScreencast(session, { maxWidth: 400, maxHeight: 300 });
    await startScreencast(session, { maxWidth: 500, maxHeight: 350 });

    expect(calls.filter((call) => call.method === "Page.startScreencast")).toEqual([
      {
        method: "Page.startScreencast",
        params: {
          format: "png",
          everyNthFrame: 2,
          maxWidth: 400,
          maxHeight: 300,
        },
        sessionId: "session-1",
      },
      {
        method: "Page.startScreencast",
        params: {
          format: "png",
          everyNthFrame: 2,
          maxWidth: 500,
          maxHeight: 350,
        },
        sessionId: "session-1",
      },
    ]);
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME;
    } else {
      process.env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME = previous;
    }
  }
});

test("changing screencast bounds restarts capture once", async () => {
  const calls: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
  const session = fakeSession({
    history: {
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    },
    title: "",
    calls,
  });

  await startScreencast(session, { maxWidth: 400, maxHeight: 300 });
  await startScreencast(session, { maxWidth: 400, maxHeight: 300 });
  await startScreencast(session, { maxWidth: 500, maxHeight: 350 });

  expect(calls.filter((call) => call.method === "Page.startScreencast")).toHaveLength(2);
  expect(calls.filter((call) => call.method === "Page.stopScreencast")).toHaveLength(1);
  expect(session.screencast.capture).toEqual({ maxWidth: 500, maxHeight: 350 });
});

test("switchTab activates the selected target and reapplies the viewport", async () => {
  const calls: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
  const session = fakeSession({
    history: {
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    },
    title: "",
    viewport: { width: 900, height: 700, deviceScaleFactor: 2, pageScaleFactor: 1.5 },
    activeTargetId: "target-1",
    activeSessionId: "session-1",
    tabs: [
      { targetId: "target-1", sessionId: "session-1", title: "One", url: "https://one.test/" },
      { targetId: "target-2", sessionId: "session-2", title: "Two", url: "https://two.test/" },
    ],
    calls,
  });
  session.screencast.started = true;

  await switchTab(session, "target-2");

  expect(session.targetId).toBe("target-2");
  expect(session.sessionId).toBe("session-2");
  expect(calls).toContainEqual({
    method: "Page.stopScreencast",
    params: {},
    sessionId: "session-1",
  });
  expect(calls).toContainEqual({
    method: "Emulation.setDeviceMetricsOverride",
    params: {
      width: 900,
      height: 700,
      deviceScaleFactor: 2,
      mobile: false,
    },
    sessionId: "session-2",
  });
  expect(calls).toContainEqual({
    method: "Emulation.setPageScaleFactor",
    params: { pageScaleFactor: 1.5 },
    sessionId: "session-2",
  });
  await expect(listTabs(session)).resolves.toEqual([
    { targetId: "target-1", title: "One", url: "https://one.test/", active: false },
    { targetId: "target-2", title: "Two", url: "https://two.test/", active: true },
  ]);
});

test("switchTab reapplies retained screencast bounds", async () => {
  const previous = process.env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME;
  process.env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME = "2";
  try {
    const calls: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
    const session = fakeSession({
      history: {
        currentIndex: 0,
        entries: [{ id: 1, url: "about:blank", title: "" }],
      },
      title: "",
      viewport: { width: 900, height: 700, deviceScaleFactor: 1 },
      activeTargetId: "target-1",
      activeSessionId: "session-1",
      tabs: [
        { targetId: "target-1", sessionId: "session-1", title: "One", url: "https://one.test/" },
        { targetId: "target-2", sessionId: "session-2", title: "Two", url: "https://two.test/" },
      ],
      calls,
    });
    session.screencast.listeners.add(() => {});
    await startScreencast(session, { maxWidth: 450, maxHeight: 350 });
    calls.length = 0;

    await switchTab(session, "target-2");

    expect(calls).toContainEqual({
      method: "Page.startScreencast",
      params: {
        format: "png",
        everyNthFrame: 2,
        maxWidth: 450,
        maxHeight: 350,
      },
      sessionId: "session-2",
    });
    expect(session.viewport).toEqual({ width: 900, height: 700, deviceScaleFactor: 1 });
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME;
    } else {
      process.env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME = previous;
    }
  }
});

test("moveMouse forwards a hover event to CDP", async () => {
  const calls: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
  const ackPacer = new ScreencastAckPacer();
  const boost = spyOn(ackPacer, "boost");
  const session = fakeSession({
    history: {
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    },
    title: "",
    calls,
    ackPacer,
  });

  await moveMouse(session, { x: 42.9, y: 12.2 });

  expect(calls).toContainEqual({
    method: "Input.dispatchMouseEvent",
    params: {
      type: "mouseMoved",
      x: 42,
      y: 12,
      button: "none",
      buttons: 0,
    },
    sessionId: "session-1",
  });
  expect(boost).toHaveBeenCalledTimes(1);
  boost.mockRestore();
});

test("captureFrameData uses screenshot backend by default", async () => {
  const calls: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
  const session = fakeSession({
    history: {
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    },
    title: "",
    screenshotData: "png-base64",
    calls,
  });

  await expect(captureFrameData(session)).resolves.toEqual({
    data: "png-base64",
    backend: "screenshot",
  });
  expect(calls).toContainEqual({
    method: "Page.captureScreenshot",
    params: {
      format: "png",
      fromSurface: true,
    },
    sessionId: "session-1",
  });
});

test("captureFrameData starts screencast and returns cached frame when configured", async () => {
  process.env.HERDR_BROWSER_CAPTURE_BACKEND = "screencast";
  const calls: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
  const session = fakeSession({
    history: {
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    },
    title: "",
    screencastData: "frame-base64",
    calls,
  });

  await expect(captureFrameData(session)).resolves.toEqual({
    data: "frame-base64",
    backend: "screencast",
  });
  expect(calls).toContainEqual({
    method: "Page.startScreencast",
    params: {
      format: "png",
      everyNthFrame: 1,
    },
    sessionId: "session-1",
  });
});

test("captureFrameData falls back to a screenshot quickly when no fresh screencast frame arrives", async () => {
  process.env.HERDR_BROWSER_CAPTURE_BACKEND = "screencast";
  const session = fakeSession({
    history: {
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    },
    title: "",
    screenshotData: "fallback-frame",
  });

  const started = performance.now();
  await expect(captureFrameData(session)).resolves.toEqual({
    data: "fallback-frame",
    backend: "screenshot",
  });
  // Regression guard: the fresh-frame wait used to be 1s, long enough to
  // stall input behind a stalled/static-page screencast fallback. It should
  // now bail out in ~200ms.
  expect(performance.now() - started).toBeLessThan(600);
});

test("nativeSelectAtPoint returns browser hit-test result", async () => {
  await expect(nativeSelectAtPoint(fakeSession({
    history: {
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    },
    title: "",
    nativeSelectHit: true,
  }), {
    x: 427.4,
    y: 470.8,
  })).resolves.toEqual({
    nativeSelect: true,
  });
});

test("currentPageInfo falls back only for CDP timeout errors", async () => {
  await expect(currentPageInfo(fakeSession({
    history: {
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    },
    title: "Recovered title",
    historyError: new Error("timed out waiting for CDP Page.getNavigationHistory"),
  }))).resolves.toEqual({
    url: "",
    title: "Recovered title",
  });

  await expect(currentPageInfo(fakeSession({
    history: {
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    },
    title: "",
    historyError: new Error("CDP WebSocket closed"),
  }))).rejects.toThrow("CDP WebSocket closed");
});

function stubFetch(result: Response | Error): void {
  globalThis.fetch = Object.assign(async () => {
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }, {
    preconnect: originalFetch.preconnect,
  });
}

type FakeSessionOptions = {
  history: {
    currentIndex: number;
    entries: Array<{ id: number; url: string; title: string }>;
  };
  title: string;
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    pageScaleFactor?: number;
  };
  activeTargetId?: string;
  activeSessionId?: string;
  tabs?: Array<{ targetId: string; sessionId: string; title: string; url: string }>;
  nativeSelectHit?: boolean;
  screenshotData?: string;
  screencastData?: string;
  historyError?: Error;
  loadTimesOut?: boolean;
  calls?: Array<{ method: string; params?: unknown; sessionId?: string }>;
  ackPacer?: ScreencastAckPacer;
};

function fakeSession(options: FakeSessionOptions): BrowserSession {
  const activeTargetId = options.activeTargetId ?? "target-1";
  const activeSessionId = options.activeSessionId ?? "session-1";
  const tabs = new Map((options.tabs ?? [{
    targetId: activeTargetId,
    sessionId: activeSessionId,
    title: options.title,
    url: options.history.entries[options.history.currentIndex]?.url ?? "about:blank",
  }]).map((tab) => [
    tab.targetId,
    {
      targetId: tab.targetId,
      sessionId: tab.sessionId,
      info: {
        targetId: tab.targetId,
        type: "page",
        title: tab.title,
        url: tab.url,
      },
      unsubscribers: [],
    },
  ])) as BrowserSession["tabs"];
  const cdp = {
    send: async (method: string, params?: { expression?: string }, sessionId?: string) => {
      options.calls?.push({ method, params, sessionId });
      if (method === "Page.getNavigationHistory") {
        if (options.historyError) {
          throw options.historyError;
        }
        return options.history;
      }
      if (method === "Page.captureScreenshot") {
        return { data: options.screenshotData ?? "" };
      }
      if (method === "Runtime.evaluate") {
        if (params?.expression?.includes("document.elementFromPoint")) {
          return {
            result: {
              type: "object",
              value: { nativeSelect: options.nativeSelectHit ?? false },
            },
          };
        }
        if (params?.expression?.includes("window.innerWidth") && options.viewport) {
          return {
            result: {
              type: "object",
              value: {
                ...options.viewport,
                deviceScaleFactor: options.viewport.deviceScaleFactor ?? 1,
              },
            },
          };
        }
        return { result: { type: "string", value: options.title } };
      }
      return {};
    },
    waitFor: async () => {
      if (options.loadTimesOut) {
        throw new Error("timeout");
      }
      return {};
    },
    close: () => {},
    on: () => {},
  };

  return {
    id: "view-1",
    chrome: {
      ownership: "owned",
      port: 3333,
      browserWebSocketUrl: "ws://127.0.0.1:3333/devtools/browser/browser-1",
      executable: "/usr/bin/chromium-browser",
      profileDir: "/tmp/herdr-browser-test",
      child: { pid: 1234 },
      recentStderr: () => "",
      close: async () => {},
    } as ChromeInstance,
    cdp,
    targetId: activeTargetId,
    sessionId: activeSessionId,
    consoleEntries: [],
    screencast: {
      started: false,
      capture: null,
      latestData: options.screencastData ?? null,
      frameCount: options.screencastData ? 1 : 0,
      invalidatedFrameCount: 0,
      waiters: [],
      listeners: new Set(),
      ackPacer: options.ackPacer ?? new ScreencastAckPacer(),
    },
    tabs,
    attachPromises: new Map(),
    viewport: options.viewport ?? null,
    unsubscribers: [],
    close: async () => {},
  } as unknown as BrowserSession;
}
