/** HTTP History commands: search, recent, get, get-response, raw, export-curl */

import { getClient, resolveProxy } from "../client";
import { decodeRaw, formatHttpRaw, rawToCurl } from "../output";
import type { OutputOpts } from "../types";

/** Terse one-line-per-request rendering for fast, low-token browsing. */
function compactLine(r: { id: string; method: string; host: string; path: string; query?: string; statusCode?: number }) {
  const status = r.statusCode != null ? r.statusCode : "—";
  return `${r.id}\t${status}\t${r.method} ${r.host}${r.path}${r.query ? "?" + r.query : ""}`;
}

export async function cmdSearch(filter: string, limit: number, after?: string, idsOnly?: boolean, desc?: boolean, compact?: boolean) {
  const client = await getClient();
  let builder = client.request.list().filter(filter).first(limit);
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
  jarText: string;
  included: string[];
  cookieCount: number;
  base: string;
}

function parseRawHeaders(raw: string): Array<{ name: string; value: string }> {
  const sep = raw.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const headerBlock = raw.split(sep)[0];
  const lines = headerBlock.split(/\r?\n/).slice(1); // drop the request line
  const out: Array<{ name: string; value: string }> = [];
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return out;
}

/** Allowlist: static auth/identity headers worth caching. Cookie is handled via the jar. */
function isAuthHeader(name: string): boolean {
  const n = name.toLowerCase();
  if (n === "authorization" || n === "user-agent") return true;
  if (n.startsWith("x-") && /(token|csrf|xsrf|key|auth)/.test(n)) return true;
  return false;
}

/** Pure builder (offline-testable): produce the `-K` config text and a Netscape cookie jar. */
export function buildAuthConfig(
  raw: string,
  host: string,
  port: number,
  isTls: boolean,
  proxy: string,
  jarPath: string,
): AuthConfigResult {
  const headers = parseRawHeaders(raw);
  const scheme = isTls ? "https" : "http";
  const portSuffix = (isTls && port === 443) || (!isTls && port === 80) ? "" : `:${port}`;
  const base = `${scheme}://${host}${portSuffix}`;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const lines: string[] = [
    `# curl config for ${base} — generated by caido-mode (INTERNAL testing only)`,
    `# Usage: curl -K <thisfile> "${base}/path"`,
    `proxy = "${esc(proxy)}"`,
    `insecure`,
  ];

  const included: string[] = [];
  for (const h of headers) {
    if (h.name.toLowerCase() === "cookie") continue; // → jar
    if (isAuthHeader(h.name)) {
      lines.push(`header = "${esc(h.name)}: ${esc(h.value)}"`);
      included.push(h.name);
    }
  }

  // Cookie jar (read + write the same file so rotated Set-Cookie is captured).
  const cookieHeader = headers.find(h => h.name.toLowerCase() === "cookie");
  const jarLines: string[] = ["# Netscape HTTP Cookie File", "# generated by caido-mode"];
  let cookieCount = 0;
  if (cookieHeader) {
    for (const pair of cookieHeader.value.split(";")) {
      const t = pair.trim();
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      // domain  includeSubdomains  path  secure  expiry  name  value
      jarLines.push(`${host}\tFALSE\t/\tFALSE\t${JAR_EXPIRY}\t${t.slice(0, eq)}\t${t.slice(eq + 1)}`);
      cookieCount++;
    }
  }
  if (cookieCount > 0) {
    lines.push(`cookie = "${esc(jarPath)}"`);      // read jar
    lines.push(`cookie-jar = "${esc(jarPath)}"`);  // write jar (capture rotation)
  }

  return { configText: lines.join("\n") + "\n", jarText: jarLines.join("\n") + "\n", included, cookieCount, base };
}

export async function cmdExportCurlConfig(requestId: string, out?: string) {
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

  const cfgPath = out ?? `/tmp/caido/${host}/auth.cfg`;
  const dir = dirname(cfgPath);
  const jarPath = join(dir, "cookies.txt");

  const built = buildAuthConfig(raw, host, port, isTls, resolveProxy(), jarPath);

  mkdirSync(dir, { recursive: true });
  writeFileSync(cfgPath, built.configText);
  writeFileSync(jarPath, built.jarText);

  console.log(JSON.stringify({
    config: cfgPath,
    cookieJar: jarPath,
    cookieCount: built.cookieCount,
    includedHeaders: built.included,
    base: built.base,
    proxy: resolveProxy(),
    note: "INTERNAL use only — proxies through Caido. For the user, always emit a FULL self-contained command via `export-curl`.",
    usage: `curl -K ${cfgPath} "${built.base}/path"`,
  }, null, 2));
}
