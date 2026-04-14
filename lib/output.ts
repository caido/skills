/** Output formatting helpers for raw HTTP data */

import type { OutputOpts } from "./types";

export function decodeRaw(raw: Uint8Array | undefined): string {
  if (!raw || raw.length === 0) return "";
  return new TextDecoder().decode(raw);
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

/** Build a curl command from raw HTTP request */
export function rawToCurl(rawRequest: string, host: string, port: number, isTls: boolean): string {
  const lines = rawRequest.split(/\r?\n/);
  if (lines.length === 0) return "";

  const [method, path] = lines[0].split(" ");
  const scheme = isTls ? "https" : "http";
  const portSuffix = (isTls && port === 443) || (!isTls && port === 80) ? "" : `:${port}`;
  const url = `${scheme}://${host}${portSuffix}${path}`;

  const parts = [`curl -X ${method} '${url}'`];

  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" || line === "\r") break;
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const name = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      if (name.toLowerCase() === "host") continue;
      if (name.toLowerCase() === "content-length") continue;
      parts.push(`  -H '${name}: ${value}'`);
    }
  }

  const body = lines.slice(i + 1).join("\n").trim();
  if (body) {
    parts.push(`  -d '${body.replace(/'/g, "'\\''")}'`);
  }

  return parts.join(" \\\n");
}
