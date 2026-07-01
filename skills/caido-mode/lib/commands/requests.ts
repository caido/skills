/** HTTP History commands: search, recent, get, get-response, raw, export-curl */

import { getClient, resolveProxy } from "../client";
import { decodeRaw, formatHttpRaw, rawToCurl, splitRaw, CURL_MANAGED_HEADERS } from "../output";
import type { OutputOpts } from "../types";

/** Terse one-line-per-request rendering for fast, low-token browsing. */
function compactLine(r: { id: string; method: string; host: string; path: string; query?: string; statusCode?: number }) {
  const status = r.statusCode != null ? r.statusCode : "—";
  return `${r.id}\t${status}\t${r.method} ${r.host}${r.path}${r.query ? "?" + r.query : ""}`;
}

export async function cmdSearch(filter: string, limit: number, after?: string, idsOnly?: boolean, desc: boolean = true, compact?: boolean) {
  const client = await getClient();
  let builder = client.request.list().filter(filter).first(limit);
  // The SDK's list() defaults to ASCENDING by id (oldest first), so .first(limit)
  // would return the oldest N matches. We default to descending (newest first) —
  // the near-universal intent — so callers get the latest traffic without a
  // client-side sort (which, on a truncated result set, silently misses newer
  // requests beyond the limit). Pass desc=false (CLI --asc/--oldest) for oldest-first.
  if (desc) builder = builder.descending("req", "id");
  if (after) builder = builder.after(after);

  const connection = await builder;

  if (idsOnly) {
    const ids = connection.edges.map(e => e.node.request.id);
    console.log(JSON.stringify(ids));
    return;
  }

  const results = connection.edges.map(e => ({
    id: e.node.request.id,
    method: e.node.request.method,
    host: e.node.request.host,
    path: e.node.request.path,
    query: e.node.request.query || undefined,
    isTls: e.node.request.isTls,
    port: e.node.request.port,
    statusCode: e.node.response?.statusCode,
    roundtrip: e.node.response?.roundtripTime,
    responseLength: e.node.response?.length,
    createdAt: e.node.request.createdAt,
    cursor: e.cursor,
  }));

  if (compact) {
    for (const r of results) console.log(compactLine(r));
    console.log(`# ${results.length} result(s)${connection.pageInfo?.hasNextPage ? `, more available (--after ${connection.pageInfo.endCursor})` : ""}`);
    return;
  }

  console.log(JSON.stringify({
    results,
    pageInfo: connection.pageInfo,
    count: results.length,
  }, null, 2));
}

export async function cmdRecent(limit: number, compact?: boolean) {
  const client = await getClient();
  const connection = await client.request.list()
    .descending("req", "id")
    .first(limit);

  const results = connection.edges.map(e => ({
    id: e.node.request.id,
    method: e.node.request.method,
    host: e.node.request.host,
    path: e.node.request.path,
    query: e.node.request.query || undefined,
    statusCode: e.node.response?.statusCode,
    roundtrip: e.node.response?.roundtripTime,
    createdAt: e.node.request.createdAt,
  }));

  if (compact) {
    for (const r of results) console.log(compactLine(r));
    console.log(`# ${results.length} result(s)`);
    return;
  }

  console.log(JSON.stringify({ results, count: results.length }, null, 2));
}

export async function cmdGet(requestId: string, opts: OutputOpts) {
  const client = await getClient();
  const result = await client.request.get(requestId, { raw: true });

  if (!result) {
    console.error(`Request ${requestId} not found`);
    process.exit(1);
  }

  const output: Record<string, any> = {
    id: result.request.id,
    method: result.request.method,
    host: result.request.host,
    path: result.request.path,
    port: result.request.port,
    isTls: result.request.isTls,
    createdAt: result.request.createdAt,
  };

  if (!opts.noRequest && result.request.raw) {
    output.raw = formatHttpRaw(decodeRaw(result.request.raw), opts);
  }

  if (result.response) {
    output.response = {
      statusCode: result.response.statusCode,
      roundtrip: result.response.roundtripTime,
      length: result.response.length,
    };
    if (result.response.raw) {
      output.response.raw = formatHttpRaw(decodeRaw(result.response.raw), opts);
    }
  }

  console.log(JSON.stringify(output, null, 2));
}

export async function cmdGetResponse(requestId: string, opts: OutputOpts) {
  const client = await getClient();
  const result = await client.request.get(requestId, {
    requestRaw: false,
    responseRaw: true,
  });

  if (!result) {
    console.error(`Request ${requestId} not found`);
    process.exit(1);
  }

  if (!result.response) {
    console.log(JSON.stringify({ error: "No response for this request" }));
    return;
  }

  const output: Record<string, any> = {
    statusCode: result.response.statusCode,
    roundtrip: result.response.roundtripTime,
    length: result.response.length,
  };

  if (result.response.raw) {
    output.raw = formatHttpRaw(decodeRaw(result.response.raw), opts);
  }

  console.log(JSON.stringify(output, null, 2));
}

/**
 * raw — dump the byte-exact raw request (or response) for a history request.
 * Writes raw bytes (no JSON wrapper) so it can be piped/redirected into a file
 * for inspection or to seed a request body.
 */
export async function cmdRaw(requestId: string, opts: { out?: string; response?: boolean }) {
  const client = await getClient();
  const result = await client.request.get(requestId, { raw: true });

  if (!result) {
    console.error(`Request ${requestId} not found`);
    process.exit(1);
  }

  const bytes: Uint8Array | undefined = opts.response ? result.response?.raw : result.request.raw;
  if (!bytes || bytes.length === 0) {
    console.error(`No raw ${opts.response ? "response" : "request"} data for request ${requestId}`);
    process.exit(1);
  }

  const buf = Buffer.from(bytes);
  if (opts.out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(opts.out, buf);
    console.error(`Wrote ${buf.length} bytes to ${opts.out}`);
  } else {
    process.stdout.write(buf);
  }
}

export async function cmdExportCurl(requestId: string) {
  const client = await getClient();
  const result = await client.request.get(requestId, { raw: true });

  if (!result) {
    console.error(`Request ${requestId} not found`);
    process.exit(1);
  }

  const raw = decodeRaw(result.request.raw);
  if (!raw) {
    console.error("No raw data for this request");
    process.exit(1);
  }

  const curl = rawToCurl(raw, result.request.host, result.request.port, result.request.isTls);
  console.log(curl);
}

// ── export-curl --config : reusable curl config + cookie jar (INTERNAL testing) ──
// Pushes the big static auth blob into a `-K` config file + a cookie jar so the
// agent tests with `curl -K auth.cfg "$BASE/path"` instead of re-pasting cookies
// into every command (and re-holding them in context). User-facing commands must
// still be full/self-contained — see `export-curl`.

// Year 2038; keeps (session) cookies sendable across separate curl invocations.
const JAR_EXPIRY = 2147483647;

interface AuthConfigResult {
  configText: string;
  jarText?: string;       // only when a cookie jar is requested
  included: string[];
  cookieCount: number;
  cookieMode: "inline" | "jar" | "none";
  base: string;
}

/**
 * Headers that must NEVER go into a reusable config: per-request, volatile, or
 * curl-managed. Everything else is captured faithfully so app-specific auth
 * headers (X-CSRF, x-goog-ext-*, X-Client-Data, Origin, Referer, Sec-*, …) are
 * never silently dropped — an allowlist can't anticipate them.
 * = the curl-managed set, plus Content-Type (per-request; the agent passes it on
 * each POST/PUT — inlining it here would duplicate that header).
 */
const SKIP_HEADERS = new Set([...CURL_MANAGED_HEADERS, "content-type"]);

function parseRawHeaders(raw: string): Array<{ name: string; value: string }> {
  const { headerBlock } = splitRaw(raw);
  const lines = headerBlock.split(/\r?\n/).slice(1); // drop the request line
  const out: Array<{ name: string; value: string }> = [];
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return out;
}

/** Build a Netscape cookie jar (control-char-safe) from a Cookie header value. */
function buildCookieJar(cookieValue: string, host: string): { text: string; count: number } {
  const jarLines = ["# Netscape HTTP Cookie File", "# generated by caido-mode"];
  let count = 0;
  for (const pair of cookieValue.split(";")) {
    const t = pair.trim();
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const name = t.slice(0, eq);
    const value = t.slice(eq + 1);
    if (/[\t\r\n]/.test(name) || /[\t\r\n]/.test(value)) continue; // no field forgery
    jarLines.push(`${host}\tFALSE\t/\tFALSE\t${JAR_EXPIRY}\t${name}\t${value}`);
    count++;
  }
  return { text: jarLines.join("\n") + "\n", count };
}

/**
 * Pure builder (offline-testable): a FAITHFUL STATIC snapshot of one request's
 * auth/identity headers as a curl `-K` config.
 *
 * - Captures ALL request headers except the volatile/per-request denylist, so
 *   nothing auth-relevant is missed (the old curated allowlist dropped headers
 *   like x-custom-ext-*, X-Browser-Validation, Origin/Referer → request rejection).
 * - Cookies are inlined STATICALLY by default (no cookie-jar), so curl never
 *   writes drifting/rotated Set-Cookie values back over the captured-good set.
 *   Pass `opts.cookieJar` to opt into the read+write jar (rotation capture).
 */
export function buildAuthConfig(
  raw: string,
  host: string,
  port: number,
  isTls: boolean,
  proxy: string,
  opts: { cookieJar?: string; exclude?: string[] } = {},
): AuthConfigResult {
  const headers = parseRawHeaders(raw);
  const scheme = isTls ? "https" : "http";
  const portSuffix = (isTls && port === 443) || (!isTls && port === 80) ? "" : `:${port}`;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const base = `${scheme}://${urlHost}${portSuffix}`;
  // Escape for a curl -K value and strip control chars so a value can't break the
  // `header = "..."` line or inject another directive.
  const esc = (s: string) => s.replace(/[\r\n]/g, "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const exclude = new Set((opts.exclude ?? []).map((s) => s.toLowerCase()));

  const lines: string[] = [
    `# curl config for ${base} — generated by caido-mode (INTERNAL testing only)`,
    `# Faithful static snapshot of one request's auth/identity headers.`,
    `# Refresh by regenerating from a fresh request; don't hand-edit cookies.`,
    `proxy = "${esc(proxy)}"`,
    `insecure`,
    `compressed`,
  ];

  const included: string[] = [];
  let cookieValue: string | undefined;
  for (const h of headers) {
    const n = h.name.toLowerCase();
    if (n === "cookie") { cookieValue = h.value; continue; }
    if (SKIP_HEADERS.has(n) || exclude.has(n)) continue;
    lines.push(`header = "${esc(h.name)}: ${esc(h.value)}"`);
    included.push(h.name);
  }

  let cookieMode: "inline" | "jar" | "none" = "none";
  let cookieCount = 0;
  let jarText: string | undefined;
  if (cookieValue && !exclude.has("cookie")) {
    if (opts.cookieJar) {
      const jar = buildCookieJar(cookieValue, host);
      jarText = jar.text;
      cookieCount = jar.count;
      lines.push(`cookie = "${esc(opts.cookieJar)}"`);      // read jar
      lines.push(`cookie-jar = "${esc(opts.cookieJar)}"`);  // write jar (rotation capture — opt-in)
      cookieMode = "jar";
    } else {
      lines.push(`header = "Cookie: ${esc(cookieValue)}"`); // static — nothing drifts
      cookieCount = cookieValue.split(";").filter((p) => p.includes("=")).length;
      cookieMode = "inline";
    }
  }

  return { configText: lines.join("\n") + "\n", jarText, included, cookieCount, cookieMode, base };
}

export async function cmdExportCurlConfig(
  requestId: string,
  opts: { out?: string; cookieJar?: boolean; exclude?: string[] } = {},
) {
  const client = await getClient();
  const result = await client.request.get(requestId, { raw: true });
  if (!result) {
    console.error(`Request ${requestId} not found`);
    process.exit(1);
  }
  const raw = decodeRaw(result.request.raw);
  if (!raw) {
    console.error("No raw data for this request");
    process.exit(1);
  }

  const { host, port, isTls } = result.request;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");

  // Sanitize the host before using it as a path segment (no traversal/separators).
  const safeHost = host.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
  const cfgPath = opts.out ?? `/tmp/caido/${safeHost}/auth.cfg`;
  const dir = dirname(cfgPath);
  const jarPath = join(dir, "cookies.txt");

  const built = buildAuthConfig(raw, host, port, isTls, resolveProxy(), {
    cookieJar: opts.cookieJar ? jarPath : undefined,
    exclude: opts.exclude,
  });

  mkdirSync(dir, { recursive: true });
  writeFileSync(cfgPath, built.configText);
  if (built.jarText) writeFileSync(jarPath, built.jarText);

  console.log(JSON.stringify({
    config: cfgPath,
    cookieMode: built.cookieMode,        // "inline" (static, default) | "jar" | "none"
    ...(built.jarText ? { cookieJar: jarPath } : {}),
    cookieCount: built.cookieCount,
    capturedHeaders: built.included,
    base: built.base,
    proxy: resolveProxy(),
    note: "Faithful static snapshot for INTERNAL testing. Cookies are inline+static (no drift); refresh by regenerating from a fresh request. For the user, always emit a FULL self-contained command via `export-curl`.",
    usage: `curl -K ${cfgPath} "${built.base}/path"`,
  }, null, 2));
}
