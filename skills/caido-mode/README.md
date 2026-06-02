# Caido Mode

Full SDK CLI for [Caido](https://caido.io) built on the official [`@caido/sdk-client`](https://github.com/caido/sdk-js) package. Search HTTP history, test with curl proxied through Caido (caching auth into reusable curl config files + cookie jars), organize handoffs into named replay sessions/collections, manage scopes/filters/environments, create findings, and fuzz — all from the terminal.

## Why?

Cookies and auth tokens are huge. Instead of copy-pasting 2KB of session cookies into every test request, you find an organic request in Caido's history that already has valid auth and work from it. Two modes, kept strictly separate:

1. **Testing → curl, proxied through Caido.** `export-curl <id> --config` caches a base request's auth into a reusable `-K` config + cookie jar under `/tmp/caido/<host>/`; then probe with `curl -K auth.cfg "$BASE/path"`. All traffic goes through Caido into history; the big auth blob stays in a file.
2. **Handoff → named replay sessions in named collections.** Only when handing requests to the user do you materialize them in Caido's UI.

## What's Covered

| Category | Commands |
|----------|----------|
| **HTTP History** | `search`, `recent`, `get`, `get-response`, `raw`, `export-curl` |
| **curl testing** | `export-curl` (full command), `export-curl --config` (reusable `-K` config + cookie jar), `raw` (dump bytes) |
| **Edit & Replay** | `edit`, `replay`, `send-raw`, `edit-session` |
| **Replay Tab Lookup** | `get-session`, `replay-entries`, `session-entries` |
| **Sessions** | `create-session`, `rename-session`, `move-session`, `sessions`, `delete-sessions` |
| **Collections** | `collections`, `create-collection`, `rename-collection`, `delete-collection` |
| **Fuzzing** | `create-automate-session`, `fuzz` |
| **Scopes** | `scopes`, `create-scope`, `update-scope`, `delete-scope` |
| **Filter Presets** | `filters`, `create-filter`, `update-filter`, `delete-filter` |
| **Environments** | `envs`, `create-env`, `select-env`, `env-set`, `delete-env` |
| **Findings** | `findings`, `get-finding`, `create-finding`, `update-finding` |
| **Tasks** | `tasks`, `cancel-task` |
| **Projects** | `projects`, `select-project` |
| **Hosted Files** | `hosted-files`, `delete-hosted-file` |
| **Intercept** | `intercept-status`, `intercept-enable`, `intercept-disable` |
| **Info** | `viewer`, `plugins`, `health` |
| **Auth** | `setup`, `auth-status` |

## Setup

Requires [Node.js](https://nodejs.org) (v24+), a running Caido instance and a [PAT](https://docs.caido.io/dashboard/guides/create_pat.html).

```bash
# Install dependencies
npm install

# 1. Create a PAT in Dashboard → Developer → Personal Access Tokens
# 2. Setup (validates PAT via SDK and caches access token)
npx tsx caido-client.ts setup <your-pat>

# 3. Verify it works
npx tsx caido-client.ts health
npx tsx caido-client.ts recent --limit 1

# Or use env var instead
export CAIDO_PAT=<your-pat>
```

The `setup` command uses the SDK's device code flow (auto-approved by your PAT) to obtain an access token, then saves the PAT and cached token to `~/.claude/config/secrets.json` via a custom `TokenCache` implementation. Subsequent runs load the cached token directly, and a valid cached token can be used even when the PAT is absent.

**Multiple instances:** credentials are keyed by instance URL, so two Caido instances on one machine never clobber each other. `setup <pat> <url>` stores that instance (and makes it the active default); setting up a second URL adds it rather than overwriting. The active instance is `CAIDO_URL` env → stored default → `http://localhost:8080` — select per shell with `CAIDO_URL` (concurrency-safe). `auth-status` lists all configured instances and the active one.

```bash
npx tsx caido-client.ts setup <pat-a> http://localhost:8080
npx tsx caido-client.ts setup <pat-b> http://localhost:8081
CAIDO_URL=http://localhost:8081 npx tsx caido-client.ts recent --compact
```

## File Structure

```
caido-client.ts          # CLI entry point — arg parsing + command dispatch
lib/
  client.ts              # SDK Client singleton, SecretsTokenCache, auth config
  graphql.ts             # gql documents for features not yet in SDK
  output.ts              # Output formatting (truncation, headers-only, raw→curl)
  types.ts               # Shared types (OutputOpts)
  commands/
    requests.ts          # search, recent, get, get-response, raw, export-curl (+ --config)
    replay.ts            # replay, send-raw, edit, replay-tab lookup, sessions, collections, automate, fuzz
    findings.ts          # findings, get-finding, create-finding, update-finding
    management.ts        # scopes, filters, environments, projects, hosted-files, tasks
    intercept.ts         # intercept-status, intercept-enable, intercept-disable
    info.ts              # viewer, plugins, health, setup, auth-status
```

## Usage

All commands output JSON. Run `npx tsx caido-client.ts --help` for the complete list.

### Search & Browse

```bash
# Search with HTTPQL (Caido's query language)
npx tsx caido-client.ts search 'req.method.eq:"POST" AND resp.code.eq:200'
npx tsx caido-client.ts search 'req.host.cont:"api"' --limit 50
npx tsx caido-client.ts search 'req.host.cont:"api"' --recent --compact   # newest first, terse

# Get recent requests
npx tsx caido-client.ts recent --limit 10 --compact

# Full request details with raw HTTP (JSON)
npx tsx caido-client.ts get <request-id>

# Just the response
npx tsx caido-client.ts get-response <request-id>

# Dump raw bytes to a file (e.g. seed a request body)
npx tsx caido-client.ts raw <request-id> --out /tmp/caido/target.com/body.json
```

### Primary testing workflow (curl through Caido)

Cache a base request's auth once, then probe with curl. Every request goes through Caido into history; the auth blob stays in a file.

```bash
# 1. find an authenticated base request
npx tsx caido-client.ts search 'req.host.cont:"target.com" AND req.path.cont:"/api/user"' --recent --compact
# 2. ONCE: write a reusable curl config + cookie jar (proxy + auth baked in)
npx tsx caido-client.ts export-curl 8431 --config
#    → /tmp/caido/target.com/auth.cfg + cookies.txt, BASE=https://target.com
# 3. test (the config carries the Caido proxy + auth; cookies auto-rotate via the jar)
BASE=https://target.com
curl -K /tmp/caido/target.com/auth.cfg "$BASE/api/user/999"
curl -K /tmp/caido/target.com/auth.cfg -X POST "$BASE/api/profile" --data-binary @body.json
```

The config is for **internal** testing. When you hand the user a reproduction, always give a **full self-contained** curl (all headers inline):

```bash
npx tsx caido-client.ts export-curl 8431      # full, portable curl command for the user
```

Refresh lazily: only on 401/403 do you re-run `export-curl <fresh-id> --config`. The proxy defaults to the Caido URL; override with `setup --proxy <addr>` or `CAIDO_PROXY`.

### Edit & Replay (handoff / explicit in-Replay testing)

Take an existing authenticated request and modify only what you need — cookies, auth headers, User-Agent are preserved. Use this when handing a request to the user, or when the user asks you to test inside Replay. New sessions require `--name`; editing an existing session requires `--no-name-change`/`--nonach` or `--new-name`.

```bash
# Edit into a NEW named session
npx tsx caido-client.ts edit <id> --path /api/user/999 --name "IDOR victim 999"

# Edit an EXISTING session (declare name intent)
npx tsx caido-client.ts edit-session "IDOR victim 999" --body '{"role":"admin"}' --nonach
npx tsx caido-client.ts edit <id> --set-header "X-Forwarded-For: 127.0.0.1" --session "IDOR victim 999" --new-name "XFF bypass"

# Find/replace text anywhere in the request
npx tsx caido-client.ts edit <id> --replace "user123:::user456" --name "IDOR replace"
```

`edit`, `replay`, and `send-raw` support connection overrides for virtual-host and upstream routing tests: `--sni`, `--connect-host`, `--connect-port`, `--connect-tls`, and `--connect-no-tls`.

### Replay Tab Lookup

Work directly from an existing Caido replay tab/session.

```bash
npx tsx caido-client.ts get-session <session-id-or-name> --compact
npx tsx caido-client.ts replay-entries <session-id-or-name> --limit 20
npx tsx caido-client.ts replay-entries <session-id-or-name> --raw --compact
npx tsx caido-client.ts edit-session <session-id-or-name> --body '{"test":true}' --compact
```

`session-entries` is accepted as an alias for `replay-entries`.

### Raw Replay (through Caido — creates a named session)

`send-raw` and `replay` create a replay session, so `--name` is required. For ephemeral testing prefer the raw-socket workflow above; use these when you want the request in Caido's UI.

```bash
npx tsx caido-client.ts send-raw --host example.com --raw @request.txt --name "G /"
cat request.txt | npx tsx caido-client.ts send-raw --host example.com --raw - --name "G / (stdin)"
npx tsx caido-client.ts replay <id> --name "repro" --connect-host 10.0.0.5 --connect-port 8443 --sni example.com
```

`--raw` accepts a string with C-style escapes, `@file`, or `-` for stdin.

### Export to curl

```bash
npx tsx caido-client.ts export-curl <request-id>            # full self-contained command (for the user)
npx tsx caido-client.ts export-curl <request-id> --config   # reusable -K config + cookie jar (internal)
npx tsx caido-client.ts export-curl <request-id> --config --out /tmp/caido/host/auth.cfg
```

### Findings

```bash
npx tsx caido-client.ts findings
npx tsx caido-client.ts get-finding <finding-id>
npx tsx caido-client.ts create-finding <request-id> \
  --title "IDOR in user profile" \
  --description "Can access other users' data" \
  --reporter "rez0"
npx tsx caido-client.ts update-finding <finding-id> --title "Updated title"
```

### Scopes

```bash
npx tsx caido-client.ts scopes
npx tsx caido-client.ts create-scope "Target" --allow "*.target.com" --deny "*.cdn.target.com"
npx tsx caido-client.ts update-scope <id> --allow "*.target.com,*.api.target.com"
npx tsx caido-client.ts delete-scope <id>
```

### Filter Presets

```bash
npx tsx caido-client.ts filters
npx tsx caido-client.ts create-filter "API Errors" --query 'req.path.cont:"/api/" AND resp.code.gte:400'
npx tsx caido-client.ts create-filter "Auth" --query 'req.path.regex:"/(login|auth)/"' --alias "auth"
npx tsx caido-client.ts delete-filter <id>
```

### Environments

```bash
npx tsx caido-client.ts envs
npx tsx caido-client.ts create-env "IDOR-Test"
npx tsx caido-client.ts env-set <env-id> victim_id "user_456"
npx tsx caido-client.ts select-env <env-id>
npx tsx caido-client.ts delete-env <id>
```

### Sessions & Collections (handoff)

Names are mandatory for sessions, and collections are referred to by name. Query existing collections before placing a session; one-off requests go in the default collection, multi-request handoffs get their own named collection.

```bash
npx tsx caido-client.ts collections                                  # query first
npx tsx caido-client.ts create-collection "Vuln chain - IDOR to ATO"
npx tsx caido-client.ts create-session <request-id> --name "1. login" --collection "Vuln chain - IDOR to ATO"
npx tsx caido-client.ts rename-session "1. login" "1. authenticate"
npx tsx caido-client.ts move-session "1. authenticate" "Vuln chain - IDOR to ATO"
npx tsx caido-client.ts sessions
npx tsx caido-client.ts delete-sessions <id1>,<id2>

npx tsx caido-client.ts rename-collection "Vuln chain - IDOR to ATO" "Vuln chain - account takeover"
npx tsx caido-client.ts delete-collection "Vuln chain - account takeover"
```

### Fuzzing

```bash
npx tsx caido-client.ts create-automate-session <request-id>
# Configure payload markers and wordlists in Caido UI first
npx tsx caido-client.ts fuzz <session-id>
```

### Tasks, Projects, Info & Health

```bash
npx tsx caido-client.ts tasks
npx tsx caido-client.ts cancel-task <task-id>
npx tsx caido-client.ts projects
npx tsx caido-client.ts select-project <id>
npx tsx caido-client.ts viewer
npx tsx caido-client.ts plugins
npx tsx caido-client.ts health
```

### Intercept Control

```bash
npx tsx caido-client.ts intercept-status
npx tsx caido-client.ts intercept-enable
npx tsx caido-client.ts intercept-disable
```

### Output Control

| Flag | Default | Description |
|------|---------|-------------|
| `--max-body <n>` | 200 | Max response body lines (0 = unlimited) |
| `--max-body-chars <n>` | 5000 | Max response body chars (0 = unlimited) |
| `--no-request` | off | Skip request raw in output |
| `--headers-only` | off | Show only HTTP headers, no body |
| `--compact` | off | Shorthand for `--no-request --max-body 50` |

## HTTPQL Quick Reference

Caido's query language for searching HTTP history. String values must be quoted, integers are not.

```
req.method.eq:"POST"                          # Match method
req.host.cont:"api"                           # Host contains
req.path.regex:"/users/[0-9]+/"               # Regex on path
resp.code.gte:400                             # Status code range
resp.len.gt:100000                            # Large responses
"password" OR "secret"                        # Search req+resp raw
req.method.eq:"POST" AND resp.code.eq:200     # Combine with AND/OR
source:"replay"                               # Filter by source
preset:"My Filter"                            # Use saved filter preset
```

## Architecture

Built on `@caido/sdk-client` v0.2.0+. Multi-file architecture with clean separation:

- **High-level SDK methods** for most features (requests, replay, findings, scopes, filters, environments, projects, hosted files, tasks, user)
- **`client.graphql.query()`/`mutation()`** with `gql` tagged templates for features not yet in SDK (intercept, plugins, automate/fuzz)
- **No raw fetch anywhere** — everything goes through the SDK

## Claude Code Integration

This repo is designed to work as a [Claude Code skill](https://docs.anthropic.com/en/docs/claude-code). The `SKILL.md` file provides Claude with full context on how to use every command, HTTPQL syntax, and testing workflows.

To install as a skill:

```bash
cp -r . ~/.claude/skills/caido-mode/
cd ~/.claude/skills/caido-mode && npm install
```

## License

MIT
