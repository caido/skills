#!/usr/bin/env -S npx tsx
/**
 * Caido SDK Client v3.1
 * Clean multi-file CLI built entirely on @caido/sdk-client.
 * No raw fetch — uses SDK methods + client.graphql.query/mutation with gql documents.
 */

import { parseOutputOpts, DEFAULT_OUTPUT_OPTS } from "./lib/types";

// Commands
import { cmdSearch, cmdRecent, cmdGet, cmdGetResponse, cmdRaw, cmdExportCurl, cmdExportCurlConfig } from "./lib/commands/requests";
import { cmdReplay, cmdSendRaw, cmdEdit, cmdGetSession, cmdReplayEntries, cmdEditSession, cmdReplaySessions, cmdCreateSession, cmdRenameSession, cmdMoveSession, cmdDeleteSessions, cmdReplayCollections, cmdCreateCollection, cmdRenameCollection, cmdDeleteCollection, cmdCreateAutomateSession, cmdFuzz } from "./lib/commands/replay";
import type { ConnectionOverrides, NameChange, EditTarget } from "./lib/commands/replay";
import { cmdFindings, cmdGetFinding, cmdCreateFinding, cmdUpdateFinding } from "./lib/commands/findings";
import { cmdScopes, cmdCreateScope, cmdUpdateScope, cmdDeleteScope, cmdFilters, cmdCreateFilter, cmdUpdateFilter, cmdDeleteFilter, cmdEnvs, cmdCreateEnv, cmdSelectEnv, cmdEnvSet, cmdDeleteEnv, cmdProjects, cmdSelectProject, cmdHostedFiles, cmdDeleteHostedFile, cmdTasks, cmdCancelTask } from "./lib/commands/management";
import { cmdInterceptStatus, cmdInterceptSet } from "./lib/commands/intercept";
import { cmdMrRules, cmdMrCollections, cmdCreateMrRule, cmdUpdateMrRule, cmdDeleteMrRule, cmdToggleMrRule, cmdRenameMrRule, cmdMoveMrRule, cmdTestMrRule, cmdCreateMrCollection, cmdRenameMrCollection, cmdDeleteMrCollection } from "./lib/commands/matchreplace";
import type { MrRuleOpts } from "./lib/commands/matchreplace";
import { cmdViewer, cmdPlugins, cmdHealth, cmdSetup, cmdAuthStatus } from "./lib/commands/info";

const DEBUG = process.env.DEBUG === "1";

function parseConnectionOverrides(args: string[], startIdx: number): ConnectionOverrides {
  const overrides: ConnectionOverrides = {};
  for (let i = startIdx; i < args.length; i++) {
    if (args[i] === "--sni" && args[i + 1]) { overrides.sni = args[i + 1]; i++; }
    else if (args[i] === "--connect-host" && args[i + 1]) { overrides.connectHost = args[i + 1]; i++; }
    else if (args[i] === "--connect-port" && args[i + 1]) { overrides.connectPort = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === "--connect-tls") { overrides.connectTls = true; }
    else if (args[i] === "--connect-no-tls") { overrides.connectTls = false; }
  }
  return overrides;
}

function parseCollectionId(args: string[], startIdx: number): string | undefined {
  for (let i = startIdx; i < args.length; i++) {
    if (args[i] === "--collection" && args[i + 1]) return args[i + 1];
  }
  return undefined;
}

function parseSessionName(args: string[], startIdx: number): string | undefined {
  for (let i = startIdx; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) return args[i + 1];
  }
  return undefined;
}

/**
 * Replay session names are mandatory. Pull --name or exit with guidance.
 */
function requireName(args: string[], startIdx: number, ctx: string): string {
  const name = parseSessionName(args, startIdx);
  if (!name) {
    console.error(`Error: --name "<session name>" is required when ${ctx}.`);
    console.error(`Replay sessions must be named so they are identifiable on handoff (never refer to them by ID).`);
    process.exit(1);
  }
  return name;
}

/**
 * Editing an existing replay session requires explicit name intent:
 * --no-name-change / --nonach  OR  --new-name "<name>". Exactly one.
 */
function requireNameChange(args: string[], startIdx: number): NameChange {
  let keep = false;
  let newName: string | undefined;
  for (let i = startIdx; i < args.length; i++) {
    if (args[i] === "--no-name-change" || args[i] === "--nonach") keep = true;
    else if (args[i] === "--new-name" && args[i + 1]) { newName = args[i + 1]; i++; }
  }
  if (keep && newName !== undefined) {
    console.error("Error: pass only one of --no-name-change/--nonach or --new-name, not both.");
    process.exit(1);
  }
  if (!keep && newName === undefined) {
    console.error("Error: editing a replay session requires explicit name intent.");
    console.error("  Keep the current name:  --no-name-change   (alias --nonach)");
    console.error('  Set a new name:         --new-name "descriptive name"');
    process.exit(1);
  }
  return keep ? { kind: "keep" } : { kind: "rename", name: newName! };
}

/** Parse Match & Replace rule options. --replace/--match-value accept empty strings. */
function parseMrOpts(args: string[], startIdx: number): MrRuleOpts {
  const o: MrRuleOpts = { section: "" };
  for (let i = startIdx; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === "--section" && v) { o.section = v; i++; }
    else if ((a === "--operation" || a === "--op") && v) { o.operation = v; i++; }
    else if (a === "--match-value" && v !== undefined) { o.matchValue = v; i++; }
    else if (a === "--match-regex" && v) { o.matchRegex = v; i++; }
    else if (a === "--match-full") { o.matchFull = true; }
    else if (a === "--match-name" && v) { o.matchName = v; i++; }
    else if (a === "--replace" && v !== undefined) { o.replace = v; i++; }
    else if (a === "--workflow" && v) { o.workflowId = v; i++; }
    else if (a === "--name" && v) { o.name = v; i++; }
    else if (a === "--condition" && v) { o.condition = v; i++; }
    else if (a === "--sources" && v) { o.sources = v.split(",").map(s => s.trim()).filter(Boolean); i++; }
  }
  return o;
}

function printUsage() {
  console.log(`
Caido SDK Client v3.1 — Built on @caido/sdk-client

Usage:
  caido-client.ts <command> [options]

═══════════════════════════════════════════════
 HTTP HISTORY & TESTING
═══════════════════════════════════════════════

  search <filter>              Search requests using HTTPQL — NEWEST FIRST by default
    --limit <n>                Max results (default: 20)
    --after <cursor>           Pagination cursor
    --ids-only                 Output only request IDs
    --asc / --oldest           Sort OLDEST first (default is newest first)
    --compact                  Terse one-line-per-request output (low token)

  recent                       Get recent requests
    --limit <n>                Max results (default: 20)
    --compact                  Terse one-line-per-request output

  get <request-id>             Get full request details with raw data

  get-response <request-id>    Get just the response for a request

  raw <request-id>             Dump byte-exact raw request (no JSON wrapper)
    --out <file>               Write to a file instead of stdout
    --response                 Dump the raw response instead of the request
                               → npx tsx caido-client.ts raw 123 --out /tmp/req.txt

  replay <request-id>          Replay into a NEW named replay session (handoff)
    --name <name>              Session name (REQUIRED)
    --raw <str|@file|->        Override with custom raw request
    --collection <name|id>     Put session in this collection (must exist)
    --sni <hostname>           TLS Server Name Indication override
    --connect-host <host>      Connect to a different host
    --connect-port <port>      Connect to a different port
    --connect-tls              Force TLS on override connection
    --connect-no-tls           Force plain HTTP on override connection

  send-raw                     Send a raw request via a NEW named replay session
    --host <hostname>          Target host (required)
    --port <port>              Target port (default: 443)
    --tls / --no-tls           Use TLS (default: true)
    --raw <str|@file|->        Raw HTTP request (required)
    --name <name>              Session name (REQUIRED)
    --collection <name|id>     Put session in this collection (must exist)
    --sni <hostname>           TLS Server Name Indication override
    --connect-host <host>      Connect to a different host
    --connect-port <port>      Connect to a different port
    --connect-tls              Force TLS on override connection
    --connect-no-tls           Force plain HTTP on override connection

  edit <request-id>            Edit + send into a replay session (keeps cookies/auth)
    --method <METHOD>          Change HTTP method
    --path <path>              Change request path
    --set-header <N:V>         Set header (repeatable)
    --remove-header <name>     Remove header (repeatable)
    --body <body>              Set request body
    --replace <from>:::<to>    Replace text in request (repeatable)
    --session <name|id>        Reuse an existing session (then requires name intent:)
      --no-name-change/--nonach  Keep the session's current name
      --new-name <name>          Rename the session
    --name <name>              REQUIRED when creating a new session (no --session)
    --collection <name|id>     Put new session in this collection (must exist)
    --sni / --connect-host / --connect-port / --connect-tls / --connect-no-tls

  export-curl <request-id>     Export a FULL self-contained curl command (give to user)
    --config                   Instead, write a reusable curl -K config for INTERNAL
                               testing: a FAITHFUL STATIC snapshot of ALL the request's
                               auth/identity headers + static cookies, proxied via Caido
    --out <file>               Config path (default: /tmp/caido/<host>/auth.cfg)
    --cookie-jar               Use a read/write cookie jar instead of static cookies
                               (follows Set-Cookie rotation; can drift — opt-in)
    --exclude <header>         Omit a header from the config (repeatable)

═══════════════════════════════════════════════
 REPLAY TAB LOOKUP
═══════════════════════════════════════════════

  get-session <id-or-name>     Get a replay session and active entry
  replay-entries <id-or-name>  List request history within a replay session
    --limit <n>                Max results (default: 20)
    --raw                      Include raw replay/request/response data
  edit-session <id-or-name>    Edit + send from a session's active entry
    --method/--path/--body/--set-header/--remove-header/--replace
    --no-name-change/--nonach  Keep the session name (one of these is REQUIRED)
    --new-name <name>          Rename the session (the other option)

═══════════════════════════════════════════════
 REPLAY SESSIONS & COLLECTIONS  (always refer by NAME, not ID)
═══════════════════════════════════════════════

  create-session <request-id>  Create a NAMED replay session from a request
    --name <name>              Session name (REQUIRED)
    --collection <name|id>     Add session to this collection (must exist)
  rename-session <name|id> <n> Rename a replay session
  move-session <s> <coll>      Move a session to a collection (by name or id)
  sessions | replay-sessions   List replay sessions (all, paginated)
    --limit <n>                Cap the number returned
  delete-sessions <id,id,...>  Delete replay sessions

  collections | replay-collections   List replay collections (all, paginated)
    --limit <n>                Cap the number returned
  create-collection <name>     Create a replay collection (name mandatory)
  rename-collection <c> <n>    Rename a collection (by name or id)
  delete-collection <name|id>  Delete a replay collection

═══════════════════════════════════════════════
 AUTOMATE & FUZZING
═══════════════════════════════════════════════

  create-automate-session <id> Create an automate session for fuzzing
  fuzz <session-id>            Start fuzzing (configure payloads in Caido UI)

═══════════════════════════════════════════════
 FINDINGS
═══════════════════════════════════════════════

  findings                     List findings
    --limit <n>                Max results (default: 20)
  get-finding <id>             Get a finding by ID
  create-finding <request-id>  Create a finding from a request
    --title <title>            Finding title (required)
    --description <desc>       Finding description
    --reporter <name>          Reporter name (default: "caido-mode")
    --dedupe-key <key>         Deduplication key
  update-finding <id>          Update a finding
    --title <title>            New title
    --description <desc>       New description
    --hidden                   Hide the finding
    --visible                  Unhide the finding

═══════════════════════════════════════════════
 PROJECT MANAGEMENT
═══════════════════════════════════════════════

  projects                     List all projects
  select-project <id>          Switch active project

═══════════════════════════════════════════════
 SCOPE MANAGEMENT
═══════════════════════════════════════════════

  scopes                       List all scopes
  create-scope <name>          Create a scope
    --allow <patterns>         Comma-separated allowlist patterns
    --deny <patterns>          Comma-separated denylist patterns
  update-scope <id>            Update a scope
    --name <name>              New name
    --allow <patterns>         New allowlist patterns
    --deny <patterns>          New denylist patterns
  delete-scope <id>            Delete a scope

═══════════════════════════════════════════════
 FILTER PRESETS
═══════════════════════════════════════════════

  filters                      List saved filter presets
  create-filter <name>         Create a filter preset
    --query <httpql>           HTTPQL query (required)
    --alias <alias>            Short alias for quick access
  update-filter <id>           Update a filter preset
    --name <name>              New name
    --query <httpql>           New HTTPQL query
    --alias <alias>            New alias
  delete-filter <id>           Delete a filter preset

═══════════════════════════════════════════════
 ENVIRONMENT VARIABLES
═══════════════════════════════════════════════

  envs                         List all environments
  create-env <name>            Create an environment
  select-env [id]              Select active environment (omit id to deselect)
  env-set <env-id> <name> <v>  Set a variable in an environment
  delete-env <id>              Delete an environment

═══════════════════════════════════════════════
 HOSTED FILES
═══════════════════════════════════════════════

  hosted-files                 List hosted files
  delete-hosted-file <id>      Delete a hosted file

═══════════════════════════════════════════════
 TASKS
═══════════════════════════════════════════════

  tasks                        List active tasks
  cancel-task <id>             Cancel a running task

═══════════════════════════════════════════════
 INTERCEPT
═══════════════════════════════════════════════

  intercept-status             Check intercept status
  intercept-enable             Enable request interception
  intercept-disable            Disable request interception

═══════════════════════════════════════════════
 MATCH & REPLACE  (auto-rewrite proxied traffic; Caido "Tamper" rules)
═══════════════════════════════════════════════

  mr-rules                     List all M&R rules
  mr-collections               List M&R collections
  create-mr-rule               Create a rule (auto-applies to proxied traffic)
    --section <s>              REQUIRED. What to tamper (see sections below)
    --operation <op>           raw | update | add | remove (default: section's only/raw)
    --match-value <str>        Match a literal term            (raw ops)
    --match-regex <re>         Match a regex                   (raw ops)
    --match-full               Match the entire section        (raw ops)
    --match-name <name>        Header/param name        (header/query update/add/remove)
    --replace <term>           Replacement string (empty string allowed)
    --workflow <id>            Replace via a workflow instead of a term
    --name <name>              Rule name
    --collection <name|id>     Put the rule in this M&R collection
    --condition <httpql>       Only apply when the request matches this HTTPQL
    --sources <a,b,…>          Limit to sources: INTERCEPT,REPLAY,AUTOMATE,WORKFLOW,…
  update-mr-rule <id>          Replace a rule's config (same flags as create)
  rename-mr-rule <id> <name>   Rename a rule
  toggle-mr-rule <id> --on|--off   Enable/disable a rule
  move-mr-rule <id> <coll>     Move a rule to a collection (by name or id)
  delete-mr-rule <id>          Delete a rule
  test-mr-rule --raw <…>       Preview a rule on a raw request WITHOUT creating it
                               (same --section/op/match/replace flags)
  create-mr-collection <name>  · rename-mr-collection <c> <n> · delete-mr-collection <c>

  Sections:
    request : req-method req-path req-query req-body req-first-line req-header req-all req-sni
    response: resp-body resp-status resp-first-line resp-header resp-all
    websocket: ws-up ws-down
    Operations per section: header/query → raw|update|add|remove; method/status → update;
    sni → raw (replacer only); everything else → raw (matcher+replacer).

  Example — strip a header on every replayed request:
    create-mr-rule --section req-header --operation remove --match-name "If-None-Match" \
      --name "drop INM" --sources REPLAY
  Example — inject auth on all proxied traffic to a host:
    create-mr-rule --section req-header --operation add --match-name "Authorization" \
      --replace "Bearer eyJ…" --condition 'req.host.eq:"target.com"' --name "auth inject"

═══════════════════════════════════════════════
 INFO
═══════════════════════════════════════════════

  viewer                       Get current user info
  plugins                      List installed plugins
  health                       Check Caido instance health

═══════════════════════════════════════════════
 OUTPUT CONTROL (works with get, get-response, replay, edit, send-raw)
═══════════════════════════════════════════════

    --max-body <n>             Max response body lines (default: 200, 0=unlimited)
    --max-body-chars <n>       Max response body chars (default: 5000, 0=unlimited)
    --no-request               Don't include request raw (saves tokens)
    --headers-only             Show only HTTP headers, no body
    --compact                  Shorthand: --no-request --max-body 50 --max-body-chars 5000

═══════════════════════════════════════════════
 SETUP & AUTH
═══════════════════════════════════════════════

  setup <pat> [url]            Save PAT (keyed by URL) and validate via SDK
                               (url defaults to http://localhost:8080)
    --proxy <addr>             Caido proxy for curl -x (defaults to the Caido URL)
  auth-status                  Check auth for the active instance + list all instances

  Multiple instances: credentials are keyed by URL; setup a second URL to add it.
  Active instance = CAIDO_URL env → stored default → http://localhost:8080.

  Or set env vars:
    export CAIDO_PAT=<token>
    export CAIDO_URL=http://localhost:8081     # selects the active instance per shell
    export CAIDO_PROXY=...      # only if the proxy listener differs from CAIDO_URL

Primary testing workflow (curl, proxied through Caido — NOT replay):
  npx tsx caido-client.ts search 'req.path.cont:"/api/user"' --recent --compact
  npx tsx caido-client.ts export-curl 12345        # grab a base request as curl
  # then test with curl, always proxying through Caido so it lands in history:
  curl -x http://127.0.0.1:8080 -k 'https://target.com/api/user/999' -H 'Cookie: ...'

Handoff to the user (named replay sessions in named collections):
  npx tsx caido-client.ts create-collection "Vuln chain - IDOR to ATO"
  npx tsx caido-client.ts create-session 12345 --name "1. login" --collection "Vuln chain - IDOR to ATO"
  npx tsx caido-client.ts edit 12345 --path /api/admin --new-name "2. priv-esc" --session "1. login"
  npx tsx caido-client.ts edit-session "2. priv-esc" --body '{"role":"admin"}' --nonach --compact

Other:
  npx tsx caido-client.ts create-finding 12345 --title "IDOR" --reporter "rez0"
  npx tsx caido-client.ts create-scope "Target" --allow "*.example.com"
  npx tsx caido-client.ts sessions --limit 10
  npx tsx caido-client.ts health
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    // ── HTTP History ──
    case "search": {
      const filter = args[1] || "";
      let limit = 20;
      let after: string | undefined;
      let idsOnly = false;
      let desc = true;  // newest-first by default — see cmdSearch
      let compact = false;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
        else if (args[i] === "--after" && args[i + 1]) { after = args[i + 1]; i++; }
        else if (args[i] === "--ids-only") { idsOnly = true; }
        else if (args[i] === "--asc" || args[i] === "--ascending" || args[i] === "--oldest") { desc = false; }
        // --desc/--latest/--recent are now the default; still accepted so old invocations don't break.
        else if (args[i] === "--desc" || args[i] === "--latest" || args[i] === "--recent") { desc = true; }
        else if (args[i] === "--compact") { compact = true; }
      }
      await cmdSearch(filter, limit, after, idsOnly, desc, compact);
      break;
    }

    case "recent": {
      let limit = 20;
      let compact = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
        else if (args[i] === "--compact") { compact = true; }
      }
      await cmdRecent(limit, compact);
      break;
    }

    case "get": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      await cmdGet(args[1], parseOutputOpts(args, 2));
      break;
    }

    case "get-response": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      await cmdGetResponse(args[1], parseOutputOpts(args, 2));
      break;
    }

    case "raw": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      let out: string | undefined, response = false;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--out" && args[i + 1]) { out = args[i + 1]; i++; }
        else if (args[i] === "--response") { response = true; }
      }
      await cmdRaw(args[1], { out, response });
      break;
    }

    case "replay": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      const name = requireName(args, 2, "creating a replay session with `replay`");
      let rawOverride: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--raw" && args[i + 1]) { rawOverride = args[i + 1]; i++; }
      }
      await cmdReplay(
        args[1],
        rawOverride,
        name,
        parseOutputOpts(args, 2),
        parseConnectionOverrides(args, 2),
        parseCollectionId(args, 2),
      );
      break;
    }

    case "send-raw": {
      let host: string | undefined, port = 443, tls = true, raw: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--host" && args[i + 1]) { host = args[i + 1]; i++; }
        else if (args[i] === "--port" && args[i + 1]) { port = parseInt(args[i + 1], 10); i++; }
        else if (args[i] === "--tls") { tls = true; }
        else if (args[i] === "--no-tls") { tls = false; }
        else if (args[i] === "--raw" && args[i + 1]) { raw = args[i + 1]; i++; }
      }
      if (!host || !raw) {
        console.error("Error: --host and --raw are required");
        process.exit(1);
      }
      const name = requireName(args, 1, "creating a replay session with `send-raw`");
      await cmdSendRaw(
        host,
        port,
        tls,
        raw,
        name,
        parseOutputOpts(args, 1),
        parseConnectionOverrides(args, 1),
        parseCollectionId(args, 1),
      );
      break;
    }

    case "edit": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      let method: string | undefined, path: string | undefined, body: string | undefined, sessionRef: string | undefined;
      const setHeaders: string[] = [], removeHeaders: string[] = [], replacements: string[] = [];
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--method" && args[i + 1]) { method = args[i + 1]; i++; }
        else if (args[i] === "--path" && args[i + 1]) { path = args[i + 1]; i++; }
        else if (args[i] === "--body" && args[i + 1]) { body = args[i + 1]; i++; }
        else if (args[i] === "--set-header" && args[i + 1]) { setHeaders.push(args[i + 1]); i++; }
        else if (args[i] === "--remove-header" && args[i + 1]) { removeHeaders.push(args[i + 1]); i++; }
        else if (args[i] === "--replace" && args[i + 1]) { replacements.push(args[i + 1]); i++; }
        else if (args[i] === "--session" && args[i + 1]) { sessionRef = args[i + 1]; i++; }
      }
      // Existing session → require name-change intent. New session → require --name.
      const target: EditTarget = sessionRef
        ? { kind: "session", ref: sessionRef, nameChange: requireNameChange(args, 2) }
        : { kind: "new", name: requireName(args, 2, "`edit` creates a new replay session"), collectionRef: parseCollectionId(args, 2) };
      await cmdEdit(
        args[1],
        { method, path, body, setHeaders, removeHeaders, replacements },
        target,
        parseOutputOpts(args, 2),
        parseConnectionOverrides(args, 2),
      );
      break;
    }

    case "export-curl": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      let asConfig = false, ecOut: string | undefined, cookieJar = false;
      const ecExclude: string[] = [];
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--config") { asConfig = true; }
        else if (args[i] === "--out" && args[i + 1]) { ecOut = args[i + 1]; i++; }
        else if (args[i] === "--cookie-jar") { cookieJar = true; }
        else if (args[i] === "--exclude" && args[i + 1]) { ecExclude.push(args[i + 1]); i++; }
      }
      if (asConfig) await cmdExportCurlConfig(args[1], { out: ecOut, cookieJar, exclude: ecExclude });
      else await cmdExportCurl(args[1]);
      break;
    }

    // ── Replay Tab Lookup ──
    case "get-session": {
      if (!args[1]) { console.error("Error: session id or name required"); process.exit(1); }
      await cmdGetSession(args[1], parseOutputOpts(args, 2));
      break;
    }

    case "replay-entries":
    case "session-entries": {
      if (!args[1]) { console.error("Error: session id or name required"); process.exit(1); }
      let limit = 20;
      let includeRaw = false;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
        else if (args[i] === "--raw") { includeRaw = true; }
      }
      await cmdReplayEntries(args[1], limit, parseOutputOpts(args, 2), includeRaw);
      break;
    }

    case "edit-session": {
      if (!args[1]) { console.error("Error: session id or name required"); process.exit(1); }
      let esMethod: string | undefined, esPath: string | undefined, esBody: string | undefined;
      const esSetHeaders: string[] = [], esRemoveHeaders: string[] = [], esReplacements: string[] = [];
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--method" && args[i + 1]) { esMethod = args[i + 1]; i++; }
        else if (args[i] === "--path" && args[i + 1]) { esPath = args[i + 1]; i++; }
        else if (args[i] === "--body" && args[i + 1]) { esBody = args[i + 1]; i++; }
        else if (args[i] === "--set-header" && args[i + 1]) { esSetHeaders.push(args[i + 1]); i++; }
        else if (args[i] === "--remove-header" && args[i + 1]) { esRemoveHeaders.push(args[i + 1]); i++; }
        else if (args[i] === "--replace" && args[i + 1]) { esReplacements.push(args[i + 1]); i++; }
      }
      await cmdEditSession(
        args[1],
        { method: esMethod, path: esPath, body: esBody, setHeaders: esSetHeaders, removeHeaders: esRemoveHeaders, replacements: esReplacements },
        requireNameChange(args, 2),
        parseOutputOpts(args, 2),
        parseConnectionOverrides(args, 2),
      );
      break;
    }

    // ── Replay Sessions ──
    case "create-session": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      const name = requireName(args, 2, "creating a replay session");
      await cmdCreateSession(args[1], name, parseCollectionId(args, 2));
      break;
    }

    case "rename-session": {
      if (!args[1] || !args[2]) { console.error("Error: session (id or name) and new name required"); process.exit(1); }
      await cmdRenameSession(args[1], args[2]);
      break;
    }

    case "move-session": {
      if (!args[1] || !args[2]) { console.error("Error: session and collection (id or name) required"); process.exit(1); }
      await cmdMoveSession(args[1], args[2]);
      break;
    }

    case "sessions":
    case "replay-sessions": {
      let limit: number | undefined;   // default: paginate all
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
      }
      await cmdReplaySessions(limit);
      break;
    }

    case "delete-sessions": {
      if (!args[1]) { console.error("Error: comma-separated session IDs required"); process.exit(1); }
      await cmdDeleteSessions(args[1].split(",").map(s => s.trim()));
      break;
    }

    // ── Replay Collections ──
    case "collections":
    case "replay-collections": {
      let limit: number | undefined;   // default: paginate all
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
      }
      await cmdReplayCollections(limit);
      break;
    }

    case "create-collection": {
      if (!args[1]) { console.error("Error: collection name required (names are mandatory)"); process.exit(1); }
      await cmdCreateCollection(args[1]);
      break;
    }

    case "rename-collection": {
      if (!args[1] || !args[2]) { console.error("Error: collection (id or name) and new name required"); process.exit(1); }
      await cmdRenameCollection(args[1], args[2]);
      break;
    }

    case "delete-collection": {
      if (!args[1]) { console.error("Error: collection (id or name) required"); process.exit(1); }
      await cmdDeleteCollection(args[1]);
      break;
    }

    // ── Automate & Fuzzing ──
    case "create-automate-session": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      await cmdCreateAutomateSession(args[1]);
      break;
    }

    case "fuzz": {
      if (!args[1]) { console.error("Error: session-id required"); process.exit(1); }
      await cmdFuzz(args[1], []);
      break;
    }

    // ── Findings ──
    case "findings": {
      let limit = 20;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
      }
      await cmdFindings(limit);
      break;
    }

    case "get-finding": {
      if (!args[1]) { console.error("Error: finding-id required"); process.exit(1); }
      await cmdGetFinding(args[1]);
      break;
    }

    case "create-finding": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      let title: string | undefined, desc: string | undefined, reporter: string | undefined, dedupeKey: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--title" && args[i + 1]) { title = args[i + 1]; i++; }
        else if (args[i] === "--description" && args[i + 1]) { desc = args[i + 1]; i++; }
        else if (args[i] === "--reporter" && args[i + 1]) { reporter = args[i + 1]; i++; }
        else if (args[i] === "--dedupe-key" && args[i + 1]) { dedupeKey = args[i + 1]; i++; }
      }
      if (!title) { console.error("Error: --title required"); process.exit(1); }
      await cmdCreateFinding(args[1], title, desc, reporter, dedupeKey);
      break;
    }

    case "update-finding": {
      if (!args[1]) { console.error("Error: finding-id required"); process.exit(1); }
      let uTitle: string | undefined, uDesc: string | undefined, uHidden: boolean | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--title" && args[i + 1]) { uTitle = args[i + 1]; i++; }
        else if (args[i] === "--description" && args[i + 1]) { uDesc = args[i + 1]; i++; }
        else if (args[i] === "--hidden") { uHidden = true; }
        else if (args[i] === "--visible") { uHidden = false; }
      }
      await cmdUpdateFinding(args[1], uTitle, uDesc, uHidden);
      break;
    }

    // ── Projects ──
    case "projects": { await cmdProjects(); break; }
    case "select-project": {
      if (!args[1]) { console.error("Error: project id required"); process.exit(1); }
      await cmdSelectProject(args[1]);
      break;
    }

    // ── Scopes ──
    case "scopes": { await cmdScopes(); break; }
    case "create-scope": {
      if (!args[1]) { console.error("Error: scope name required"); process.exit(1); }
      let allow: string[] = [], deny: string[] = [];
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--allow" && args[i + 1]) { allow = args[i + 1].split(",").map(s => s.trim()); i++; }
        else if (args[i] === "--deny" && args[i + 1]) { deny = args[i + 1].split(",").map(s => s.trim()); i++; }
      }
      await cmdCreateScope(args[1], allow, deny);
      break;
    }
    case "update-scope": {
      if (!args[1]) { console.error("Error: scope id required"); process.exit(1); }
      let sName: string | undefined, sAllow: string[] | undefined, sDeny: string[] | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--name" && args[i + 1]) { sName = args[i + 1]; i++; }
        else if (args[i] === "--allow" && args[i + 1]) { sAllow = args[i + 1].split(",").map(s => s.trim()); i++; }
        else if (args[i] === "--deny" && args[i + 1]) { sDeny = args[i + 1].split(",").map(s => s.trim()); i++; }
      }
      await cmdUpdateScope(args[1], sName, sAllow, sDeny);
      break;
    }
    case "delete-scope": {
      if (!args[1]) { console.error("Error: scope id required"); process.exit(1); }
      await cmdDeleteScope(args[1]);
      break;
    }

    // ── Filters ──
    case "filters": { await cmdFilters(); break; }
    case "create-filter": {
      if (!args[1]) { console.error("Error: filter name required"); process.exit(1); }
      let fQuery: string | undefined, fAlias: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--query" && args[i + 1]) { fQuery = args[i + 1]; i++; }
        else if (args[i] === "--alias" && args[i + 1]) { fAlias = args[i + 1]; i++; }
      }
      if (!fQuery) { console.error("Error: --query required"); process.exit(1); }
      await cmdCreateFilter(args[1], fQuery, fAlias);
      break;
    }
    case "update-filter": {
      if (!args[1]) { console.error("Error: filter id required"); process.exit(1); }
      let ufName: string | undefined, ufQuery: string | undefined, ufAlias: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--name" && args[i + 1]) { ufName = args[i + 1]; i++; }
        else if (args[i] === "--query" && args[i + 1]) { ufQuery = args[i + 1]; i++; }
        else if (args[i] === "--alias" && args[i + 1]) { ufAlias = args[i + 1]; i++; }
      }
      await cmdUpdateFilter(args[1], ufName, ufQuery, ufAlias);
      break;
    }
    case "delete-filter": {
      if (!args[1]) { console.error("Error: filter id required"); process.exit(1); }
      await cmdDeleteFilter(args[1]);
      break;
    }

    // ── Environments ──
    case "envs": { await cmdEnvs(); break; }
    case "create-env": {
      if (!args[1]) { console.error("Error: environment name required"); process.exit(1); }
      await cmdCreateEnv(args[1]);
      break;
    }
    case "select-env": { await cmdSelectEnv(args[1]); break; }
    case "env-set": {
      if (!args[1] || !args[2] || args[3] === undefined) {
        console.error("Error: env-set requires <env-id> <var-name> <value>");
        process.exit(1);
      }
      await cmdEnvSet(args[1], args[2], args[3]);
      break;
    }
    case "delete-env": {
      if (!args[1]) { console.error("Error: environment id required"); process.exit(1); }
      await cmdDeleteEnv(args[1]);
      break;
    }

    // ── Hosted Files ──
    case "hosted-files": { await cmdHostedFiles(); break; }
    case "delete-hosted-file": {
      if (!args[1]) { console.error("Error: hosted file id required"); process.exit(1); }
      await cmdDeleteHostedFile(args[1]);
      break;
    }

    // ── Tasks ──
    case "tasks": { await cmdTasks(); break; }
    case "cancel-task": {
      if (!args[1]) { console.error("Error: task id required"); process.exit(1); }
      await cmdCancelTask(args[1]);
      break;
    }

    // ── Intercept ──
    case "intercept-status": { await cmdInterceptStatus(); break; }
    case "intercept-enable": { await cmdInterceptSet(true); break; }
    case "intercept-disable": { await cmdInterceptSet(false); break; }

    // ── Match & Replace (Tamper) ──
    case "mr-rules": { await cmdMrRules(); break; }
    case "mr-collections": { await cmdMrCollections(); break; }

    case "create-mr-rule": {
      await cmdCreateMrRule(parseMrOpts(args, 1), parseCollectionId(args, 1));
      break;
    }
    case "update-mr-rule": {
      if (!args[1]) { console.error("Error: rule id required"); process.exit(1); }
      await cmdUpdateMrRule(args[1], parseMrOpts(args, 2));
      break;
    }
    case "delete-mr-rule": {
      if (!args[1]) { console.error("Error: rule id required"); process.exit(1); }
      await cmdDeleteMrRule(args[1]);
      break;
    }
    case "toggle-mr-rule": {
      if (!args[1]) { console.error("Error: rule id required"); process.exit(1); }
      const off = args.includes("--off") || args.includes("--disable");
      const on = args.includes("--on") || args.includes("--enable");
      if (off === on) { console.error("Error: pass exactly one of --on/--enable or --off/--disable"); process.exit(1); }
      await cmdToggleMrRule(args[1], on);
      break;
    }
    case "rename-mr-rule": {
      if (!args[1] || !args[2]) { console.error("Error: rule id and new name required"); process.exit(1); }
      await cmdRenameMrRule(args[1], args[2]);
      break;
    }
    case "move-mr-rule": {
      if (!args[1] || !args[2]) { console.error("Error: rule id and collection (name or id) required"); process.exit(1); }
      await cmdMoveMrRule(args[1], args[2]);
      break;
    }
    case "test-mr-rule": {
      let mrRaw: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--raw" && args[i + 1]) { mrRaw = args[i + 1]; i++; }
      }
      if (!mrRaw) { console.error("Error: --raw <str|@file|-> required (the request/response to tamper)"); process.exit(1); }
      await cmdTestMrRule(parseMrOpts(args, 1), mrRaw);
      break;
    }

    case "create-mr-collection": {
      if (!args[1]) { console.error("Error: collection name required"); process.exit(1); }
      await cmdCreateMrCollection(args[1]);
      break;
    }
    case "rename-mr-collection": {
      if (!args[1] || !args[2]) { console.error("Error: collection (id or name) and new name required"); process.exit(1); }
      await cmdRenameMrCollection(args[1], args[2]);
      break;
    }
    case "delete-mr-collection": {
      if (!args[1]) { console.error("Error: collection (id or name) required"); process.exit(1); }
      await cmdDeleteMrCollection(args[1]);
      break;
    }

    // ── Info ──
    case "viewer": { await cmdViewer(); break; }
    case "plugins": { await cmdPlugins(); break; }
    case "health": { await cmdHealth(); break; }

    // ── Setup & Auth ──
    case "setup": {
      const pat = args[1];
      if (!pat) {
        console.error("Usage: npx tsx caido-client.ts setup <pat> [url] [--proxy <addr>]");
        console.error("\nGet a PAT from: Caido → Settings → Developer → Personal Access Tokens");
        process.exit(1);
      }
      let url: string | undefined, proxy: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--proxy" && args[i + 1]) { proxy = args[i + 1]; i++; }
        else if (!args[i].startsWith("--") && !url) { url = args[i]; }
      }
      url = url || process.env.CAIDO_URL || "http://localhost:8080";
      await cmdSetup(pat, url, proxy);
      break;
    }
    case "auth-status": { await cmdAuthStatus(); break; }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  if (DEBUG) console.error(e.stack);
  process.exit(1);
});
