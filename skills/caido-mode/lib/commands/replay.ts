/** Replay, Edit, Sessions, Collections, Automate/Fuzz commands */

import { getClient } from "../client";
import { decodeRaw, formatHttpRaw } from "../output";
import {
  CREATE_AUTOMATE_SESSION,
  GET_AUTOMATE_SESSION,
  START_AUTOMATE_TASK,
} from "../graphql";
import type { OutputOpts } from "../types";

// ── Shared helpers ──

/** Connection override options parsed from CLI */
export interface ConnectionOverrides {
  sni?: string;
  connectHost?: string;
  connectPort?: number;
  connectTls?: boolean;
}

/**
 * Resolve raw HTTP request value, handling @file, stdin, and C-style escapes.
 * Follows curl conventions:
 *   --raw @file.txt       → read from file
 *   --raw -               → read from stdin
 *   --raw "GET / ..."     → process C-style escape sequences (\r \n \t \\)
 */
export async function resolveRaw(raw: string): Promise<string> {
  // @file — read from file (like curl -d @file)
  if (raw.startsWith("@")) {
    const filePath = raw.slice(1);
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    return (await readFile(resolve(filePath), "utf-8"));
  }

  // - — read from stdin (like curl -d @-)
  if (raw === "-") {
    return await readStdin();
  }

  // String value — process C-style escapes then ensure CRLF
  return normalizeRaw(raw);
}

/** Read all of stdin as a string */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Process C-style escape sequences in a raw HTTP string.
 * If the string already contains real CRLF bytes, return as-is.
 * Otherwise interpret: \r → CR, \n → LF, \t → TAB, \\ → backslash
 */
export function normalizeRaw(raw: string): string {
  // If the raw already contains real CR characters, it's fine
  if (raw.includes("\r\n")) return raw;
  // Process C-style escape sequences
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

/** Build connection info with overrides */
function buildConnection(
  host: string,
  port: number,
  isTLS: boolean,
  overrides?: ConnectionOverrides,
) {
  const conn: Record<string, any> = {
    host: overrides?.connectHost ?? host,
    port: overrides?.connectPort ?? port,
    isTLS: overrides?.connectTls ?? isTLS,
  };
  if (overrides?.sni) {
    conn.SNI = overrides.sni;
  }
  return conn;
}

// ── Replay ──

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

  let raw = rawOverride ? await resolveRaw(rawOverride) : decodeRaw(original.request.raw);
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

  const output: Record<string, any> = {
    sessionId: session.id,
    status: result.status,
    error: result.error,
  };

  if (result.entry) {
    output.entryId = result.entry.id;
    if (result.entry.request) {
      output.requestId = result.entry.request.id;
    }
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

  console.log(JSON.stringify(output, null, 2));
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
  const rawB64 = btoa(raw);

  const connection = buildConnection(host, port, tls, overrides);

  const createOpts: any = {
    requestSource: {
      raw: rawB64,
      connection,
    },
  };
  if (collectionId) createOpts.collectionId = collectionId;

  const session = await client.replay.sessions.create(createOpts);

  if (sessionName) {
    await client.replay.sessions.rename(session.id, sessionName);
  }

  const result = await client.replay.send(session.id, { raw, connection });

  const output: Record<string, any> = {
    sessionId: session.id,
    status: result.status,
    error: result.error,
  };

  if (result.entry) {
    output.entryId = result.entry.id;
    if (result.entry.request) {
      output.requestId = result.entry.request.id;
    }
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

  console.log(JSON.stringify(output, null, 2));
}

// ── Edit ──

export async function cmdEdit(
  requestId: string,
  edits: {
    method?: string;
    path?: string;
    setHeaders: string[];
    removeHeaders: string[];
    body?: string;
    replacements: string[];
  },
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

  let raw = decodeRaw(original.request.raw);
  if (!raw) {
    console.error("No raw data for this request");
    process.exit(1);
  }

  // Apply replacements
  for (const rep of edits.replacements) {
    const [from, to] = rep.split(":::");
    if (from && to !== undefined) {
      raw = raw.replaceAll(from, to);
    }
  }

  // Parse request line and headers
  const lineEnd = raw.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
  const parts = raw.split(lineEnd + lineEnd);
  const headerBlock = parts[0];
  let bodyPart = parts.slice(1).join(lineEnd + lineEnd);

  const headerLines = headerBlock.split(lineEnd);
  let requestLine = headerLines[0];
  let headers = headerLines.slice(1);

  // Modify method
  if (edits.method) {
    const spaceIdx = requestLine.indexOf(" ");
    if (spaceIdx > 0) {
      requestLine = edits.method + requestLine.substring(spaceIdx);
    }
  }

  // Modify path
  if (edits.path) {
    const firstSpace = requestLine.indexOf(" ");
    const lastSpace = requestLine.lastIndexOf(" ");
    if (firstSpace > 0 && lastSpace > firstSpace) {
      requestLine = requestLine.substring(0, firstSpace + 1) + edits.path + requestLine.substring(lastSpace);
    }
  }

  // Remove headers
  for (const name of edits.removeHeaders) {
    headers = headers.filter(h => !h.toLowerCase().startsWith(name.toLowerCase() + ":"));
  }

  // Set headers
  for (const header of edits.setHeaders) {
    const colonIdx = header.indexOf(":");
    if (colonIdx > 0) {
      const name = header.substring(0, colonIdx).trim();
      headers = headers.filter(h => !h.toLowerCase().startsWith(name.toLowerCase() + ":"));
      headers.push(header.trim());
    }
  }

  // Set body
  if (edits.body !== undefined) {
    bodyPart = edits.body;
    // Update Content-Length
    const clBytes = new TextEncoder().encode(bodyPart).length;
    headers = headers.filter(h => !h.toLowerCase().startsWith("content-length:"));
    headers.push(`Content-Length: ${clBytes}`);
  }

  const modifiedRaw = [requestLine, ...headers].join(lineEnd) + lineEnd + lineEnd + bodyPart;

  const createOpts: any = { requestSource: { id: requestId } };
  if (collectionId) createOpts.collectionId = collectionId;
  const session = await client.replay.sessions.create(createOpts);

  const connection = buildConnection(
    original.request.host,
    original.request.port,
    original.request.isTls,
    overrides,
  );

  const result = await client.replay.send(session.id, { raw: modifiedRaw, connection });

  const output: Record<string, any> = {
    sessionId: session.id,
    status: result.status,
    error: result.error,
  };

  if (!opts.noRequest) {
    output.modifiedRequest = formatHttpRaw(modifiedRaw, opts);
  }

  if (result.entry) {
    output.entryId = result.entry.id;
    if (result.entry.request) {
      output.requestId = result.entry.request.id;
    }
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

  console.log(JSON.stringify(output, null, 2));
}

// ── Sessions ──

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
  const createOpts: any = { requestSource: { id: requestId } };
  if (collectionId) createOpts.collectionId = collectionId;
  const session = await client.replay.sessions.create(createOpts);
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

export async function cmdDeleteSessions(ids: string[]) {
  const client = await getClient();
  await client.replay.sessions.delete(ids);
  console.log(JSON.stringify({ deleted: ids }, null, 2));
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

export async function cmdSessionEntries(sessionId: string, limit: number, includeRaw: boolean) {
  const client = await getClient();
  const session = await client.replay.sessions.get(sessionId);
  if (!session) {
    console.error(`Session ${sessionId} not found`);
    process.exit(1);
  }

  let builder = session.entries();
  if (includeRaw) {
    builder = builder.includeRaw({ request: true, response: true, replay: false });
  }
  const connection = await builder.first(limit);

  const results = connection.edges.map(e => {
    const entry: Record<string, any> = {
      id: e.node.id,
      sessionId: e.node.sessionId,
      createdAt: e.node.createdAt,
      error: e.node.error,
    };

    if (e.node.connection) {
      entry.connection = {
        host: e.node.connection.host,
        port: e.node.connection.port,
        isTLS: e.node.connection.isTLS,
        ...(e.node.connection.SNI ? { SNI: e.node.connection.SNI } : {}),
      };
    }

    if (e.node.request) {
      entry.request = {
        id: e.node.request.id,
        method: e.node.request.method,
        host: e.node.request.host,
        port: e.node.request.port,
        path: e.node.request.path,
        isTls: e.node.request.isTls,
      };
    }

    if (e.node.response) {
      entry.response = {
        statusCode: e.node.response.statusCode,
        roundtrip: e.node.response.roundtripTime,
        length: e.node.response.length,
      };
    }

    return entry;
  });

  console.log(JSON.stringify({
    sessionId,
    sessionName: session.name,
    activeEntryId: session.activeEntryId,
    results,
    count: results.length,
  }, null, 2));
}

// ── Collections ──

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

// ── Automate / Fuzz ──

export async function cmdCreateAutomateSession(requestId: string) {
  const client = await getClient();
  const result = await client.graphql.mutation(CREATE_AUTOMATE_SESSION, {
    input: { requestSource: { id: requestId } },
  });
  console.log(JSON.stringify((result as any).createAutomateSession.session, null, 2));
}

export async function cmdFuzz(sessionId: string, payloads: string[]) {
  const client = await getClient();

  // Verify session exists and get its current state
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

  // Start fuzzing
  const startResult = await client.graphql.mutation(START_AUTOMATE_TASK, { automateSessionId: sessionId });
  const task = (startResult as any).startAutomateTask.automateTask;

  console.log(JSON.stringify({
    sessionId,
    taskId: task.id,
    status: "started",
  }, null, 2));
}
