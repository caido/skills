/** Bounded binary output must obey the same cap as text output. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bounded, printResult } from "../lib/output.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("output keeps version/date and caps body data", () => {
  assert.deepEqual(bounded({ version: "1", output: "abcdef", createdAt: new Date(0) }, { "max-body-chars": 3 }), {
    version: "1",
    output: { text: "abc", truncated: true, totalChars: 6 },
    createdAt: "1970-01-01T00:00:00.000Z",
  });
});

test("zero keeps text and binary output unlimited, as for the original body limit", () => {
  const bytes = Uint8Array.from({ length: 10000 }, () => 255);
  assert.deepEqual(bounded({ body: "x".repeat(10000), frame: bytes }, { "max-body-chars": 0 }), {
    body: "x".repeat(10000),
    frame: { encoding: "base64", data: Buffer.from(bytes).toString("base64") },
  });
});

test("binary output caps its encoded data instead of bypassing the output limit", () => {
  const bytes = Uint8Array.from({ length: 10000 }, (_, i) => i % 256);
  const encoded = Buffer.from(bytes).toString("base64");
  assert.deepEqual(bounded({ frame: bytes }, { "max-body-chars": 16 }), {
    frame: {
      encoding: "base64",
      data: { text: encoded.slice(0, 16), truncated: true, totalChars: encoded.length },
    },
  });
});

test("small binary output preserves every byte and empty output remains empty", () => {
  const bytes = Uint8Array.from([0, 128, 255]);
  assert.deepEqual(bounded(bytes), { encoding: "base64", data: "AID/" });
  assert.deepEqual(bounded(new Uint8Array()), { encoding: "base64", data: "" });
});

test("plain public JSON preserves underscore and graphql keys", () => {
  assert.deepEqual(bounded({
    strategy: { __typename: "PipelineStrategySinglePacketAttack", _id: "member", failureBehavior: "ABORT_ON_PARTIAL" },
    graphql: "public-value",
  }), {
    strategy: { __typename: "PipelineStrategySinglePacketAttack", _id: "member", failureBehavior: "ABORT_ON_PARTIAL" },
    graphql: "public-value",
  });
});

test("artifact output keeps complete normalized binary data and public JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "caido-mode-output-"));
  const path = join(directory, "result.json");
  const previousLog = console.log;
  const output: string[] = [];
  console.log = value => output.push(String(value));
  try {
    await printResult({ raw: Uint8Array.from([0, 128, 255]), body: "abcdef", createdAt: new Date(0), size: 3n, _id: "public", graphql: "public" }, { output: path, maxBodyChars: 1 });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      raw: { encoding: "base64", data: "AID/" }, body: "abcdef", createdAt: "1970-01-01T00:00:00.000Z", size: "3", _id: "public", graphql: "public",
    });
    assert.deepEqual(JSON.parse(output.join("\n")), { outputFile: path });
  } finally {
    console.log = previousLog;
    await rm(directory, { recursive: true, force: true });
  }
});
