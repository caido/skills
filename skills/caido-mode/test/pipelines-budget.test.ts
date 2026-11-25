import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchema, introspectionFromSchema, parse, validate } from "graphql";
import { pipelineRunFields, checkPipelineRequestBudget } from "../lib/commands/pipelines.ts";

test("Pipeline run count selections validate on both schema variants", () => {
  for (const variant of ["HttpPipeline", "HttpOnePipeline"]) {
    const schema = buildSchema(`
      interface ReplaySession {id: ID!, name: String!}
      type ReplaySession${variant} implements ReplaySession {id: ID!, name: String!, activeEntry: ReplayEntry}
      interface ReplayEntry {id: ID!}
      type ReplayEntry${variant} implements ReplayEntry {id: ID!, httpEntries: [HttpEntry!]!}
      type HttpEntry {id: ID!}
      type Query {replaySession(id: ID!): ReplaySession}
    `);
    const data = introspectionFromSchema(schema);
    const g = { types: new Map(data.__schema.types.map((type) => [type.name, type])) };
    const document = parse(`query {replaySession(id: "1") {${pipelineRunFields(g)}}}`);
    assert.deepEqual(validate(schema, document), []);
  }
});

test("Pipeline run enforces the actual stored member count", () => {
  const session = { __typename: "ReplaySessionHttpPipeline", activeEntry: { httpEntries: Array(21).fill({ id: "1" }) } };
  assert.throws(() => checkPipelineRequestBudget(session), /request budget/);
  assert.equal(checkPipelineRequestBudget(session, 21), 21);
  assert.throws(() => checkPipelineRequestBudget({ ...session, __typename: "ReplaySessionHttp" }), /HTTP pipeline session/);
  assert.throws(() => checkPipelineRequestBudget({ ...session, activeEntry: null }), /at least two active/);
});
