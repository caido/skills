/**
 * Automate / Fuzz commands — rename, placeholders, payloads, results.
 */
import { getClient } from "../client";
import {
  CREATE_AUTOMATE_SESSION,
  GET_AUTOMATE_SESSION,
  START_AUTOMATE_TASK,
  RENAME_AUTOMATE_SESSION,
  UPDATE_AUTOMATE_SESSION,
  AUTOMATE_SESSION_RESULTS,
  AUTOMATE_SESSIONS,
  AUTOMATE_TASKS,
  DELETE_AUTOMATE_SESSION,
  DUPLICATE_AUTOMATE_SESSION,
  PAUSE_AUTOMATE_TASK,
  RESUME_AUTOMATE_TASK,
  CANCEL_AUTOMATE_TASK,
  RENAME_AUTOMATE_ENTRY,
  DELETE_AUTOMATE_ENTRIES,
} from "../graphql";

interface PlaceholderInput {
  start: number;
  end: number;
}

// ── Create automate session ──

export async function cmdCreateAutomateSession(requestId: string) {
  const client = await getClient();
  const result = await client.graphql.mutation(CREATE_AUTOMATE_SESSION, {
    input: { requestSource: { id: requestId } },
  });
  console.log(JSON.stringify((result as any).createAutomateSession.session, null, 2));
}

// ── Fuzz ──

export async function cmdFuzz(sessionId: string) {
  const client = await getClient();

  const check = await client.graphql.query(GET_AUTOMATE_SESSION, { id: sessionId });
  const session = (check as any).automateSession;
  if (!session) {
    console.error(`Automate session ${sessionId} not found`);
    process.exit(1);
  }

  console.log(JSON.stringify({
    note: "Starting automate task.",
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

// ── Rename automate session ──

export async function cmdRenameAutomateSession(sessionId: string, name: string) {
  const client = await getClient();
  const result = await client.graphql.mutation(RENAME_AUTOMATE_SESSION, {
    id: sessionId,
    name,
  });
  console.log(JSON.stringify((result as any).renameAutomateSession.session, null, 2));
}

// ── Set placeholder (injection point) ──

export async function cmdSetPlaceholder(
  sessionId: string,
  placeholders: PlaceholderInput[],
  showRaw: boolean,
  searchStr?: string,
  searchLength?: number,
) {
  const client = await getClient();

  const getResult = await client.graphql.query(GET_AUTOMATE_SESSION, { id: sessionId });
  const session = (getResult as any).automateSession;
  if (!session) {
    console.error(`Automate session ${sessionId} not found`);
    process.exit(1);
  }

  if (!session.raw) {
    console.error("No raw request data in session");
    process.exit(1);
  }

  const raw = Buffer.from(session.raw, "base64").toString("utf-8");

  // Auto-compute placeholder from --search
  // Two modes:
  //   --search <str>          : placeholder covers the found string
  //   --search <str> --len <n>: placeholder covers n bytes after the string
  if (searchStr && placeholders.length === 0) {
    const idx = raw.indexOf(searchStr);
    if (idx === -1) {
      console.error(`Search string not found in raw request: "${searchStr}"`);
      showRaw = true;
    } else {
      let start: number, end: number;
      if (searchLength !== undefined) {
        // Legacy mode: cover N bytes after the search string
        start = idx + searchStr.length;
        end = start + searchLength;
      } else {
        // Default mode: cover the search string itself
        start = idx;
        end = idx + searchStr.length;
      }
      placeholders.push({ start, end });
      console.log(JSON.stringify({
        note: `Found "${searchStr}" at byte ${idx}, setting placeholder at [${start}-${end}]`,
      }, null, 2));
    }
  }

  if (showRaw) {
    const escaped = raw.replace(/\r\n/g, "\\r\\n");
    console.log(JSON.stringify({ raw: escaped }, null, 2));
    const lines = raw.split("\r\n");
    let pos = 0;
    for (const line of lines) {
      console.log(`  [${pos}-${pos + line.length}] ${line}`);
      pos += line.length + 2;
    }
  }

  if (placeholders.length === 0) {
    return;
  }

  // Preserve existing payloads when setting placeholders
  const existingSettings = session.settings as any;
  let existingPayloads: any[] = [];
  if (existingSettings?.payloads?.length > 0) {
    existingPayloads = existingSettings.payloads.map((p: any) => {
      const opts: any = {};
      if (p.options?.list) opts.simpleList = { list: p.options.list };
      else if (p.options?.range) opts.number = { range: p.options.range, increments: p.options.increments, minLength: p.options.minLength };
      else opts.simpleList = { list: [] };
      return { options: opts, preprocessors: [] };
    });
  }

  const input: any = {
    connection: session.connection,
    raw: session.raw,
    settings: {
      payloads: existingPayloads,
      placeholders: placeholders.map(p => ({ start: p.start, end: p.end })),
      redirect: { strategy: "ALWAYS", max: 5 },
      strategy: "ALL",
      concurrency: { workers: 1, delay: 0 },
      retryOnFailure: { maximumRetries: 0, backoff: 0 },
      closeConnection: false,
      updateContentLength: true,
    },
  };

  await client.graphql.mutation(UPDATE_AUTOMATE_SESSION, { id: sessionId, input });

  console.log(JSON.stringify({
    sessionId,
    placeholdersSet: placeholders.length,
    placeholders,
    updated: true,
  }, null, 2));
}

// ── Set payload list ──

export async function cmdSetPayload(sessionId: string, list: string[]) {
  const client = await getClient();

  const getResult = await client.graphql.query(GET_AUTOMATE_SESSION, { id: sessionId });
  const session = (getResult as any).automateSession;
  if (!session) {
    console.error(`Automate session ${sessionId} not found`);
    process.exit(1);
  }

  // Preserve existing placeholders when setting payloads
  const existingSettings = session.settings as any;
  let existingPlaceholders: { start: number; end: number }[] = [];
  if (existingSettings?.placeholders?.length > 0) {
    existingPlaceholders = existingSettings.placeholders.map((p: any) => ({ start: p.start, end: p.end }));
  }

  const input: any = {
    connection: session.connection,
    raw: session.raw,
    settings: {
      payloads: [
        {
          options: { simpleList: { list } },
          preprocessors: [],
        },
      ],
      placeholders: existingPlaceholders,
      redirect: { strategy: "ALWAYS", max: 5 },
      strategy: "ALL",
      concurrency: { workers: 1, delay: 0 },
      retryOnFailure: { maximumRetries: 0, backoff: 0 },
      closeConnection: false,
      updateContentLength: true,
    },
  };

  await client.graphql.mutation(UPDATE_AUTOMATE_SESSION, { id: sessionId, input });

  console.log(JSON.stringify({
    sessionId,
    payloadsSet: list.length,
    payloads: list,
    updated: true,
  }, null, 2));
}

// ── Get automate results ──

export async function cmdAutomateResults(sessionId: string) {
  const client = await getClient();
  const result = await client.graphql.query(AUTOMATE_SESSION_RESULTS, { id: sessionId });

  const session = (result as any).automateSession;
  if (!session) {
    console.error(`Automate session ${sessionId} not found`);
    process.exit(1);
  }

  const output: any = {
    sessionId: session.id,
    name: session.name,
    entries: [],
  };

  for (const entry of session.entries) {
    const entryOutput: any = {
      entryId: entry.id,
      entryName: entry.name,
      requests: [],
    };

    for (const reqEdge of entry.requests.edges) {
      const req = reqEdge.node;
      const reqOutput: any = {
        sequenceId: req.sequenceId,
        payloads: req.payloads,
        error: req.error || null,
      };

      if (req.request) {
        reqOutput.method = req.request.method;
        reqOutput.host = req.request.host;
        reqOutput.path = req.request.path;
        reqOutput.port = req.request.port;

        if (req.request.response) {
          reqOutput.response = {
            statusCode: req.request.response.statusCode,
            roundtrip: req.request.response.roundtripTime,
            length: req.request.response.length,
          };

          if (req.request.response.raw) {
            const rawResp = Buffer.from(req.request.response.raw, "base64").toString("utf-8");
            const bodyIdx = rawResp.indexOf("\r\n\r\n");
            if (bodyIdx >= 0) {
              reqOutput.response.bodyPreview = rawResp.substring(bodyIdx + 4, bodyIdx + 500);
            }
          }
        }
      }

      entryOutput.requests.push(reqOutput);
    }

    output.entries.push(entryOutput);
  }

  console.log(JSON.stringify(output, null, 2));
}

// ── List automate sessions ──

export async function cmdAutomateSessions(limit: number = 20) {
  const client = await getClient();
  const result = await client.graphql.query(AUTOMATE_SESSIONS, { first: limit });
  const sessions = (result as any).automateSessions;
  if (!sessions || !sessions.edges?.length) {
    console.log(JSON.stringify({ count: 0, sessions: [] }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    count: sessions.count?.value ?? sessions.edges.length,
    sessions: sessions.edges.map((e: any) => e.node),
  }, null, 2));
}

// ── List automate tasks ──

export async function cmdAutomateTasks(limit: number = 20) {
  const client = await getClient();
  const result = await client.graphql.query(AUTOMATE_TASKS, { first: limit });
  const tasks = (result as any).automateTasks;
  if (!tasks || !tasks.edges?.length) {
    console.log(JSON.stringify({ count: 0, tasks: [] }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    count: tasks.count?.value ?? tasks.edges.length,
    tasks: tasks.edges.map((e: any) => e.node),
  }, null, 2));
}

// ── Delete automate session ──

export async function cmdDeleteAutomateSession(sessionId: string) {
  const client = await getClient();
  const result = await client.graphql.mutation(DELETE_AUTOMATE_SESSION, { id: sessionId });
  console.log(JSON.stringify({
    deletedId: (result as any).deleteAutomateSession.deletedId,
    status: "deleted",
  }, null, 2));
}

// ── Duplicate automate session ──

export async function cmdDuplicateAutomateSession(sessionId: string) {
  const client = await getClient();
  const result = await client.graphql.mutation(DUPLICATE_AUTOMATE_SESSION, { id: sessionId });
  console.log(JSON.stringify({
    duped: (result as any).duplicateAutomateSession.session,
    status: "created",
  }, null, 2));
}

// ── Pause automate task ──

export async function cmdPauseAutomateTask(taskId: string) {
  const client = await getClient();
  const result = await client.graphql.mutation(PAUSE_AUTOMATE_TASK, { id: taskId });
  console.log(JSON.stringify((result as any).pauseAutomateTask, null, 2));
}

// ── Resume automate task ──

export async function cmdResumeAutomateTask(taskId: string) {
  const client = await getClient();
  const result = await client.graphql.mutation(RESUME_AUTOMATE_TASK, { id: taskId });
  console.log(JSON.stringify((result as any).resumeAutomateTask, null, 2));
}

// ── Cancel automate task ──

export async function cmdCancelAutomateTask(taskId: string) {
  const client = await getClient();
  const result = await client.graphql.mutation(CANCEL_AUTOMATE_TASK, { id: taskId });
  console.log(JSON.stringify({
    cancelledId: (result as any).cancelAutomateTask.cancelledId,
    status: "cancelled",
  }, null, 2));
}

// ── Rename automate entry ──

export async function cmdRenameAutomateEntry(entryId: string, name: string) {
  const client = await getClient();
  const result = await client.graphql.mutation(RENAME_AUTOMATE_ENTRY, { entryId, name });
  console.log(JSON.stringify({
    entry: (result as any).renameAutomateEntry.entry,
    updated: true,
  }, null, 2));
}

// ── Delete automate entries ──

export async function cmdDeleteAutomateEntries(ids: string[]) {
  const client = await getClient();
  const result = await client.graphql.mutation(DELETE_AUTOMATE_ENTRIES, { ids });
  console.log(JSON.stringify((result as any).deleteAutomateEntries, null, 2));
}

// ── Edit automate session body ──
// Find/replace in the raw request body, update Content-Length

export async function cmdEditAutomateBody(sessionId: string, replacements: string[]) {
  if (replacements.length === 0) {
    console.error("Error: --replace <from>:::<to> is required");
    process.exit(1);
  }

  const client = await getClient();

  const getResult = await client.graphql.query(GET_AUTOMATE_SESSION, { id: sessionId });
  const session = (getResult as any).automateSession;
  if (!session) {
    console.error(`Automate session ${sessionId} not found`);
    process.exit(1);
  }

  let raw = Buffer.from(session.raw, "base64").toString("utf-8");
  const oldRaw = raw;

  for (const rep of replacements) {
    const [from, to] = rep.split(":::");
    if (from !== undefined && to !== undefined) {
      raw = raw.replaceAll(from, to);
    }
  }

  if (raw === oldRaw) {
    console.log(JSON.stringify({ sessionId, note: "No changes made — search strings not found", modified: false }, null, 2));
    return;
  }

  // Recompute Content-Length if body changed
  const lineEnd = "\r\n";
  const separator = lineEnd + lineEnd;
  const parts = raw.split(separator);
  if (parts.length >= 2) {
    const headerBlock = parts[0];
    const bodyPart = parts.slice(1).join(separator);
    const headerLines = headerBlock.split(lineEnd);
    const clBytes = new TextEncoder().encode(bodyPart).length;
    const newHeaders = headerLines.filter(h => !h.toLowerCase().startsWith("content-length:"));
    newHeaders.push(`Content-Length: ${clBytes}`);
    raw = newHeaders.join(lineEnd) + separator + bodyPart;
  }

  const newBase64 = Buffer.from(raw, "utf-8").toString("base64");

  // Preserve existing settings
  const existingSettings = (session.settings || {}) as any;
  const settingsPayload: any = {
    redirect: existingSettings.redirect || { strategy: "ALWAYS", max: 5 },
    strategy: existingSettings.strategy || "ALL",
    concurrency: existingSettings.concurrency || { workers: 1, delay: 0 },
    retryOnFailure: existingSettings.retryOnFailure || { maximumRetries: 0, backoff: 0 },
    closeConnection: existingSettings.closeConnection ?? false,
    updateContentLength: true,
  };

  // Preserve payloads and placeholders if they exist
  if (existingSettings.payloads?.length > 0) {
    settingsPayload.payloads = existingSettings.payloads;
  } else {
    settingsPayload.payloads = [{ options: { simpleList: { list: [""] } }, preprocessors: [] }];
  }
  if (existingSettings.placeholders?.length > 0) {
    settingsPayload.placeholders = existingSettings.placeholders;
  } else {
    settingsPayload.placeholders = [];
  }

  await client.graphql.mutation(UPDATE_AUTOMATE_SESSION, {
    id: sessionId,
    input: {
      connection: session.connection,
      raw: newBase64,
      settings: settingsPayload,
    },
  });

  console.log(JSON.stringify({
    sessionId,
    note: `Applied ${replacements.length} replacements, body modified`,
    modified: true,
  }, null, 2));
}