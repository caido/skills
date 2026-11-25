/** Intercept commands: status, enable, disable */

import { getClient } from "../client";
import { INTERCEPT_OPTIONS_QUERY, PAUSE_INTERCEPT, RESUME_INTERCEPT } from "../graphql";
import type { Graph } from "../capabilities";
import { printResult, decodeStreamFrames, type ResultOutputOpts } from "../output";

export interface InterceptMessageOpts extends ResultOutputOpts {
  kind?: string;
  limit?: number;
  after?: string;
}

export interface InterceptForwardOpts extends ResultOutputOpts {
  kind?: string;
  raw?: Uint8Array;
}

interface InterceptFilterInput {
  HTTPQL?: { code: string };
  streamQL?: { code: string };
}

export interface InterceptOptionsPatch {
  request?: { enabled?: boolean; filter?: InterceptFilterInput | null };
  response?: { enabled?: boolean; filter?: InterceptFilterInput | null };
  scope?: { scopeId?: string | null };
  streamWs?: { enabled?: boolean };
}

const OPTIONS_FIELDS = "request {enabled filter {__typename ... on HTTPQL {code} ... on StreamQL {code}}} response {enabled filter {__typename ... on HTTPQL {code} ... on StreamQL {code}}} scope {scopeId} streamWs {enabled}";

export async function cmdInterceptStatus(clientOverride?: Awaited<ReturnType<typeof getClient>>) {
  const client = clientOverride ?? await getClient();
  try {
    const result = await client.graphql.query(INTERCEPT_OPTIONS_QUERY, {});
    console.log(JSON.stringify({ ...(result as any).interceptOptions, status: (result as any).interceptStatus }, null, 2));
  } catch (err: any) {
    console.log(JSON.stringify({ error: err.message, hint: "Intercept may not be available" }, null, 2));
    process.exitCode = 1;
  }
}

export async function cmdInterceptSet(enabled: boolean, clientOverride?: Awaited<ReturnType<typeof getClient>>) {
  const client = clientOverride ?? await getClient();
  try {
    // Pausing forwarding queues matching traffic for interception. Resuming
    // forwarding turns interception off; the options' enabled flags alone do not.
    const mutation = enabled ? PAUSE_INTERCEPT : RESUME_INTERCEPT;
    const result = await client.graphql.mutation(mutation, {});
    const key = enabled ? "pauseIntercept" : "resumeIntercept";
    console.log(JSON.stringify((result as any)[key], null, 2));
  } catch (err: any) {
    console.error(`Failed to ${enabled ? "enable" : "disable"} intercept: ${err.message}`);
    process.exitCode = 1;
  }
}

async function interceptMessages(g: Graph, opts: InterceptMessageOpts, includeRaw: boolean) {
  const { pageArgs, connectionPage } = await import("../capabilities");
  const kind = { request: "REQUEST", response: "RESPONSE", ws: "STREAM_WS", stream_ws: "STREAM_WS" }[opts.kind ?? "request"];
  if (!kind) throw new Error("Intercept kind must be request, response or ws");
  const result = await g.query("interceptMessages", { ...pageArgs(opts), kind },
    `edges {node {id __typename
      ... on InterceptRequestMessage {request {id host method path ${includeRaw ? "raw" : ""}}}
      ... on InterceptResponseMessage {request {id} response {id statusCode ${includeRaw ? "raw" : ""}}}
      ... on InterceptStreamWsMessage {message {id head {direction format length ${includeRaw ? "raw" : ""}}}}
    }} pageInfo {hasNextPage endCursor}`);
  return connectionPage(result);
}

export async function cmdInterceptMessages(opts: InterceptMessageOpts = {}) {
  const client = await getClient();
  const { getGraph } = await import("../capabilities");
  const g = await getGraph(client);
  await printResult(await interceptMessages(g, opts, false), opts);
}

export async function cmdGetInterceptMessage(messageId: string, opts: InterceptMessageOpts = {}) {
  const client = await getClient();
  const { getGraph } = await import("../capabilities");
  const g = await getGraph(client);
  const page = await interceptMessages(g, opts, true);
  const message = page.items.find((item: any) => item.id === messageId);
  if (!message) throw new Error("Message not on this queue page; supply its kind and the cursor from intercept-messages --after");
  await printResult(decodeStreamFrames(message, true), opts);
}

export function mergeInterceptOptions(current: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  for (const [key, value] of Object.entries(patch)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid intercept option key");
    // A filter is a oneOf input: switching HTTPQL/StreamQL replaces that value,
    // rather than retaining the previous branch and producing an invalid union.
    current[key] = key !== "filter" && value && typeof value === "object" && !Array.isArray(value)
      ? mergeInterceptOptions(current[key] ?? {}, value)
      : value;
  }
  return current;
}

export async function cmdSetInterceptOptions(patch: InterceptOptionsPatch, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  const { getGraph } = await import("../capabilities");
  const g = await getGraph(client);
  const current = await g.query("interceptOptions", {}, OPTIONS_FIELDS);
  for (const key of ["request", "response"]) {
    const filter = current[key].filter;
    if (filter) current[key].filter = {
      [filter.__typename === "HTTPQL" ? "HTTPQL" : "streamQL"]: { code: filter.code },
    };
  }
  const result = await g.mutation("setInterceptOptions", { input: mergeInterceptOptions(current, patch) });
  await printResult(result, opts);
}

export async function cmdForwardInterceptMessage(messageId: string, opts: InterceptForwardOpts = {}) {
  const client = await getClient();
  const { getGraph } = await import("../capabilities");
  const g = await getGraph(client);
  let input: Record<string, unknown> | undefined;
  if (opts.raw !== undefined) {
    const kind = { request: "request", response: "response", ws: "streamWs" }[opts.kind ?? "request"];
    if (!kind) throw new Error("Intercept kind must be request, response or ws");
    input = { [kind]: {
      updateRaw: Buffer.from(opts.raw).toString("base64"),
      ...(kind === "streamWs" ? {} : { updateContentLength: true }),
    } };
  }
  await printResult(await g.mutation("forwardInterceptMessage", {
    id: messageId,
    ...(input ? { input } : {}),
  }), opts);
}

export async function cmdDropInterceptMessage(messageId: string, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  const { getGraph } = await import("../capabilities");
  const g = await getGraph(client);
  await printResult(await g.mutation("dropInterceptMessage", { id: messageId }), opts);
}
