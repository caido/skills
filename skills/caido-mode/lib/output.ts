/** Output formatting helpers for raw HTTP data */

import type { OutputOpts } from "./types";

export function decodeRaw(raw: Uint8Array | undefined): string {
  if (!raw || raw.length === 0) return "";
  return new TextDecoder().decode(raw);
}

/** Split a raw HTTP message at the first blank line. Returns headerBlock, body (undefined = no separator found), and the separator string. */
export function splitRaw(raw: string): { headerBlock: string; body: string | undefined; sep: "\r\n\r\n" | "\n\n" | undefined } {
  const idxCrlf = raw.indexOf("\r\n\r\n");
  const idxLf = raw.indexOf("\n\n");
  if (idxCrlf >= 0 && (idxLf < 0 || idxCrlf <= idxLf)) {
    return { headerBlock: raw.slice(0, idxCrlf), body: raw.slice(idxCrlf + 4), sep: "\r\n\r\n" };
  } else if (idxLf >= 0) {
    return { headerBlock: raw.slice(0, idxLf), body: raw.slice(idxLf + 2), sep: "\n\n" };
  }
  return { headerBlock: raw, body: undefined, sep: undefined };
}

export function extractHeaders(decoded: string): string {
  const doubleCrlf = decoded.indexOf("\r\n\r\n");
  const doubleLf = decoded.indexOf("\n\n");
  if (doubleCrlf >= 0 && (doubleLf < 0 || doubleCrlf <= doubleLf)) {
    return decoded.substring(0, doubleCrlf);
  } else if (doubleLf >= 0) {
    return decoded.substring(0, doubleLf);
  }
  return decoded;
}

export function formatHttpRaw(decoded: string, opts: OutputOpts): string {
  if (opts.headersOnly) return extractHeaders(decoded);
  return truncateBody(decoded, opts.maxBodyLines, opts.maxBodyChars);
}

export function truncateBody(decoded: string, maxLines: number, maxChars: number): string {
  const noLineLimit = maxLines <= 0;
  const noCharLimit = maxChars <= 0;
  if (noLineLimit && noCharLimit) return decoded;

  const doubleCrlf = decoded.indexOf("\r\n\r\n");
  const doubleLf = decoded.indexOf("\n\n");

  let splitIndex: number;
  let separator: string;

  if (doubleCrlf >= 0 && (doubleLf < 0 || doubleCrlf <= doubleLf)) {
    splitIndex = doubleCrlf;
    separator = "\r\n\r\n";
  } else if (doubleLf >= 0) {
    splitIndex = doubleLf;
    separator = "\n\n";
  } else {
    return decoded;
  }

  const headers = decoded.substring(0, splitIndex);
  let body = decoded.substring(splitIndex + separator.length);

  if (!noCharLimit && body.length > maxChars) {
    body = body.substring(0, maxChars) + `\n\n[TRUNCATED at ${maxChars} chars, total ${decoded.length - splitIndex - separator.length}]`;
  }

  if (!noLineLimit) {
    const lines = body.split("\n");
    if (lines.length > maxLines) {
      body = lines.slice(0, maxLines).join("\n") + `\n\n[TRUNCATED at ${maxLines} lines, total ${lines.length}]`;
    }
  }

  return headers + separator + body;
}

/** Single-quote a value for safe pasting into a POSIX shell. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Bracket an IPv6 literal host for use in a URL. */
function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Headers curl sets/manages itself per request/connection — inlining a captured
 * copy is at best redundant and at worst breaks things (stale Content-Length →
 * hang/duplicate; inlined Accept-Encoding without --compressed → unreadable gzip).
 * Single source of truth shared by rawToCurl and the curl-config builder.
 */
export const CURL_MANAGED_HEADERS = new Set([
  "host", "content-length", "accept-encoding", "connection",
  "transfer-encoding", "proxy-connection", "keep-alive", "upgrade", "te",
]);

/**
 * Build a curl command from a raw HTTP request.
 * Every interpolated, request-derived value (URL, method, header name/value, body)
 * is shell-quoted — these come from proxied traffic and the output is pasted into a shell.
 * `--compressed` is added (and Accept-Encoding dropped) so responses are readable.
 */
export function rawToCurl(rawRequest: string, host: string, port: number, isTls: boolean): string {
  const lines = rawRequest.split(/\r?\n/);
  if (lines.length === 0) return "";

  const [method, path] = lines[0].split(" ");
  const scheme = isTls ? "https" : "http";
  const portSuffix = (isTls && port === 443) || (!isTls && port === 80) ? "" : `:${port}`;
  const url = `${scheme}://${urlHost(host)}${portSuffix}${path ?? ""}`;

  const parts = [`curl --compressed -X ${shQuote(method ?? "GET")} ${shQuote(url)}`];

  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" || line === "\r") break;
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const name = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      if (CURL_MANAGED_HEADERS.has(name.toLowerCase())) continue;
      parts.push(`  -H ${shQuote(`${name}: ${value}`)}`);
    }
  }

  const body = lines.slice(i + 1).join("\n").trim();
  if (body) {
    // --data-raw (not -d): a body starting with '@' must be sent literally, not
    // treated by curl as a "read this file" instruction.
    parts.push(`  --data-raw ${shQuote(body)}`);
  }

  return parts.join(" \\\n");
}
