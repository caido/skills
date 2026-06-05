/**
 * Automate / Fuzz commands — create, edit, placeholders, payloads, results.
 *
 * Workflow:
 *   1. create-automate-session <request-id> [--name] [--strategy] [--strategy-options]
 *   2. edit-automate-session <id> --replace 'old:::FUZZ' [--name] [--strategy]
 *   3. set-placeholder <id> search FUZZ
 *   4. set-payload <id> --add-set --index 0 --list "a,b,c"
 *   5. fuzz <id>
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

// ── Types ──

export interface PlaceholderInput {
  start: number;
  end: number;
}

export interface PayloadSet {
  index: number;
  type: "simpleList" | "number";
  list?: string[];
  range?: { min: number; max: number; step?: number };
  preprocessors?: string[];
}

export interface EditAutomateOpts {
  name?: string;
  strategy?: "ALL" | "SEQUENTIAL" | "PARALLEL" | "MATRIX";
  strategyOptions?: string; // JSON string
  replacements?: string[];
  setHeaders?: string[];
  removeHeaders?: string[];
  body?: string;
  method?: string;
  path?: string;
}

export interface SetPayloadOpts {
  list?: string[];
  json?: string; // @file path or inline JSON
  index?: number;
  range?: string; // "min-max" or "min-max:step"
  remove?: boolean;
}

// ── Helpers ──

/** Resolve @file arg — if string starts with @, read file contents; otherwise return as-is */
function resolveFileArg(value: string): string {
  if (value.startsWith("@")) {
    const fs = require("fs");
    const filePath = value.slice(1);
    return fs.readFileSync(filePath, "utf-8");
  }
  return value;
}

/** Read existing session, exit on error */
async function getSession(sessionId: string) {
  const client = await getClient();
  const result = await client.graphql.query(GET_AUTOMATE_SESSION, { id: sessionId });
  const session = (result as any).automateSession;
  if (!session) {
    console.error(`Automate session ${sessionId} not found`);
    process.exit(1);
  }
  return { client, session };
}

/** Read existing settings preserving everything except what we're changing */
function buildCompleteSettings(
  existingSettings: any,
  overrides: {
    payloads?: any[];
    placeholders?: any[];
    strategy?: string;
    redirect?: any;
    concurrency?: any;
  } = {},
) {
  const settings = {
    payloads: overrides.payloads ?? existingSettings?.payloads ?? [],
    placeholders: overrides.placeholders ?? existingSettings?.placeholders ?? [],
    redirect: overrides.redirect ?? existingSettings?.redirect ?? { strategy: "ALWAYS", max: 5 },
    strategy: overrides.strategy ?? existingSettings?.strategy ?? "ALL",
    concurrency: overrides.concurrency ?? existingSettings?.concurrency ?? { workers: 1, delay: 0 },
    retryOnFailure: existingSettings?.retryOnFailure ?? { maximumRetries: 0, backoff: 0 },
    closeConnection: existingSettings?.closeConnection ?? false,
    updateContentLength: true,
  };
  return settings;
}

/** Normalise payload from SDK format to our internal format */
function normalisePayloads(payloads: any[]): any[] {
  if (!payloads?.length) return [];
  return payloads.map((p: any) => {
    const opts: any = {};
    if (p.options?.list) opts.simpleList = { list: p.options.list };
    else if (p.options?.simpleList) opts.simpleList = p.options.simpleList;
    else if (p.options?.range) opts.number = { range: p.options.range, increments: p.options.increments, minLength: p.options.minLength };
    else if (p.options?.number) opts.number = p.options.number;
    else opts.simpleList = { list: [] };
    return { options: opts, preprocessors: p.preprocessors ?? [] };
  });
}

/** Normalise placeholders from SDK format */
function normalisePlaceholders(placeholders: any[]): PlaceholderInput[] {
  if (!placeholders?.length) return [];
  return placeholders.map((p: any) => ({ start: p.start, end: p.end }));
}

/** Validate PARALLEL/MATRIX strategies against placeholder and payload counts */
function validateStrategyPayloads(strategy: string, payloads: any[], placeholderCount: number) {
  if (strategy !== "PARALLEL" && strategy !== "MATRIX") return;

  // Both PARALLEL and MATRIX require one payload set per placeholder
  if (placeholderCount > 0 && payloads.length !== placeholderCount) {
    console.error(JSON.stringify({
      error: `${strategy} requires one payload set per placeholder. Have ${placeholderCount} placeholder(s) but ${payloads.length} payload set(s). Use 'set-payload --add-set --index N ...' to add sets.`,
      placeholders: placeholderCount,
      payloadSets: payloads.length,
    }, null, 2));
    process.exit(1);
  }

  // PARALLEL additionally requires all sets to be the same length
  if (strategy === "PARALLEL" && payloads.length >= 2) {
    const lengths = payloads.map((p: any) => {
      if (p.options?.simpleList?.list) return p.options.simpleList.list.length;
      if (p.options?.number?.range) {
        const r = p.options.number.range;
        const step = p.options.number.increments ?? 1;
        return Math.floor((r.max - r.min) / step) + 1;
      }
      return 0;
    });

    const first = lengths[0];
    const mismatched = lengths.findIndex((l: number) => l !== first);
    if (mismatched !== -1) {
      console.error(JSON.stringify({
        error: `PARALLEL strategy requires all payload sets to be the same length. Set 0 has ${first} items but set ${mismatched} has ${lengths[mismatched]} items.`,
        lengths,
      }, null, 2));
      process.exit(1);
    }
  }
}

// ── Create automate session ──

export async function cmdCreateAutomateSession(
  requestId: string,
  name?: string,
  strategy?: string,
  strategyOptions?: string,
) {
  const client = await getClient();
  const result = await client.graphql.mutation(CREATE_AUTOMATE_SESSION, {
    input: { requestSource: { id: requestId } },
  });
  const session = (result as any).createAutomateSession.session;
  const sessionId = session.id;

  // If name/strategy/strategyOptions provided, apply via UPDATE
  if (name || strategy || strategyOptions) {
    const getResult = await client.graphql.query(GET_AUTOMATE_SESSION, { id: sessionId });
    const fullSession = (getResult as any).automateSession;

    const overrides: any = {};
    if (strategy) overrides.strategy = strategy;

    let parsedOptions: any = {};
    if (strategyOptions) {
      const soContent = resolveFileArg(strategyOptions);
      try { parsedOptions = JSON.parse(soContent); } catch {
        console.error("Error: --strategy-options must be valid JSON (or @file pointing to JSON)");
        process.exit(1);
      }
    }

    const settings = buildCompleteSettings(fullSession.settings, overrides);

    // Apply strategy options
    if (parsedOptions.redirectStrategy || parsedOptions.followRedirects !== undefined) {
      settings.redirect = {
        strategy: parsedOptions.redirectStrategy ?? settings.redirect.strategy,
        max: parsedOptions.redirectMax ?? settings.redirect.max ?? 5,
      };
    }
    if (parsedOptions.workers !== undefined || parsedOptions.delay !== undefined) {
      settings.concurrency = {
        workers: parsedOptions.workers ?? settings.concurrency.workers,
        delay: parsedOptions.delay ?? settings.concurrency.delay,
      };
    }

    await client.graphql.mutation(UPDATE_AUTOMATE_SESSION, {
      id: sessionId,
      input: {
        connection: fullSession.connection,
        raw: fullSession.raw,
        name: name ?? fullSession.name,
        settings,
      },
    });
  }

  console.log(JSON.stringify({
    sessionId,
    name: name ?? session.name,
    strategy: strategy ?? "ALL",
    ...(Object.keys(parsedOptions).length ? { strategyOptions: parsedOptions } : {}),
  }, null, 2));
}

// ── Edit automate session (unified) ──

export async function cmdEditAutomateSession(sessionId: string, opts: EditAutomateOpts) {
  const { client, session } = await getSession(sessionId);
  if (!session.raw) {
    console.error("No raw request data in session");
    process.exit(1);
  }

  let raw = Buffer.from(session.raw, "base64").toString("utf-8");
  const existingSettings = session.settings as any;
  let modified = false;

  // Apply body replacements
  if (opts.replacements?.length) {
    for (const rep of opts.replacements) {
      const [from, to] = rep.split(":::");
      if (from !== undefined && to !== undefined) {
        raw = raw.replaceAll(from, to);
      }
    }
    modified = true;
  }

  // Apply method change
  if (opts.method) {
    const firstLine = raw.split("\r\n")[0];
    const parts = firstLine.split(" ");
    if (parts.length >= 3) {
      parts[0] = opts.method.toUpperCase();
      raw = parts.join(" ") + raw.substring(firstLine.length);
      modified = true;
    }
  }

  // Apply path change
  if (opts.path) {
    const firstLine = raw.split("\r\n")[0];
    const parts = firstLine.split(" ");
    if (parts.length >= 3) {
      parts[1] = opts.path;
      raw = parts.join(" ") + raw.substring(firstLine.length);
      modified = true;
    }
  }

  // Apply header changes
  if (opts.setHeaders?.length || opts.removeHeaders?.length) {
    const lineEnd = "\r\n";
    const separator = lineEnd + lineEnd;
    const parts = raw.split(separator);
    const headerLines = parts[0].split(lineEnd);
    const bodyPart = parts.slice(1).join(separator);

    let newHeaders = [...headerLines];

    // Remove headers
    if (opts.removeHeaders?.length) {
      for (const rmHeader of opts.removeHeaders) {
        const lower = rmHeader.toLowerCase();
        newHeaders = newHeaders.filter(h => !h.toLowerCase().startsWith(lower + ":"));
      }
    }

    // Set headers
    if (opts.setHeaders?.length) {
      for (const setHeader of opts.setHeaders) {
        const colonIdx = setHeader.indexOf(":");
        if (colonIdx === -1) continue;
        const name = setHeader.substring(0, colonIdx).toLowerCase();
        newHeaders = newHeaders.filter(h => !h.toLowerCase().startsWith(name + ":"));
        newHeaders.push(setHeader);
      }
    }

    raw = newHeaders.join(lineEnd) + separator + bodyPart;
    modified = true;
  }

  // Apply full body replacement (@file supported)
  if (opts.body !== undefined) {
    const bodyContent = resolveFileArg(opts.body);
    const lineEnd = "\r\n";
    const separator = lineEnd + lineEnd;
    const parts = raw.split(separator);
    raw = parts[0] + separator + bodyContent;
    modified = true;
  }

  // Recompute Content-Length if body changed
  if (modified) {
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
  }

  const newBase64 = Buffer.from(raw, "utf-8").toString("base64");

  // Build strategy settings
  let strategy = existingSettings?.strategy ?? "ALL";
  if (opts.strategy) strategy = opts.strategy;

  let parsedOptions: any = {};
  if (opts.strategyOptions) {
    const soContent = resolveFileArg(opts.strategyOptions);
    try { parsedOptions = JSON.parse(soContent); } catch {
      console.error("Error: --strategy-options must be valid JSON (or @file pointing to JSON)");
      process.exit(1);
    }
  }

  const settings = buildCompleteSettings(existingSettings, { strategy });

  if (parsedOptions.redirectStrategy || parsedOptions.followRedirects !== undefined) {
    settings.redirect = {
      strategy: parsedOptions.redirectStrategy ?? settings.redirect.strategy,
      max: parsedOptions.redirectMax ?? settings.redirect.max ?? 5,
    };
  }
  if (parsedOptions.workers !== undefined || parsedOptions.delay !== undefined) {
    settings.concurrency = {
      workers: parsedOptions.workers ?? settings.concurrency.workers,
      delay: parsedOptions.delay ?? settings.concurrency.delay,
    };
  }

  // Normalise existing payloads to SDK format
  settings.payloads = normalisePayloads(settings.payloads);
  settings.placeholders = normalisePlaceholders(settings.placeholders);

  await client.graphql.mutation(UPDATE_AUTOMATE_SESSION, {
    id: sessionId,
    input: {
      connection: session.connection,
      raw: modified ? newBase64 : session.raw,
      name: opts.name ?? session.name,
      settings,
    },
  });

  console.log(JSON.stringify({
    sessionId,
    name: opts.name ?? session.name,
    strategy,
    modified,
    ...(opts.replacements?.length ? { replacements: opts.replacements.length } : {}),
  }, null, 2));
}

// ── Set placeholder (mode-based) ──

export async function cmdSetPlaceholder(
  sessionId: string,
  mode: "search" | "range" | "list" | "clear" | "remove" | "replace" | "show-raw",
  args: string[],
) {
  const { client, session } = await getSession(sessionId);
  if (!session.raw) {
    console.error("No raw request data in session");
    process.exit(1);
  }

  const raw = Buffer.from(session.raw, "base64").toString("utf-8");
  const existingSettings = session.settings as any;
  let placeholders: PlaceholderInput[] = normalisePlaceholders(existingSettings?.placeholders ?? []);

  switch (mode) {
    case "show-raw": {
      const escaped = raw.replace(/\r\n/g, "\\r\\n");
      const lines = raw.split("\r\n");
      let pos = 0;
      const lineMap: { start: number; end: number; content: string }[] = [];
      for (const line of lines) {
        lineMap.push({ start: pos, end: pos + line.length, content: line });
        pos += line.length + 2;
      }
      console.log(JSON.stringify({
        raw: escaped,
        length: raw.length,
        lines: lineMap,
        placeholders,
      }, null, 2));
      return;
    }

    case "search": {
      if (!args[0]) { console.error("Error: search requires <pattern>"); process.exit(1); }
      const pattern = args[0];
      let count: number | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--count" && args[i + 1]) { count = parseInt(args[i + 1], 10); i++; }
      }

      const found: PlaceholderInput[] = [];
      let searchPos = 0;
      while (true) {
        const idx = raw.indexOf(pattern, searchPos);
        if (idx === -1) break;
        found.push({ start: idx, end: idx + pattern.length });
        searchPos = idx + pattern.length;
        if (count !== undefined && found.length >= count) break;
      }

      if (found.length === 0) {
        console.error(`Pattern "${pattern}" not found in raw request`);
        process.exit(1);
      }

      // Replace ALL placeholders with search results
      placeholders = found;
      console.log(JSON.stringify({
        note: `Found ${found.length} occurrence(s) of "${pattern}"`,
        placeholders: found,
      }, null, 2));
      break;
    }

    case "range": {
      if (!args[0] || !args[1]) { console.error("Error: range requires <start> <end>"); process.exit(1); }
      const start = parseInt(args[0], 10);
      const end = parseInt(args[1], 10);
      if (isNaN(start) || isNaN(end) || start >= end) {
        console.error("Error: invalid range (start must be < end)");
        process.exit(1);
      }
      // Replace ALL placeholders with single range
      placeholders = [{ start, end }];
      console.log(JSON.stringify({ placeholders }, null, 2));
      break;
    }

    case "list": {
      if (!args.length) { console.error("Error: list requires <start:end> arguments"); process.exit(1); }
      const parsed: PlaceholderInput[] = [];
      for (const arg of args) {
        const parts = arg.split(":");
        if (parts.length !== 2) {
          console.error(`Error: invalid range "${arg}" — expected start:end`);
          process.exit(1);
        }
        const start = parseInt(parts[0], 10);
        const end = parseInt(parts[1], 10);
        if (isNaN(start) || isNaN(end) || start >= end) {
          console.error(`Error: invalid range "${arg}"`);
          process.exit(1);
        }
        parsed.push({ start, end });
      }
      // Replace ALL placeholders with explicit list
      placeholders = parsed;
      console.log(JSON.stringify({ placeholders }, null, 2));
      break;
    }

    case "clear": {
      placeholders = [];
      console.log(JSON.stringify({ note: "All placeholders cleared", placeholders: [] }, null, 2));
      break;
    }

    case "remove": {
      if (!args[0]) { console.error("Error: remove requires <index>"); process.exit(1); }
      const idx = parseInt(args[0], 10);
      if (isNaN(idx) || idx < 0 || idx >= placeholders.length) {
        console.error(`Error: index ${idx} out of range (0-${placeholders.length - 1})`);
        process.exit(1);
      }
      const removed = placeholders.splice(idx, 1);
      console.log(JSON.stringify({
        note: `Removed placeholder at index ${idx}`,
        removed: removed[0],
        remaining: placeholders.length,
        placeholders,
      }, null, 2));
      break;
    }

    case "replace": {
      if (!args[0] || !args[1] || !args[2]) { console.error("Error: replace requires <index> <start> <end>"); process.exit(1); }
      const idx = parseInt(args[0], 10);
      const start = parseInt(args[1], 10);
      const end = parseInt(args[2], 10);
      if (isNaN(idx) || idx < 0 || idx >= placeholders.length) {
        console.error(`Error: index ${idx} out of range (0-${placeholders.length - 1})`);
        process.exit(1);
      }
      if (isNaN(start) || isNaN(end) || start >= end) {
        console.error("Error: invalid range (start must be < end)");
        process.exit(1);
      }
      const old = { ...placeholders[idx] };
      placeholders[idx] = { start, end };
      console.log(JSON.stringify({
        note: `Replaced placeholder ${idx}`,
        old,
        new: placeholders[idx],
        placeholders,
      }, null, 2));
      break;
    }
  }

  // Write back updated placeholders (preserving payloads)
  const settings = buildCompleteSettings(existingSettings);
  settings.payloads = normalisePayloads(settings.payloads);
  settings.placeholders = placeholders;

  await client.graphql.mutation(UPDATE_AUTOMATE_SESSION, {
    id: sessionId,
    input: {
      connection: session.connection,
      raw: session.raw,
      settings,
    },
  });

  console.log(JSON.stringify({
    sessionId,
    placeholdersSet: placeholders.length,
    placeholders,
    updated: true,
  }, null, 2));
}

// ── Set payload (extended) ──

export async function cmdSetPayload(sessionId: string, opts: SetPayloadOpts) {
  const { client, session } = await getSession(sessionId);
  const existingSettings = session.settings as any;
  let payloads: any[] = normalisePayloads(existingSettings?.payloads ?? []);

  // Mode: --json (full config from file or inline)
  if (opts.json) {
    const jsonContent = resolveFileArg(opts.json);

    let config: any;
    try { config = JSON.parse(jsonContent); } catch (e: any) {
      console.error(`Error: invalid JSON: ${e.message}`);
      process.exit(1);
    }

    if (config.payloads?.length) {
      payloads = config.payloads.map((p: PayloadSet) => {
        if (p.type === "number" && p.range) {
          return {
            options: { number: { range: { min: p.range.min, max: p.range.max }, increments: p.range.step ?? 1 } },
            preprocessors: p.preprocessors ?? [],
          };
        }
        return {
          options: { simpleList: { list: p.list ?? [] } },
          preprocessors: p.preprocessors ?? [],
        };
      });
    }

    if (config.strategy) {
      // Apply strategy from JSON too
      const settings = buildCompleteSettings(existingSettings, { strategy: config.strategy, payloads });
      settings.placeholders = normalisePlaceholders(settings.placeholders);

      if (config.strategyOptions) {
        if (config.strategyOptions.redirectStrategy) {
          settings.redirect = { strategy: config.strategyOptions.redirectStrategy, max: config.strategyOptions.redirectMax ?? 5 };
        }
        if (config.strategyOptions.workers !== undefined || config.strategyOptions.delay !== undefined) {
          settings.concurrency = {
            workers: config.strategyOptions.workers ?? settings.concurrency.workers,
            delay: config.strategyOptions.delay ?? settings.concurrency.delay,
          };
        }
      }

      validateStrategyPayloads(settings.strategy, payloads, settings.placeholders.length);

      await client.graphql.mutation(UPDATE_AUTOMATE_SESSION, {
        id: sessionId,
        input: { connection: session.connection, raw: session.raw, settings },
      });

      console.log(JSON.stringify({
        sessionId,
        strategy: settings.strategy,
        payloadSets: payloads.length,
        totalPayloads: payloads.reduce((a: number, p: any) => a + (p.options?.simpleList?.list?.length ?? 0), 0),
        updated: true,
      }, null, 2));
      return;
    }

    // Just payloads, no strategy override
    const settings = buildCompleteSettings(existingSettings, { payloads });
    settings.placeholders = normalisePlaceholders(settings.placeholders);

    validateStrategyPayloads(settings.strategy, payloads, settings.placeholders.length);

    await client.graphql.mutation(UPDATE_AUTOMATE_SESSION, {
      id: sessionId,
      input: { connection: session.connection, raw: session.raw, settings },
    });

    console.log(JSON.stringify({
      sessionId,
      payloadSets: payloads.length,
      totalPayloads: payloads.reduce((a: number, p: any) => a + (p.options?.simpleList?.list?.length ?? 0), 0),
      updated: true,
    }, null, 2));
    return;
  }

  // Mode: --index N --remove
  if (opts.index !== undefined && opts.remove) {
    if (opts.index < 0 || opts.index >= payloads.length) {
      console.error(`Error: index ${opts.index} out of range (0-${payloads.length - 1})`);
      process.exit(1);
    }
    payloads.splice(opts.index, 1);
  }
  // Mode: --index N --list/range (add or replace at index)
  else if (opts.index !== undefined && (opts.list?.length || opts.range)) {
    const entry = buildPayloadEntry(opts);
    if (opts.index >= payloads.length) {
      // Pad with empty sets up to index
      while (payloads.length < opts.index) {
        payloads.push({ options: { simpleList: { list: [] } }, preprocessors: [] });
      }
      payloads.push(entry);
    } else {
      payloads[opts.index] = entry;
    }
  }
  // Mode: --list (no index — backward compat, replaces all with single set)
  else if (opts.list?.length) {
    // Guard: bare --list with a multi-set strategy is almost certainly a mistake
    const currentStrategy = existingSettings?.strategy ?? "ALL";
    if (currentStrategy === "PARALLEL" || currentStrategy === "MATRIX") {
      console.error(JSON.stringify({
        error: `--list without --index replaces ALL payload sets with a single set. Use --index N --list "..." to set a payload for each placeholder when strategy is ${currentStrategy}.`,
      }, null, 2));
      process.exit(1);
    }
    payloads = [{
      options: { simpleList: { list: opts.list } },
      preprocessors: [],
    }];
  }
  else {
    console.error("Error: provide --list, --range, --json, or --index N --remove");
    process.exit(1);
  }

  const settings = buildCompleteSettings(existingSettings, { payloads });
  settings.placeholders = normalisePlaceholders(settings.placeholders);

  validateStrategyPayloads(settings.strategy, payloads, settings.placeholders.length);

  await client.graphql.mutation(UPDATE_AUTOMATE_SESSION, {
    id: sessionId,
    input: { connection: session.connection, raw: session.raw, settings },
  });

  console.log(JSON.stringify({
    sessionId,
    payloadSets: payloads.length,
    updated: true,
  }, null, 2));
}

/** Build a single payload entry from opts (--list or --range) */
function buildPayloadEntry(opts: SetPayloadOpts): any {
  if (opts.range) {
    // Format: "min-max" or "min-max:step"
    const rangeParts = opts.range.split(":");
    const step = rangeParts[1] ? Number(rangeParts[1]) : 1;
    const bounds = rangeParts[0].split("-").map(Number);
    const min = bounds[0];
    const max = bounds[1];
    if (isNaN(min) || isNaN(max) || min >= max) {
      console.error(`Error: invalid range "${opts.range}" — expected "min-max" or "min-max:step"`);
      process.exit(1);
    }
    return {
      options: { number: { range: { min, max }, increments: step } },
      preprocessors: [],
    };
  }
  if (opts.list?.length) {
    return {
      options: { simpleList: { list: opts.list } },
      preprocessors: [],
    };
  }
  console.error("Error: --index requires --list or --range");
  process.exit(1);
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
