/**
 * Tests for the raw-request edit/normalize pipeline and curl generation:
 *   - normalizeRaw      (lib/commands/replay.ts) — backslash-escape decoding
 *   - ensureHeaderCrlf  (lib/commands/replay.ts) — header CRLF promotion
 *   - applyRawEdits     (lib/commands/replay.ts) — method/path/header/body edits
 *   - rawToCurl         (lib/output.ts)          — raw HTTP → curl command
 *
 * Run: npm test
 *
 * These guard the invariants the inline comments in those functions promise:
 * bodies stay byte-exact (the header/body split is derived from the header block,
 * never from body content), line endings are preserved, Content-Length is byte-
 * accurate, and a body that starts with '@' is sent literally (--data-raw).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRaw,
  ensureHeaderCrlf,
  applyRawEdits,
  type RawEdits,
} from "../lib/commands/replay.ts";
import { rawToCurl } from "../lib/output.ts";

/** RawEdits with the array fields defaulted, so each test states only what it changes. */
function edits(partial: Partial<RawEdits> = {}): RawEdits {
  return { setHeaders: [], removeHeaders: [], replacements: [], ...partial };
}

// ---------------------------------------------------------------------------
// normalizeRaw
// ---------------------------------------------------------------------------

test("normalizeRaw: decodes \\r\\n\\t\\\\ escape sequences into real bytes", () => {
  const out = normalizeRaw("GET / HTTP/1.1\\r\\nHost: h\\r\\nX-Tab:\\ta\\r\\n\\r\\n");
  assert.equal(out, "GET / HTTP/1.1\r\nHost: h\r\nX-Tab:\ta\r\n\r\n");
});

test("normalizeRaw: a string already containing CRLF is returned untouched (no double-decode)", () => {
  // A real pasted request whose body legitimately contains the two chars '\' 'n'
  // must not have that literal turned into a newline.
  const raw = 'POST /x HTTP/1.1\r\nHost: h\r\n\r\n{"path":"a\\nb"}';
  assert.equal(normalizeRaw(raw), raw);
});

test("normalizeRaw: lone \\n is decoded to LF when no CRLF is present", () => {
  assert.equal(normalizeRaw("a\\nb"), "a\nb");
});

// ---------------------------------------------------------------------------
// ensureHeaderCrlf
// ---------------------------------------------------------------------------

test("ensureHeaderCrlf: promotes bare-LF headers to CRLF but leaves the body byte-exact", () => {
  // Body contains a lone \n (JSON) — it must survive unchanged.
  const out = ensureHeaderCrlf('POST / HTTP/1.1\nHost: h\n\n{"a":\n1}');
  assert.equal(out, 'POST / HTTP/1.1\r\nHost: h\r\n\r\n{"a":\n1}');
});

test("ensureHeaderCrlf: is idempotent on already-CRLF input", () => {
  const raw = "GET / HTTP/1.1\r\nHost: h\r\nAccept: */*\r\n\r\nbody\nwith-lf";
  assert.equal(ensureHeaderCrlf(raw), raw);
});

test("ensureHeaderCrlf: a header-only request (no blank line) gets no spurious body separator", () => {
  assert.equal(ensureHeaderCrlf("GET / HTTP/1.1\nHost: h"), "GET / HTTP/1.1\r\nHost: h");
});

test("ensureHeaderCrlf: normalizes mixed CRLF/LF headers without doubling existing CRLFs", () => {
  const out = ensureHeaderCrlf("GET / HTTP/1.1\r\nA: 1\nB: 2\r\n\r\nbody");
  assert.equal(out, "GET / HTTP/1.1\r\nA: 1\r\nB: 2\r\n\r\nbody");
  assert.doesNotMatch(out, /\r\r/);
});

// ---------------------------------------------------------------------------
// applyRawEdits
// ---------------------------------------------------------------------------

const REQ = "POST /old?x=1 HTTP/1.1\r\nHost: h\r\nAuthorization: old\r\nCookie: a=b\r\n\r\nhello";

test("applyRawEdits: changes the method, preserving path and version", () => {
  const out = applyRawEdits(REQ, edits({ method: "PUT" }));
  assert.match(out, /^PUT \/old\?x=1 HTTP\/1\.1\r\n/);
});

test("applyRawEdits: changes the path, preserving method and version", () => {
  const out = applyRawEdits(REQ, edits({ path: "/new" }));
  assert.match(out, /^POST \/new HTTP\/1\.1\r\n/);
});

test("applyRawEdits: setHeaders replaces an existing header case-insensitively (no duplicate)", () => {
  const out = applyRawEdits(REQ, edits({ setHeaders: ["authorization: new"] }));
  assert.match(out, /authorization: new/);
  assert.doesNotMatch(out, /Authorization: old/);
  // exactly one authorization header
  assert.equal((out.match(/authorization: /gi) ?? []).length, 1);
});

test("applyRawEdits: setHeaders appends a header that wasn't present", () => {
  const out = applyRawEdits(REQ, edits({ setHeaders: ["X-New: 1"] }));
  assert.match(out, /\r\nX-New: 1\r\n/);
});

test("applyRawEdits: removeHeaders drops a header case-insensitively", () => {
  const out = applyRawEdits(REQ, edits({ removeHeaders: ["COOKIE"] }));
  assert.doesNotMatch(out, /Cookie/i);
});

test("applyRawEdits: setting the body recomputes Content-Length in BYTES (multibyte-safe)", () => {
  // '€' is one char but three UTF-8 bytes.
  const out = applyRawEdits(REQ, edits({ body: "€" }));
  assert.match(out, /\r\nContent-Length: 3\r\n/);
  assert.ok(out.endsWith("\r\n\r\n€"));
  // no stale Content-Length lingers
  assert.equal((out.match(/Content-Length:/gi) ?? []).length, 1);
});

test("applyRawEdits: replacements run across the whole message; empty 'to' deletes", () => {
  const out = applyRawEdits(REQ, edits({ replacements: ["old:::NEW", "hello:::"] }));
  assert.match(out, /\/NEW\?x=1/);          // path token replaced
  assert.match(out, /Authorization: NEW/);  // header value replaced
  assert.ok(out.endsWith("\r\n\r\n"));      // body 'hello' deleted
});

test("applyRawEdits: a body containing a blank line (multipart) is preserved byte-exact", () => {
  // The split must come from the FIRST blank line (end of headers), not from the
  // blank line *inside* the multipart body.
  const body = '--X\r\nContent-Disposition: form-data; name="a"\r\n\r\nval\r\n--X--\r\n';
  const raw = "POST /u HTTP/1.1\r\nHost: h\r\nContent-Type: multipart/form-data; boundary=X\r\n\r\n" + body;
  const out = applyRawEdits(raw, edits({ setHeaders: ["X-T: 1"] }));
  assert.ok(out.endsWith("\r\n\r\n" + body), "multipart body must be untouched");
  assert.match(out, /\r\nX-T: 1\r\n/);
});

test("applyRawEdits: a header-only request gains no spurious empty body", () => {
  const out = applyRawEdits("GET / HTTP/1.1\r\nHost: h", edits({ setHeaders: ["X-T: 1"] }));
  assert.equal(out, "GET / HTTP/1.1\r\nHost: h\r\nX-T: 1");
  assert.doesNotMatch(out, /\r\n\r\n/);
});

test("applyRawEdits: LF-only requests keep LF line endings (no CRLF promotion)", () => {
  const out = applyRawEdits("GET / HTTP/1.1\nHost: h\n\nbody", edits({ setHeaders: ["X-T: 1"] }));
  assert.doesNotMatch(out, /\r/);
  assert.equal(out, "GET / HTTP/1.1\nHost: h\nX-T: 1\n\nbody");
});

// ---------------------------------------------------------------------------
// rawToCurl
// ---------------------------------------------------------------------------

test("rawToCurl: a body starting with '@' is emitted via --data-raw, not -d", () => {
  // -d '@x' makes curl read file x; --data-raw sends the literal text.
  const raw = "POST /api HTTP/1.1\r\nHost: h\r\nContent-Type: text/plain\r\n\r\n@not-a-file";
  const curl = rawToCurl(raw, "h", 443, true);
  assert.match(curl, /--data-raw '@not-a-file'/);
  assert.doesNotMatch(curl, /(^|\s)-d\s/); // never the file-reading short flag
});

test("rawToCurl: a GET with no body emits no data flag", () => {
  const curl = rawToCurl("GET / HTTP/1.1\r\nHost: h\r\n\r\n", "h", 443, true);
  assert.doesNotMatch(curl, /--data-raw|(^|\s)-d\s/);
});

test("rawToCurl: omits the port for 443/https and 80/http, includes it otherwise", () => {
  assert.match(rawToCurl("GET /p HTTP/1.1\r\nHost: h\r\n\r\n", "h", 443, true), /'https:\/\/h\/p'/);
  assert.match(rawToCurl("GET /p HTTP/1.1\r\nHost: h\r\n\r\n", "h", 80, false), /'http:\/\/h\/p'/);
  assert.match(rawToCurl("GET /p HTTP/1.1\r\nHost: h\r\n\r\n", "h", 8443, true), /'https:\/\/h:8443\/p'/);
});

test("rawToCurl: brackets an IPv6 literal host", () => {
  const curl = rawToCurl("GET /p HTTP/1.1\r\nHost: x\r\n\r\n", "::1", 8080, false);
  assert.match(curl, /'http:\/\/\[::1\]:8080\/p'/);
});

test("rawToCurl: shell-quotes a single quote in a header value (no shell break-out)", () => {
  const raw = "GET / HTTP/1.1\r\nHost: h\r\nX-Q: a'b\r\n\r\n";
  const curl = rawToCurl(raw, "h", 443, true);
  // POSIX single-quote escaping turns ' into '\''
  assert.match(curl, /-H 'X-Q: a'\\''b'/);
});
