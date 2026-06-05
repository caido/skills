/** Composite CLI commands — SDK-powered multi-step operations */

import { getClient } from "../client";
import { decodeRaw, formatHttpRaw } from "../output";
import {
  CREATE_AUTOMATE_SESSION,
  GET_AUTOMATE_SESSION,
  UPDATE_AUTOMATE_SESSION,
  START_AUTOMATE_TASK,
  AUTOMATE_SESSION_RESULTS,
} from "../graphql";
import {
  cmdSetPlaceholder,
  cmdSetPayload,
  cmdFuzz,
} from "./automate";
import type { OutputOpts } from "../types";

export interface IdorChainResult {
  targetId: string;
  requestId: string;
  sessionId: string;
  statusCode: number;
  roundtrip: number;
  length: number;
  success: boolean;
  error?: string;
}

export interface FuzzAutomateOptions {
  strategy?: "ALL" | "SEQUENTIAL" | "PARALLEL" | "MATRIX";
  workers?: number;
  delay?: number;
  redirectStrategy?: "NEVER" | "IN_SCOPE" | "SAME_SITE" | "ALWAYS";
  followRedirects?: boolean;
}

export interface IdorChainOptions {
  createFindings?: boolean;
  findingTitlePrefix?: string;
  findingDescription?: string;
  dedupeKeyPrefix?: string;
  maxConcurrent?: number;
  outputOpts?: OutputOpts;
}

export interface BulkReplayOptions {
  filter?: string; // HTTPQL filter
  collectionId?: string;
  rateLimit?: number; // requests per second
  maxRequests?: number;
  outputOpts?: OutputOpts;
}

/**
 * IDOR Chain Testing
 * 
 * Takes a base authenticated request and tests IDOR against multiple target IDs.
 * Creates a replay session for each target, modifies the path to swap the ID,
 * and optionally creates findings for successful accesses.
 * 
 * Usage:
 *   caido idor-chain <base-request-id> --ids "100,101,102,103" [--create-findings]
 */
export async function cmdIdorChain(
  baseRequestId: string,
  targetIds: string[],
  options: IdorChainOptions = {}
) {
  const client = await getClient();
  const {
    createFindings = false,
    findingTitlePrefix = "IDOR on",
    findingDescription,
    dedupeKeyPrefix = "idor",
    maxConcurrent = 3,
    outputOpts,
  } = options;

  console.error(`[*] Fetching base request ${baseRequestId}...`);
  const base = await client.request.get(baseRequestId, { raw: true });
  if (!base) {
    console.error(`Error: Request ${baseRequestId} not found`);
    process.exit(1);
  }

  const basePath = base.request.path;
  const results: IdorChainResult[] = [];

  // Extract the numeric ID pattern from the base path (e.g., /api/user/123 -> 123)
  const idMatch = basePath.match(/\d+/);
  if (!idMatch) {
    console.error("Error: Could not extract numeric ID from base path. Use --path-template if needed.");
    process.exit(1);
  }
  const originalId = idMatch[0];
  console.error(`[*] Base path: ${basePath} (detected ID: ${originalId})`);

  // Process targets with concurrency control
  const queue = [...targetIds];
  const running = new Set<Promise<void>>();

  async function processNext() {
    if (queue.length === 0) return;
    
    const targetId = queue.shift()!;
    const promise = (async () => {
      try {
        const modifiedPath = basePath.replace(originalId, targetId);
        console.error(`[*] Testing ${modifiedPath}...`);

        const session = await client.replay.sessions.create({
          requestSource: { id: baseRequestId },
        });

        const raw = decodeRaw(base.request.raw!);
        if (!raw) throw new Error("No raw data");

        // Modify path in raw request
        const modifiedRaw = raw.replace(
          new RegExp(`\\b${originalId}\\b`),
          targetId
        );

        const result = await client.replay.send(session.id, {
          raw: modifiedRaw,
          connection: {
            host: base.request.host,
            port: base.request.port,
            isTLS: base.request.isTls,
          },
        });

        const statusCode = result.entry?.response?.statusCode ?? 0;
        const roundtrip = result.entry?.response?.roundtripTime ?? 0;
        const length = result.entry?.response?.length ?? 0;
        const success = statusCode === 200 || statusCode === 201 || statusCode === 204;

        const entry: IdorChainResult = {
          targetId,
          requestId: baseRequestId,
          sessionId: session.id,
          statusCode,
          roundtrip,
          length,
          success,
        };

        // Rename session for traceability
        await client.replay.sessions.rename(session.id, `idor-${targetId}-${baseRequestId}`);

        if (createFindings && success) {
          const dedupeKey = `${dedupeKeyPrefix}-${targetId}`;
          const title = `${findingTitlePrefix} ${modifiedPath} (target: ${targetId})`;
          try {
            await client.finding.create({
              requestId: baseRequestId,
              title,
              description: findingDescription || `IDOR allows access to ${modifiedPath} by changing ID to ${targetId}`,
              dedupeKey,
            });
            console.error(`[+] Created finding: ${title}`);
          } catch (e) {
            console.error(`[!] Finding creation failed for ${targetId}: ${e}`);
          }
        }

        results.push(entry);
        console.error(`[${success ? "+" : "-"}] ${targetId}: ${statusCode} (${roundtrip}ms, ${length} bytes)`);
      } catch (err: any) {
        results.push({
          targetId,
          requestId: baseRequestId,
          sessionId: "",
          statusCode: 0,
          roundtrip: 0,
          length: 0,
          success: false,
          error: err.message,
        });
        console.error(`[!] ${targetId}: ${err.message}`);
      }
    })();

    running.add(promise);
    promise.finally(() => running.delete(promise));
    await processNext();
  }

  // Start initial workers
  const workers = Math.min(maxConcurrent, targetIds.length);
  await Promise.all(Array(workers).fill(0).map(() => processNext()));
  await Promise.all(running);

  console.log(JSON.stringify({
    baseRequestId,
    totalTested: targetIds.length,
    successful: results.filter(r => r.success).length,
    results,
  }, null, 2));
}

/**
 * Full Automate Fuzzing Pipeline
 * 
 * One-command fuzzing: creates automate session, sets body markers,
 * configures placeholders and payloads, runs fuzz, returns results.
 * 
 * Usage:
 *   caido fuzz-automate <request-id> --payloads "payload1,payload2" 
 *     [--strategy MATRIX] [--workers 5] [--delay 100]
 */
export async function cmdFuzzAutomate(
  requestId: string,
  payloads: string[],
  options: FuzzAutomateOptions = {}
) {
  const client = await getClient();
  const {
    strategy = "MATRIX",
    workers = 5,
    delay = 100,
    redirectStrategy = "NEVER",
    followRedirects = false,
  } = options;

  console.error(`[*] Creating automate session from request ${requestId}...`);
  
  // Step 1: Create automate session
  const createResult = await client.graphql.mutation(CREATE_AUTOMATE_SESSION, {
    input: { requestSource: { id: requestId } },
  });
  const session = (createResult as any).createAutomateSession.session;
  const sessionId = session.id;
  console.error(`[+] Created automate session: ${sessionId}`);

  // Step 2: Get current body to identify fuzz targets
  const check = await client.graphql.query(GET_AUTOMATE_SESSION, { id: sessionId });
  const sessionData = (check as any).automateSession;
  const rawBody = sessionData.raw;
  if (!rawBody) {
    console.error("Error: No raw body in automate session");
    process.exit(1);
  }

  const body = decodeRaw(rawBody);
  console.error(`[*] Raw body (${body.length} bytes)`);

  // Step 3: Auto-detect or use provided FUZZ markers
  // Strategy: replace boolean true/false and null values with "FUZZ" markers
  let modifiedBody = body;
  let markerCount = 0;
  
  // Replace common fuzz targets: true, false, null, numbers
  const patterns = [
    { from: ':true', to: ':"FUZZ"' },
    { from: ':false', to: ':"FUZZ"' },
    { from: ':null', to: ':"FUZZ"' },
    { from: ':""', to: ':"FUZZ"' }, // empty strings
  ];

  for (const { from, to } of patterns) {
    const regex = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const matches = modifiedBody.match(regex);
    if (matches) {
      modifiedBody = modifiedBody.replace(regex, to);
      markerCount += matches.length;
    }
  }

  if (markerCount === 0) {
    console.error("[!] No auto-detected fuzz targets. Consider manual edit-automate-body first.");
  } else {
    console.error(`[*] Auto-inserted ${markerCount} FUZZ marker(s)`);
  }

  // Step 3: Compute placeholder positions from FUZZ markers
  const placeholders: { start: number; end: number }[] = [];
  let searchPos = 0;
  while (true) {
    const idx = modifiedBody.indexOf("FUZZ", searchPos);
    if (idx === -1) break;
    placeholders.push({ start: idx, end: idx + 4 }); // "FUZZ" is 4 bytes
    searchPos = idx + 4;
  }

  // Step 4: Set body, placeholders and payloads in one complete UPDATE
  await client.graphql.mutation(UPDATE_AUTOMATE_SESSION, {
    id: sessionId,
    input: {
      connection: sessionData.connection,
      raw: Buffer.from(modifiedBody).toString("base64"),
      settings: {
        payloads: [{
          options: { simpleList: { list: payloads } },
          preprocessors: [],
        }],
        placeholders,
        redirect: { strategy: "ALWAYS", max: 5 },
        strategy: "ALL",
        concurrency: { workers, delay },
        retryOnFailure: { maximumRetries: 0, backoff: 0 },
        closeConnection: false,
        updateContentLength: true,
      },
    },
  });
  console.error(`[+] Configured body, ${placeholders.length} placeholder(s) and ${payloads.length} payload(s)`);

  // Step 5: Verify settings
  const verify = await client.graphql.query(GET_AUTOMATE_SESSION, { id: sessionId });
  const vSession = (verify as any).automateSession;
  const placeholderCount = vSession.settings?.placeholders?.length ?? 0;
  // Payload count: check both simpleList and direct list (for different schema versions)
  const payloadCount = vSession.settings?.payloads?.reduce((a: number, p: any) => {
    const list = p.options?.simpleList?.list ?? p.options?.list ?? [];
    return a + (Array.isArray(list) ? list.length : 0);
  }, 0) ?? 0;
  
  if (placeholderCount === 0) {
    console.error(`[!] No placeholders set. Use 'caido set-placeholder' to add injection points before fuzzing.`);
    console.error(`[+] Automate session ${sessionId} created with payloads. Run 'caido fuzz ${sessionId}' after setting placeholders.`);
    return;
  }
  if (payloadCount === 0) {
    console.error(`Error: Payloads (${payloadCount}) not set correctly`);
    process.exit(1);
  }
  console.error(`[+] Verified: ${placeholderCount} placeholders, ${payloadCount} payloads`);

  // Step 6: Start fuzzing
  console.error("[*] Starting fuzz task...");
  const startResult = await client.graphql.mutation(START_AUTOMATE_TASK, { automateSessionId: sessionId });
  const task = (startResult as any).startAutomateTask.automateTask;
  const taskId = task.id;
  console.error(`[+] Fuzz task started: ${taskId}`);

  // Step 7: Poll for completion (simple polling - in production you'd want websocket)
  console.error("[*] Waiting for completion...");
  let completed = false;
  let attempts = 0;
  while (!completed && attempts < 120) { // 2 min max
    await new Promise(r => setTimeout(r, 2000));
    attempts++;
    
    const tasks = await client.task.list({ limit: 10 });
    const taskList = Array.isArray(tasks) ? tasks : tasks.edges?.map((e: any) => e.node) ?? [];
    const ourTask = taskList.find((t: any) => t.id === taskId);
    if (ourTask && ourTask.status === "COMPLETED") {
      completed = true;
      break;
    }
    if (attempts % 5 === 0) console.error(`  ... waiting (${attempts * 2}s)`);
  }

  if (!completed) {
    console.error("[!] Timeout waiting for fuzz completion. Check Caido UI for task status.");
  }

  // Step 8: Get results
  console.error("[*] Fetching results...");
  const results = await client.graphql.query(AUTOMATE_SESSION_RESULTS, { id: sessionId });
  const entries = (results as any).automateSession.entries;

  console.log(JSON.stringify({
    sessionId,
    taskId,
    totalEntries: entries.length,
    entries: entries.map((e: any) => ({
      entryId: e.id,
      entryName: e.name,
      requestCount: e.requests?.edges?.length ?? 0,
      requests: e.requests?.edges?.map((re: any) => ({
        sequenceId: re.node.sequenceId,
        statusCode: re.node.request?.response?.statusCode,
        roundtrip: re.node.request?.response?.roundtripTime,
        length: re.node.request?.response?.length,
        payload: re.node.payloads?.[0]?.raw,
        error: re.node.error,
      })) || [],
    })),
  }, null, 2));
}

/**
 * Bulk Replay from Collection or Filter
 * 
 * Replays all requests matching a filter or in a collection through the proxy.
 * Useful for populating history withclean baselines after direct enumeration.
 * 
 * Usage:
 *   caido bulk-replay --collection <id> [--rate 10] [--max 100]
 *   caido bulk-replay --filter 'req.path.cont:"/api/"' [--rate 10]
 */
export async function cmdBulkReplay(
  options: BulkReplayOptions = {}
) {
  const client = await getClient();
  const {
    filter,
    collectionId,
    rateLimit = 10,
    maxRequests = 100,
    outputOpts,
  } = options;

  if (!filter && !collectionId) {
    console.error("Error: Either --filter or --collection required");
    process.exit(1);
  }

  let requestIds: string[] = [];

  if (collectionId) {
    console.error(`[*] Fetching requests from collection ${collectionId}...`);
    const collection = await client.replay.collections.get(collectionId);
    // Get sessions in collection, then their requests
    // This requires GraphQL since SDK may not expose collection->entries directly
    const query = `
      query($id: ID!) {
        replayCollection(id: $id) {
          entries { edges { node { request { id } } } }
        }
      }
    `;
    const result = await client.graphql.query({ query, variables: { id: collectionId } } as any);
    requestIds = (result as any).replayCollection.entries.edges
      .map((e: any) => e.node.request?.id)
      .filter(Boolean);
  } else if (filter) {
    console.error(`[*] Searching requests with filter: ${filter}`);
    const results = await client.request.list({ query: filter, limit: maxRequests });
    requestIds = results.edges.map(e => String(e.node.id));
  }

  if (requestIds.length === 0) {
    console.error("No requests found");
    return;
  }

  console.error(`[*] Replaying ${requestIds.length} requests at ${rateLimit}/s...`);

  const results = [];
  const delay = 1000 / rateLimit;

  for (let i = 0; i < requestIds.length; i++) {
    const requestId = requestIds[i];
    try {
      const request = await client.request.get(requestId, { raw: true });
      if (!request) continue;

      const session = await client.replay.sessions.create({ requestSource: { id: requestId } });
      const raw = decodeRaw(request.request.raw!);
      
      const result = await client.replay.send(session.id, {
        raw,
        connection: {
          host: request.request.host,
          port: request.request.port,
          isTLS: request.request.isTls,
        },
      });

      await client.replay.sessions.rename(session.id, `bulk-${requestId}-${Date.now()}`);

      results.push({
        requestId,
        sessionId: session.id,
        statusCode: result.entry?.response?.statusCode ?? 0,
        roundtrip: result.entry?.response?.roundtripTime ?? 0,
        length: result.entry?.response?.length ?? 0,
      });

      console.error(`[${i + 1}/${requestIds.length}] ${requestId}: ${result.entry?.response?.statusCode ?? "err"}`);
    } catch (err: any) {
      results.push({
        requestId,
        sessionId: "",
        statusCode: 0,
        error: err.message,
      });
      console.error(`[${i + 1}/${requestIds.length}] ${requestId}: ERROR - ${err.message}`);
    }

    if (i < requestIds.length - 1) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.log(JSON.stringify({
    total: requestIds.length,
    successful: results.filter(r => r.statusCode > 0).length,
    results,
  }, null, 2));
}

/**
 * Authenticated Endpoint Discovery
 * 
 * Searches for authenticated endpoints and tests IDOR on each.
 * Combines search -> idor-chain for systematic auth surface testing.
 * 
 * Usage:
 *   caido discover-auth --base-request <id> --pattern "/api/user" --ids "1,2,3"
 */
export async function cmdDiscoverAuth(
  baseRequestId: string,
  searchPattern: string,
  targetIds: string[],
  options: IdorChainOptions = {}
) {
  const client = await getClient();
  
  console.error(`[*] Searching for endpoints matching: ${searchPattern}`);
  const searchResults = await client.request.list({ query: searchPattern, limit: 50 });
  
  console.log(JSON.stringify({
    discoveredEndpoints: searchResults.edges.map(e => ({
      id: e.node.id,
      method: e.node.method,
      path: e.node.path,
      host: e.node.host,
      statusCode: e.node.responseCode,
    })),
  }, null, 2));

  // For each discovered endpoint, run idor-chain
  for (const edge of searchResults.edges) {
    console.error(`\n[*] Testing IDOR on ${edge.node.method} ${edge.node.path}...`);
    await cmdIdorChain(String(edge.node.id), targetIds, options);
  }
}

export {
  cmdIdorChain as idorChain,
  cmdFuzzAutomate as fuzzAutomate,
  cmdBulkReplay as bulkReplay,
  cmdDiscoverAuth as discoverAuth,
};