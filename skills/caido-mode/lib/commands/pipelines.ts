/** Native Replay pipelines: sequential, last-byte and single-packet execution. */

import { getClient } from "../client";
import { getGraph, integer, fail, type Graph } from "../capabilities";
import { printResult, type ResultOutputOpts } from "../output";
import { resolveCollectionId } from "./replay";

export interface PipelineCreateOpts extends ResultOutputOpts {
  requests: string[];
  name: string;
  strategy?: string;
  collection?: string;
  maxRequests?: number;
}

export interface PipelineRunOpts extends ResultOutputOpts {
  maxRequests?: number;
}

export function pipelineStrategy(kind: string = "sequential"): Record<string, unknown> {
  if (kind === "sequential") return { sequential: { abortOnFailure: true } };
  if (kind === "last-byte") return { lastByteSynchronization: { failureBehavior: "ABORT_ON_PARTIAL" } };
  if (kind === "single-packet") {
    return { singlePacketAttack: { failureBehavior: "ABORT_ON_PARTIAL", convertToHttp2: true } };
  }
  fail("Strategy must be sequential, last-byte or single-packet");
}

const SESSION_TYPES = ["ReplaySessionHttpPipeline", "ReplaySessionHttpOnePipeline"];
const ENTRY_TYPES = ["ReplayEntryHttpPipeline", "ReplayEntryHttpOnePipeline"];

export function pipelineRunFields(g: Pick<Graph, "types">): string {
  const entries = ENTRY_TYPES.filter((type) => g.types.has(type));
  const fragments = SESSION_TYPES.filter((type) => g.types.has(type)).map((type) =>
    `... on ${type} {activeEntry {__typename ${entries.map((entry) =>
      `... on ${entry} {httpEntries {id}}`).join(" ")}}}`);
  return `__typename id name ${fragments.join(" ")}`;
}

export function pipelineRequestCount(session: any): number {
  if (!session || !SESSION_TYPES.includes(session.__typename))
    fail("An existing HTTP pipeline session is required", "INVALID_INPUT");
  const members = session.activeEntry?.httpEntries;
  if (!Array.isArray(members) || members.length < 2)
    fail("Pipeline must have at least two active HTTP entries", "BUDGET_UNKNOWN");
  return members.length;
}

export function checkPipelineRequestBudget(session: any, maxRequests?: number): number {
  const count = pipelineRequestCount(session);
  if (count > integer(maxRequests, 20, 2, 100))
    fail("Configured pipeline exceeds request budget; increase the explicit limit or narrow its members", "BUDGET_EXCEEDED");
  return count;
}

export async function cmdCreatePipeline(opts: PipelineCreateOpts) {
  const client = await getClient();
  const ids = opts.requests.map((id) => id.trim()).filter(Boolean);
  if (ids.length < 2 || ids.length > integer(opts.maxRequests, 20, 2, 100))
    fail("Pipeline needs 2..max-requests request IDs");
  if (!opts.name) fail("Pipeline name required");
  const collectionId = opts.collection ? await resolveCollectionId(client, opts.collection) : undefined;
  if (opts.collection && !collectionId) fail(`Collection "${opts.collection}" not found`);
  const g = await getGraph(client);
  const operation = g.choose("mutation", ["createReplayPipelineHttpSession", "createReplayPipelineHttpOneSession"]);
  const result = await g.mutation(operation, {
    input: {
      requestSources: ids.map((id) => ({ id })),
      settings: { strategy: pipelineStrategy(opts.strategy) },
      ...(collectionId ? { collectionId } : {}),
    },
  }, "session {id name} error {__typename}");
  if (!result.session) throw new Error("Create pipeline returned no session");
  await g.mutation("renameReplaySession", { id: result.session.id, name: opts.name }, "session {id name}");
  await printResult({ ...result, session: { ...result.session, name: opts.name }, strategy: opts.strategy ?? "sequential" }, opts);
}

export async function cmdRunPipeline(sessionId: string, opts: PipelineRunOpts = {}) {
  const client = await getClient();
  const g = await getGraph(client);
  const session = await g.query("replaySession", { id: sessionId }, pipelineRunFields(g));
  const estimatedRequests = checkPipelineRequestBudget(session, opts.maxRequests);
  const result = await g.mutation("startReplayTask", { sessionId });
  await printResult({ ...result, estimatedRequests }, opts);
}

export async function cmdGetPipeline(sessionId: string, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  const g = await getGraph(client);
  const sessions = SESSION_TYPES.filter((type) => g.types.has(type));
  const entries = ENTRY_TYPES.filter((type) => g.types.has(type));
  const result = await g.query("replaySession", { id: sessionId },
    `__typename id name ${sessions.map((type) => `... on ${type} {
      settings {strategy {${g.selection("PipelineStrategy", 2)}}}
      activeEntry {id ${entries.map((entry) => `... on ${entry} {
        error httpEntries {id error request {id host path response {statusCode length}}}
      }`).join(" ")}}
    }`).join(" ")}`);
  if (!result || !sessions.includes(result.__typename)) throw new Error(`HTTP pipeline ${sessionId} not found`);
  await printResult(result, opts);
}

export async function cmdDeletePipeline(sessionId: string, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  const g = await getGraph(client);
  const session = await g.query("replaySession", { id: sessionId }, "__typename id");
  if (!session || !SESSION_TYPES.includes(session.__typename)) throw new Error(`HTTP pipeline ${sessionId} not found`);
  await client.replay.sessions.delete([sessionId]);
  await printResult({ deleted: sessionId }, opts);
}
