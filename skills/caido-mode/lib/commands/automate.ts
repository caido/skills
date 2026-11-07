/** Automate payload configuration, bounded starts, results and task control. */

import type { Client } from "@caido/sdk-client";
import { getClient } from "../client";
import { getGraph, pageArgs, connectionPage, integer, fail, type Graph } from "../capabilities";
import { printResult, type ResultOutputOpts } from "../output";

export interface AutomateOpts extends ResultOutputOpts {
  limit?: number;
  after?: string;
  raw?: boolean;
}

export interface AutomateConfigureOpts extends AutomateOpts {
  input?: Record<string, unknown>;
  match?: string;
  payloads?: string[];
  workers?: number;
  delay?: number;
  maxRequests?: number;
}

export interface AutomateStartOpts extends ResultOutputOpts {
  maxRequests?: number;
  maxWorkers?: number;
}

export interface AutomateResultsOpts extends AutomateOpts {
  entry?: string;
}

interface AutomateBuildOpts {
  workers?: number;
  delay?: number;
  maxRequests?: number;
}

export interface AutomateBudgetSettings {
  strategy: string;
  payloads: Array<{ options: Record<string, any> }>;
  placeholders?: Array<{ start: number; end: number }>;
  retryOnFailure?: { maximumRetries: number };
  redirect?: { max: number };
}

export function automateSettings(raw: Uint8Array, match: string, payloads: string[],
  { workers = 1, delay = 0, maxRequests = 100 }: AutomateBuildOpts = {}) {
  if (!match || !Array.isArray(payloads) || payloads.some((value) => typeof value !== "string"))
    fail("Provide a match token and a JSON array of string payloads");
  if (!payloads.length || payloads.length > maxRequests)
    fail(`Payload count must be 1..${maxRequests}`, "BUDGET_EXCEEDED");
  const bytes = Buffer.from(raw);
  const needle = Buffer.from(match);
  const placeholders: Array<{ start: number; end: number }> = [];
  let index = 0;
  while ((index = bytes.indexOf(needle, index)) !== -1) {
    placeholders.push({ start: index, end: index + needle.length });
    index += needle.length;
  }
  if (!placeholders.length) fail("Match token absent from request");
  return {
    payloads: [{ options: { simpleList: { list: payloads } }, preprocessors: [] }],
    placeholders,
    redirect: { strategy: "NEVER", max: 0 },
    strategy: "ALL",
    concurrency: { workers, delay },
    retryOnFailure: { maximumRetries: 0, backoff: 0 },
    closeConnection: false,
    updateContentLength: true,
    extractors: [],
  };
}

export function estimateAutomateRequests(settings: AutomateBudgetSettings): number {
  if (!Array.isArray(settings.payloads)) fail("No finite payloads configured", "BUDGET_UNKNOWN");
  const counts = settings.payloads.map(({ options }) => {
    if (options.__typename === "AutomateSimpleListPayload") return options.list.length;
    if (options.__typename === "AutomateNullPayload") return options.quantity;
    if (options.__typename === "AutomateNumberPayload") {
      if (!Number.isSafeInteger(options.increments) || options.increments <= 0)
        fail("Payload increment must be a positive integer", "BUDGET_UNKNOWN");
      return Math.max(0, Math.floor((options.range.end - options.range.start) / options.increments) + 1);
    }
    fail("Cannot bound this payload source; use an explicit finite list for a CLI-started job", "BUDGET_UNKNOWN");
  });
  if (!counts.length || counts.some((count) => !Number.isSafeInteger(count) || count < 1))
    fail("No finite payloads configured", "BUDGET_UNKNOWN");

  // https://docs.caido.io/app/guides/automate_multiple
  // Sequential sends every value once per placeholder; All shares each value.
  let total: number;
  if (settings.strategy === "ALL" || settings.strategy === "SEQUENTIAL") {
    if (counts.length !== 1)
      fail("All/Sequential requires a single payload set to bound the job", "BUDGET_UNKNOWN");
    const placeholders = settings.placeholders?.length;
    if (settings.strategy === "SEQUENTIAL" && (!Number.isSafeInteger(placeholders) || placeholders! < 1))
      fail("Sequential requires a finite placeholder count", "BUDGET_UNKNOWN");
    total = counts[0] * (settings.strategy === "SEQUENTIAL" ? placeholders! : 1);
  } else if (settings.strategy === "PARALLEL") {
    if (counts.some((count) => count !== counts[0]))
      fail("Parallel payload sets must have equal counts", "BUDGET_UNKNOWN");
    total = counts[0];
  } else if (settings.strategy === "MATRIX") {
    total = counts.reduce((a, b) => a * b, 1);
  } else {
    fail("Cannot bound unknown payload strategy", "BUDGET_UNKNOWN");
  }
  const retries = settings.retryOnFailure?.maximumRetries ?? 0;
  const redirects = settings.redirect?.max ?? 0;
  if (![retries, redirects].every((value) => Number.isSafeInteger(value) && value >= 0))
    fail("Retry and redirect limits must be finite nonnegative integers", "BUDGET_UNKNOWN");
  total *= (1 + retries) * (1 + redirects);
  if (!Number.isSafeInteger(total) || total < 1)
    fail("Configured request count exceeds a finite safe budget", "BUDGET_UNKNOWN");
  return total;
}

export async function cmdAutomateSessions(opts: AutomateOpts = {}) {
  const client = await getClient();
  const g = await getGraph(client);
  const result = await g.query("automateSessions", pageArgs(opts),
    "edges {node {id name}} pageInfo {hasNextPage endCursor}");
  await printResult(connectionPage(result), opts);
}

export async function cmdGetAutomateSession(sessionId: string, opts: AutomateOpts = {}) {
  const client = await getClient();
  const g = await getGraph(client);
  const result = await g.query("automateSession", { id: sessionId },
    `id name connection {host port isTLS SNI} settings {${g.selection("AutomateSettings", 5)}} ${opts.raw ? "raw" : ""}`);
  if (!result) throw new Error(`Automate session ${sessionId} not found`);
  await printResult(result, opts);
}

export async function cmdConfigureAutomateSession(sessionId: string, opts: AutomateConfigureOpts) {
  if (!opts.input && (!opts.match || !Array.isArray(opts.payloads)))
    throw new Error("Provide --input, or both --match and --payloads");
  const client = await getClient();
  const g = await getGraph(client);
  let spec = opts.input;
  if (!spec) {
    const session = await g.query("automateSession", { id: sessionId }, "raw connection {host port isTLS SNI}");
    if (!session) throw new Error(`Automate session ${sessionId} not found`);
    spec = {
      raw: session.raw,
      connection: session.connection,
      settings: automateSettings(Buffer.from(session.raw, "base64"), opts.match!, opts.payloads!, {
        workers: integer(opts.workers, 1, 1, 20),
        delay: integer(opts.delay, 0, 0, 60000),
        maxRequests: integer(opts.maxRequests, 100, 1, 10000),
      }),
    };
  }
  const result = await g.mutation("updateAutomateSession", { id: sessionId, input: spec },
    "session {id name} error {__typename}");
  await printResult(result, opts);
}

/** Shared by the original fuzz alias; checks saved settings before starting. */
export async function startAutomateTask(client: Client, sessionId: string, opts: AutomateStartOpts = {}) {
  const g = await getGraph(client);
  const session = await g.query("automateSession", { id: sessionId },
    "settings {strategy placeholders {start end} concurrency {workers delay} retryOnFailure {maximumRetries} redirect {max} payloads {options {__typename ... on AutomateSimpleListPayload {list} ... on AutomateNullPayload {quantity} ... on AutomateNumberPayload {increments range {start end}}}}}");
  if (!session) throw new Error(`Automate session ${sessionId} not found`);
  const estimatedRequests = estimateAutomateRequests(session.settings);
  const workers = session.settings.concurrency.workers;
  if (estimatedRequests > integer(opts.maxRequests, 100, 1, 10000) ||
    !Number.isSafeInteger(workers) || workers < 1 || workers > integer(opts.maxWorkers, 20, 1, 100)) {
    fail("Configured job exceeds request/worker budget; increase explicit limits or narrow its settings", "BUDGET_EXCEEDED");
  }
  const result = await g.mutation("startAutomateTask", { automateSessionId: sessionId });
  return { ...result, estimatedRequests };
}

export async function cmdStartAutomateTask(sessionId: string, opts: AutomateStartOpts = {}) {
  const client = await getClient();
  await printResult(await startAutomateTask(client, sessionId, opts), opts);
}

export async function cmdAutomateTasks(opts: AutomateOpts = {}) {
  const client = await getClient();
  const g = await getGraph(client);
  const result = await g.query("automateTasks", pageArgs(opts),
    `edges {node {${g.selection("AutomateTask", 3)}}} pageInfo {hasNextPage endCursor}`);
  await printResult(connectionPage(result), opts);
}

export async function getAutomateResults(g: Pick<Graph, "query">, sessionId: string, opts: AutomateResultsOpts = {}) {
  let entryId = opts.entry;
  if (entryId) {
    const entry = await g.query("automateEntry", { id: entryId }, "id session {id}");
    if (!entry || entry.session.id !== sessionId) throw new Error(`Automate entry ${entryId} does not belong to session ${sessionId}`);
  } else {
    const session = await g.query("automateSession", { id: sessionId }, "id entries {id createdAt}");
    if (!session) throw new Error(`Automate session ${sessionId} not found`);
    if (!session.entries.length) return { id: sessionId, entries: [] };
    if (session.entries.length === 1) {
      entryId = session.entries[0].id;
    } else {
      let latest = -Infinity;
      let ambiguous = false;
      for (const entry of session.entries) {
        const timestamp = typeof entry.createdAt === "number" ? entry.createdAt : Date.parse(entry.createdAt);
        if (!Number.isFinite(timestamp)) throw new Error("Run timestamps unavailable; select an exact --entry ID");
        if (timestamp > latest) {
          latest = timestamp;
          entryId = entry.id;
          ambiguous = false;
        } else if (timestamp === latest) {
          ambiguous = true;
        }
      }
      if (ambiguous) throw new Error("Latest runs share a timestamp; select an exact --entry ID");
    }
  }
  const args = Object.entries(pageArgs(opts)).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}:${JSON.stringify(value)}`).join(",");
  const entry = await g.query("automateEntry", { id: entryId },
    `id requests(${args}) {edges {node {error request {id host path response {statusCode length}}}} pageInfo {hasNextPage endCursor}}`);
  if (!entry) throw new Error(`Automate entry ${entryId} not found`);
  return { id: sessionId, entries: [entry] };
}

export async function cmdAutomateResults(sessionId: string, opts: AutomateResultsOpts = {}) {
  const client = await getClient();
  const g = await getGraph(client);
  await printResult(await getAutomateResults(g, sessionId, opts), opts);
}

export async function cmdControlAutomateTask(action: "pause" | "resume" | "cancel", taskId: string, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  const g = await getGraph(client);
  await printResult(await g.mutation(`${action}AutomateTask`, { id: taskId }), opts);
}

export async function cmdDeleteAutomateSession(sessionId: string, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  const g = await getGraph(client);
  await printResult(await g.mutation("deleteAutomateSession", { id: sessionId }), opts);
}
