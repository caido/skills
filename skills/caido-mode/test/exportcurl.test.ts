/**
 * Tests for `export-curl --config` (buildAuthConfig).
 * Run: npm test
 *
 * Regression coverage for two real bugs found during testing:
 *   1. a narrow header allowlist dropped app-specific auth headers (x-custom-ext-*,
 *      X-Browser-Validation, Origin/Referer/X-Same-Domain) → request rejection.
 *   2. an always-on cookie-jar wrote rotated Set-Cookie back over the good cookies.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthConfig } from "../lib/commands/requests.ts";
import { rawToCurl } from "../lib/output.ts";

test("export-curl (full command): adds --compressed and drops Accept-Encoding, keeps real headers", () => {
  const raw = "GET / HTTP/1.1\r\nHost: h\r\nAccept-Encoding: gzip, br, zstd\r\nAuthorization: tok\r\nConnection: keep-alive\r\n\r\n";
  const curl = rawToCurl(raw, "h", 443, true);
  assert.match(curl, /^curl --compressed /);
  assert.doesNotMatch(curl, /Accept-Encoding/i);   // would otherwise return unreadable gzip
  assert.doesNotMatch(curl, /Connection/i);          // hop-by-hop, curl-managed
  assert.match(curl, /Authorization: tok/);          // real headers preserved
});

// A request shaped like a typical authenticated JSON-RPC POST with app-specific headers.
const RAW = [
  "POST /api/data/rpc?method=query HTTP/1.1",
  "Host: api.example.com",
  "Content-Length: 42",
  "Content-Type: application/x-www-form-urlencoded;charset=UTF-8",
  "Accept-Encoding: gzip, deflate, br",
  "Connection: keep-alive",
  "User-Agent: Mozilla/5.0",
  "Authorization: BEARER abc123",
  "Origin: https://api.example.com",
  "Referer: https://api.example.com/app",
  "X-Same-Domain: 1",
  "X-Browser-Validation: deadbeef",
  "X-Client-Data: CIa2yQEI",
  "x-custom-ext-525001261-jspb: [1,null,0]",
  "x-custom-ext-73010989-jspb: [\"en\"]",
  "Cookie: __Secure-1PSID=A; __Secure-1PSIDCC=B; SIDCC=C",
  "",
  "data=%5B%5D&token=xyz",
].join("\r\n");

function configHeaders(cfg: string): string[] {
  return [...cfg.matchAll(/^header = "([^:]+):/gm)].map((m) => m[1]);
}

test("captures app-specific auth headers the old allowlist dropped", () => {
  const { configText } = buildAuthConfig(RAW, "api.example.com", 443, true, "http://p");
  const hdrs = configHeaders(configText).map((h) => h.toLowerCase());
  for (const need of [
    "user-agent", "authorization", "origin", "referer", "x-same-domain",
    "x-browser-validation", "x-client-data",
    "x-custom-ext-525001261-jspb", "x-custom-ext-73010989-jspb",
  ]) {
    assert.ok(hdrs.includes(need), `expected captured header: ${need}`);
  }
});

test("drops volatile/per-request/curl-managed headers", () => {
  const { configText } = buildAuthConfig(RAW, "api.example.com", 443, true, "http://p");
  const hdrs = configHeaders(configText).map((h) => h.toLowerCase());
  for (const skip of ["host", "content-length", "content-type", "accept-encoding", "connection"]) {
    assert.ok(!hdrs.includes(skip), `header should be dropped: ${skip}`);
  }
});

test("proxy + insecure + compressed directives present", () => {
  const { configText } = buildAuthConfig(RAW, "h", 443, true, "http://127.0.0.1:8080");
  assert.match(configText, /^proxy = "http:\/\/127\.0\.0\.1:8080"$/m);
  assert.match(configText, /^insecure$/m);
  assert.match(configText, /^compressed$/m);
});

test("cookies are inline + static by default (no jar, no drift)", () => {
  const r = buildAuthConfig(RAW, "api.example.com", 443, true, "http://p");
  assert.equal(r.cookieMode, "inline");
  assert.equal(r.jarText, undefined);
  assert.match(r.configText, /^header = "Cookie: __Secure-1PSID=A; __Secure-1PSIDCC=B; SIDCC=C"$/m);
  assert.doesNotMatch(r.configText, /cookie-jar/); // nothing writes rotated cookies back
  assert.equal(r.cookieCount, 3);
});

test("--cookie-jar opts into a read/write jar", () => {
  const r = buildAuthConfig(RAW, "api.example.com", 443, true, "http://p", { cookieJar: "/tmp/x/cookies.txt" });
  assert.equal(r.cookieMode, "jar");
  assert.match(r.configText, /^cookie = "\/tmp\/x\/cookies\.txt"$/m);
  assert.match(r.configText, /^cookie-jar = "\/tmp\/x\/cookies\.txt"$/m);
  assert.ok(r.jarText && r.jarText.includes("__Secure-1PSID\tA"));
  assert.doesNotMatch(r.configText, /header = "Cookie:/); // not also inline
});

test("--exclude drops a named header (and 'cookie' omits cookies entirely)", () => {
  const r1 = buildAuthConfig(RAW, "h", 443, true, "http://p", { exclude: ["x-client-data", "referer"] });
  const h1 = configHeaders(r1.configText).map((h) => h.toLowerCase());
  assert.ok(!h1.includes("x-client-data") && !h1.includes("referer"));
  assert.ok(h1.includes("origin")); // others still present

  const r2 = buildAuthConfig(RAW, "h", 443, true, "http://p", { exclude: ["cookie"] });
  assert.equal(r2.cookieMode, "none");
  assert.doesNotMatch(r2.configText, /Cookie/);
});

test("config-injection: a quote in a header value is escaped, not broken out", () => {
  // A double-quote inside a single header value must be escaped, not allowed to
  // close the directive and inject another (e.g. a bare `insecure-but-injected`).
  const raw = 'GET / HTTP/1.1\r\nHost: h\r\nX-Q: a"b\r\n\r\n';
  const { configText } = buildAuthConfig(raw, "h", 443, true, "http://p");
  assert.match(configText, /^header = "X-Q: a\\"b"$/m);
  assert.doesNotMatch(configText, /^insecure-but-injected/m);
});
