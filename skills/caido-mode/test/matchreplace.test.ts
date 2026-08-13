/**
 * Tests for Match & Replace (Tamper) rule construction.
 * Run: npm test   (node --import tsx --test test/matchreplace.test.ts)
 *
 * These assert the exact TamperSectionInput / CreateTamperRuleInput the CLI sends.
 * The expected structures were validated against a live Caido via `testTamperRule`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTamperSection, buildRuleInput, SECTIONS } from "../lib/commands/matchreplace.ts";

// ── valid section/operation/matcher/replacer combinations ──

const CASES: Array<{ label: string; opts: any; expect: any }> = [
  // request — single-op sections
  {
    label: "req-method update → term",
    opts: { section: "req-method", replace: "POST" },
    expect: { requestMethod: { operation: { update: { replacer: { term: { term: "POST" } } } } } },
  },
  {
    label: "req-path raw regex → term",
    opts: { section: "req-path", matchRegex: "/api/test", replace: "/api/ADMIN" },
    expect: { requestPath: { operation: { raw: { matcher: { regex: { regex: "/api/test" } }, replacer: { term: { term: "/api/ADMIN" } } } } } },
  },
  {
    label: "req-body raw full → term",
    opts: { section: "req-body", matchFull: true, replace: "NEW BODY" },
    expect: { requestBody: { operation: { raw: { matcher: { full: { full: true } }, replacer: { term: { term: "NEW BODY" } } } } } },
  },
  {
    label: "req-first-line raw value → term",
    opts: { section: "req-first-line", matchValue: "GET /a HTTP/1.1", replace: "GET /b HTTP/1.1" },
    expect: { requestFirstLine: { operation: { raw: { matcher: { value: { value: "GET /a HTTP/1.1" } }, replacer: { term: { term: "GET /b HTTP/1.1" } } } } } },
  },
  {
    label: "req-all raw value → workflow replacer",
    opts: { section: "req-all", matchValue: "secret", workflowId: "wf-123" },
    expect: { requestAll: { operation: { raw: { matcher: { value: { value: "secret" } }, replacer: { workflow: { id: "wf-123" } } } } } },
  },
  {
    label: "req-sni raw → term (no matcher)",
    opts: { section: "req-sni", replace: "evil.example.com" },
    expect: { requestSNI: { operation: { raw: { replacer: { term: { term: "evil.example.com" } } } } } },
  },
  // request — header (all four ops)
  {
    label: "req-header raw value → term",
    opts: { section: "req-header", matchValue: "X-Old: 1", replace: "X-Old: 2" },
    expect: { requestHeader: { operation: { raw: { matcher: { value: { value: "X-Old: 1" } }, replacer: { term: { term: "X-Old: 2" } } } } } },
  },
  {
    label: "req-header add by name",
    opts: { section: "req-header", operation: "add", matchName: "X-Injected", replace: "hi" },
    expect: { requestHeader: { operation: { add: { matcher: { name: "X-Injected" }, replacer: { term: { term: "hi" } } } } } },
  },
  {
    label: "req-header update by name",
    opts: { section: "req-header", operation: "update", matchName: "X-Old", replace: "999" },
    expect: { requestHeader: { operation: { update: { matcher: { name: "X-Old" }, replacer: { term: { term: "999" } } } } } },
  },
  {
    label: "req-header remove by name (no replacer)",
    opts: { section: "req-header", operation: "remove", matchName: "If-None-Match" },
    expect: { requestHeader: { operation: { remove: { matcher: { name: "If-None-Match" } } } } },
  },
  {
    label: "req-header update → empty-string term",
    opts: { section: "req-header", operation: "update", matchName: "Authorization", replace: "" },
    expect: { requestHeader: { operation: { update: { matcher: { name: "Authorization" }, replacer: { term: { term: "" } } } } } },
  },
  // request — query (all four ops)
  {
    label: "req-query raw value → term",
    opts: { section: "req-query", matchValue: "a=1", replace: "a=2" },
    expect: { requestQuery: { operation: { raw: { matcher: { value: { value: "a=1" } }, replacer: { term: { term: "a=2" } } } } } },
  },
  {
    label: "req-query add by name",
    opts: { section: "req-query", operation: "add", matchName: "b", replace: "2" },
    expect: { requestQuery: { operation: { add: { matcher: { name: "b" }, replacer: { term: { term: "2" } } } } } },
  },
  {
    label: "req-query remove by name",
    opts: { section: "req-query", operation: "remove", matchName: "a" },
    expect: { requestQuery: { operation: { remove: { matcher: { name: "a" } } } } },
  },
  // response
  {
    label: "resp-status update → term",
    opts: { section: "resp-status", replace: "403" },
    expect: { responseStatusCode: { operation: { update: { replacer: { term: { term: "403" } } } } } },
  },
  {
    label: "resp-body raw regex → term",
    opts: { section: "resp-body", matchRegex: "admin", replace: "user" },
    expect: { responseBody: { operation: { raw: { matcher: { regex: { regex: "admin" } }, replacer: { term: { term: "user" } } } } } },
  },
  {
    label: "resp-first-line raw value → term",
    opts: { section: "resp-first-line", matchValue: "HTTP/1.1 200 OK", replace: "HTTP/1.1 401 Unauthorized" },
    expect: { responseFirstLine: { operation: { raw: { matcher: { value: { value: "HTTP/1.1 200 OK" } }, replacer: { term: { term: "HTTP/1.1 401 Unauthorized" } } } } } },
  },
  {
    label: "resp-header add by name",
    opts: { section: "resp-header", operation: "add", matchName: "X-Frame-Options", replace: "DENY" },
    expect: { responseHeader: { operation: { add: { matcher: { name: "X-Frame-Options" }, replacer: { term: { term: "DENY" } } } } } },
  },
  {
    label: "resp-all raw full → term",
    opts: { section: "resp-all", matchFull: true, replace: "tampered" },
    expect: { responseAll: { operation: { raw: { matcher: { full: { full: true } }, replacer: { term: { term: "tampered" } } } } } },
  },
  // websocket
  {
    label: "ws-up raw value → term",
    opts: { section: "ws-up", matchValue: "ping", replace: "pong" },
    expect: { streamWsMessageUpstream: { operation: { raw: { matcher: { value: { value: "ping" } }, replacer: { term: { term: "pong" } } } } } },
  },
  {
    label: "ws-down raw value → term",
    opts: { section: "ws-down", matchValue: "foo", replace: "bar" },
    expect: { streamWsMessageDownstream: { operation: { raw: { matcher: { value: { value: "foo" } }, replacer: { term: { term: "bar" } } } } } },
  },
];

for (const c of CASES) {
  test(`buildTamperSection: ${c.label}`, () => {
    assert.deepEqual(buildTamperSection(c.opts), c.expect);
  });
}

test("every section in SECTIONS has at least one working case covered", () => {
  const covered = new Set(CASES.map((c) => c.opts.section));
  const missing = Object.keys(SECTIONS).filter((s) => !covered.has(s));
  assert.deepEqual(missing, [], `sections without a test case: ${missing.join(", ")}`);
});

// ── validation errors ──

test("unknown section throws", () => {
  assert.throws(() => buildTamperSection({ section: "bogus", replace: "x" }), /Unknown --section/);
});

test("invalid operation for section throws", () => {
  assert.throws(() => buildTamperSection({ section: "req-method", operation: "add", replace: "x" }), /not valid for section/);
});

test("raw op with no matcher throws", () => {
  assert.throws(() => buildTamperSection({ section: "req-body", replace: "x" }), /exactly one matcher/);
});

test("raw op with two matchers throws", () => {
  assert.throws(() => buildTamperSection({ section: "req-body", matchValue: "a", matchRegex: "b", replace: "x" }), /exactly one matcher/);
});

test("name op without --match-name throws", () => {
  assert.throws(() => buildTamperSection({ section: "req-header", operation: "add", replace: "x" }), /needs --match-name/);
});

test("none-matcher section given a matcher throws", () => {
  assert.throws(() => buildTamperSection({ section: "req-method", matchValue: "GET", replace: "POST" }), /takes no matcher/);
});

test("missing replacer throws", () => {
  assert.throws(() => buildTamperSection({ section: "req-header", operation: "add", matchName: "X" }), /exactly one replacer/);
});

test("two replacers throws", () => {
  assert.throws(() => buildTamperSection({ section: "req-header", operation: "add", matchName: "X", replace: "a", workflowId: "w" }), /exactly one replacer/);
});

test("remove op given a replacer throws", () => {
  assert.throws(() => buildTamperSection({ section: "req-header", operation: "remove", matchName: "X", replace: "a" }), /takes no replacer/);
});

// ── buildRuleInput (name / collection / condition / sources) ──

test("buildRuleInput: name + collectionId attached", () => {
  const input = buildRuleInput({ section: "req-method", replace: "POST", name: "force POST" }, "col-1");
  assert.equal(input.name, "force POST");
  assert.equal(input.collectionId, "col-1");
  assert.ok(input.section.requestMethod);
});

test("buildRuleInput: HTTP section condition → HTTPQL", () => {
  const input = buildRuleInput({ section: "req-header", operation: "add", matchName: "X", replace: "1", condition: 'req.host.eq:"t.com"' });
  assert.deepEqual(input.condition, { HTTPQL: { code: 'req.host.eq:"t.com"' } });
});

test("buildRuleInput: WS section condition → streamQL", () => {
  const input = buildRuleInput({ section: "ws-up", matchValue: "a", replace: "b", condition: "something" });
  assert.deepEqual(input.condition, { streamQL: { code: "something" } });
});

test("buildRuleInput: sources normalized + validated", () => {
  const input = buildRuleInput({ section: "req-method", replace: "POST", sources: ["replay", "Intercept"] });
  assert.deepEqual(input.sources, ["REPLAY", "INTERCEPT"]);
});

test("buildRuleInput: sources defaults to [INTERCEPT] (required by Caido)", () => {
  const input = buildRuleInput({ section: "req-method", replace: "POST" });
  assert.deepEqual(input.sources, ["INTERCEPT"]);
});

test("buildRuleInput: invalid source throws", () => {
  assert.throws(() => buildRuleInput({ section: "req-method", replace: "POST", sources: ["bogus"] }), /Unknown source/);
});

test("buildRuleInput: no collectionId when omitted (valid UpdateTamperRuleInput)", () => {
  const input = buildRuleInput({ section: "req-method", replace: "POST" });
  assert.ok(!("collectionId" in input));
});
