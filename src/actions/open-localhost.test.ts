import { expect, test } from "bun:test";

import { normalizeConfig } from "../config";
import { runOpenLocalhost } from "./open-localhost";

test("open-localhost passes browser config to the new pane", async () => {
  let paneConfig: ReturnType<typeof normalizeConfig> | null = null;
  await runOpenLocalhost("http://127.0.0.1:49731/benchmark", {
      loadConfig: async () => normalizeConfig({
        captureBackend: "screencast",
        screencastEveryNthFrame: 2,
        profileRoot: "/tmp/browser-profiles",
      }),
      createView: async () => ({ ok: true, viewId: "view-1" }),
      status: async () => ({
        ok: true,
        pid: 1,
        chrome_pid: 2,
        chrome_executable: "/usr/bin/chromium",
        chrome_cdp_port: 3,
        url: "http://127.0.0.1:49731/benchmark",
        title: "benchmark",
        captureBackend: "screencast",
        tabs: [],
        mode: "default" as const,
        capabilities: {
          modes: ["default", "observe_mirror"] as const,
          observe_mirror: {
            env: {
              mode: "HERDR_BROWSER_MODE" as const,
              target_state: "HERDR_BROWSER_TARGET_STATE" as const,
              cdp_url: "HERDR_BROWSER_CDP_URL" as const,
            },
            read_only: true as const,
            mutates_viewport: false as const,
            creates_targets: false as const,
            closes_targets: false as const,
          },
          target_state_schema_version: 1 as const,
        },
      }),
      openBrowserPane: (config) => {
        paneConfig = config;
        return { attempted: true, ok: true };
      },
      closeView: async () => {},
  });

  expect(paneConfig).toMatchObject({
    screencastEveryNthFrame: 2,
    profileRoot: "/tmp/browser-profiles",
  });
});
