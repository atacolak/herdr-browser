import { writeFile } from "node:fs/promises";

import { chromeCdpHttpUrl, resolveChrome, type ChromeInstance } from "./chrome";
import { CdpClient } from "./cdp";
import {
  configuredCaptureBackend,
  type CaptureBackend,
  type ScreencastCaptureSize,
} from "./captureBackend";
import { configuredScreencastEveryNthFrame } from "./screencastCadence";
import { ScreencastAckPacer, type ScreencastCapacityGate } from "./screencastAckPacer";

type CreateTargetResult = {
  targetId: string;
};

type CloseTargetResult = {
  success: boolean;
};

type AttachResult = {
  sessionId: string;
};

type GetTargetsResult = {
  targetInfos: CdpTargetInfo[];
};

type EvaluateResult = {
  result: {
    type: string;
    value?: unknown;
    description?: string;
  };
  exceptionDetails?: unknown;
};

type CaptureScreenshotResult = {
  data: string;
};

type ScreencastFrameParams = {
  data?: unknown;
  sessionId?: unknown;
};

type ScreencastState = {
  started: boolean;
  capture: ScreencastCaptureSize | null;
  latestData: string | null;
  frameCount: number;
  invalidatedFrameCount: number;
  waiters: Array<(data: string) => void>;
  listeners: Set<ScreencastFrameListener>;
  ackPacer: ScreencastAckPacer;
};

export type ScreencastFrameListener = (data: string) => void | Promise<void>;

type CdpTargetInfo = {
  targetId: string;
  type: string;
  title?: string;
  url?: string;
  attached?: boolean;
  openerId?: string;
};

type TargetEventParams = {
  targetInfo?: unknown;
  targetId?: unknown;
};

type BrowserTab = {
  targetId: string;
  sessionId: string;
  info: CdpTargetInfo;
  unsubscribers: Array<() => void>;
};

type GetNavigationHistoryResult = {
  currentIndex: number;
  entries: Array<{
    id: number;
    url: string;
    title: string;
  }>;
};

type CdpPageTarget = {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
};

const NAVIGATION_SETTLE_MS = 2_000;
const FRESH_SCREENCAST_FRAME_TIMEOUT_MS = 200;

type SelectorPoint = {
  x: number;
  y: number;
};

export type ConsoleEntry = {
  level: string;
  text: string;
  timestamp: number;
};

export type BrowserSession = {
  id: string;
  runtime: BrowserRuntime;
  chrome: ChromeInstance;
  cdp: CdpClient;
  targetId: string;
  sessionId: string;
  consoleEntries: ConsoleEntry[];
  screencast: ScreencastState;
  tabs: Map<string, BrowserTab>;
  attachPromises: Map<string, Promise<BrowserTab | null>>;
  viewport: BrowserViewport | null;
  closed: boolean;
  close: () => Promise<void>;
};

export type BrowserRuntime = {
  chrome: ChromeInstance;
  cdp: CdpClient;
  views: Map<string, BrowserSession>;
  targetOwners: Map<string, string>;
  unsubscribers: Array<() => void>;
  closed: boolean;
  close: () => Promise<void>;
};

export type BrowserViewport = {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  pageScaleFactor?: number;
};

export type BrowserMouseClick = {
  x: number;
  y: number;
};

export type BrowserMouseMove = {
  x: number;
  y: number;
};

export type BrowserNativeSelectHit = {
  nativeSelect: boolean;
};

export type BrowserMouseWheel = {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
};

const KEY_DEFINITIONS = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
} as const;

export type BrowserKey = keyof typeof KEY_DEFINITIONS;

export type BrowserKeyboardInput =
  | {
    kind: "text";
    text: string;
  }
  | {
    kind: "key";
    key: BrowserKey;
  };

export type BrowserNavigationResult = {
  navigated: boolean;
  timed_out: boolean;
  url: string;
  title: string;
};

export type BrowserTabInfo = {
  targetId: string;
  title: string;
  url: string;
  active: boolean;
};

export type BrowserAutomationDescriptor = {
  contract_version: 1;
  view_id: string;
  cdp_scope: "view";
  tab_authority: "external-cdp";
  cdp_http_url: string;
  browser_ws_url: string;
  active_target_id: string;
  active_page_ws_url: string | null;
  url: string;
  title: string;
  chrome_pid: number | null;
  chrome_executable: string;
  chrome_profile_dir: string;
  viewport: BrowserViewport | null;
  snippets: {
    playwright_mcp: string;
    browser_use_env: string;
    playwright_connect_over_cdp: string;
    pinchtab_attach: string;
    chrome_devtools_mcp: string;
  };
};

type BrowserAutomationEndpoints = {
  cdpHttpUrl: string;
  browserWebSocketUrl: string;
  pageWebSocketUrl: (targetId: string) => string;
};

export async function createBrowserSession(): Promise<BrowserSession> {
  const runtime = await createBrowserRuntime();
  try {
    const session = await createBrowserView(runtime, crypto.randomUUID());
    session.close = runtime.close;
    return session;
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

type BrowserRuntimeDependencies = {
  launch: () => Promise<ChromeInstance>;
  connect: (url: string) => Promise<CdpClient>;
};

export async function createBrowserRuntime(
  dependencies: BrowserRuntimeDependencies = {
    launch: resolveChrome,
    connect: CdpClient.connect,
  },
): Promise<BrowserRuntime> {
  const chrome = await dependencies.launch();
  let cdp: CdpClient | undefined;
  try {
    cdp = await dependencies.connect(chrome.browserWebSocketUrl);
    const runtime: BrowserRuntime = {
      chrome,
      cdp,
      views: new Map(),
      targetOwners: new Map(),
      unsubscribers: [],
      closed: false,
      close: async () => {
        if (runtime.closed) {
          return;
        }
        runtime.closed = true;
        for (const view of [...runtime.views.values()]) {
          await closeBrowserView(view);
        }
        for (const unsubscribe of runtime.unsubscribers) {
          unsubscribe();
        }
        cdp?.close();
        await chrome.close();
      },
    };
    runtime.unsubscribers.push(
      cdp.on("Target.targetCreated", (params) => {
        const targetInfo = targetInfoFromEvent(params);
        if (!targetInfo) {
          return;
        }
        const owner = targetInfo.openerId
          ? runtime.targetOwners.get(targetInfo.openerId)
          : undefined;
        if (!owner) {
          return;
        }
        runtime.targetOwners.set(targetInfo.targetId, owner);
        const view = runtime.views.get(owner);
        if (view) {
          void ensurePageTargetAttached(view, targetInfo, true).catch(() => {});
        }
      }),
      cdp.on("Target.targetInfoChanged", (params) => {
        const targetInfo = targetInfoFromEvent(params);
        if (!targetInfo) {
          return;
        }
        const owner = runtime.targetOwners.get(targetInfo.targetId) ??
          (targetInfo.openerId ? runtime.targetOwners.get(targetInfo.openerId) : undefined);
        if (!owner) {
          return;
        }
        runtime.targetOwners.set(targetInfo.targetId, owner);
        const view = runtime.views.get(owner);
        if (!view) {
          return;
        }
        const tab = view.tabs.get(targetInfo.targetId);
        if (tab) {
          tab.info = normalizedTargetInfo(targetInfo);
          return;
        }
        void ensurePageTargetAttached(view, targetInfo, targetInfo.targetId !== view.targetId).catch(() => {});
      }),
      cdp.on("Target.targetDestroyed", (params) => {
        const targetId = targetIdFromEvent(params);
        if (!targetId) {
          return;
        }
        const owner = runtime.targetOwners.get(targetId);
        runtime.targetOwners.delete(targetId);
        const view = owner ? runtime.views.get(owner) : undefined;
        if (view) {
          void removeTab(view, targetId);
        }
      }),
    );
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    return runtime;
  } catch (error) {
    cdp?.close();
    await chrome.close();
    throw error;
  }
}

export async function createBrowserView(
  runtime: BrowserRuntime,
  id: string,
  initialUrl = "about:blank",
): Promise<BrowserSession> {
  if (runtime.closed) {
    throw new Error("browser runtime is closed");
  }
  if (runtime.views.has(id)) {
    throw new Error(`browser view already exists: ${id}`);
  }
  const session: BrowserSession = {
    id,
    runtime,
    chrome: runtime.chrome,
    cdp: runtime.cdp,
    targetId: "",
    sessionId: "",
    consoleEntries: [],
    screencast: createScreencastState(),
    tabs: new Map(),
    attachPromises: new Map(),
    viewport: null,
    closed: false,
    close: async () => await closeBrowserView(session),
  };
  runtime.views.set(id, session);
  let createdTargetId: string | null = null;
  try {
    const created = await runtime.cdp.send<CreateTargetResult>("Target.createTarget", {
      url: initialUrl,
    });
    createdTargetId = created.targetId;
    runtime.targetOwners.set(created.targetId, id);
    await ensurePageTargetAttached(session, {
      targetId: created.targetId,
      type: "page",
      title: "",
      url: initialUrl,
    }, true);
    return session;
  } catch (error) {
    runtime.views.delete(id);
    if (createdTargetId) {
      runtime.targetOwners.delete(createdTargetId);
      await runtime.cdp.send("Target.closeTarget", { targetId: createdTargetId }, undefined, 1_000).catch(() => {});
    }
    throw error;
  }
}

export async function closeBrowserView(session: BrowserSession): Promise<void> {
  if (!session.runtime.views.delete(session.id)) {
    return;
  }
  session.closed = true;
  await stopActiveScreencast(session);
  const targetIds = [...session.runtime.targetOwners]
    .filter(([, owner]) => owner === session.id)
    .map(([targetId]) => targetId);
  for (const targetId of targetIds) {
    session.runtime.targetOwners.delete(targetId);
    const tab = session.tabs.get(targetId);
    if (tab) {
      cleanupTab(tab);
      session.tabs.delete(targetId);
    }
    await session.cdp.send("Target.closeTarget", { targetId }, undefined, 1_000).catch(() => {});
  }
  session.targetId = "";
  session.sessionId = "";
}

async function ensurePageTargetAttached(
  session: BrowserSession,
  targetInfo: CdpTargetInfo,
  activate: boolean,
): Promise<BrowserTab | null> {
  if (session.closed || !isPageTargetInfo(targetInfo)) {
    return null;
  }

  const existing = session.tabs.get(targetInfo.targetId);
  if (existing) {
    existing.info = normalizedTargetInfo(targetInfo);
    if (activate) {
      await activateTab(session, existing.targetId);
    }
    return existing;
  }

  const pending = session.attachPromises.get(targetInfo.targetId);
  if (pending) {
    const tab = await pending;
    if (tab) {
      tab.info = normalizedTargetInfo(targetInfo);
    }
    if (tab && activate) {
      await activateTab(session, tab.targetId);
    }
    return tab;
  }

  const attach = attachPageTarget(session, targetInfo);
  session.attachPromises.set(targetInfo.targetId, attach);
  try {
    const tab = await attach;
    if (tab && activate) {
      await activateTab(session, tab.targetId);
    }
    return tab;
  } finally {
    session.attachPromises.delete(targetInfo.targetId);
  }
}

async function attachPageTarget(
  session: BrowserSession,
  targetInfo: CdpTargetInfo,
): Promise<BrowserTab | null> {
  try {
    const { sessionId } = await session.cdp.send<AttachResult>("Target.attachToTarget", {
      targetId: targetInfo.targetId,
      flatten: true,
    }, undefined, 3_000);
    if (
      session.closed ||
      session.runtime.targetOwners.get(targetInfo.targetId) !== session.id
    ) {
      await session.cdp.send("Target.closeTarget", {
        targetId: targetInfo.targetId,
      }, undefined, 1_000).catch(() => {});
      return null;
    }
    const tab: BrowserTab = {
      targetId: targetInfo.targetId,
      sessionId,
      info: normalizedTargetInfo(targetInfo),
      unsubscribers: [],
    };
    session.tabs.set(tab.targetId, tab);
    installPageEventHandlers(session, tab);
    await session.cdp.send("Page.enable", {}, sessionId, 3_000);
    await session.cdp.send("Runtime.enable", {}, sessionId, 3_000);
    await session.cdp.send("Log.enable", {}, sessionId, 3_000);
    return tab;
  } catch (error) {
    if (isTargetGoneError(error)) {
      return null;
    }
    throw error;
  }
}

function installPageEventHandlers(session: BrowserSession, tab: BrowserTab): void {
  const pushConsoleEntry = (entry: ConsoleEntry) => {
    session.consoleEntries.push(entry);
    if (session.consoleEntries.length > 500) {
      session.consoleEntries.splice(0, session.consoleEntries.length - 500);
    }
  };
  tab.unsubscribers.push(
    session.cdp.on(`${tab.sessionId}:Log.entryAdded`, (params) => {
      const entry = (params as { entry?: { level?: unknown; text?: unknown; timestamp?: unknown } }).entry;
      if (!entry) {
        return;
      }
      pushConsoleEntry({
        level: typeof entry.level === "string" ? entry.level : "info",
        text: typeof entry.text === "string" ? entry.text : "",
        timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
      });
    }),
    session.cdp.on(`${tab.sessionId}:Runtime.consoleAPICalled`, (params) => {
      const event = params as {
        type?: unknown;
        args?: Array<{ value?: unknown; description?: unknown }>;
        timestamp?: unknown;
      };
      pushConsoleEntry({
        level: typeof event.type === "string" ? event.type : "log",
        text: (event.args ?? [])
          .map((arg) => String(arg.value ?? arg.description ?? ""))
          .join(" "),
        timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
      });
    }),
    session.cdp.on(`${tab.sessionId}:Page.loadEventFired`, () => {
      if (session.targetId !== tab.targetId || session.viewport?.pageScaleFactor === undefined) {
        return;
      }
      void applyPageScale(session, tab.sessionId, session.viewport.pageScaleFactor).catch(() => {});
    }),
    session.cdp.on(`${tab.sessionId}:Page.screencastFrame`, (params) => {
      const frame = params as ScreencastFrameParams;
      if (typeof frame.sessionId === "number") {
        const frameSessionId = frame.sessionId;
        session.screencast.ackPacer.enqueue(() => {
          void session.cdp.send("Page.screencastFrameAck", {
            sessionId: frameSessionId,
          }, tab.sessionId).catch(() => {});
        });
      }
      if (session.targetId !== tab.targetId || typeof frame.data !== "string") {
        return;
      }
      pushScreencastFrame(session, frame.data);
    }),
  );
}

export async function navigate(session: BrowserSession, url: string): Promise<BrowserNavigationResult> {
  boostScreencast(session);
  const load = waitForLoadEvent(session);
  await session.cdp.send("Page.navigate", { url }, session.sessionId, 3_000);
  const loaded = await load;
  invalidateScreencast(session);
  const info = await currentPageInfo(session);
  return {
    navigated: true,
    timed_out: !loaded,
    url: info.url || url,
    title: info.title,
  };
}

export async function goBack(session: BrowserSession): Promise<BrowserNavigationResult> {
  return await navigateHistory(session, -1);
}

export async function goForward(session: BrowserSession): Promise<BrowserNavigationResult> {
  return await navigateHistory(session, 1);
}

export async function reloadPage(session: BrowserSession): Promise<BrowserNavigationResult> {
  boostScreencast(session);
  const load = waitForLoadEvent(session);
  await session.cdp.send("Page.reload", {}, session.sessionId);
  const loaded = await load;
  invalidateScreencast(session);
  const info = await currentPageInfo(session);
  return {
    navigated: true,
    timed_out: !loaded,
    url: info.url,
    title: info.title,
  };
}

export async function stopLoading(session: BrowserSession): Promise<BrowserNavigationResult> {
  boostScreencast(session);
  await session.cdp.send("Page.stopLoading", {}, session.sessionId);
  invalidateScreencast(session);
  const info = await currentPageInfo(session);
  return {
    navigated: false,
    timed_out: false,
    url: info.url,
    title: info.title,
  };
}

export async function listTabs(session: BrowserSession): Promise<BrowserTabInfo[]> {
  await refreshTabInfos(session);
  return [...session.tabs.values()].map((tab) => tabInfo(session, tab));
}

export async function createTab(
  session: BrowserSession,
  initialUrl = "about:blank",
): Promise<BrowserTabInfo> {
  const created = await session.cdp.send<CreateTargetResult>("Target.createTarget", {
    url: initialUrl,
  });
  session.runtime.targetOwners.set(created.targetId, session.id);
  try {
    const tab = await ensurePageTargetAttached(session, {
      targetId: created.targetId,
      type: "page",
      title: "",
      url: initialUrl,
    }, true);
    if (tab) {
      return tabInfo(session, tab);
    }
    throw new Error("failed to create browser tab");
  } catch (error) {
    await removeTab(session, created.targetId).catch(() => {});
    const rollback = await session.cdp.send<CloseTargetResult>("Target.closeTarget", {
      targetId: created.targetId,
    }, undefined, 1_000).catch(() => null);
    if (rollback?.success) {
      session.runtime.targetOwners.delete(created.targetId);
    }
    throw error;
  }
}

export async function claimTab(
  session: BrowserSession,
  targetId: string,
  activate = true,
): Promise<BrowserTabInfo> {
  const owner = session.runtime.targetOwners.get(targetId);
  if (owner && owner !== session.id) {
    throw new Error(`target belongs to another browser view: ${targetId}`);
  }

  const existing = session.tabs.get(targetId);
  if (existing) {
    if (activate) {
      await activateTab(session, targetId);
    }
    return tabInfo(session, existing);
  }

  const response = await session.cdp.send<{ targetInfo?: CdpTargetInfo }>(
    "Target.getTargetInfo",
    { targetId },
  );
  const targetInfo = response.targetInfo;
  if (!targetInfo || targetInfo.type !== "page") {
    throw new Error(`target is not a page: ${targetId}`);
  }

  session.runtime.targetOwners.set(targetId, session.id);
  try {
    const tab = await ensurePageTargetAttached(session, targetInfo, activate);
    if (!tab) {
      throw new Error(`failed to attach browser tab: ${targetId}`);
    }
    return tabInfo(session, tab);
  } catch (error) {
    if (!owner) {
      session.runtime.targetOwners.delete(targetId);
    }
    throw error;
  }
}

export function ownsTarget(session: BrowserSession, targetId: string): boolean {
  return session.runtime.targetOwners.get(targetId) === session.id;
}

export async function closeTab(
  session: BrowserSession,
  targetId: string,
): Promise<BrowserTabInfo> {
  if (!session.tabs.has(targetId)) {
    throw new Error(`tab not found: ${targetId}`);
  }
  if (session.tabs.size === 1) {
    await createTab(session);
  }

  const closed = await session.cdp.send<CloseTargetResult>(
    "Target.closeTarget",
    { targetId },
    undefined,
    1_000,
  );
  if (!closed.success) {
    throw new Error(`failed to close browser tab: ${targetId}`);
  }
  session.runtime.targetOwners.delete(targetId);
  await removeTab(session, targetId);

  const active = session.tabs.get(session.targetId);
  if (!active) {
    throw new Error("browser view has no active tab");
  }
  return tabInfo(session, active);
}

export async function switchTab(
  session: BrowserSession,
  targetId: string,
): Promise<BrowserTabInfo> {
  await activateTab(session, targetId);
  const tab = session.tabs.get(targetId);
  if (!tab) {
    throw new Error(`tab not found: ${targetId}`);
  }
  return tabInfo(session, tab);
}

export async function evaluate(
  session: BrowserSession,
  expression: string,
  timeoutMs = 10_000,
): Promise<unknown> {
  const result = await session.cdp.send<EvaluateResult>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, session.sessionId, timeoutMs);

  if (result.exceptionDetails) {
    throw new Error(`evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
  }

  return result.result.value ?? result.result.description ?? null;
}

export async function pageTitle(session: BrowserSession): Promise<string> {
  try {
    const value = await evaluate(session, "document.title", 1_000);
    return typeof value === "string" ? value : "";
  } catch (error) {
    if (!isTimeoutError(error)) {
      throw error;
    }
    return "";
  }
}

export async function captureScreenshot(
  session: BrowserSession,
  outputPath: string,
): Promise<void> {
  const data = await captureScreenshotData(session);
  await writeFile(outputPath, Buffer.from(data, "base64"));
}

export async function captureScreenshotData(session: BrowserSession): Promise<string> {
  const result = await session.cdp.send<CaptureScreenshotResult>("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  }, session.sessionId);
  return result.data;
}

export async function captureFrameData(
  session: BrowserSession,
  capture: ScreencastCaptureSize | null = session.screencast.capture,
): Promise<{
  data: string;
  backend: CaptureBackend;
}> {
  if (configuredCaptureBackend() !== "screencast") {
    return {
      data: await captureScreenshotData(session),
      backend: "screenshot",
    };
  }

  await ensureScreencast(session, capture);
  if (hasFreshScreencastFrame(session)) {
    return {
      data: session.screencast.latestData as string,
      backend: "screencast",
    };
  }

  try {
    return {
      data: await waitForFreshScreencastFrame(session, FRESH_SCREENCAST_FRAME_TIMEOUT_MS),
      backend: "screencast",
    };
  } catch {
    return {
      data: await captureScreenshotData(session),
      backend: "screenshot",
    };
  }
}

export async function startScreencast(
  session: BrowserSession,
  capture: ScreencastCaptureSize | null = null,
): Promise<boolean> {
  return await ensureScreencast(session, capture);
}

export async function stopScreencast(session: BrowserSession): Promise<void> {
  await stopActiveScreencast(session, true);
}

export function onScreencastFrame(
  session: BrowserSession,
  listener: ScreencastFrameListener,
): () => void {
  session.screencast.listeners.add(listener);
  return () => {
    session.screencast.listeners.delete(listener);
  };
}

// Lets a downstream frame consumer (e.g. the daemon's pane-graphics stream)
// hold Chrome's next screencast ack while it's saturated, so Chrome doesn't
// pay for encoding frames that would just be coalesced away. Pass null to
// detach, e.g. when that consumer stops or tears down.
export function setScreencastCapacityGate(
  session: BrowserSession,
  gate: ScreencastCapacityGate | null,
): void {
  session.screencast.ackPacer.setCapacityGate(gate);
}

export async function setViewport(
  session: BrowserSession,
  viewport: BrowserViewport,
): Promise<void> {
  boostScreencast(session);
  session.viewport = viewport;
  await applyViewport(session, session.sessionId, viewport);
  invalidateScreencast(session);
}

export async function clickMouse(
  session: BrowserSession,
  click: BrowserMouseClick,
): Promise<void> {
  boostScreencast(session);
  const x = Math.max(0, Math.floor(click.x));
  const y = Math.max(0, Math.floor(click.y));
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  }, session.sessionId, 1_000);
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  }, session.sessionId, 1_000);
  invalidateScreencast(session);
}

export async function moveMouse(
  session: BrowserSession,
  move: BrowserMouseMove,
): Promise<void> {
  boostScreencast(session);
  const x = Math.max(0, Math.floor(move.x));
  const y = Math.max(0, Math.floor(move.y));
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  }, session.sessionId, 1_000);
}

export async function nativeSelectAtPoint(
  session: BrowserSession,
  point: BrowserMouseClick,
): Promise<BrowserNativeSelectHit> {
  const x = Math.max(0, Math.floor(point.x));
  const y = Math.max(0, Math.floor(point.y));
  const value = await evaluate(session, `(() => {
    const element = document.elementFromPoint(${x}, ${y});
    if (!(element instanceof Element)) return { nativeSelect: false };
    const select = element.closest("select");
    return {
      nativeSelect: Boolean(
        select &&
        select instanceof HTMLSelectElement &&
        select.matches(":enabled") &&
        !select.multiple &&
        select.size <= 1 &&
        select.getClientRects().length > 0
      )
    };
  })()`);
  if (typeof value === "object" && value !== null && typeof (value as BrowserNativeSelectHit).nativeSelect === "boolean") {
    return {
      nativeSelect: (value as BrowserNativeSelectHit).nativeSelect,
    };
  }
  return { nativeSelect: false };
}

export async function wheelMouse(
  session: BrowserSession,
  wheel: BrowserMouseWheel,
): Promise<void> {
  boostScreencast(session);
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: Math.max(0, Math.floor(wheel.x)),
    y: Math.max(0, Math.floor(wheel.y)),
    deltaX: wheel.deltaX,
    deltaY: wheel.deltaY,
  }, session.sessionId, 1_000);
  invalidateScreencast(session);
}

export async function sendKeyboardInput(
  session: BrowserSession,
  input: BrowserKeyboardInput,
): Promise<void> {
  boostScreencast(session);
  if (input.kind === "text") {
    await session.cdp.send("Input.insertText", {
      text: input.text,
    }, session.sessionId, 1_000);
    invalidateScreencast(session);
    return;
  }

  const definition = keyDefinition(input.key);
  await session.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...definition,
  }, session.sessionId, 1_000);
  await session.cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...definition,
  }, session.sessionId, 1_000);
  invalidateScreencast(session);
}

export async function pageText(session: BrowserSession): Promise<string> {
  const value = await evaluate(session, "document.body ? document.body.innerText : ''");
  return typeof value === "string" ? value : "";
}

export function consoleEntries(session: BrowserSession): ConsoleEntry[] {
  return [...session.consoleEntries];
}

export async function selectorClick(
  session: BrowserSession,
  selector: string,
): Promise<SelectorPoint> {
  const point = await selectorCenter(session, selector);
  await clickMouse(session, point);
  return point;
}

export async function selectorType(
  session: BrowserSession,
  selector: string,
  text: string,
): Promise<void> {
  await focusSelector(session, selector);
  await sendKeyboardInput(session, { kind: "text", text });
}

export async function selectorPress(
  session: BrowserSession,
  selector: string | null,
  key: BrowserKey,
): Promise<void> {
  if (selector) {
    await focusSelector(session, selector);
  }
  await sendKeyboardInput(session, { kind: "key", key });
}

export async function waitForExpression(
  session: BrowserSession,
  expression: string,
  timeoutMs: number,
): Promise<unknown> {
  const started = Date.now();
  let lastValue: unknown = null;
  while (Date.now() - started < timeoutMs) {
    lastValue = await evaluate(session, expression);
    if (lastValue) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for expression: ${expression}; last value: ${JSON.stringify(lastValue)}`);
}

// Reads the active tab's title/url from locally cached target info instead of
// asking Chrome for it. `tab.info` is kept current by the runtime's
// Target.targetInfoChanged listener, so this is safe for hot polling paths
// (e.g. /status) that must not pay for a Page.getNavigationHistory +
// Runtime.evaluate round trip on every tick.
export function cachedPageInfo(session: BrowserSession): { url: string; title: string } {
  const tab = session.tabs.get(session.targetId);
  return {
    url: tab?.info.url ?? "",
    title: tab?.info.title ?? "",
  };
}

// Same trade-off as cachedPageInfo: reads locally tracked tab state instead
// of listTabs' Chrome /json/list fetch.
export function cachedTabs(session: BrowserSession): BrowserTabInfo[] {
  return [...session.tabs.values()].map((tab) => tabInfo(session, tab));
}

export async function currentPageInfo(session: BrowserSession): Promise<{
  url: string;
  title: string;
}> {
  if (!session.sessionId) {
    return {
      url: "",
      title: "",
    };
  }
  try {
    const history = await session.cdp.send<GetNavigationHistoryResult>(
      "Page.getNavigationHistory",
      {},
      session.sessionId,
      1_000,
    );
    const current = history.entries[history.currentIndex];
    if (current) {
      return {
        url: current.url,
        title: await pageTitle(session),
      };
    }
  } catch (error) {
    if (!isTimeoutError(error)) {
      throw error;
    }
    return {
      url: "",
      title: await pageTitle(session),
    };
  }
  return {
    url: "",
    title: await pageTitle(session),
  };
}

export async function automationDescriptor(
  session: BrowserSession,
  endpoints: BrowserAutomationEndpoints,
): Promise<BrowserAutomationDescriptor> {
  const info = await currentPageInfo(session);
  const cdpHttpUrl = endpoints.cdpHttpUrl;
  const viewport = await currentViewport(session);

  return {
    contract_version: 1,
    view_id: session.id,
    cdp_scope: "view",
    tab_authority: "external-cdp",
    cdp_http_url: cdpHttpUrl,
    browser_ws_url: endpoints.browserWebSocketUrl,
    active_target_id: session.targetId,
    active_page_ws_url: session.targetId
      ? endpoints.pageWebSocketUrl(session.targetId)
      : null,
    url: info.url,
    title: info.title,
    chrome_pid: session.chrome.ownership === "owned"
      ? (session.chrome.child.pid ?? null)
      : null,
    chrome_executable: session.chrome.executable,
    chrome_profile_dir: session.chrome.profileDir ?? "",
    viewport,
    snippets: {
      playwright_mcp: `npx @playwright/mcp@latest --cdp-endpoint=${cdpHttpUrl}`,
      browser_use_env: `BU_CDP_URL=${cdpHttpUrl} browser-use`,
      playwright_connect_over_cdp: `const browser = await chromium.connectOverCDP(${JSON.stringify(cdpHttpUrl)});`,
      pinchtab_attach: `pinchtab bridge --cdp-attach ${cdpHttpUrl}`,
      chrome_devtools_mcp: `npx chrome-devtools-mcp --browser-url=${cdpHttpUrl}`,
    },
  };
}

async function navigateHistory(
  session: BrowserSession,
  direction: -1 | 1,
): Promise<BrowserNavigationResult> {
  const history = await navigationHistory(session);
  const next = history.entries[history.currentIndex + direction];
  if (!next) {
    const info = await currentPageInfo(session);
    return {
      navigated: false,
      timed_out: false,
      url: info.url,
      title: info.title,
    };
  }

  boostScreencast(session);
  const load = waitForLoadEvent(session);
  await session.cdp.send("Page.navigateToHistoryEntry", {
    entryId: next.id,
  }, session.sessionId);
  const loaded = await load;
  invalidateScreencast(session);
  const info = await currentPageInfo(session);
  return {
    navigated: true,
    timed_out: !loaded,
    url: info.url,
    title: info.title,
  };
}

async function navigationHistory(session: BrowserSession): Promise<GetNavigationHistoryResult> {
  return await session.cdp.send<GetNavigationHistoryResult>(
    "Page.getNavigationHistory",
    {},
    session.sessionId,
  );
}

async function waitForLoadEvent(session: BrowserSession): Promise<boolean> {
  try {
    await session.cdp.waitFor(
      `${session.sessionId}:Page.loadEventFired`,
      NAVIGATION_SETTLE_MS,
    );
    return true;
  } catch {
    return false;
  }
}

async function refreshTabInfos(session: BrowserSession): Promise<void> {
  let targets: CdpPageTarget[];
  try {
    targets = await fetchPageTargets(session);
  } catch {
    return;
  }
  for (const target of targets) {
    if (target.type !== "page") {
      continue;
    }
    const tab = session.tabs.get(target.id);
    if (tab) {
      tab.info = pageTargetToTargetInfo(target);
    }
  }
}

async function fetchPageTargets(session: BrowserSession): Promise<CdpPageTarget[]> {
  const response = await fetch(`${chromeCdpHttpUrl(session.chrome)}/json/list`);
  if (!response.ok) {
    return [];
  }
  return await response.json() as CdpPageTarget[];
}

function pageTargetToTargetInfo(target: CdpPageTarget): CdpTargetInfo {
  return {
    targetId: target.id,
    type: target.type,
    title: target.title,
    url: target.url,
  };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("timed out waiting");
}

function createScreencastState(): ScreencastState {
  return {
    started: false,
    capture: null,
    latestData: null,
    frameCount: 0,
    invalidatedFrameCount: 0,
    waiters: [],
    listeners: new Set(),
    ackPacer: new ScreencastAckPacer(),
  };
}

function boostScreencast(session: BrowserSession): void {
  session.screencast.ackPacer.boost();
}

function pushScreencastFrame(session: BrowserSession, frameData: string): void {
  const screencast = session.screencast;
  screencast.latestData = frameData;
  screencast.frameCount += 1;
  const waiters = screencast.waiters.splice(0);
  for (const resolve of waiters) {
    resolve(frameData);
  }
  for (const listener of screencast.listeners) {
    try {
      void Promise.resolve(listener(frameData)).catch(() => {});
    } catch {
      // Screencast delivery should not block Chrome frame acknowledgements.
    }
  }
}

async function ensureScreencast(
  session: BrowserSession,
  capture: ScreencastCaptureSize | null = session.screencast.capture,
): Promise<boolean> {
  if (session.screencast.started && sameScreencastCapture(session.screencast.capture, capture)) {
    return false;
  }
  if (session.screencast.started) {
    await stopActiveScreencast(session);
  }
  if (!session.sessionId) {
    throw new Error("no active browser tab");
  }
  const params: Record<string, unknown> = {
    format: "png",
    everyNthFrame: configuredScreencastEveryNthFrame(),
  };
  if (capture) {
    params.maxWidth = capture.maxWidth;
    params.maxHeight = capture.maxHeight;
  }
  await session.cdp.send("Page.startScreencast", params, session.sessionId);
  session.screencast.started = true;
  session.screencast.capture = capture;
  return true;
}

async function stopActiveScreencast(
  session: BrowserSession,
  clearCapture = false,
): Promise<void> {
  session.screencast.ackPacer.flush();
  if (!session.screencast.started || !session.sessionId) {
    resetScreencastFrames(session.screencast, clearCapture);
    return;
  }
  await session.cdp.send("Page.stopScreencast", {}, session.sessionId, 1_000).catch(() => {});
  session.screencast.ackPacer.flush();
  resetScreencastFrames(session.screencast, clearCapture);
}

function resetScreencastFrames(screencast: ScreencastState, clearCapture = false): void {
  screencast.started = false;
  if (clearCapture) {
    screencast.capture = null;
  }
  screencast.latestData = null;
  screencast.frameCount = 0;
  screencast.invalidatedFrameCount = 0;
  screencast.waiters.splice(0);
}

function sameScreencastCapture(
  left: ScreencastCaptureSize | null,
  right: ScreencastCaptureSize | null,
): boolean {
  return (
    left === right ||
    Boolean(
      left &&
      right &&
      left.maxWidth === right.maxWidth &&
      left.maxHeight === right.maxHeight,
    )
  );
}

function invalidateScreencast(session: BrowserSession): void {
  session.screencast.invalidatedFrameCount = session.screencast.frameCount;
}

function hasFreshScreencastFrame(session: BrowserSession): boolean {
  return Boolean(
    session.screencast.latestData &&
    session.screencast.frameCount > session.screencast.invalidatedFrameCount,
  );
}

async function waitForFreshScreencastFrame(session: BrowserSession, timeoutMs: number): Promise<string> {
  if (hasFreshScreencastFrame(session)) {
    return session.screencast.latestData as string;
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeWaiter();
      reject(new Error("timed out waiting for screencast frame"));
    }, timeoutMs);
    const waiter = (data: string) => {
      if (!hasFreshScreencastFrame(session)) {
        return;
      }
      clearTimeout(timer);
      removeWaiter();
      resolve(data);
    };
    const removeWaiter = () => {
      const index = session.screencast.waiters.indexOf(waiter);
      if (index !== -1) {
        session.screencast.waiters.splice(index, 1);
      }
    };
    session.screencast.waiters.push(waiter);
  });
}

async function activateTab(session: BrowserSession, targetId: string): Promise<void> {
  const tab = session.tabs.get(targetId);
  if (!tab) {
    throw new Error(`tab not found: ${targetId}`);
  }
  if (session.targetId === tab.targetId && session.sessionId === tab.sessionId) {
    return;
  }

  await stopActiveScreencast(session);
  session.targetId = tab.targetId;
  session.sessionId = tab.sessionId;
  await session.cdp.send("Page.bringToFront", {}, tab.sessionId, 1_000).catch(() => {});
  if (session.viewport) {
    await applyViewport(session, tab.sessionId, session.viewport).catch(() => {});
  }
  boostScreencast(session);
  if (session.screencast.listeners.size > 0) {
    await ensureScreencast(session).catch(() => {});
  }
}

async function removeTab(session: BrowserSession, targetId: string): Promise<void> {
  const tab = session.tabs.get(targetId);
  if (!tab) {
    return;
  }
  cleanupTab(tab);
  session.tabs.delete(targetId);
  if (session.targetId !== targetId) {
    return;
  }
  await stopActiveScreencast(session);
  session.targetId = "";
  session.sessionId = "";
  const next = session.tabs.values().next().value;
  if (next) {
    await activateTab(session, next.targetId).catch(() => {});
  } else if (!session.closed) {
    await createTab(session).catch(() => {});
  }
}

function cleanupTab(tab: BrowserTab): void {
  for (const unsubscribe of tab.unsubscribers) {
    unsubscribe();
  }
  tab.unsubscribers = [];
}

async function applyViewport(
  session: BrowserSession,
  sessionId: string,
  viewport: BrowserViewport,
): Promise<void> {
  if (!sessionId) {
    return;
  }
  await session.cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    mobile: false,
  }, sessionId, 3_000);
  if (viewport.pageScaleFactor !== undefined) {
    await applyPageScale(session, sessionId, viewport.pageScaleFactor);
  }
}

async function applyPageScale(
  session: BrowserSession,
  sessionId: string,
  pageScaleFactor: number,
): Promise<void> {
  await session.cdp.send("Emulation.setPageScaleFactor", {
    pageScaleFactor,
  }, sessionId, 3_000);
}

function tabInfo(session: BrowserSession, tab: BrowserTab): BrowserTabInfo {
  return {
    targetId: tab.targetId,
    title: tab.info.title ?? "",
    url: tab.info.url ?? "",
    active: session.targetId === tab.targetId,
  };
}

function targetInfoFromEvent(params: unknown): CdpTargetInfo | null {
  const targetInfo = (params as TargetEventParams | null)?.targetInfo;
  if (typeof targetInfo !== "object" || targetInfo === null) {
    return null;
  }
  return normalizedTargetInfo(targetInfo as Partial<CdpTargetInfo>);
}

function targetIdFromEvent(params: unknown): string | null {
  const targetId = (params as TargetEventParams | null)?.targetId;
  return typeof targetId === "string" ? targetId : null;
}

function normalizedTargetInfo(value: Partial<CdpTargetInfo>): CdpTargetInfo {
  return {
    targetId: typeof value.targetId === "string" ? value.targetId : "",
    type: typeof value.type === "string" ? value.type : "",
    title: typeof value.title === "string" ? value.title : "",
    url: typeof value.url === "string" ? value.url : "",
    attached: typeof value.attached === "boolean" ? value.attached : undefined,
    openerId: typeof value.openerId === "string" ? value.openerId : undefined,
  };
}

function isPageTargetInfo(value: CdpTargetInfo): boolean {
  return typeof value.targetId === "string" && value.targetId.length > 0 && value.type === "page";
}

function isTargetGoneError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /No target with given id|Target closed|Session closed|Cannot find context/i.test(error.message);
}

async function currentViewport(session: BrowserSession): Promise<BrowserViewport | null> {
  const value = await evaluate(
    session,
    "({ width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio })",
    1_000,
  );
  if (
    typeof value === "object" &&
    value !== null &&
    Number.isFinite((value as { width?: unknown }).width) &&
    Number.isFinite((value as { height?: unknown }).height) &&
    Number.isFinite((value as { deviceScaleFactor?: unknown }).deviceScaleFactor)
  ) {
    return {
      width: Math.max(1, Math.floor((value as { width: number }).width)),
      height: Math.max(1, Math.floor((value as { height: number }).height)),
      deviceScaleFactor: Math.max(0.1, (value as { deviceScaleFactor: number }).deviceScaleFactor),
    };
  }
  return null;
}

async function selectorCenter(
  session: BrowserSession,
  selector: string,
): Promise<SelectorPoint> {
  const selectorLiteral = JSON.stringify(selector);
  const value = await evaluate(session, `(() => {
    const selector = ${selectorLiteral};
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error("selector not found: " + selector);
    }
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!isSelectorPoint(value)) {
    throw new Error(`selector did not produce coordinates: ${selector}`);
  }
  return value;
}

async function focusSelector(
  session: BrowserSession,
  selector: string,
): Promise<void> {
  const selectorLiteral = JSON.stringify(selector);
  await evaluate(session, `(() => {
    const selector = ${selectorLiteral};
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error("selector not found: " + selector);
    }
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();
    if (
      "setSelectionRange" in element &&
      typeof element.value === "string" &&
      typeof element.setSelectionRange === "function"
    ) {
      element.setSelectionRange(element.value.length, element.value.length);
    }
    return true;
  })()`);
}

function isSelectorPoint(value: unknown): value is SelectorPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { x?: unknown }).x === "number" &&
    typeof (value as { y?: unknown }).y === "number" &&
    Number.isFinite((value as { x: number }).x) &&
    Number.isFinite((value as { y: number }).y)
  );
}

function keyDefinition(key: BrowserKey): {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
} {
  const definition = KEY_DEFINITIONS[key];
  return {
    key,
    code: definition.code,
    windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
    nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
  };
}
