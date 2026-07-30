import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyBrowserConfigEnv, normalizeConfig, saveBrowserZoom } from "./config";

test("normalizeConfig returns defaults for invalid config", () => {
  expect(normalizeConfig(null)).toEqual({
    linkOpenPlacement: "split",
    splitDirection: "right",
    focusOnOpen: true,
    showDiagnostics: false,
    browserZoom: 1,
    captureBackend: "screenshot",
    captureScale: 1,
    screencastEveryNthFrame: 1,
    screencastPollMs: 250,
    profileRoot: null,
    cdpUrl: null,
    browserMode: "default",
    targetStatePath: null,
  });
});

test("normalizeConfig accepts supported pane options", () => {
  expect(normalizeConfig({
    linkOpenPlacement: "overlay",
    splitDirection: "down",
    focusOnOpen: false,
    showDiagnostics: true,
    browserZoom: 1.5,
    captureBackend: "screencast",
    captureScale: 0.5,
    screencastEveryNthFrame: 2,
    screencastPollMs: 500,
    profileRoot: "/tmp/herdr-browser-profiles",
    cdpUrl: "http://127.0.0.1:9222/",
    browserMode: "observe_mirror",
    targetStatePath: "/tmp/active-target.json",
  })).toEqual({
    linkOpenPlacement: "overlay",
    splitDirection: "down",
    focusOnOpen: false,
    showDiagnostics: true,
    browserZoom: 1.5,
    captureBackend: "screencast",
    captureScale: 0.5,
    screencastEveryNthFrame: 2,
    screencastPollMs: 500,
    profileRoot: "/tmp/herdr-browser-profiles",
    cdpUrl: "http://127.0.0.1:9222",
    browserMode: "observe_mirror",
    targetStatePath: "/tmp/active-target.json",
  });
});

test("normalizeConfig ignores unsupported pane options", () => {
  expect(normalizeConfig({
    linkOpenPlacement: "left",
    splitDirection: "up",
    browserZoom: 4,
    captureBackend: "window-capture",
    captureScale: 0.05,
    screencastEveryNthFrame: 3,
    screencastPollMs: 10,
    profileRoot: "  ",
    cdpUrl: "  ",
  })).toEqual({
    linkOpenPlacement: "split",
    splitDirection: "right",
    focusOnOpen: true,
    showDiagnostics: false,
    browserZoom: 1,
    captureBackend: "screenshot",
    captureScale: 1,
    screencastEveryNthFrame: 1,
    screencastPollMs: 250,
    profileRoot: null,
    cdpUrl: null,
    browserMode: "default",
    targetStatePath: null,
  });
});

test("applyBrowserConfigEnv sets daemon configuration before startup", () => {
  const env: NodeJS.ProcessEnv = {};
  applyBrowserConfigEnv(normalizeConfig({
    captureBackend: "screencast",
    captureScale: 0.75,
    browserZoom: 1.5,
    screencastEveryNthFrame: 2,
    profileRoot: "/tmp/herdr-browser-profiles",
    cdpUrl: "http://127.0.0.1:9333",
    browserMode: "observe_mirror",
    targetStatePath: "/tmp/controller/active-target.json",
  }), env);

  expect(env).toMatchObject({
    HERDR_BROWSER_CAPTURE_BACKEND: "screencast",
    HERDR_BROWSER_CAPTURE_SCALE: "0.75",
    HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME: "2",
    HERDR_BROWSER_SCREENCAST_POLL_MS: "250",
    HERDR_BROWSER_PROFILE_ROOT: "/tmp/herdr-browser-profiles",
    HERDR_BROWSER_CDP_URL: "http://127.0.0.1:9333",
    HERDR_BROWSER_MODE: "observe_mirror",
    HERDR_BROWSER_TARGET_STATE: "/tmp/controller/active-target.json",
  });
});

test("applyBrowserConfigEnv keeps an explicit HERDR_BROWSER_CDP_URL over config", () => {
  const env: NodeJS.ProcessEnv = {
    HERDR_BROWSER_CDP_URL: "http://127.0.0.1:9444/",
  };
  applyBrowserConfigEnv(normalizeConfig({
    cdpUrl: "http://127.0.0.1:9333",
  }), env);
  expect(env.HERDR_BROWSER_CDP_URL).toBe("http://127.0.0.1:9444");
});

test("normalizeConfig accepts previous scaling fields as browser zoom", () => {
  expect(normalizeConfig({ uiScale: 1.35 }).browserZoom).toBe(1.35);
  expect(normalizeConfig({ deviceScaleFactor: 1.5 }).browserZoom).toBe(1.5);
});

test("saveBrowserZoom preserves config and migrates previous scaling fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-browser-config-"));
  const path = join(directory, "browser.json");
  writeFileSync(path, JSON.stringify({
    linkOpenPlacement: "overlay",
    uiScale: 1.35,
    deviceScaleFactor: 1.5,
  }));

  await saveBrowserZoom(1.4, { HERDR_BROWSER_CONFIG: path });

  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    linkOpenPlacement: "overlay",
    browserZoom: 1.4,
  });
});

test("saveBrowserZoom preserves rapid update order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-browser-config-"));
  const path = join(directory, "browser.json");
  const env = { HERDR_BROWSER_CONFIG: path };

  await Promise.all([
    saveBrowserZoom(1.1, env),
    saveBrowserZoom(1.2, env),
  ]);

  expect(JSON.parse(readFileSync(path, "utf8")).browserZoom).toBe(1.2);
});
