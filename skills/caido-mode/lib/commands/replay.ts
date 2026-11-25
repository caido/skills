/** Replay, Edit, Sessions, Collections, Automate/Fuzz commands */

import { getClient } from "../client";
import { decodeRaw, formatHttpRaw, splitRaw, printResult, type ResultOutputOpts } from "../output";
import {
  CREATE_AUTOMATE_SESSION,
  CREATE_REPLAY_SESSION_RAW,
  RENAME_REPLAY_SESSION,
  MOVE_REPLAY_SESSION,
} from "../graphql";
import type { OutputOpts } from "../types";
import type { ConnectionInfoInput } from "@caido/sdk-client";

export interface ConnectionOverrides {
  sni?: string;
  connectHost?: string;
  connectPort?: number;
  connectTls?: boolean;
}

/**
 * Editing a replay session is an explicit, named operation: the caller must
 * declare intent — keep the current name (--no-name-change/--nonach) or set a
 * new one (--new-name). This prevents silently leaving a stale auto-name.
 */
export type NameChange = { kind: "keep" } | { kind: "rename"; name: string };

export interface RawEdits {
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

/**
 * Normalize a raw request's HEADER line endings to CRLF, so a replay session
 * created from scratch is never built with bare-LF (\n) line endings. Only the
 * header section is touched; the body is left byte-exact (it may legitimately
 * contain \n, e.g. JSON or multipart). Idempotent — re-running is a no-op.
 */
export function ensureHeaderCrlf(raw: string): string {
  const { headerBlock, body } = splitRaw(raw);
  // Collapse any CRLF to LF, then promote every LF to CRLF — handles bare-LF and
  // mixed endings without doubling existing CRLFs.
  const headers = headerBlock.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  return body === undefined ? headers : headers + "\r\n\r\n" + body;
}

export function applyRawEdits(raw: string, edits: RawEdits): string {
  for (const rep of edits.replacements) {
    const [from, to] = rep.split(":::");
    if (from && to !== undefined) raw = raw.replaceAll(from, to);
  }

  // Header/body boundary = the FIRST blank line (CRLF or LF, whichever comes first),
  // and the line ending is derived from the header block — never from body content,
  // so a body that contains \r\n\r\n (e.g. multipart) can't be mistaken for the split.
  const { headerBlock, body: splitBody, sep } = splitRaw(raw);
  let bodyPart = splitBody ?? "";
  const lineEnd = sep === "\r\n\r\n" ? "\r\n" : sep === "\n\n" ? "\n" : (raw.includes("\r\n") ? "\r\n" : "\n");
  let hasBody = sep !== undefined;

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
    hasBody = true;
  }

  const head = [requestLine, ...headers].join(lineEnd);
  // Only re-attach a body section if the request actually had one (or one was set);
  // don't graft a spurious blank line + empty body onto a body-less request.
  return hasBody ? head + lineEnd + lineEnd + bodyPart : head;
}

interface ReplayGraph {
  types: Map<string, any>;
  query(name: string, args: Record<string, any>, selection?: string): Promise<any>;
}

const nativeSessionClients = new WeakMap<object, Promise<ReplayGraph>>();
const nativeSessionGraphs = new WeakMap<object, ReplayGraph>();

async function replayGraph(client?: any): Promise<ReplayGraph> {
  // Most HTTP commands never load discovery or read its cache. Only sessions the
  // SDK cannot deserialize take this path (pipeline and WebSocket sessions).
  const { getGraph } = await import("../capabilities");
  return getGraph(client);
}

function concreteTypes(g: ReplayGraph, name: string): any[] {
  const type = g.types.get(name);
  if (!type) throw new Error(`Instance does not expose ${name}`);
  return type.possibleTypes?.map((t: any) => g.types.get(t.name)) ?? [type];
}

/** Select variant fields only on the concrete types exposed by this instance. */
export function replaySessionFields(g: ReplayGraph): string {
  return `__typename id name ${concreteTypes(g, "ReplaySession").map((t) => {
    const fields = new Set(t.fields?.map((f: any) => f.name));
    const selection = [
      fields.has("collection") ? "collection {id}" : "",
      fields.has("activeEntry") ? "activeEntry {id}" : "",
    ].filter(Boolean).join(" ");
    return selection ? `... on ${t.name} {${selection}}` : "";
  }).join(" ")}`;
}

function nativeSession(node: any, g: ReplayGraph): any {
  if (!node) return undefined;
  const session = {
    id: node.id,
    name: node.name,
    collectionId: node.collection?.id,
    activeEntryId: node.activeEntry?.id,
    __typename: node.__typename,
  };
  nativeSessionGraphs.set(session, g);
  return session;
}

/** Retain the SDK fast path for ordinary HTTP sessions and older Caido versions. */
export async function getReplaySession(client: any, id: string, graphFactory = replayGraph): Promise<any> {
  if (!nativeSessionClients.has(client)) {
    try {
      return await client.replay.sessions.get(id);
    } catch (err) {
      // SDK 0.5.2 assumes data.collection exists, but its GraphQL fragment only
      // selects it on HTTP sessions. Transport/permission errors should surface.
      if (!(err instanceof TypeError)) throw err;
      nativeSessionClients.set(client, graphFactory(client));
    }
  }
  const g = await nativeSessionClients.get(client)!;
  return nativeSession(await g.query("replaySession", { id }, replaySessionFields(g)), g);
}

export async function getReplaySessionPage(client: any, after: string | undefined, first: number, graphFactory = replayGraph): Promise<any> {
  if (!nativeSessionClients.has(client)) {
    try {
      return await (after
        ? client.replay.sessions.list().after(after).first(first)
        : client.replay.sessions.list().first(first));
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      nativeSessionClients.set(client, graphFactory(client));
    }
  }
  const g = await nativeSessionClients.get(client)!;
  const page = await g.query("replaySessions", { after, first },
    `edges {node {${replaySessionFields(g)}}} pageInfo {hasNextPage endCursor}`);
  return { ...page, edges: page.edges.map((e: any) => ({ ...e, node: nativeSession(e.node, g) })) };
}

async function renameReplaySession(client: any, id: string, name: string): Promise<void> {
  const result = await client.graphql.mutation(RENAME_REPLAY_SESSION, { id, name });
  if (!result.renameReplaySession?.session) throw new Error(`Replay session ${id} could not be renamed`);
}

/** Preserve the familiar HTTP output while adding the native pipeline/WS shapes. */
export function replayEntryFields(g: ReplayGraph, includeRaw: boolean): string {
  const http = `connection {host port isTLS SNI} ${includeRaw ? "raw" : ""}
    request {id method host port path query isTls ${includeRaw ? "raw" : ""}
      response {statusCode roundtripTime length ${includeRaw ? "raw" : ""}}}`;
  return `__typename id createdAt error session {id} ${concreteTypes(g, "ReplayEntry").map((t) => {
    const fields = new Set(t.fields?.map((f: any) => f.name));
    if (fields.has("httpEntries"))
      return `... on ${t.name} {httpEntries {id createdAt error session {id} ${http}}}`;
    if (fields.has("messages"))
      return `... on ${t.name} {http {id createdAt error session {id} ${http}}
        stream {id} messages {id head {direction format length ${includeRaw ? "raw" : ""}}}}`;
    if (fields.has("request")) return `... on ${t.name} {${http}}`;
    return "";
  }).join(" ")}`;
}

export function decodeReplayEntry(node: any): any {
  if (!node) return undefined;
  const decode = (value: any) => typeof value === "string" ? Buffer.from(value, "base64") : value;
  return {
    ...node,
    sessionId: node.session?.id,
    raw: decode(node.raw),
    request: node.request ? { ...node.request, raw: decode(node.request.raw) } : undefined,
    response: node.request?.response ? { ...node.request.response, raw: decode(node.request.response.raw) } : undefined,
    ...(node.httpEntries ? { httpEntries: node.httpEntries.map(decodeReplayEntry) } : {}),
    ...(node.http ? { http: decodeReplayEntry(node.http) } : {}),
    ...(node.messages ? { messages: node.messages.map((m: any) => ({
      id: m.id,
      head: { ...m.head, ...(m.head?.raw !== undefined ? { raw: decode(m.head.raw) } : {}) },
    })) } : {}),
  };
}

export function replaySessionKind(g: ReplayGraph, typename: string): string {
  if (typename === "ReplaySessionWs") return "WS";
  if (!typename.includes("Pipeline")) return "HTTP";
  const values = new Set(g.types.get("ReplaySessionKind")?.enumValues?.map((v: any) => v.name));
  const kind = ["HTTP_PIPELINE", "HTTP_ONE_PIPELINE"].find((v) => values.has(v));
  if (!kind) throw new Error("Instance does not expose a pipeline replay session kind");
  return kind;
}

async function nativeReplayEntry(g: ReplayGraph, id: string, includeRaw: boolean, sessionType: string): Promise<any> {
  const sessionKind = replaySessionKind(g, sessionType);
  return decodeReplayEntry(await g.query("replayEntry", { id, sessionKind }, replayEntryFields(g, includeRaw)));
}

async function nativeSessionEntries(g: ReplayGraph, id: string, first: number, includeRaw: boolean): Promise<any> {
  if (!Number.isInteger(first) || first < 0) throw new Error("Entry limit must be a nonnegative integer");
  const fragments = concreteTypes(g, "ReplaySession")
    .filter((t) => t.fields?.some((f: any) => f.name === "entries"))
    .map((t) => `... on ${t.name} {entries(first: ${first}) {
      edges {node {${replayEntryFields(g, includeRaw)}}} pageInfo {hasNextPage endCursor}
    }}`).join(" ");
  const session = await g.query("replaySession", { id }, `id ${fragments}`);
  if (!session) throw new Error(`Replay session ${id} not found`);
  if (!session.entries) throw new Error(`Replay session ${id} does not expose entries`);
  return { ...session.entries, edges: session.entries.edges.map((e: any) => ({ ...e, node: decodeReplayEntry(e.node) })) };
}

function requireHttpSession(session: any): void {
  if (session.__typename && session.__typename !== "ReplaySessionHttp" && session.__typename !== "ReplaySession") {
    throw new Error(`Session ${session.id} is ${session.__typename}; HTTP edit requires an HTTP replay session`);
  }
}

async function resolveSession(client: any, idOrName: string) {
  try {
    const byId = await getReplaySession(client, idOrName);
    if (byId) return byId;
  } catch {}

  let after: string | undefined;
  while (true) {
    const page = await getReplaySessionPage(client, after, 100);

    for (const edge of page.edges) {
      if (edge.node.name === idOrName) return edge.node;
    }

    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }

  return undefined;
}

/**
 * Resolve a collection by id OR name to its id. Collections are referred to by
 * name in this workflow, so `--collection "My Collection"` is the norm. Returns
 * undefined if no collection matches (callers should error and tell the user to
 * create it explicitly — collection names are mandatory and never auto-created).
 */
export async function resolveCollectionId(client: any, idOrName: string): Promise<string | undefined> {
  let after: string | undefined;
  while (true) {
    const page = after
      ? await client.replay.collections.list().after(after).first(100)
      : await client.replay.collections.list().first(100);

    for (const edge of page.edges) {
      if (edge.node.id === idOrName || edge.node.name === idOrName) return edge.node.id;
    }

    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return undefined;
}

/** Resolve a --collection ref to an id, exiting with guidance if it doesn't exist. */
async function requireCollection(client: any, ref: string | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  const id = await resolveCollectionId(client, ref);
  if (!id) {
    console.error(`Collection "${ref}" not found.`);
    console.error(`List collections:  npx tsx caido-client.ts collections`);
    console.error(`Create it (name is mandatory):  npx tsx caido-client.ts create-collection "${ref}"`);
    process.exit(1);
  }
  return id;
}

/** Apply a NameChange to a just-touched session, returning the effective name. */
async function applyNameChange(client: any, sessionId: string, current: string | undefined, change: NameChange): Promise<string | undefined> {
  if (change.kind === "rename") {
    await renameReplaySession(client, sessionId, change.name);
    return change.name;
  }
  return current;
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
  // A session built from scratch must never carry bare-LF header endings.
  raw = ensureHeaderCrlf(raw);
  const input: Record<string, any> = {
    kind: "HTTP", // required since Caido 0.57 (ReplaySessionKind)
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
  name: string,
  opts: OutputOpts,
  overrides?: ConnectionOverrides,
  collectionRef?: string,
) {
  const client = await getClient();
  const original = await client.request.get(requestId, { raw: true });
  if (!original) {
    console.error(`Request ${requestId} not found`);
    process.exit(1);
  }

  const collectionId = await requireCollection(client, collectionRef);
  const createOpts: any = { requestSource: { id: requestId } };
  if (collectionId) createOpts.collectionId = collectionId;
  const session = await client.replay.sessions.create(createOpts);
  await renameReplaySession(client, session.id, name);

  let raw = rawOverride ? await resolveRaw(rawOverride) : decodeRaw(original.request.raw);
  if (!raw) {
    console.error("No raw data for this request");
    process.exit(1);
  }
  // A user-supplied raw override is normalized to CRLF header endings.
  if (rawOverride) raw = ensureHeaderCrlf(raw);

  const connection = buildConnection(
    original.request.host,
    original.request.port,
    original.request.isTls,
    overrides,
  );

  const result = await client.replay.send(session.id, { raw, connection });
  console.log(JSON.stringify({ sessionName: name, ...buildReplayOutput(session.id, result, opts) }, null, 2));
}

export async function cmdSendRaw(
  host: string,
  port: number,
  tls: boolean,
  raw: string,
  name: string,
  opts: OutputOpts,
  overrides?: ConnectionOverrides,
  collectionRef?: string,
) {
  const client = await getClient();
  // Normalize header line endings once so the session and the sent bytes match.
  raw = ensureHeaderCrlf(await resolveRaw(raw));

  const collectionId = await requireCollection(client, collectionRef);
  const connection = buildConnection(host, port, tls, overrides);
  const session = await createRawReplaySession(client, raw, connection, collectionId);
  await renameReplaySession(client, session.id, name);

  const result = await client.replay.send(session.id, { raw, connection });
  console.log(JSON.stringify({ sessionName: name, ...buildReplayOutput(session.id, result, opts) }, null, 2));
}

// -- Edit --

export type EditTarget =
  | { kind: "new"; name: string; collectionRef?: string }
  | { kind: "session"; ref: string; nameChange: NameChange };

export async function cmdEdit(
  requestId: string,
  edits: RawEdits,
  target: EditTarget,
  opts: OutputOpts,
  overrides?: ConnectionOverrides,
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

  let sessionId: string;
  let sessionName: string | undefined;
  if (target.kind === "new") {
    const collectionId = await requireCollection(client, target.collectionRef);
    const session = await client.replay.sessions.create({
      requestSource: { id: requestId },
      ...(collectionId ? { collectionId } : {}),
    });
    await renameReplaySession(client, session.id, target.name);
    sessionId = session.id;
    sessionName = target.name;
  } else {
    const session = await resolveSession(client, target.ref);
    if (!session) {
      console.error(`Replay session "${target.ref}" not found`);
      process.exit(1);
    }
    requireHttpSession(session);
    sessionId = session.id;
    sessionName = await applyNameChange(client, session.id, session.name, target.nameChange);
  }

  const connection = buildConnection(
    original.request.host,
    original.request.port,
    original.request.isTls,
    overrides,
  );

  const result = await client.replay.send(sessionId, { raw: modifiedRaw, connection });
  console.log(JSON.stringify({ sessionName, ...buildReplayOutput(sessionId, result, opts, modifiedRaw) }, null, 2));
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
    const g = nativeSessionGraphs.get(session);
    const entry = g
      ? await nativeReplayEntry(g, session.activeEntryId, true, session.__typename)
      : await client.replay.entries.get(session.activeEntryId);
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

  const g = nativeSessionGraphs.get(session);
  const connection = g
    ? await nativeSessionEntries(g, session.id, limit, includeRaw)
    : await session.entries()
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
  nameChange: NameChange,
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

  requireHttpSession(session);

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
  const sessionName = await applyNameChange(client, session.id, session.name, nameChange);
  console.log(JSON.stringify({ sessionName, ...buildReplayOutput(session.id, result, opts, modifiedRaw) }, null, 2));
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

  if (entry.httpEntries) {
    output.httpEntries = entry.httpEntries.map((e: any) => formatReplayEntry(e, opts, includeRaw));
  }
  if (entry.http) output.http = formatReplayEntry(entry.http, opts, includeRaw);
  if (entry.stream) output.streamId = entry.stream.id;
  if (entry.messages) {
    output.messages = entry.messages.map((m: any) => ({
      id: m.id,
      ...m.head,
      ...(m.head?.raw ? { raw: { encoding: "base64", data: Buffer.from(m.head.raw).toString("base64") } } : {}),
    }));
  }

  return output;
}

// -- Pagination helper --

async function paginateSdkList<T>(
  fetchPage: (after: string | undefined, want: number) => PromiseLike<{
    edges: Array<{ node: T }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  }>,
  mapNode: (node: T) => any,
  limit?: number,
): Promise<{ results: any[]; truncated: boolean }> {
  const cap = limit && limit > 0 ? limit : 2000;
  const results: any[] = [];
  let after: string | undefined;
  let truncated = false;
  while (results.length < cap) {
    const want = Math.min(100, cap - results.length);
    const page = await fetchPage(after, want);
    for (const e of page.edges) results.push(mapNode(e.node));
    if (!page.pageInfo.hasNextPage) break;
    if (results.length >= cap) { truncated = true; break; }
    after = page.pageInfo.endCursor ?? undefined;
  }
  return { results, truncated };
}

// -- Sessions --

export async function cmdReplaySessions(limit?: number) {
  const client = await getClient();
  // Sessions can't be sorted (SDK exposes no order field), so a single page can hide
  // recently-created sessions on later pages. Paginate fully (capped) by default.
  const { results, truncated } = await paginateSdkList(
    (after, want) => getReplaySessionPage(client, after, want),
    (n: any) => ({ id: n.id, name: n.name, collectionId: n.collectionId, activeEntryId: n.activeEntryId }),
    limit,
  );
  console.log(JSON.stringify({ results, count: results.length, ...(truncated ? { truncated: true } : {}) }, null, 2));
}

export async function cmdCreateSession(requestId: string, name: string, collectionRef?: string) {
  const client = await getClient();
  const collectionId = await requireCollection(client, collectionRef);
  const session = await client.replay.sessions.create({
    requestSource: { id: requestId },
    ...(collectionId ? { collectionId } : {}),
  });
  await renameReplaySession(client, session.id, name);
  console.log(JSON.stringify({
    id: session.id,
    name,
    collectionId: session.collectionId ?? collectionId ?? null,
  }, null, 2));
}

export async function cmdRenameSession(sessionRef: string, name: string) {
  const client = await getClient();
  const session = await resolveSession(client, sessionRef);
  if (!session) {
    console.error(`Replay session "${sessionRef}" not found`);
    process.exit(1);
  }
  await renameReplaySession(client, session.id, name);
  console.log(JSON.stringify({ id: session.id, name, renamed: true }, null, 2));
}

export async function cmdMoveSession(sessionRef: string, collectionRef: string) {
  const client = await getClient();
  const session = await resolveSession(client, sessionRef);
  if (!session) {
    console.error(`Replay session "${sessionRef}" not found`);
    process.exit(1);
  }
  const collectionId = await requireCollection(client, collectionRef);
  const result = await client.graphql.mutation(MOVE_REPLAY_SESSION, { id: session.id, collectionId });
  const moved = (result as any).moveReplaySession?.session;
  if (!moved) throw new Error(`Replay session ${session.id} could not be moved`);
  console.log(JSON.stringify({
    id: moved.id,
    name: moved.name,
    collectionId,
    moved: true,
  }, null, 2));
}

export async function cmdDeleteSessions(ids: string[]) {
  const client = await getClient();
  await client.replay.sessions.delete(ids);
  console.log(JSON.stringify({ deleted: ids }, null, 2));
}

// -- Collections --

export async function cmdReplayCollections(limit?: number) {
  const client = await getClient();
  const { results, truncated } = await paginateSdkList(
    (after, want) => after
      ? client.replay.collections.list().after(after).first(want)
      : client.replay.collections.list().first(want),
    (n: any) => ({ id: n.id, name: n.name }),
    limit,
  );
  console.log(JSON.stringify({ results, count: results.length, ...(truncated ? { truncated: true } : {}) }, null, 2));
}

export async function cmdCreateCollection(name: string) {
  const client = await getClient();
  const collection = await client.replay.collections.create({ name });
  console.log(JSON.stringify({ id: collection.id, name: collection.name }, null, 2));
}

export async function cmdRenameCollection(collectionRef: string, name: string) {
  const client = await getClient();
  const collectionId = await requireCollection(client, collectionRef);
  await client.replay.collections.rename(collectionId!, name);
  console.log(JSON.stringify({ id: collectionId, name, renamed: true }, null, 2));
}

export async function cmdDeleteCollection(collectionRef: string) {
  const client = await getClient();
  const collectionId = await requireCollection(client, collectionRef);
  await client.replay.collections.delete(collectionId!);
  console.log(JSON.stringify({ deleted: collectionId }, null, 2));
}

// -- Automate / Fuzz --

export async function cmdCreateAutomateSession(requestId: string, opts: ResultOutputOpts & { name?: string } = {}) {
  const client = await getClient();
  const result = await client.graphql.mutation(CREATE_AUTOMATE_SESSION, {
    input: { requestSource: { id: requestId } },
  });
  const session = (result as any).createAutomateSession.session;
  if (!session) throw new Error("Create automate session returned no session");
  if (opts.name) {
    const { getGraph } = await import("../capabilities");
    const g = await getGraph(client);
    await g.mutation("renameAutomateSession", { id: session.id, name: opts.name }, "session {id name}");
    session.name = opts.name;
  }
  await printResult(session, opts);
}

export async function cmdFuzz(sessionId: string, payloads: string[]) {
  // The legacy alias starts the same bounded job as `automate start`. Payloads
  // were historically configured on the session; this argument stays accepted
  // for CLI compatibility and does not silently replace those saved settings.
  const client = await getClient();
  const { startAutomateTask } = await import("./automate");
  const result = await startAutomateTask(client, sessionId);
  const task = result.automateTask;
  if (!task) throw new Error(`Automate session ${sessionId} returned no task`);

  console.log(JSON.stringify({
    note: "Starting automate task with existing session settings.",
    sessionId,
  }, null, 2));

  console.log(JSON.stringify({
    sessionId,
    taskId: task.id,
    status: "started",
    estimatedRequests: result.estimatedRequests,
  }, null, 2));
}
