import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { Client } from "@caido/sdk-client";
import { buildSchema, introspectionFromSchema } from "graphql";

const previousEnv = Object.fromEntries(["CAIDO_CONFIG", "CAIDO_MODE_HOME", "CAIDO_URL", "CAIDO_PAT"].map(key => [key, process.env[key]]));
const directory = join(tmpdir(), `caido-workflow-unit-${randomUUID()}`);
process.env.CAIDO_CONFIG = join(directory, "secrets.json");
process.env.CAIDO_MODE_HOME = directory;
process.env.CAIDO_URL = "http://fixture.invalid:8080";
process.env.CAIDO_PAT = "fixture";
const { cmdTestWorkflow, cmdRunWorkflow, cmdBuildWorkflow, cmdGetWorkflow } = await import("../lib/commands/workflows.ts");
const fixture = new Client({ url: process.env.CAIDO_URL });
const workflows = Object.getPrototypeOf(fixture.workflow);
const requests = Object.getPrototypeOf(fixture.request);

after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.ok(directory.startsWith(join(tmpdir(), "caido-workflow-unit-")));
  await rm(directory, { recursive: true, force: true });
});

test("convert test/run preserve binary bytes with --raw and keep text defaults", async t => {
  t.mock.method(Client.prototype, "connect", async () => {});
  const bytes = Uint8Array.from([255, 0, 65]);
  t.mock.method(workflows, "get", async () => ({ id: "1", kind: "CONVERT" }));
  t.mock.method(workflows, "test", async () => ({ output: bytes }));
  t.mock.method(workflows, "run", async () => ({ output: bytes }));
  const output: any[] = [];
  t.mock.method(console, "log", value => output.push(JSON.parse(String(value))));
  await cmdTestWorkflow({ kind: "convert", graph: {} }, { data: new Uint8Array() });
  await cmdTestWorkflow({ kind: "convert", graph: {} }, { data: new Uint8Array(), raw: true });
  await cmdRunWorkflow("1", { data: new Uint8Array() });
  await cmdRunWorkflow("1", { data: new Uint8Array(), raw: true });
  assert.equal(output[0].output, "\ufffd\u0000A");
  assert.equal(output[2].output, output[0].output);
  for (const index of [1, 3]) {
    assert.equal(output[index].output.encoding, "base64");
    assert.deepEqual(Buffer.from(output[index].output.data, "base64"), Buffer.from(bytes));
  }
});

test("an explicit response overrides captured response data in HTTP workflow tests", async t => {
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(requests, "get", async () => ({
    request: { host: "fixture.invalid", port: 80, isTls: false, raw: Buffer.from("captured request") },
    response: { raw: Buffer.from("captured response") },
  }));
  let received: Uint8Array | undefined;
  t.mock.method(workflows, "test", async options => { received = options.response.raw; return {}; });
  t.mock.method(console, "log", () => {});
  const response = Buffer.from("explicit response");
  await cmdTestWorkflow({ kind: "passive", graph: {} }, { requestId: "1", response });
  assert.deepEqual(received, response);
});

test("build/get emit runnable workflow definitions with code over 5000 characters", async t => {
  t.mock.method(Client.prototype, "connect", async () => {});
  const schema = buildSchema("scalar JsonObject type Definition {raw: JsonObject!} type Query {workflowNodeDefinitions: [Definition!]!}");
  const nodes = [
    { id: "caido/convert-start", name: "Start", version: "0.1.0", workflows: ["convert"], data: { outputs: [{ alias: "data" }] } },
    { id: "caido/code-js", name: "JavaScript", version: "2.0.0", workflows: ["convert"], data: { outputs: [{ alias: "data" }] } },
    { id: "caido/convert-end", name: "End", version: "0.1.0", workflows: ["convert"], data: { outputs: [] } },
  ];
  t.mock.method(Object.getPrototypeOf(fixture.graphql), "query", async document =>
    document.definitions.some(definition => definition.name?.value === "IntrospectionQuery")
      ? introspectionFromSchema(schema)
      : { workflowNodeDefinitions: nodes.map(raw => ({ raw })) });
  const printed: any[] = [];
  t.mock.method(console, "log", value => printed.push(JSON.parse(String(value))));
  const code = "export function run({data}){return data;} //" + "x".repeat(6000);
  await cmdBuildWorkflow({ name: "large code", code });
  const definition = printed[0];
  assert.equal(definition.graph.nodes[1].inputs[0].value.data, code);
  t.mock.method(workflows, "get", async () => ({ id: "1", kind: "CONVERT", definition }));
  await cmdGetWorkflow("1");
  assert.equal(printed[1].definition.graph.nodes[1].inputs[0].value.data, code);
});
