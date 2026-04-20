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

// ── Resolve session by ID or name ──

async function resolveSession(client: any, idOrName: string) {
  // Try direct ID lookup first (may throw on non-numeric strings)
  try {
    const byId = await client.replay.sessions.get(idOrName);
    if (byId) return byId;
  } catch {
    // ID lookup failed (e.g., non-numeric string) — fall through to name search
  }

  // Fall back to searching by name (paginate in chunks of 100)
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

// ── Replay ──

export async function cmdReplay(requestId: string, rawOverride: string | undefined, opts: OutputOpts) {
  const client = await getClient();

  // Get the original request to extract connection info
  const original = await client.request.get(requestId, { raw: true });
  if (!original) {
    console.error(`Request ${requestId} not found`);
    process.exit(1);
  }

  // Create a temporary replay session
  const session = await client.replay.sessions.create({
    requestSource: { id: requestId },
  });

  const raw = rawOverride || decodeRaw(original.request.raw);
  if (!raw) {
    console.error("No raw data for this request");
    process.exit(1);
  }

  const result = await client.replay.send(session.id, {
    raw,
    connection: {
      host: original.request.host,
      port: original.request.port,
      isTLS: original.request.isTls,
    },
  });

  const output: Record<string, any> = {
    sessionId: session.id,
    status: result.status,
    error: result.error,
  };

  if (result.entry) {
    output.entryId = result.entry.id;
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

export async function cmdSendRaw(host: string, port: number, tls: boolean, raw: string, opts: OutputOpts) {
  const client = await getClient();

  // SDK 0.2.0's sessions.create doesn't base64-encode the raw source, but
  // Caido 0.56+ types it as Blob. Issue the mutation ourselves with an
  // encoded payload; replay.send below handles its own encoding correctly.
  const createResult = await client.graphql.mutation(CREATE_REPLAY_SESSION_RAW, {
    input: {
      requestSource: {
        raw: {
          connectionInfo: { host, port, isTLS: tls },
          raw: Buffer.from(raw).toString("base64"),
        },
      },
    },
  });
  const session = (createResult as any).createReplaySession.session;

  const result = await client.replay.send(session.id, {
    raw,
    connection: { host, port, isTLS: tls },
  });

  const output: Record<string, any> = {
    sessionId: session.id,
    status: result.status,
    error: result.error,
  };

  if (result.entry?.response) {
    output.response = {
      statusCode: result.entry.response.statusCode,
      roundtrip: result.entry.response.roundtripTime,
      length: result.entry.response.length,
    };
    if (result.entry.response.raw) {
      output.response.raw = formatHttpRaw(decodeRaw(result.entry.response.raw), opts);
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

  // Create session and send
  const session = await client.replay.sessions.create({
    requestSource: { id: requestId },
  });

  const result = await client.replay.send(session.id, {
    raw: modifiedRaw,
    connection: {
      host: original.request.host,
      port: original.request.port,
      isTLS: original.request.isTls,
    },
  });

  const output: Record<string, any> = {
    sessionId: session.id,
    status: result.status,
    error: result.error,
  };

  if (!opts.noRequest) {
    output.modifiedRequest = formatHttpRaw(modifiedRaw, opts);
  }

  if (result.entry?.response) {
    output.response = {
      statusCode: result.entry.response.statusCode,
      roundtrip: result.entry.response.roundtripTime,
      length: result.entry.response.length,
    };
    if (result.entry.response.raw) {
      output.response.raw = formatHttpRaw(decodeRaw(result.entry.response.raw), opts);
    }
  }

  console.log(JSON.stringify(output, null, 2));
}

// ── Get Session (by ID — matches tab number in UI) ──

export async function cmdGetSession(sessionId: string, opts: OutputOpts) {
  const client = await getClient();
  const session = await resolveSession(client, sessionId);

  if (!session) {
    console.error(`Replay session "${sessionId}" not found (tried ID and name lookup)`);
    process.exit(1);
  }

  const output: Record<string, any> = {
    id: session.id,
    name: session.name,
    collectionId: session.collectionId,
    activeEntryId: session.activeEntryId,
  };

  // If there's an active entry, fetch its details
  if (session.activeEntryId) {
    const entry = await client.replay.entries.get(session.activeEntryId);
    if (entry) {
      output.activeEntry = {
        id: entry.id,
        sessionId: entry.sessionId,
        connection: {
          host: entry.connection.host,
          port: entry.connection.port,
          isTLS: (entry.connection as any).isTLS ?? (entry.connection as any).isTls,
        },
        createdAt: entry.createdAt,
        error: entry.error,
      };

      if (entry.request) {
        output.activeEntry.request = {
          id: entry.request.id,
          method: entry.request.method,
          host: entry.request.host,
          path: entry.request.path,
          port: entry.request.port,
          isTls: entry.request.isTls,
        };
      }

      if (entry.raw) {
        output.activeEntry.raw = formatHttpRaw(decodeRaw(entry.raw), opts);
      }

      if (entry.response) {
        output.activeEntry.response = {
          statusCode: entry.response.statusCode,
          roundtrip: entry.response.roundtripTime,
          length: entry.response.length,
        };
        if (entry.response.raw) {
          output.activeEntry.response.raw = formatHttpRaw(decodeRaw(entry.response.raw), opts);
        }
      }
    }
  }

  console.log(JSON.stringify(output, null, 2));
}

// ── Replay Entries (list entries within a session) ──

export async function cmdReplayEntries(sessionId: string, limit: number, opts: OutputOpts) {
  const client = await getClient();
  const session = await resolveSession(client, sessionId);

  if (!session) {
    console.error(`Replay session "${sessionId}" not found (tried ID and name lookup)`);
    process.exit(1);
  }

  const connection = await session.entries().includeRaw({ request: false, response: false, replay: false }).first(limit);

  const results = connection.edges.map(e => ({
    id: e.node.id,
    sessionId: e.node.sessionId,
    createdAt: e.node.createdAt,
    error: e.node.error,
    connection: {
      host: e.node.connection.host,
      port: e.node.connection.port,
      isTLS: (e.node.connection as any).isTLS ?? (e.node.connection as any).isTls,
    },
    request: e.node.request ? {
      method: e.node.request.method,
      host: e.node.request.host,
      path: e.node.request.path,
      statusCode: e.node.response?.statusCode,
      roundtrip: e.node.response?.roundtripTime,
      responseLength: e.node.response?.length,
    } : undefined,
  }));

  console.log(JSON.stringify({
    sessionId,
    sessionName: session.name,
    activeEntryId: session.activeEntryId,
    results,
    count: results.length,
  }, null, 2));
}

// ── Edit from Session (use active entry as source) ──

export async function cmdEditSession(
  sessionIdOrName: string,
  edits: {
    method?: string;
    path?: string;
    setHeaders: string[];
    removeHeaders: string[];
    body?: string;
    replacements: string[];
  },
  opts: OutputOpts,
) {
  const client = await getClient();
  const session = await resolveSession(client, sessionIdOrName);

  if (!session) {
    console.error(`Replay session "${sessionIdOrName}" not found (tried ID and name lookup)`);
    process.exit(1);
  }

  const sessionId = session.id;

  if (!session.activeEntryId) {
    console.error(`Session ${sessionId} has no active entry`);
    process.exit(1);
  }

  const entry = await client.replay.entries.get(session.activeEntryId);
  if (!entry || !entry.raw) {
    console.error(`Could not get raw data for active entry ${session.activeEntryId}`);
    process.exit(1);
  }

  let raw = decodeRaw(entry.raw);
  if (!raw) {
    console.error("No raw data for the active entry");
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
    const clBytes = new TextEncoder().encode(bodyPart).length;
    headers = headers.filter(h => !h.toLowerCase().startsWith("content-length:"));
    headers.push(`Content-Length: ${clBytes}`);
  }

  const modifiedRaw = [requestLine, ...headers].join(lineEnd) + lineEnd + lineEnd + bodyPart;

  const result = await client.replay.send(sessionId, {
    raw: modifiedRaw,
    connection: {
      host: entry.connection.host,
      port: entry.connection.port,
      isTLS: (entry.connection as any).isTLS ?? (entry.connection as any).isTls,
    },
  });

  const output: Record<string, any> = {
    sessionId,
    status: result.status,
    error: result.error,
  };

  if (!opts.noRequest) {
    output.modifiedRequest = formatHttpRaw(modifiedRaw, opts);
  }

  if (result.entry?.response) {
    output.response = {
      statusCode: result.entry.response.statusCode,
      roundtrip: result.entry.response.roundtripTime,
      length: result.entry.response.length,
    };
    if (result.entry.response.raw) {
      output.response.raw = formatHttpRaw(decodeRaw(result.entry.response.raw), opts);
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

export async function cmdCreateSession(requestId: string) {
  const client = await getClient();
  const session = await client.replay.sessions.create({
    requestSource: { id: requestId },
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

export async function cmdDeleteSessions(ids: string[]) {
  const client = await getClient();
  await client.replay.sessions.delete(ids);
  console.log(JSON.stringify({ deleted: ids }, null, 2));
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
