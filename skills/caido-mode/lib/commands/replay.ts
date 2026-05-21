/** Replay, Edit, Sessions, Collections, Automate/Fuzz commands */

import { getClient } from "../client";
import { decodeRaw, formatHttpRaw } from "../output";
import {
  CREATE_AUTOMATE_SESSION,
  GET_AUTOMATE_SESSION,
  START_AUTOMATE_TASK,
  CREATE_REPLAY_SESSION_RAW,
} from "../graphql";
import type { OutputOpts } from "../types";
import type { ConnectionInfoInput } from "@caido/sdk-client";

export interface ConnectionOverrides {
  sni?: string;
  connectHost?: string;
  connectPort?: number;
  connectTls?: boolean;
}

interface RawEdits {
  method?: string;
  path?: string;
  setHeaders: string[];
  removeHeaders: string[];
  body?: string;
  replacements: string[];
}

function buildConnection(host: string, port: number, isTLS: boolean, overrides?: ConnectionOverrides): ConnectionInfoInput {
  const connection: ConnectionInfoInput = {
    host: overrides?.connectHost ?? host,
    port: overrides?.connectPort ?? port,
    isTLS: overrides?.connectTls ?? isTLS,
  };
  if (overrides?.sni) connection.SNI = overrides.sni;
  return connection;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function resolveRaw(raw: string): Promise<string> {
  if (raw === "-") return readStdin();

  if (raw.startsWith("@")) {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    return readFile(resolve(raw.slice(1)), "utf-8");
  }

  return normalizeRaw(raw);
}

export function normalizeRaw(raw: string): string {
  if (raw.includes("\r\n")) return raw;
  return raw.replace(/\\([rnt\\])/g, (_, ch) => {
    switch (ch) {
      case "r": return "\r";
      case "n": return "\n";
      case "t": return "\t";
      case "\\": return "\\";
      default: return ch;
    }
  });
}

function applyRawEdits(raw: string, edits: RawEdits): string {
  for (const rep of edits.replacements) {
    const [from, to] = rep.split(":::");
    if (from && to !== undefined) raw = raw.replaceAll(from, to);
  }

  const lineEnd = raw.includes("\r\n") ? "\r\n" : "\n";
  const separator = lineEnd + lineEnd;
  const parts = raw.split(separator);
  const headerBlock = parts[0];
  let bodyPart = parts.slice(1).join(separator);

  const headerLines = headerBlock.split(lineEnd);
  let requestLine = headerLines[0];
  let headers = headerLines.slice(1);

  if (edits.method) {
    const spaceIdx = requestLine.indexOf(" ");
    if (spaceIdx > 0) requestLine = edits.method + requestLine.substring(spaceIdx);
  }

  if (edits.path) {
    const firstSpace = requestLine.indexOf(" ");
    const lastSpace = requestLine.lastIndexOf(" ");
    if (firstSpace > 0 && lastSpace > firstSpace) {
      requestLine = requestLine.substring(0, firstSpace + 1) + edits.path + requestLine.substring(lastSpace);
    }
  }

  for (const name of edits.removeHeaders) {
    headers = headers.filter(h => !h.toLowerCase().startsWith(name.toLowerCase() + ":"));
  }

  for (const header of edits.setHeaders) {
    const colonIdx = header.indexOf(":");
    if (colonIdx > 0) {
      const name = header.substring(0, colonIdx).trim();
      headers = headers.filter(h => !h.toLowerCase().startsWith(name.toLowerCase() + ":"));
      headers.push(header.trim());
    }
  }

  if (edits.body !== undefined) {
    bodyPart = edits.body;
    const clBytes = new TextEncoder().encode(bodyPart).length;
    headers = headers.filter(h => !h.toLowerCase().startsWith("content-length:"));
    headers.push(`Content-Length: ${clBytes}`);
  }

  return [requestLine, ...headers].join(lineEnd) + separator + bodyPart;
}

async function resolveSession(client: any, idOrName: string) {
  try {
    const byId = await client.replay.sessions.get(idOrName);
    if (byId) return byId;
  } catch {}

  let after: string | undefined;
  while (true) {
    const page = after
      ? await client.replay.sessions.list().after(after, 100)
      : await client.replay.sessions.list().first(100);

    for (const edge of page.edges) {
      if (edge.node.name === idOrName) return edge.node;
    }

    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }

  return undefined;
}

function buildReplayOutput(sessionId: string, result: any, opts: OutputOpts, modifiedRaw?: string) {
  const output: Record<string, any> = {
    sessionId,
    status: result.status,
    error: result.error,
  };

  if (modifiedRaw !== undefined && !opts.noRequest) {
    output.modifiedRequest = formatHttpRaw(modifiedRaw, opts);
  }

  if (result.entry) {
    output.entryId = result.entry.id;
    if (result.entry.request) output.requestId = result.entry.request.id;
    if (result.entry.response) {
      output.response = {
        statusCode: result.entry.response.statusCode,
        roundtrip: result.entry.response.roundtripTime,
        length: result.entry.response.length,
      };
      if (result.entry.response.raw) {
        output.response.raw = formatHttpRaw(decodeRaw(result.entry.response.raw), opts);
      }
    }
  }

  return output;
}

async function createRawReplaySession(
  client: any,
  raw: string,
  connection: ConnectionInfoInput,
  collectionId?: string,
) {
  const input: Record<string, any> = {
    requestSource: {
      raw: {
        connectionInfo: connection,
        raw: Buffer.from(raw, "utf-8").toString("base64"),
      },
    },
  };
  if (collectionId) input.collectionId = collectionId;

  const createResult = await client.graphql.mutation(CREATE_REPLAY_SESSION_RAW, { input });
  return (createResult as any).createReplaySession.session;
}

// -- Replay --

export async function cmdReplay(
  requestId: string,
  rawOverride: string | undefined,
  opts: OutputOpts,
  overrides?: ConnectionOverrides,
  collectionId?: string,
) {
  const client = await getClient();
  const original = await client.request.get(requestId, { raw: true });
  if (!original) {
    console.error(`Request ${requestId} not found`);
    process.exit(1);
  }

  const createOpts: any = { requestSource: { id: requestId } };
  if (collectionId) createOpts.collectionId = collectionId;
  const session = await client.replay.sessions.create(createOpts);

  const raw = rawOverride ? await resolveRaw(rawOverride) : decodeRaw(original.request.raw);
  if (!raw) {
    console.error("No raw data for this request");
    process.exit(1);
  }

  const connection = buildConnection(
    original.request.host,
    original.request.port,
    original.request.isTls,
    overrides,
  );

  const result = await client.replay.send(session.id, { raw, connection });
  console.log(JSON.stringify(buildReplayOutput(session.id, result, opts), null, 2));
}

export async function cmdSendRaw(
  host: string,
  port: number,
  tls: boolean,
  raw: string,
  opts: OutputOpts,
  overrides?: ConnectionOverrides,
  collectionId?: string,
  sessionName?: string,
) {
  const client = await getClient();
  raw = await resolveRaw(raw);

  const connection = buildConnection(host, port, tls, overrides);
  const session = await createRawReplaySession(client, raw, connection, collectionId);

  if (sessionName) await client.replay.sessions.rename(session.id, sessionName);

  const result = await client.replay.send(session.id, { raw, connection });
  console.log(JSON.stringify(buildReplayOutput(session.id, result, opts), null, 2));
}

// -- Edit --

export async function cmdEdit(
  requestId: string,
  edits: RawEdits & { sessionId?: string },
  opts: OutputOpts,
  overrides?: ConnectionOverrides,
  collectionId?: string,
) {
  const client = await getClient();
  const original = await client.request.get(requestId, { raw: true });
  if (!original) {
    console.error(`Request ${requestId} not found`);
    process.exit(1);
  }

  const raw = decodeRaw(original.request.raw);
  if (!raw) {
    console.error("No raw data for this request");
    process.exit(1);
  }

  const modifiedRaw = applyRawEdits(raw, edits);
  const session = edits.sessionId
    ? { id: edits.sessionId }
    : await client.replay.sessions.create({
      requestSource: { id: requestId },
      ...(collectionId ? { collectionId } : {}),
    });

  const connection = buildConnection(
    original.request.host,
    original.request.port,
    original.request.isTls,
    overrides,
  );

  const result = await client.replay.send(session.id, { raw: modifiedRaw, connection });
  console.log(JSON.stringify(buildReplayOutput(session.id, result, opts, modifiedRaw), null, 2));
}

export async function cmdGetSession(sessionIdOrName: string, opts: OutputOpts) {
  const client = await getClient();
  const session = await resolveSession(client, sessionIdOrName);
  if (!session) {
    console.error(`Replay session "${sessionIdOrName}" not found`);
    process.exit(1);
  }

  const output: Record<string, any> = {
    id: session.id,
    name: session.name,
    collectionId: session.collectionId,
    activeEntryId: session.activeEntryId,
  };

  if (session.activeEntryId) {
    const entry = await client.replay.entries.get(session.activeEntryId);
    if (entry) output.activeEntry = formatReplayEntry(entry, opts, true);
  }

  console.log(JSON.stringify(output, null, 2));
}

export async function cmdReplayEntries(
  sessionIdOrName: string,
  limit: number,
  opts: OutputOpts,
  includeRaw: boolean,
) {
  const client = await getClient();
  const session = await resolveSession(client, sessionIdOrName);
  if (!session) {
    console.error(`Replay session "${sessionIdOrName}" not found`);
    process.exit(1);
  }

  const connection = await session.entries()
    .includeRaw(includeRaw ? { request: true, response: true, replay: true } : false)
    .first(limit);

  const results = connection.edges.map((e: any) => formatReplayEntry(e.node, opts, includeRaw));

  console.log(JSON.stringify({
    sessionId: session.id,
    sessionName: session.name,
    activeEntryId: session.activeEntryId,
    results,
    count: results.length,
  }, null, 2));
}

export async function cmdEditSession(
  sessionIdOrName: string,
  edits: RawEdits,
  opts: OutputOpts,
  overrides?: ConnectionOverrides,
) {
  const client = await getClient();
  const session = await resolveSession(client, sessionIdOrName);
  if (!session) {
    console.error(`Replay session "${sessionIdOrName}" not found`);
    process.exit(1);
  }

  if (!session.activeEntryId) {
    console.error(`Session ${session.id} has no active entry`);
    process.exit(1);
  }

  const entry = await client.replay.entries.get(session.activeEntryId);
  if (!entry?.raw) {
    console.error(`Could not get raw data for active entry ${session.activeEntryId}`);
    process.exit(1);
  }

  const raw = decodeRaw(entry.raw);
  if (!raw) {
    console.error("No raw data for the active entry");
    process.exit(1);
  }

  const modifiedRaw = applyRawEdits(raw, edits);
  const connection = buildConnection(
    entry.connection.host,
    entry.connection.port,
    entry.connection.isTLS,
    overrides,
  );

  const result = await client.replay.send(session.id, { raw: modifiedRaw, connection });
  console.log(JSON.stringify(buildReplayOutput(session.id, result, opts, modifiedRaw), null, 2));
}

function formatReplayEntry(entry: any, opts: OutputOpts, includeRaw: boolean) {
  const output: Record<string, any> = {
    id: entry.id,
    sessionId: entry.sessionId,
    createdAt: entry.createdAt,
    error: entry.error,
    connection: entry.connection ? {
      host: entry.connection.host,
      port: entry.connection.port,
      isTLS: entry.connection.isTLS,
      ...(entry.connection.SNI ? { SNI: entry.connection.SNI } : {}),
    } : undefined,
  };

  if (entry.request) {
    output.request = {
      id: entry.request.id,
      method: entry.request.method,
      host: entry.request.host,
      port: entry.request.port,
      path: entry.request.path,
      query: entry.request.query || undefined,
      isTls: entry.request.isTls,
    };
  }

  if (entry.response) {
    output.response = {
      statusCode: entry.response.statusCode,
      roundtrip: entry.response.roundtripTime,
      length: entry.response.length,
    };
  }

  if (includeRaw) {
    if (entry.raw) output.raw = formatHttpRaw(decodeRaw(entry.raw), opts);
    if (entry.request?.raw) output.request.raw = formatHttpRaw(decodeRaw(entry.request.raw), opts);
    if (entry.response?.raw) output.response.raw = formatHttpRaw(decodeRaw(entry.response.raw), opts);
  }

  return output;
}

// -- Sessions --

export async function cmdReplaySessions(limit: number) {
  const client = await getClient();
  const connection = await client.replay.sessions.list().first(limit);

  const results = connection.edges.map(e => ({
    id: e.node.id,
    name: e.node.name,
    collectionId: e.node.collectionId,
    activeEntryId: e.node.activeEntryId,
  }));

  console.log(JSON.stringify({ results, count: results.length }, null, 2));
}

export async function cmdCreateSession(requestId: string, collectionId?: string) {
  const client = await getClient();
  const session = await client.replay.sessions.create({
    requestSource: { id: requestId },
    ...(collectionId ? { collectionId } : {}),
  });
  console.log(JSON.stringify({
    id: session.id,
    name: session.name,
    collectionId: session.collectionId,
  }, null, 2));
}

export async function cmdRenameSession(sessionId: string, name: string) {
  const client = await getClient();
  await client.replay.sessions.rename(sessionId, name);
  console.log(JSON.stringify({ id: sessionId, name, renamed: true }, null, 2));
}

export async function cmdMoveSession(sessionId: string, collectionId: string) {
  const client = await getClient();
  const session = await client.replay.sessions.move(sessionId, collectionId);
  console.log(JSON.stringify({
    id: session.id,
    name: session.name,
    collectionId: session.collectionId,
    moved: true,
  }, null, 2));
}

export async function cmdDeleteSessions(ids: string[]) {
  const client = await getClient();
  await client.replay.sessions.delete(ids);
  console.log(JSON.stringify({ deleted: ids }, null, 2));
}

// -- Collections --

export async function cmdReplayCollections(limit: number) {
  const client = await getClient();
  const connection = await client.replay.collections.list().first(limit);

  const results = connection.edges.map(e => ({
    id: e.node.id,
    name: e.node.name,
  }));

  console.log(JSON.stringify({ results, count: results.length }, null, 2));
}

export async function cmdCreateCollection(name: string) {
  const client = await getClient();
  const collection = await client.replay.collections.create({ name });
  console.log(JSON.stringify({ id: collection.id, name: collection.name }, null, 2));
}

export async function cmdRenameCollection(collectionId: string, name: string) {
  const client = await getClient();
  await client.replay.collections.rename(collectionId, name);
  console.log(JSON.stringify({ id: collectionId, name, renamed: true }, null, 2));
}

export async function cmdDeleteCollection(collectionId: string) {
  const client = await getClient();
  await client.replay.collections.delete(collectionId);
  console.log(JSON.stringify({ deleted: collectionId }, null, 2));
}

// -- Automate / Fuzz --

export async function cmdCreateAutomateSession(requestId: string) {
  const client = await getClient();
  const result = await client.graphql.mutation(CREATE_AUTOMATE_SESSION, {
    input: { requestSource: { id: requestId } },
  });
  console.log(JSON.stringify((result as any).createAutomateSession.session, null, 2));
}

export async function cmdFuzz(sessionId: string, payloads: string[]) {
  const client = await getClient();

  const check = await client.graphql.query(GET_AUTOMATE_SESSION, { id: sessionId });
  const session = (check as any).automateSession;
  if (!session) {
    console.error(`Automate session ${sessionId} not found`);
    process.exit(1);
  }

  console.log(JSON.stringify({
    note: "Starting automate task with existing session settings. Configure payloads in Caido UI.",
    sessionId,
  }, null, 2));

  const startResult = await client.graphql.mutation(START_AUTOMATE_TASK, { automateSessionId: sessionId });
  const task = (startResult as any).startAutomateTask.automateTask;

  console.log(JSON.stringify({
    sessionId,
    taskId: task.id,
    status: "started",
  }, null, 2));
}
