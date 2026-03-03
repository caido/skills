#!/usr/bin/env -S npx tsx
/**
 * Caido SDK Client v3.0
 * Clean multi-file CLI built entirely on @caido/sdk-client.
 * No raw fetch — uses SDK methods + client.graphql.query/mutation with gql documents.
 */

import { parseOutputOpts, DEFAULT_OUTPUT_OPTS } from "./lib/types";

// Commands
import { cmdSearch, cmdRecent, cmdGet, cmdGetResponse, cmdExportCurl } from "./lib/commands/requests";
import { cmdReplay, cmdSendRaw, cmdEdit, cmdReplaySessions, cmdCreateSession, cmdRenameSession, cmdDeleteSessions, cmdReplayCollections, cmdCreateCollection, cmdRenameCollection, cmdDeleteCollection, cmdCreateAutomateSession, cmdFuzz } from "./lib/commands/replay";
import { cmdFindings, cmdGetFinding, cmdCreateFinding, cmdUpdateFinding } from "./lib/commands/findings";
import { cmdScopes, cmdCreateScope, cmdUpdateScope, cmdDeleteScope, cmdFilters, cmdCreateFilter, cmdUpdateFilter, cmdDeleteFilter, cmdEnvs, cmdCreateEnv, cmdSelectEnv, cmdEnvSet, cmdDeleteEnv, cmdProjects, cmdSelectProject, cmdHostedFiles, cmdDeleteHostedFile, cmdTasks, cmdCancelTask } from "./lib/commands/management";
import { cmdInterceptStatus, cmdInterceptSet } from "./lib/commands/intercept";
import { cmdViewer, cmdPlugins, cmdHealth, cmdSetup, cmdAuthStatus } from "./lib/commands/info";

const DEBUG = process.env.DEBUG === "1";

function printUsage() {
  console.log(`
Caido SDK Client v3.0 — Built on @caido/sdk-client

Usage:
  caido-client.ts <command> [options]

═══════════════════════════════════════════════
 HTTP HISTORY & TESTING
═══════════════════════════════════════════════

  search <filter>              Search requests using HTTPQL
    --limit <n>                Max results (default: 20)
    --after <cursor>           Pagination cursor
    --ids-only                 Output only request IDs

  recent                       Get recent requests
    --limit <n>                Max results (default: 20)

  get <request-id>             Get full request details with raw data

  get-response <request-id>    Get just the response for a request

  replay <request-id>          Replay a request (blocks until response)
    --raw <raw-request>        Override with custom raw request

  send-raw                     Send a custom raw request
    --host <hostname>          Target host (required)
    --port <port>              Target port (default: 443)
    --tls / --no-tls           Use TLS (default: true)
    --raw <raw-request>        Raw HTTP request (required)

  edit <request-id>            Edit and replay a request (keeps cookies/auth)
    --method <METHOD>          Change HTTP method
    --path <path>              Change request path
    --set-header <N:V>         Set header (repeatable)
    --remove-header <name>     Remove header (repeatable)
    --body <body>              Set request body
    --replace <from>:::<to>    Replace text in request (repeatable)

  export-curl <request-id>     Export request as curl command

═══════════════════════════════════════════════
 REPLAY SESSIONS & COLLECTIONS
═══════════════════════════════════════════════

  create-session <request-id>  Create a replay session from a request
  rename-session <id> <name>   Rename a replay session
  replay-sessions              List replay sessions
    --limit <n>                Max results (default: 20)
  delete-sessions <id,id,...>  Delete replay sessions

  replay-collections           List replay collections
    --limit <n>                Max results (default: 20)
  create-collection <name>     Create a replay collection
  rename-collection <id> <n>   Rename a replay collection
  delete-collection <id>       Delete a replay collection

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

  setup <pat> [url]            Save PAT and validate via SDK
                               (url defaults to http://localhost:8080)
  auth-status                  Check current auth status

  Or set env vars:
    export CAIDO_PAT=<token>
    export CAIDO_URL=http://localhost:8080

Examples:
  npx tsx caido-client.ts search 'req.method.eq:"POST"' --limit 50
  npx tsx caido-client.ts edit 12345 --path /api/admin --method POST
  npx tsx caido-client.ts create-finding 12345 --title "IDOR" --reporter "rez0"
  npx tsx caido-client.ts create-scope "Target" --allow "*.example.com"
  npx tsx caido-client.ts replay-sessions --limit 10
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
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
        else if (args[i] === "--after" && args[i + 1]) { after = args[i + 1]; i++; }
        else if (args[i] === "--ids-only") { idsOnly = true; }
      }
      await cmdSearch(filter, limit, after, idsOnly);
      break;
    }

    case "recent": {
      let limit = 20;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
      }
      await cmdRecent(limit);
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

    case "replay": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      let rawOverride: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--raw" && args[i + 1]) { rawOverride = args[i + 1]; i++; }
      }
      await cmdReplay(args[1], rawOverride, parseOutputOpts(args, 2));
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
      await cmdSendRaw(host, port, tls, raw, parseOutputOpts(args, 1));
      break;
    }

    case "edit": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      let method: string | undefined, path: string | undefined, body: string | undefined;
      const setHeaders: string[] = [], removeHeaders: string[] = [], replacements: string[] = [];
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--method" && args[i + 1]) { method = args[i + 1]; i++; }
        else if (args[i] === "--path" && args[i + 1]) { path = args[i + 1]; i++; }
        else if (args[i] === "--body" && args[i + 1]) { body = args[i + 1]; i++; }
        else if (args[i] === "--set-header" && args[i + 1]) { setHeaders.push(args[i + 1]); i++; }
        else if (args[i] === "--remove-header" && args[i + 1]) { removeHeaders.push(args[i + 1]); i++; }
        else if (args[i] === "--replace" && args[i + 1]) { replacements.push(args[i + 1]); i++; }
      }
      await cmdEdit(args[1], { method, path, body, setHeaders, removeHeaders, replacements }, parseOutputOpts(args, 2));
      break;
    }

    case "export-curl": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      await cmdExportCurl(args[1]);
      break;
    }

    // ── Replay Sessions ──
    case "create-session": {
      if (!args[1]) { console.error("Error: request-id required"); process.exit(1); }
      await cmdCreateSession(args[1]);
      break;
    }

    case "rename-session": {
      if (!args[1] || !args[2]) { console.error("Error: session-id and name required"); process.exit(1); }
      await cmdRenameSession(args[1], args[2]);
      break;
    }

    case "replay-sessions": {
      let limit = 20;
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
    case "replay-collections": {
      let limit = 20;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
      }
      await cmdReplayCollections(limit);
      break;
    }

    case "create-collection": {
      if (!args[1]) { console.error("Error: collection name required"); process.exit(1); }
      await cmdCreateCollection(args[1]);
      break;
    }

    case "rename-collection": {
      if (!args[1] || !args[2]) { console.error("Error: collection-id and name required"); process.exit(1); }
      await cmdRenameCollection(args[1], args[2]);
      break;
    }

    case "delete-collection": {
      if (!args[1]) { console.error("Error: collection-id required"); process.exit(1); }
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

    // ── Info ──
    case "viewer": { await cmdViewer(); break; }
    case "plugins": { await cmdPlugins(); break; }
    case "health": { await cmdHealth(); break; }

    // ── Setup & Auth ──
    case "setup": {
      const pat = args[1];
      if (!pat) {
        console.error("Usage: npx tsx caido-client.ts setup <pat> [url]");
        console.error("\nGet a PAT from: Caido → Settings → Developer → Personal Access Tokens");
        process.exit(1);
      }
      const url = args[2] || process.env.CAIDO_URL || "http://localhost:8080";
      await cmdSetup(pat, url);
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
