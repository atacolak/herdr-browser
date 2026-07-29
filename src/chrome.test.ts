import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  chromeCdpHttpUrl,
  configuredBrowserCdpUrl,
  connectExternalChrome,
  externalBrowserWebSocketUrl,
  hasChromeExited,
  normalizeCdpHttpUrl,
  resolveChrome,
  type ChromeInstance,
} from "./chrome";

const originalCdpUrl = process.env.HERDR_BROWSER_CDP_URL;

afterEach(() => {
  if (originalCdpUrl === undefined) {
    delete process.env.HERDR_BROWSER_CDP_URL;
  } else {
    process.env.HERDR_BROWSER_CDP_URL = originalCdpUrl;
  }
});

test("signal-terminated Chrome is already exited", () => {
  expect(hasChromeExited({ exitCode: null, signalCode: "SIGTERM" })).toBe(true);
  expect(hasChromeExited({ exitCode: 0, signalCode: null })).toBe(true);
  expect(hasChromeExited({ exitCode: null, signalCode: null })).toBe(false);
});

test("configuredBrowserCdpUrl trims and normalizes strictly", () => {
  expect(configuredBrowserCdpUrl({})).toBeNull();
  expect(configuredBrowserCdpUrl({ HERDR_BROWSER_CDP_URL: "  " })).toBeNull();
  expect(configuredBrowserCdpUrl({
    HERDR_BROWSER_CDP_URL: " http://127.0.0.1:9222/ ",
  })).toBe("http://127.0.0.1:9222");
  expect(configuredBrowserCdpUrl({
    HERDR_BROWSER_CDP_URL: "http://localhost:9222/json/version",
  })).toBe("http://127.0.0.1:9222");
});

test("normalizeCdpHttpUrl enforces equivalence and rejects unsafe endpoints", () => {
  expect(normalizeCdpHttpUrl("http://127.0.0.1:9222/json/version")).toBe(
    "http://127.0.0.1:9222",
  );
  expect(normalizeCdpHttpUrl("http://localhost:9222/")).toBe("http://127.0.0.1:9222");
  expect(normalizeCdpHttpUrl("http://[::1]:9222")).toBe("http://[::1]:9222");
  expect(normalizeCdpHttpUrl("http://127.0.0.1:9222/?x=1#y")).toBe("http://127.0.0.1:9222");
  // Default ports become explicit so forms compare equal.
  expect(normalizeCdpHttpUrl("http://127.0.0.1")).toBe("http://127.0.0.1:80");

  // CDP remote debugging is plain HTTP; https/ws are rejected.
  expect(() => normalizeCdpHttpUrl("https://127.0.0.1:9222")).toThrow(/http:\/\//);
  expect(() => normalizeCdpHttpUrl("ws://127.0.0.1:9222")).toThrow(/http:\/\//);
  expect(() => normalizeCdpHttpUrl("not a url")).toThrow(/invalid/);
  expect(() => normalizeCdpHttpUrl("http://user:pass@127.0.0.1:9222")).toThrow(/credentials/);
  expect(() => normalizeCdpHttpUrl("http://192.168.1.10:9222")).toThrow(/loopback/);
  expect(() => normalizeCdpHttpUrl("http://example.com:9222")).toThrow(/loopback/);
  expect(() => normalizeCdpHttpUrl("http://0.0.0.0:9222")).toThrow(/loopback/);
});

test("externalBrowserWebSocketUrl keeps configured authority and Chrome browser path", () => {
  expect(externalBrowserWebSocketUrl(
    "http://127.0.0.1:9222",
    "ws://10.43.8.12:9222/devtools/browser/abc?untrusted=one",
  )).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
  expect(externalBrowserWebSocketUrl(
    "http://[::1]:9333",
    "ws://localhost:9/devtools/browser/xyz",
  )).toBe("ws://[::1]:9333/devtools/browser/xyz");

  expect(() => externalBrowserWebSocketUrl(
    "http://127.0.0.1:9222",
    "not a url",
  )).toThrow(/invalid webSocketDebuggerUrl/);
  expect(() => externalBrowserWebSocketUrl(
    "http://127.0.0.1:9222",
    "http://127.0.0.1:9222/devtools/browser/abc",
  )).toThrow(/non-WebSocket/);
  expect(() => externalBrowserWebSocketUrl(
    "http://127.0.0.1:9222",
    "ws://127.0.0.1:9222/devtools/page/abc",
  )).toThrow(/browser WebSocket path/);
});

test("chromeCdpHttpUrl preserves external base and reconstructs owned localhost", () => {
  const owned = {
    ownership: "owned",
    port: 9333,
  } as ChromeInstance;
  expect(chromeCdpHttpUrl(owned)).toBe("http://127.0.0.1:9333");

  const externalV4 = {
    ownership: "external",
    port: 9222,
    cdpUrl: "http://127.0.0.1:9222",
  } as ChromeInstance;
  expect(chromeCdpHttpUrl(externalV4)).toBe("http://127.0.0.1:9222");

  // [::1] must not be rewritten to 127.0.0.1 when used as an upstream base.
  const externalV6 = {
    ownership: "external",
    port: 9222,
    cdpUrl: "http://[::1]:9222",
  } as ChromeInstance;
  expect(chromeCdpHttpUrl(externalV6)).toBe("http://[::1]:9222");
});

describe("external CDP attach", () => {
  test("connectExternalChrome fetches /json/version and never kills on close", async () => {
    const server = await startFakeCdpServer({
      webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/browser/fake",
      Browser: "FakeChrome/1.0",
    });
    try {
      const chrome = await connectExternalChrome(server.baseUrl);
      expect(chrome.ownership).toBe("external");
      if (chrome.ownership !== "external") {
        throw new Error("expected external ownership");
      }
      expect(chrome.port).toBe(server.port);
      expect(chrome.cdpUrl).toBe(server.baseUrl);
      expect(chrome.browserWebSocketUrl).toBe(
        `ws://127.0.0.1:${server.port}/devtools/browser/fake`,
      );
      expect(chrome.executable).toBe("FakeChrome/1.0");
      expect(chrome.child).toBeNull();
      expect(chrome.profileDir).toBeNull();
      expect(chrome.recentStderr()).toBe("");

      await chrome.close();
      const stillUp = await fetch(`${server.baseUrl}/json/version`);
      expect(stillUp.ok).toBe(true);
      expect(server.requestPaths).toContain("/json/version");
    } finally {
      await server.close();
    }
  });

  test("resolveChrome attaches externally when HERDR_BROWSER_CDP_URL is set", async () => {
    const server = await startFakeCdpServer({
      webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/browser/env",
      Browser: "EnvChrome/1.0",
    });
    try {
      process.env.HERDR_BROWSER_CDP_URL = `http://localhost:${server.port}/`;
      const chrome = await resolveChrome();
      expect(chrome.ownership).toBe("external");
      if (chrome.ownership !== "external") {
        throw new Error("expected external ownership");
      }
      expect(chrome.cdpUrl).toBe(server.baseUrl);
      expect(chrome.browserWebSocketUrl).toBe(
        `ws://127.0.0.1:${server.port}/devtools/browser/env`,
      );
      expect(chrome.child).toBeNull();
      await chrome.close();
      expect((await fetch(`${server.baseUrl}/json/version`)).ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("resolveChrome rejects non-loopback HERDR_BROWSER_CDP_URL before attach", async () => {
    process.env.HERDR_BROWSER_CDP_URL = "http://example.com:9222";
    await expect(resolveChrome()).rejects.toThrow(/loopback/);
  });
});

async function startFakeCdpServer(version: {
  webSocketDebuggerUrl: string;
  Browser: string;
}): Promise<{
  baseUrl: string;
  port: number;
  requestPaths: string[];
  close: () => Promise<void>;
}> {
  const requestPaths: string[] = [];
  const server = createServer((request, response) => {
    requestPaths.push(request.url ?? "");
    if (request.url === "/json/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(version));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requestPaths,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
