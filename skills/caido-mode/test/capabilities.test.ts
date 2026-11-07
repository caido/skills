import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph, capabilities } from "../lib/capabilities.ts";
import { automateSettings } from "../lib/commands/automate.ts";
import { pipelineStrategy } from "../lib/commands/pipelines.ts";
import * as dep from "graphql";
import { buildWorkflow } from "../lib/commands/workflows.ts";
test("both published/live pipeline schemas validate creation and rename before transport", async () => {
  for (const variant of ["Http", "HttpOne"]) {
    const name = "createReplayPipeline" + variant + "Session";
    const schema = dep.buildSchema(
      `type Query { health: Boolean } type Mutation { ${name}(input: CreateReplayPipelineSessionInput!): Payload! renameReplaySession(id: ID!, name: String!): Payload! } input CreateReplayPipelineSessionInput { requestSources: [Source!]!, settings: Settings!, collectionId: ID } input Source {id:ID!} input Settings {strategy:Strategy!} input Strategy {sequential:Sequential} input Sequential {abortOnFailure:Boolean!} type Payload {session:Session error:Error} type Error {code:String} type Session {id:ID! name:String!}`,
    );
    const calls = [],
      client = {
        graphql: {
          mutation: async (doc, vars) => {
            const op =
              doc.definitions[0].selectionSet.selections[0].name.value;
            calls.push({ op, vars });
            return {
              [op]: { session: { id: "7", name: "fixture" }, error: null },
            };
          },
        },
      };
    const g = new Graph({ client }, dep.introspectionFromSchema(schema));
    const result = await g.mutation(name, {input:{requestSources:[{id:"1"},{id:"2"}],settings:{strategy:pipelineStrategy()}}}, "session {id name} error {code}");
    await g.mutation("renameReplaySession", {id:result.session.id,name:"fixture"}, "session {id name}");
    assert.equal(result.session.id, "7");
    assert.deepEqual(
      calls.map((x) => x.op),
      [name, "renameReplaySession"],
    );
    assert.deepEqual(calls[0].vars.input.requestSources, [
      { id: "1" },
      { id: "2" },
    ]);
    await assert.rejects(
      () => g.mutation(name, { input: { requestSources: [{ id: "1" }] } }),
      /settings/,
    );
    assert.equal(calls.length, 2);
  }
});

test("automate byte ranges match multibyte prefixes and enforce budget", () => {
  const s = automateSettings(Buffer.from("雪=FUZZ"), "FUZZ", ["one", "two"]);
  assert.deepEqual(s.placeholders, [{ start: 4, end: 8 }]);
  assert.equal(s.concurrency.workers, 1);
  assert.throws(
    () => automateSettings(Buffer.from("FUZZ"), "FUZZ", Array(101).fill("x")),
    /count/,
  );
  assert.throws(
    () => automateSettings(Buffer.from("none"), "FUZZ", ["x"]),
    /absent/,
  );
});
test("native strategies are explicit, unknown names fail", () => {
  assert.ok(pipelineStrategy("last-byte").lastByteSynchronization);
  assert.ok(pipelineStrategy("single-packet").singlePacketAttack);
  assert.throws(() => pipelineStrategy("parallel"));
});
test("workflow builder selects available node versions and wires data", () => {
  const defs = [
    {
      id: "caido/convert-start",
      name: "start",
      version: "0.1.0",
      workflows: ["convert"],
      data: { outputs: [{ alias: "data" }] },
    },
    {
      id: "caido/code-js",
      name: "js",
      version: "2.0.0",
      workflows: ["convert"],
    },
    {
      id: "caido/convert-end",
      name: "end",
      version: "0.1.0",
      workflows: ["convert"],
    },
  ];
  const d = buildWorkflow(
    { name: "test", code: "export function run({data}) {return data;}" },
    defs,
  );
  assert.equal(d.graph.nodes[1].version, "2.0.0");
  assert.equal(d.graph.nodes[2].inputs[0].value.data, "$check.data");
  assert.equal(d.graph.edges.length, 2);
  assert.throws(
    () => buildWorkflow({ name: "x", kind: "active", code: "x" }, defs),
    /unavailable/,
  );
});
test("schema discovery supports both pipeline API names without guessing", () => {
  for (const name of [
    "createReplayPipelineHttpSession",
    "createReplayPipelineHttpOneSession",
  ]) {
    const schema = dep.buildSchema(`type Query {health:Boolean} type Mutation {${name}:Boolean}`);
    const g = new Graph({} as any, dep.introspectionFromSchema(schema));
    assert.equal(capabilities(g).pipelineOperation, name);
    assert.equal(
      g.choose("mutation", [
        "createReplayPipelineHttpSession",
        "createReplayPipelineHttpOneSession",
      ]),
      name,
    );
  }
});
