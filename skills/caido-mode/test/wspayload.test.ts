/**
 * Tests for WebSocket message payload formatting (formatWsPayload).
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatWsPayload } from "../lib/commands/replay.ts";

const opts = (maxBodyLines: number, maxBodyChars: number) =>
  ({ maxBodyLines, maxBodyChars }) as any;

test("TEXT frames are decoded as utf-8", () => {
  const out = formatWsPayload("TEXT", new TextEncoder().encode("héllo"), opts(0, 0));
  assert.equal(out.encoding, "utf-8");
  assert.equal(out.raw, "héllo");
});

test("non-TEXT frames are base64 and survive bytes that are not valid utf-8", () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
  const out = formatWsPayload("BINARY", bytes, opts(0, 0));
  assert.equal(out.encoding, "base64");
  assert.deepEqual(new Uint8Array(Buffer.from(out.raw, "base64")), bytes);
});

test("a TEXT frame carrying bytes that are not valid utf-8 falls back to base64", () => {
  // A real close frame Caido reported as TEXT: 0x03 0xE8 is close code 1000.
  const bytes = new Uint8Array([0x03, 0xe8]);
  const out = formatWsPayload("TEXT", bytes, opts(0, 0));

  assert.equal(out.encoding, "base64");
  assert.deepEqual(new Uint8Array(Buffer.from(out.raw, "base64")), bytes);
});

test("PING and CLOSE frames are treated as binary, not text", () => {
  for (const format of ["PING", "PONG", "CLOSE"]) {
    assert.equal(formatWsPayload(format, new Uint8Array([0x01]), opts(0, 0)).encoding, "base64");
  }
});

test("truncated base64 stays decodable and reports the cut separately", () => {
  const bytes = new Uint8Array(600).fill(0x41);
  const out = formatWsPayload("BINARY", bytes, opts(0, 100));

  assert.equal(out.encoding, "base64");
  assert.equal(out.raw.length % 4, 0);
  assert.ok(out.raw.length <= 100);
  assert.doesNotThrow(() => Buffer.from(out.raw, "base64"));
  assert.match(out.truncated!, /^\[TRUNCATED at 100 chars, total 800\]$/);
  // The marker must never land inside the value a consumer decodes.
  assert.ok(!out.raw.includes("TRUNCATED"));
});

test("base64 shorter than the limit carries no truncation field", () => {
  const out = formatWsPayload("BINARY", new Uint8Array([1, 2, 3]), opts(0, 100));
  assert.equal(out.truncated, undefined);
  assert.equal(out.raw, Buffer.from([1, 2, 3]).toString("base64"));
});

test("a char limit that is not a multiple of 4 still cuts on a boundary", () => {
  const out = formatWsPayload("BINARY", new Uint8Array(600).fill(0x41), opts(0, 99));
  assert.equal(out.raw.length, 96);
  assert.doesNotThrow(() => Buffer.from(out.raw, "base64"));
});
