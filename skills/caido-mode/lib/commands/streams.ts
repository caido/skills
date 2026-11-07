/** WebSocket stream history commands. */

import { getClient } from "../client";
import { getGraph, pageArgs, connectionPage } from "../capabilities";
import { printResult, decodeStreamFrames, type ResultOutputOpts } from "../output";

export interface StreamOpts extends ResultOutputOpts {
  limit?: number;
  after?: string;
  filter?: string;
  scope?: string;
  raw?: boolean;
}

export async function cmdStreams(opts: StreamOpts = {}) {
  const client = await getClient();
  const g = await getGraph(client);
  const result = await g.query("streams", {
    ...pageArgs(opts),
    order: { by: "ID", ordering: "DESC" },
    ...(opts.filter ? { filter: { code: opts.filter } } : {}),
    ...(opts.scope ? { scopeId: opts.scope } : {}),
  }, "edges {node {id host port path isTls protocol source}} pageInfo {hasNextPage endCursor}");
  await printResult(connectionPage(result), opts);
}

export async function cmdWsMessages(streamId: string, opts: StreamOpts = {}) {
  const client = await getClient();
  const g = await getGraph(client);
  const result = await g.query("streamWsMessages", {
    streamId,
    ...pageArgs(opts),
    ...(opts.filter ? { filter: { code: opts.filter } } : {}),
  }, `edges {node {id head {id direction format length createdAt ${opts.raw ? "raw" : ""}}}} pageInfo {hasNextPage endCursor}`);
  await printResult(decodeStreamFrames(connectionPage(result), !!opts.raw), opts);
}

export async function cmdGetWsMessage(messageId: string, opts: StreamOpts = {}) {
  const client = await getClient();
  const g = await getGraph(client);
  const result = await g.query("streamWsMessage", { id: messageId },
    `id head {id direction format length createdAt ${opts.raw ? "raw" : ""}}`);
  if (!result) throw new Error(`WebSocket message ${messageId} not found`);
  await printResult(decodeStreamFrames(result, !!opts.raw), opts);
}
