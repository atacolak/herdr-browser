import { expect, test } from "bun:test";

import { chromeProfileDir, daemonStateFile } from "./paths";

test("daemonStateFile honors explicit override", () => {
  expect(daemonStateFile({
    HERDR_BROWSER_DAEMON_STATE: "/tmp/custom-daemon.json",
    HERDR_PLUGIN_STATE_DIR: "/tmp/plugin-state",
    HERDR_SESSION: "browser-2",
  })).toBe("/tmp/custom-daemon.json");
});

test("daemonStateFile scopes plugin daemon state by Herdr session", () => {
  expect(daemonStateFile({
    HERDR_PLUGIN_STATE_DIR: "/tmp/plugin-state",
    HERDR_SESSION: "browser-2",
  })).toBe("/tmp/plugin-state/daemon-browser-2-3310469cdfea.json");
});

test("daemonStateFile sanitizes Herdr session names for filenames", () => {
  expect(daemonStateFile({
    HERDR_PLUGIN_STATE_DIR: "/tmp/plugin-state",
    HERDR_SESSION: "local/dev session",
  })).toBe("/tmp/plugin-state/daemon-local_dev_session-5bc4d7893473.json");
});

test("daemonStateFile keeps legacy plugin path when session is unknown", () => {
  expect(daemonStateFile({
    HERDR_PLUGIN_STATE_DIR: "/tmp/plugin-state",
  })).toBe("/tmp/plugin-state/daemon.json");
});

test("standalone daemon state remains isolated by session outside the installed tree", () => {
  const first = daemonStateFile({
    XDG_STATE_HOME: "/tmp/user-state",
    HERDR_SESSION: "session/one",
  });
  const second = daemonStateFile({
    XDG_STATE_HOME: "/tmp/user-state",
    HERDR_SESSION: "session_one",
  });

  expect(first.startsWith("/tmp/user-state/herdr-browser/")).toBe(true);
  expect(second.startsWith("/tmp/user-state/herdr-browser/")).toBe(true);
  expect(first).not.toBe(second);
});

test("agent invocation inside Herdr finds the managed plugin state", () => {
  const env = {
    XDG_STATE_HOME: "/tmp/user-state",
    HERDR_ENV: "1",
    HERDR_SESSION: "browser-2",
  };

  expect(daemonStateFile(env)).toBe(
    "/tmp/user-state/herdr/plugins/official.browser/daemon-browser-2-3310469cdfea.json",
  );
  expect(chromeProfileDir(env)).toBe(
    "/tmp/user-state/herdr/plugins/official.browser/chrome-profiles/browser-2-3310469cdfea",
  );
});

test("chromeProfileDir persists profiles per Herdr session", () => {
  expect(chromeProfileDir({
    HERDR_PLUGIN_STATE_DIR: "/tmp/plugin-state",
    HERDR_SESSION: "local/dev session",
  })).toBe("/tmp/plugin-state/chrome-profiles/local_dev_session-5bc4d7893473");
});

test("chromeProfileDir appends the session to a configured root", () => {
  expect(chromeProfileDir({
    HERDR_BROWSER_PROFILE_ROOT: "/tmp/custom-profiles",
    HERDR_SESSION: "browser-2",
  })).toBe("/tmp/custom-profiles/browser-2-3310469cdfea");
});

test("session path components cannot traverse or alias", () => {
  const root = "/tmp/plugin-state/chrome-profiles/";
  const traversal = chromeProfileDir({
    HERDR_PLUGIN_STATE_DIR: "/tmp/plugin-state",
    HERDR_SESSION: "..",
  });
  const slash = chromeProfileDir({
    HERDR_PLUGIN_STATE_DIR: "/tmp/plugin-state",
    HERDR_SESSION: "local/dev",
  });
  const underscore = chromeProfileDir({
    HERDR_PLUGIN_STATE_DIR: "/tmp/plugin-state",
    HERDR_SESSION: "local_dev",
  });

  expect(traversal.startsWith(root)).toBe(true);
  expect(traversal).not.toBe("/tmp/plugin-state");
  expect(slash).not.toBe(underscore);
});

test("external CDP ports get distinct daemon state namespaces within one session", () => {
  const base = {
    HERDR_PLUGIN_STATE_DIR: "/tmp/plugin-state",
    HERDR_SESSION: "browser-2",
  };
  const owned = daemonStateFile(base);
  const portA = daemonStateFile({
    ...base,
    HERDR_BROWSER_CDP_URL: "http://127.0.0.1:9222",
  });
  const portB = daemonStateFile({
    ...base,
    HERDR_BROWSER_CDP_URL: "http://127.0.0.1:9333",
  });
  const portATrailing = daemonStateFile({
    ...base,
    HERDR_BROWSER_CDP_URL: "http://localhost:9222/",
  });

  expect(owned).toBe("/tmp/plugin-state/daemon-browser-2-3310469cdfea.json");
  expect(portA).not.toBe(owned);
  expect(portB).not.toBe(owned);
  expect(portA).not.toBe(portB);
  expect(portA).toBe(portATrailing);
  expect(portA.startsWith("/tmp/plugin-state/daemon-")).toBe(true);
  expect(portA.endsWith(".json")).toBe(true);
});

test("external CDP does not alter chrome profile path", () => {
  const base = {
    HERDR_PLUGIN_STATE_DIR: "/tmp/plugin-state",
    HERDR_SESSION: "browser-2",
  };
  const owned = chromeProfileDir(base);
  const external = chromeProfileDir({
    ...base,
    HERDR_BROWSER_CDP_URL: "http://127.0.0.1:9222",
  });
  expect(owned).toBe(
    "/tmp/plugin-state/chrome-profiles/browser-2-3310469cdfea",
  );
  expect(external).toBe(owned);
});
