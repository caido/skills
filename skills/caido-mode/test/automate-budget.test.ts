import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateAutomateRequests } from "../lib/commands/automate.ts";

const list = (length: number) => ({ options: { __typename: "AutomateSimpleListPayload", list: Array(length).fill("x") } });
const settings = (strategy: string, counts: number[], placeholders = 2) => ({
  strategy,
  payloads: counts.map(list),
  placeholders: Array.from({ length: placeholders }, (_, i) => ({ start: i * 2, end: i * 2 + 1 })),
  retryOnFailure: { maximumRetries: 0 },
  redirect: { max: 0 },
});

test("Automate strategy budgets match documented placeholder combinations", () => {
  // Two placeholders with three values: All/Parallel send three, Sequential
  // sends six, and a two-set Matrix sends nine.
  assert.equal(estimateAutomateRequests(settings("ALL", [3])), 3);
  assert.equal(estimateAutomateRequests(settings("SEQUENTIAL", [3])), 6);
  assert.equal(estimateAutomateRequests(settings("PARALLEL", [3, 3])), 3);
  assert.equal(estimateAutomateRequests(settings("MATRIX", [3, 3])), 9);
  assert.equal(estimateAutomateRequests(settings("SEQUENTIAL", [100], 100)), 10000);
});

test("Automate budgets account for retries and redirects", () => {
  const value = settings("SEQUENTIAL", [3]);
  value.retryOnFailure.maximumRetries = 2;
  value.redirect.max = 1;
  assert.equal(estimateAutomateRequests(value), 36);
});

test("Ambiguous strategies and invalid finite sources cannot bypass a budget", () => {
  assert.throws(() => estimateAutomateRequests(settings("OTHER", [3])), /unknown payload strategy/);
  assert.throws(() => estimateAutomateRequests(settings("SEQUENTIAL", [3], 0)), /placeholder count/);
  assert.throws(() => estimateAutomateRequests(settings("SEQUENTIAL", [3, 3])), /single payload set/);
  assert.throws(() => estimateAutomateRequests(settings("PARALLEL", [2, 3])), /equal counts/);
  const value = settings("ALL", [3]);
  value.retryOnFailure.maximumRetries = -1;
  assert.throws(() => estimateAutomateRequests(value), /nonnegative integers/);
  const unknown = { ...settings("ALL", [1]), payloads: [{ options: { __typename: "AutomateHostedFilePayload", id: "1" } }] };
  assert.throws(() => estimateAutomateRequests(unknown), /Cannot bound this payload source/);
});
