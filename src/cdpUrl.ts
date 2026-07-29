/**
 * Strict canonical form for external CDP HTTP endpoints.
 * - http only (Chrome remote debugging is plain HTTP; https is rejected)
 * - no credentials
 * - loopback host only (127.0.0.1, localhost, [::1])
 * - localhost → 127.0.0.1 for stable equivalence
 * - path/query/hash stripped (discovery is always /json/version)
 * - explicit port always emitted so default-port forms compare equal
 */
export function normalizeCdpHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`invalid HERDR_BROWSER_CDP_URL: ${value}`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error(
      `HERDR_BROWSER_CDP_URL must be an http:// loopback endpoint, got ${parsed.protocol}`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("HERDR_BROWSER_CDP_URL must not include credentials");
  }
  const host = canonicalizeLoopbackHost(parsed.hostname);
  const port = parsed.port || "80";
  return `http://${host}:${port}`;
}

/** Read and strictly normalize HERDR_BROWSER_CDP_URL, or null when unset. */
export function configuredBrowserCdpUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.HERDR_BROWSER_CDP_URL?.trim();
  if (!raw) {
    return null;
  }
  return normalizeCdpHttpUrl(raw);
}

function canonicalizeLoopbackHost(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1") {
    return "127.0.0.1";
  }
  if (host === "::1") {
    return "[::1]";
  }
  throw new Error(
    `HERDR_BROWSER_CDP_URL must target loopback (127.0.0.1, localhost, or [::1]), got ${hostname}`,
  );
}
