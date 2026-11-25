import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@caido/sdk-client";
import { buildSchema, introspectionFromSchema } from "graphql";

const directory = await mkdtemp(join(tmpdir(), "caido-management-pipelines-"));
const keys = ["CAIDO_CONFIG", "CAIDO_MODE_HOME", "CAIDO_URL", "CAIDO_PAT"];
const previousEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.CAIDO_CONFIG = join(directory, "secrets.json");
process.env.CAIDO_MODE_HOME = directory;
process.env.CAIDO_URL = "http://fixture.invalid:8080";
process.env.CAIDO_PAT = "fixture";
const { cmdCreateFilter } = await import("../lib/commands/management.ts");
const { cmdCreatePipeline } = await import("../lib/commands/pipelines.ts");
const fixture = new Client({ url: process.env.CAIDO_URL });
const filters = Object.getPrototypeOf(fixture.filter);
const graphql = Object.getPrototypeOf(fixture.graphql);
const schema = introspectionFromSchema(buildSchema(`
  type Query {health: Boolean}
  type Mutation {
    createReplayPipelineHttpSession(input: CreateInput!): Payload!
    renameReplaySession(id: ID!, name: String!): Payload!
  }
  input CreateInput {requestSources: [Source!]!, settings: Settings!}
  input Source {id: ID!}
  input Settings {strategy: Strategy!}
  input Strategy {sequential: Sequential}
  input Sequential {abortOnFailure: Boolean!}
  type Payload {session: Session, error: Error}
  type Session {id: ID!, name: String!}
  type Error {code: String}
`));

after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

test("derived filter alias collisions require an explicit alias before creation", async t => {
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(filters, "list", async () => [{ name: "QA Prod", alias: "qa-prod" }]);
  const create = t.mock.method(filters, "create", async () => assert.fail("must not create a duplicate alias"));
  await assert.rejects(() => cmdCreateFilter("QA-Prod", "req.method.eq:GET"), /qa-prod.*unique --alias/);
  assert.equal(create.mock.callCount(), 0);
});

test("unused derived aliases and supplied aliases preserve their values", async t => {
  t.mock.method(Client.prototype, "connect", async () => {});
  const list = t.mock.method(filters, "list", async () => []);
  const create = t.mock.method(filters, "create", async input => input);
  t.mock.method(console, "log", () => {});
  await cmdCreateFilter("QA Prod", "query");
  assert.equal(create.mock.calls[0].arguments[0].alias, "qa-prod");
  await cmdCreateFilter("QA-Prod", "query", "qa-prod-custom");
  assert.equal(create.mock.calls[1].arguments[0].alias, "qa-prod-custom");
  assert.equal(list.mock.callCount(), 1, "explicit aliases bypass automatic collision checks");
});

test("pipeline rename failures identify the persisted session as a partial failure", async t => {
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(graphql, "query", async () => schema);
  const operations: string[] = [];
  t.mock.method(graphql, "mutation", async document => {
    const operation = document.definitions[0].selectionSet.selections[0].name.value;
    operations.push(operation);
    if (operation === "renameReplaySession") throw new Error("permission denied");
    return { [operation]: { session: { id: "pipeline-7", name: "Default" } } };
  });
  const print = t.mock.method(console, "log", () => {});
  await assert.rejects(() => cmdCreatePipeline({ requests: ["1", "2"], name: "Named pipeline" }), error => {
    assert.equal((error as Error & { code: string }).code, "PARTIAL_FAILURE");
    assert.match((error as Error).message, /pipeline-7.*created.*rename failed.*permission denied/);
    return true;
  });
  assert.deepEqual(operations, ["createReplayPipelineHttpSession", "renameReplaySession"]);
  assert.equal(print.mock.callCount(), 0);
});

test("successful pipeline creation reports the requested name and persisted ID", async t => {
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(graphql, "query", async () => schema);
  const calls: any[] = [];
  t.mock.method(graphql, "mutation", async (document, variables) => {
    const operation = document.definitions[0].selectionSet.selections[0].name.value;
    calls.push({ operation, variables });
    return { [operation]: { session: { id: "pipeline-8", name: variables.name ?? "Default" } } };
  });
  const print = t.mock.method(console, "log", () => {});
  await cmdCreatePipeline({ requests: ["1", "2"], name: "Named pipeline" });
  assert.deepEqual(calls[1], { operation: "renameReplaySession", variables: { id: "pipeline-8", name: "Named pipeline" } });
  assert.deepEqual(JSON.parse(String(print.mock.calls[0].arguments[0])), {
    session: { id: "pipeline-8", name: "Named pipeline" }, strategy: "sequential",
  });
});
