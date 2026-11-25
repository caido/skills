import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSchema, introspectionFromSchema } from "graphql";

const directory = mkdtempSync(join(tmpdir(), "caido-mode-cache-"));
const cacheHome = join(directory, "cache");
const url = "http://fixture.invalid:8080";
const keys = ["CAIDO_CONFIG", "CAIDO_MODE_HOME", "CAIDO_URL", "CAIDO_PAT"];
const previousEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.CAIDO_CONFIG = join(directory, "secrets.json");
process.env.CAIDO_MODE_HOME = cacheHome;
process.env.CAIDO_URL = url;
delete process.env.CAIDO_PAT;
writeFileSync(process.env.CAIDO_CONFIG, JSON.stringify({ caido: { default: url, instances: {
  [url]: { cachedToken: { accessToken: "cache-fixture-token", expiresAt: new Date(Date.now() + 3600000).toISOString() } },
} } }));
writeFileSync(cacheHome, "Cache cannot create directories under this file.");

const schema = introspectionFromSchema(buildSchema("type Query { ping: String! }"));
const previousFetch = globalThis.fetch;
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const address = String(input);
  calls.push(address);
  const query = init?.body ? JSON.parse(String(init.body)).query : "";
  const body = address.endsWith("/health") ? { name: "fixture", version: "0.58.0", ready: true }
    : { data: query.includes("__schema") ? schema : query.includes("viewer")
      ? { viewer: { __typename: "GuestUser", id: "fixture-user" } } : { ping: "pong" } };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { getGraph } = await import("../lib/capabilities.ts");
const { cmdHealth, cmdAuthStatus } = await import("../lib/commands/info.ts");
const { instanceSlot } = await import("../lib/state.ts");

after(() => {
  globalThis.fetch = previousFetch;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

test("unwritable metadata cache does not turn health or valid auth into failure", async () => {
  const previousLog = console.log;
  const output: string[] = [];
  console.log = value => output.push(String(value));
  try {
    await cmdHealth();
    assert.equal(JSON.parse(output.pop()!).ready, true);
    await cmdAuthStatus();
    assert.equal(JSON.parse(output.pop()!).authenticated, true);
  } finally { console.log = previousLog; }
});

test("schema operations work even when their optional cache cannot be written", async () => {
  calls.length = 0;
  const graph = await getGraph();
  assert.equal(await graph.query("ping"), "pong");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(address => !address.endsWith("/health")));
});

test("corrupt schema metadata is refetched and cached for the next operation", async () => {
  unlinkSync(cacheHome);
  const slot = instanceSlot(url);
  mkdirSync(slot, { recursive: true });
  const path = join(slot, "schema.json");
  for (const invalid of ["{broken-json", JSON.stringify({ unrelated: "wrong shape" })]) {
    writeFileSync(path, invalid);
    calls.length = 0;
    assert.equal(await (await getGraph()).query("ping"), "pong");
    assert.equal(calls.length, 2);
    assert.ok(JSON.parse(readFileSync(path, "utf8")).__schema);
  }
  calls.length = 0;
  assert.equal(await (await getGraph()).query("ping"), "pong");
  assert.equal(calls.length, 1);
});
