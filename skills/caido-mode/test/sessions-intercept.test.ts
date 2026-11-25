import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchema, introspectionFromSchema, parse, validate } from "graphql";
import {
  getReplaySession, getReplaySessionPage, replaySessionFields,
  replayEntryFields, decodeReplayEntry, replaySessionKind,
} from "../lib/commands/replay.ts";
import { cmdInterceptSet, cmdInterceptStatus, mergeInterceptOptions } from "../lib/commands/intercept.ts";
import { RENAME_REPLAY_SESSION, MOVE_REPLAY_SESSION } from "../lib/graphql.ts";

function fixtureSchema(pipeline: "HttpPipeline" | "HttpOnePipeline") {
  const schema = buildSchema(`
    interface ReplaySession { id: ID!, name: String! }
    type ReplaySessionHttp implements ReplaySession {
      id: ID!, name: String!, collection: Collection!, activeEntry: ReplayEntry,
      entries(first: Int): EntryConnection!
    }
    type ReplaySession${pipeline} implements ReplaySession {
      id: ID!, name: String!, collection: Collection!, activeEntry: ReplayEntry,
      entries(first: Int): EntryConnection!
    }
    type ReplaySessionWs implements ReplaySession {
      id: ID!, name: String!, collection: Collection!, activeEntry: ReplayEntry,
      entries(first: Int): EntryConnection!
    }
    interface ReplayEntry { id: ID!, createdAt: String!, error: String, session: ReplaySession! }
    type ReplayEntryHttp implements ReplayEntry {
      id: ID!, createdAt: String!, error: String, session: ReplaySession!,
      connection: Connection!, raw: String!, request: Request
    }
    type ReplayEntry${pipeline} implements ReplayEntry {
      id: ID!, createdAt: String!, error: String, session: ReplaySession!, httpEntries: [ReplayEntryHttp!]!
    }
    type ReplayEntryWs implements ReplayEntry {
      id: ID!, createdAt: String!, error: String, session: ReplaySession!,
      http: ReplayEntryHttp, stream: Stream, messages: [Message!]!
    }
    type Collection {id: ID!}
    type Connection {host: String!, port: Int!, isTLS: Boolean!, SNI: String}
    type Request {id: ID!, method: String!, host: String!, port: Int!, path: String!, query: String!, isTls: Boolean!, raw: String!, response: Response}
    type Response {statusCode: Int!, roundtripTime: Int!, length: Int!, raw: String!}
    type Stream {id: ID!}
    type Message {id: ID!, head: MessageHead!}
    type MessageHead {direction: String!, format: String!, length: Int!, raw: String!}
    type EntryConnection {edges: [EntryEdge!]!, pageInfo: PageInfo!}
    type EntryEdge {node: ReplayEntry!}
    type SessionConnection {edges: [SessionEdge!]!, pageInfo: PageInfo!}
    type SessionEdge {node: ReplaySession!}
    type PageInfo {hasNextPage: Boolean!, endCursor: String}
    enum ReplaySessionKind {HTTP WS ${pipeline === "HttpPipeline" ? "HTTP_PIPELINE" : "HTTP_ONE_PIPELINE"}}
    type Query {
      replaySession(id: ID!): ReplaySession,
      replaySessions(after: String, first: Int): SessionConnection!,
      replayEntry(id: ID!, sessionKind: ReplaySessionKind!): ReplayEntry
    }
    type Payload {session: ReplaySession}
    type Mutation {
      renameReplaySession(id: ID!, name: String!): Payload!,
      moveReplaySession(id: ID!, collectionId: ID!): Payload!
    }
  `);
  const data = introspectionFromSchema(schema);
  return { schema, types: new Map(data.__schema.types.map((t) => [t.name, t])) };
}

test("session and entry selections validate against both pipeline schema variants", () => {
  for (const variant of ["HttpPipeline", "HttpOnePipeline"] as const) {
    const { schema, types } = fixtureSchema(variant);
    const g = { types, query: async () => undefined };
    for (const raw of [false, true]) {
      const doc = parse(`query {
        replaySession(id: "1") {${replaySessionFields(g)}}
        replayEntry(id: "2", sessionKind: ${replaySessionKind(g, "ReplaySession" + variant)}) {${replayEntryFields(g, raw)}}
      }`);
      assert.deepEqual(validate(schema, doc), []);
    }
    assert.deepEqual(validate(schema, RENAME_REPLAY_SESSION), []);
    assert.deepEqual(validate(schema, MOVE_REPLAY_SESSION), []);
    assert.match(replaySessionFields(g), /ReplaySessionWs/);
    assert.match(replayEntryFields(g, false), /httpEntries/);
    assert.ok(!/\braw\b/.test(replayEntryFields(g, false)));
  }
});

test("HTTP session reads and listing keep the SDK path without discovery", async () => {
  const expected = { id: "1", name: "HTTP", collectionId: "2" };
  const page = { edges: [{ node: expected }], pageInfo: { hasNextPage: false } };
  const client = { replay: { sessions: {
    get: async () => expected,
    list: () => ({ first: async () => page }),
  } } };
  const noDiscovery = async () => { throw new Error("HTTP path must not discover schema"); };
  assert.equal(await getReplaySession(client, "1", noDiscovery), expected);
  assert.equal(await getReplaySessionPage(client, undefined, 10, noDiscovery), page);
});

test("mixed sessions recover from SDK deserialization once and retain metadata", async () => {
  let sdkCalls = 0, discoveries = 0;
  const client = { replay: { sessions: {
    get: async () => { sdkCalls++; throw new TypeError("Cannot read properties of undefined (reading 'id')"); },
    list: () => { throw new Error("A recovered client should keep using native metadata"); },
  } } };
  const { types } = fixtureSchema("HttpPipeline");
  const node = { __typename: "ReplaySessionHttpPipeline", id: "3", name: "race", collection: { id: "4" }, activeEntry: { id: "5" } };
  const g = { types, query: async (operation: string) => operation === "replaySession"
    ? node : { edges: [{ node }], pageInfo: { hasNextPage: false } } };
  const discover = async () => { discoveries++; return g; };
  const session = await getReplaySession(client, "3", discover);
  assert.equal(session.id, "3");
  assert.equal(session.collectionId, "4");
  assert.equal(session.activeEntryId, "5");
  const page = await getReplaySessionPage(client, undefined, 10, discover);
  assert.equal(page.edges[0].node.name, "race");
  assert.equal(sdkCalls, 1);
  assert.equal(discoveries, 1);
});

test("a mixed SDK list can fall back without discarding its cursor", async () => {
  const { types } = fixtureSchema("HttpOnePipeline");
  let received: any;
  const builder = { after: () => builder, first: async () => { throw new TypeError("missing collection"); } };
  const client = { replay: { sessions: { list: () => builder } } };
  const g = { types, query: async (_op: string, args: any) => {
    received = args;
    return { edges: [{ node: { __typename: "ReplaySessionWs", id: "9", name: "socket", collection: { id: "8" } } }],
      pageInfo: { hasNextPage: true, endCursor: "next" } };
  } };
  const page = await getReplaySessionPage(client, "previous", 7, async () => g);
  assert.deepEqual(received, { after: "previous", first: 7 });
  assert.equal(page.edges[0].node.collectionId, "8");
  assert.equal(page.pageInfo.endCursor, "next");
});

test("permission errors surface without attempting schema discovery", async () => {
  const denied = new Error("permission denied");
  const client = { replay: { sessions: { get: async () => { throw denied; } } } };
  await assert.rejects(() => getReplaySession(client, "1", async () => {
    assert.fail("permission errors must not cause retries");
  }), (e) => e === denied);
});

test("native entries decode HTTP responses and binary WebSocket frames", () => {
  const bytes = Buffer.from([0, 255, 13, 10]);
  const entry = decodeReplayEntry({
    id: "1", session: { id: "2" },
    http: { id: "3", session: { id: "2" }, raw: "R0VUIC8=", request: {
      raw: "R0VUIC8=", response: { raw: "SFRUUC8xLjE=", statusCode: 200 },
    } },
    messages: [{ id: "4", head: { format: "BINARY", raw: bytes.toString("base64") } }],
  });
  assert.equal(entry.sessionId, "2");
  assert.equal(entry.http.raw.toString(), "GET /");
  assert.equal(entry.http.response.statusCode, 200);
  assert.equal(entry.http.response.raw.toString(), "HTTP/1.1");
  assert.ok(entry.messages[0].head.raw.equals(bytes));
});

test("intercept enable pauses forwarding and disable resumes it", async (t) => {
  t.mock.method(console, "log", () => {});
  const operations: string[] = [];
  const client = { graphql: { mutation: async (doc: any) => {
    const op = doc.definitions[0].selectionSet.selections[0].name.value;
    operations.push(op);
    return { [op]: { status: op === "pauseIntercept" ? "PAUSED" : "RUNNING" } };
  } } };
  await cmdInterceptSet(true, client as any);
  await cmdInterceptSet(false, client as any);
  assert.deepEqual(operations, ["pauseIntercept", "resumeIntercept"]);
});

test("intercept command errors set a failing exit status", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const previous = process.exitCode;
  const fail = async () => { throw new Error("fixture failure"); };
  const client = { graphql: { query: fail, mutation: fail } };
  try {
    process.exitCode = 0;
    await cmdInterceptSet(true, client as any);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
    await cmdInterceptStatus(client as any);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previous;
  }
});

test("intercept patches preserve scope/options and replace oneOf filters", () => {
  const current = {
    request: { enabled: true, filter: { HTTPQL: { code: "old" } } },
    response: { enabled: false, filter: null },
    scope: { scopeId: "fixture-scope" },
    streamWs: { enabled: true },
  };
  const next = mergeInterceptOptions(current, { request: { filter: { streamQL: { code: "new" } } } });
  assert.deepEqual(next.request.filter, { streamQL: { code: "new" } });
  assert.equal(next.request.enabled, true);
  assert.deepEqual(next.scope, { scopeId: "fixture-scope" });
  assert.deepEqual(next.response, { enabled: false, filter: null });
  assert.deepEqual(next.streamWs, { enabled: true });
  assert.equal(mergeInterceptOptions(next, { request: { filter: null } }).request.filter, null);
});
