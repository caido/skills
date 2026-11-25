import { test } from "node:test";
import assert from "node:assert/strict";
import { getAutomateResults } from "../lib/commands/automate.ts";

test("Automate results fetch one bounded page from the newest of many runs", async () => {
  const metadata = Array.from({ length: 1000 }, (_, index) => ({ id: String(index), createdAt: 1793944272639 + index * 1000 })).reverse();
  const calls: Array<{ name: string; args: any; fields: string }> = [];
  const result = await getAutomateResults({ query: async (name, args, fields) => {
    calls.push({ name, args, fields: fields! });
    if (name === "automateSession") return { id: "session", entries: metadata };
    assert.equal(args!.id, "999");
    assert.match(fields!, /requests\(first:3,after:"cursor"\)/);
    return { id: "999", requests: { edges: Array.from({ length: 3 }, () => ({ node: {} })) } };
  } }, "session", { limit: 3, after: "cursor" });
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].fields.includes("requests"));
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].requests.edges.length, 3);
});

test("An exact Automate entry is checked against its session before rows are read", async () => {
  let calls = 0;
  await assert.rejects(() => getAutomateResults({ query: async (_name, _args, fields) => {
    calls++;
    assert.ok(!fields!.includes("requests"));
    return { id: "entry", session: { id: "other-session" } };
  } }, "session", { entry: "entry" }), /does not belong/);
  assert.equal(calls, 1);
});

test("Ambiguous run timestamps need an exact entry, and empty sessions need no row query", async () => {
  const g = { query: async () => ({ id: "session", entries: [
    { id: "one", createdAt: "2026-01-01T00:00:00Z" },
    { id: "two", createdAt: "2026-01-01T00:00:00Z" },
  ] }) };
  await assert.rejects(() => getAutomateResults(g, "session"), /exact --entry/);
  assert.deepEqual(await getAutomateResults({ query: async () => ({ entries: [] }) }, "session"), { id: "session", entries: [] });
  const single = await getAutomateResults({ query: async name => name === "automateSession"
    ? { entries: [{ id: "only" }] } : { id: "only", requests: { edges: [] } } }, "session");
  assert.equal(single.entries[0].id, "only");
});
