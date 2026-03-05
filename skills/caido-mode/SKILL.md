---
name: caido-mode
description: Full Caido SDK integration for Claude Code. Search HTTP history, replay/edit requests, manage scopes/filters/environments, create findings, export curl commands, and control intercept - all via the official @caido/sdk-client. PAT auth recommended.
tags: [worker]
---

# Caido Mode Skill

## Overview

Full-coverage CLI for Caido's API, built on the official `@caido/sdk-client` package. Covers:

- **HTTP History** - Search, retrieve, replay, edit requests with HTTPQL
- **Replay & Sessions** - Sessions, collections, entries, fuzzing
- **Scopes** - Create and manage testing scopes (allowlist/denylist patterns)
- **Filter Presets** - Save and reuse HTTPQL filter presets
- **Environments** - Store test variables (victim IDs, tokens, etc.)
- **Findings** - Create, list, update security findings
- **Tasks** - Monitor and cancel background tasks
- **Projects** - Switch between testing projects
- **Hosted Files** - Manage files served by Caido
- **Intercept** - Enable/disable request interception programmatically
- **Plugins** - List installed plugins
- **Export** - Convert requests to curl commands for PoCs
- **Health** - Check Caido instance status

All traffic goes through Caido, so it appears in the UI for further analysis.

### Why This Model?

**Cookies and auth tokens can be huge** - session cookies, JWTs, CSRF tokens can easily be 1-2KB. Rather than manually copy-pasting:

1. **Find an organic request** in Caido's HTTP history that already has valid auth
2. **Use `edit` to modify just what you need** (path, method, body) while keeping all auth headers intact
3. **Send it** - response comes back with full context preserved

## Authentication Setup

### Setup (One-Time)

1. Open [Dashboard → Developer → Personal Access Tokens](https://docs.caido.io/dashboard/guides/create_pat.html)
2. Create a new token
3. Run:

```bash
node ~/.claude/skills/caido-mode/caido-client.ts setup <your-pat>

# Non-default Caido instance
node ~/.claude/skills/caido-mode/caido-client.ts setup <pat> http://192.168.1.100:8080

# Or set env var instead
export CAIDO_PAT=caido_xxxxx
```

The `setup` command validates the PAT via the SDK (which exchanges it for an access token), then saves both the PAT and the cached access token to `~/.claude/config/secrets.json`. Subsequent runs load the cached token directly, skipping the PAT exchange.

### Check Status

```bash
node ~/.claude/skills/caido-mode/caido-client.ts auth-status
```

### How Auth Works

The SDK uses a device code flow internally — the PAT auto-approves it and receives an access token + refresh token. A custom `SecretsTokenCache` (implementing the SDK's `TokenCache` interface) persists these tokens to secrets.json so they survive across CLI invocations.

Auth resolution: `CAIDO_PAT` env var → `secrets.json` PAT → error with setup instructions

## CLI Tool

Located at `~/.claude/skills/caido-mode/caido-client.ts`. All commands output JSON.

---

## HTTP History & Testing Commands

### search - Search HTTP history with HTTPQL

```bash
node caido-client.ts search 'req.method.eq:"POST" AND resp.code.eq:200'
node caido-client.ts search 'req.host.cont:"api"' --limit 50
node caido-client.ts search 'req.path.cont:"/admin"' --ids-only
node caido-client.ts search 'resp.raw.cont:"password"' --after <cursor>
```

### recent - Get recent requests

```bash
node caido-client.ts recent
node caido-client.ts recent --limit 50
```

### get / get-response - Retrieve full details

```bash
node caido-client.ts get <request-id>
node caido-client.ts get <request-id> --headers-only
node caido-client.ts get-response <request-id>
node caido-client.ts get-response <request-id> --compact
```

### edit - Edit and replay (KEY FEATURE)

Modifies an existing request while preserving all cookies/auth headers:

```bash
# Change path (IDOR testing)
node caido-client.ts edit <id> --path /api/user/999

# Change method and add body
node caido-client.ts edit <id> --method POST --body '{"admin":true}'

# Add/remove headers
node caido-client.ts edit <id> --set-header "X-Forwarded-For: 127.0.0.1"
node caido-client.ts edit <id> --remove-header "X-CSRF-Token"

# Find/replace text anywhere in request
node caido-client.ts edit <id> --replace "user123:::user456"

# Combine multiple edits
node caido-client.ts edit <id> --method PUT --path /api/admin --body '{"role":"admin"}' --compact
```

| Option | Description |
|--------|-------------|
| `--method <METHOD>` | Change HTTP method |
| `--path <path>` | Change request path |
| `--set-header <Name: Value>` | Add or replace a header (repeatable) |
| `--remove-header <Name>` | Remove a header (repeatable) |
| `--body <content>` | Set request body (auto-updates Content-Length) |
| `--replace <from>:::<to>` | Find/replace text anywhere in request (repeatable) |

### replay / send-raw - Send requests

```bash
# Replay as-is
node caido-client.ts replay <request-id>

# Replay with custom raw
node caido-client.ts replay <id> --raw "GET /modified HTTP/1.1\r\nHost: example.com\r\n\r\n"

# Send completely custom request
node caido-client.ts send-raw --host example.com --port 443 --tls --raw "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"
```

### export-curl - Convert to curl for PoCs

```bash
node caido-client.ts export-curl <request-id>
```

Outputs a ready-to-use curl command with all headers and body.

---

## Replay Sessions & Collections

### Sessions

```bash
# Create replay session from an existing request
node caido-client.ts create-session <request-id>

# ALWAYS rename sessions for easy identification in Caido UI
node caido-client.ts rename-session <session-id> "idor-user-profile"

# List all replay sessions
node caido-client.ts replay-sessions
node caido-client.ts replay-sessions --limit 50

# Delete replay sessions
node caido-client.ts delete-sessions <session-id-1>,<session-id-2>
```

### Collections

Organize replay sessions into collections:

```bash
# List replay collections
node caido-client.ts replay-collections
node caido-client.ts replay-collections --limit 50

# Create a collection
node caido-client.ts create-collection "IDOR Testing"

# Rename a collection
node caido-client.ts rename-collection <collection-id> "Auth Bypass Tests"

# Delete a collection
node caido-client.ts delete-collection <collection-id>
```

### Fuzzing

```bash
# Create automate session for fuzzing
node caido-client.ts create-automate-session <request-id>

# Start fuzzing (configure payloads and markers in Caido UI first)
node caido-client.ts fuzz <session-id>
```

---

## Scope Management

Define what's in scope for your testing. Uses glob patterns.

```bash
# List all scopes
node caido-client.ts scopes

# Create scope with allowlist and denylist
node caido-client.ts create-scope "Target Corp" --allow "*.target.com,*.target.io" --deny "*.cdn.target.com"

# Update scope
node caido-client.ts update-scope <scope-id> --allow "*.target.com,*.api.target.com"

# Delete scope
node caido-client.ts delete-scope <scope-id>
```

**Glob patterns:** `*.example.com` matches any subdomain of example.com.

---

## Filter Presets

Save frequently used HTTPQL queries as named presets.

```bash
# List saved filters
node caido-client.ts filters

# Create filter preset
node caido-client.ts create-filter "API Errors" --query 'req.path.cont:"/api/" AND resp.code.gte:400'
node caido-client.ts create-filter "Auth Endpoints" --query 'req.path.regex:"/(login|auth|oauth)/"' --alias "auth"

# Update filter
node caido-client.ts update-filter <filter-id> --query 'req.path.cont:"/api/" AND resp.code.gte:500'

# Delete filter
node caido-client.ts delete-filter <filter-id>
```

---

## Environment Variables

Store testing variables that persist across sessions. Great for IDOR testing with multiple user IDs.

```bash
# List environments
node caido-client.ts envs

# Create environment
node caido-client.ts create-env "IDOR-Test"

# Set variables
node caido-client.ts env-set <env-id> victim_user_id "user_456"
node caido-client.ts env-set <env-id> attacker_token "eyJhbG..."

# Select active environment
node caido-client.ts select-env <env-id>

# Deselect environment
node caido-client.ts select-env

# Delete environment
node caido-client.ts delete-env <env-id>
```

---

## Findings

Create, list, and update security findings. Shows up in Caido's Findings tab.

```bash
# List all findings
node caido-client.ts findings
node caido-client.ts findings --limit 50

# Get a specific finding
node caido-client.ts get-finding <finding-id>

# Create finding linked to a request
node caido-client.ts create-finding <request-id> \
  --title "IDOR in user profile endpoint" \
  --description "Can access other users' profiles by changing ID parameter" \
  --reporter "rez0"

# With deduplication key (prevents duplicates)
node caido-client.ts create-finding <request-id> \
  --title "Auth bypass on /admin" \
  --dedupe-key "admin-auth-bypass"

# Update finding
node caido-client.ts update-finding <finding-id> \
  --title "Updated title" \
  --description "Updated description"
```

---

## Tasks

Monitor and cancel background tasks (imports, exports, etc.).

```bash
# List all tasks
node caido-client.ts tasks

# Cancel a running task
node caido-client.ts cancel-task <task-id>
```

---

## Project Management

```bash
# List all projects
node caido-client.ts projects

# Switch active project
node caido-client.ts select-project <project-id>
```

---

## Hosted Files

```bash
# List hosted files
node caido-client.ts hosted-files

# Delete hosted file
node caido-client.ts delete-hosted-file <file-id>
```

---

## Intercept Control

```bash
# Check intercept status
node caido-client.ts intercept-status

# Enable/disable interception
node caido-client.ts intercept-enable
node caido-client.ts intercept-disable
```

---

## Info, Health & Plugins

```bash
# Current user info
node caido-client.ts viewer

# List installed plugins
node caido-client.ts plugins

# Check Caido instance health (version, ready state)
node caido-client.ts health
```

---

## Output Control

Works with `get`, `get-response`, `replay`, `edit`, `send-raw`:

| Flag | Description |
|------|-------------|
| `--max-body <n>` | Max response body lines (default: 200, 0=unlimited) |
| `--max-body-chars <n>` | Max body chars (default: 5000, 0=unlimited) |
| `--no-request` | Skip request raw in output |
| `--headers-only` | Only HTTP headers, no body |
| `--compact` | Shorthand: `--no-request --max-body 50 --max-body-chars 5000` |

---

## HTTPQL Reference

Caido's query language for searching HTTP history.

**CRITICAL**: String values MUST be quoted. Integer values are NOT quoted.

### Namespaces and Fields

| Namespace | Field | Type | Description |
|-----------|-------|------|-------------|
| `req` | `ext` | string | File extension (includes `.`) |
| `req` | `host` | string | Hostname |
| `req` | `method` | string | HTTP method (uppercase) |
| `req` | `path` | string | URL path |
| `req` | `query` | string | Query string |
| `req` | `raw` | string | Full raw request |
| `req` | `port` | int | Port number |
| `req` | `len` | int | Request body length |
| `req` | `created_at` | date | Creation timestamp |
| `req` | `tls` | bool | Is HTTPS |
| `resp` | `raw` | string | Full raw response |
| `resp` | `code` | int | Status code |
| `resp` | `len` | int | Response body length |
| `resp` | `roundtrip` | int | Roundtrip time (ms) |
| `row` | `id` | int | Request ID |
| `source` | - | special | `"intercept"`, `"replay"`, `"automate"`, `"workflow"` |
| `preset` | - | special | Filter preset reference |

### Operators

**String:** `eq`, `ne`, `cont`, `ncont`, `like`, `nlike`, `regex`, `nregex`
**Integer:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`
**Boolean:** `eq`, `ne`
**Logical:** `AND`, `OR`, parentheses for grouping

### Example Queries

```httpql
# POST requests with 200 responses
req.method.eq:"POST" AND resp.code.eq:200

# API requests
req.host.cont:"api" OR req.path.cont:"/api/"

# Standalone string searches both req and resp
"password" OR "secret" OR "api_key"

# Error responses
resp.code.gte:400 AND resp.code.lt:500

# Large responses (potential data exposure)
resp.len.gt:100000

# Slow endpoints
resp.roundtrip.gt:5000

# Auth endpoints by regex
req.path.regex:"/(login|auth|signin|oauth)/"

# Replay/automate traffic only
source:"replay" OR source:"automate"

# Date filtering
req.created_at.gt:"2024-01-01T00:00:00Z"
```

---

## SDK Architecture

This CLI is built on `@caido/sdk-client` v0.1.4+, using a clean multi-file architecture:

```
caido-client.ts          # CLI entry point — arg parsing + command dispatch
lib/
  client.ts              # SDK Client singleton, SecretsTokenCache, auth config
  graphql.ts             # gql documents for features not yet in SDK
  output.ts              # Output formatting (truncation, headers-only, raw→curl)
  types.ts               # Shared types (OutputOpts)
  commands/
    requests.ts          # search, recent, get, get-response, export-curl
    replay.ts            # replay, send-raw, edit, sessions, collections, automate, fuzz
    findings.ts          # findings, get-finding, create-finding, update-finding
    management.ts        # scopes, filters, environments, projects, hosted-files, tasks
    intercept.ts         # intercept-status, intercept-enable, intercept-disable
    info.ts              # viewer, plugins, health, setup, auth-status
```

### SDK Coverage

Most features use the high-level SDK directly:

| SDK Method | Commands |
|-----------|----------|
| `client.request.list()`, `.get()` | search, recent, get, get-response, export-curl |
| `client.replay.sessions.*` | create-session, replay-sessions, rename-session, delete-sessions |
| `client.replay.collections.*` | replay-collections, create-collection, rename-collection, delete-collection |
| `client.replay.send()` | replay, send-raw, edit |
| `client.finding.*` | findings, get-finding, create-finding, update-finding |
| `client.scope.*` | scopes, create-scope, update-scope, delete-scope |
| `client.filter.*` | filters, create-filter, update-filter, delete-filter |
| `client.environment.*` | envs, create-env, select-env, env-set, delete-env |
| `client.project.*` | projects, select-project |
| `client.hostedFile.*` | hosted-files, delete-hosted-file |
| `client.task.*` | tasks, cancel-task |
| `client.user.viewer()` | viewer |
| `client.health()` | health |

Features not yet in the high-level SDK use `client.graphql.query()`/`client.graphql.mutation()` with `gql` tagged templates from `graphql-tag`. This is the proper SDK approach (typed documents through urql) — **no raw fetch anywhere**.

| GraphQL Document | Commands |
|-----------------|----------|
| `INTERCEPT_OPTIONS_QUERY` | intercept-status |
| `PAUSE_INTERCEPT` / `RESUME_INTERCEPT` | intercept-enable, intercept-disable |
| `PLUGIN_PACKAGES_QUERY` | plugins |
| `CREATE_AUTOMATE_SESSION` | create-automate-session |
| `GET_AUTOMATE_SESSION` | fuzz (verify session) |
| `START_AUTOMATE_TASK` | fuzz (start task) |

---

## Workflow Examples

### 1. IDOR Testing (Primary Pattern)

```bash
# Find authenticated request
node caido-client.ts search 'req.path.cont:"/api/user"' --limit 10

# Create scope
node caido-client.ts create-scope "IDOR-Test" --allow "*.target.com"

# Create environment for test data
node caido-client.ts create-env "IDOR-Test"
node caido-client.ts env-set <env-id> victim_id "user_999"

# Test IDOR by changing user ID
node caido-client.ts edit <request-id> --path /api/user/999

# Mark as finding if it works
node caido-client.ts create-finding <request-id> --title "IDOR on /api/user/:id"

# Export curl for PoC
node caido-client.ts export-curl <request-id>
```

### 2. Privilege Escalation Testing

```bash
node caido-client.ts search 'req.path.cont:"/admin"' --limit 10
node caido-client.ts edit <id> --path /api/admin/users --method GET
node caido-client.ts edit <id> --method POST --body '{"role":"admin"}'
```

### 3. Header Bypass Testing

```bash
node caido-client.ts edit <id> --set-header "X-Forwarded-For: 127.0.0.1"
node caido-client.ts edit <id> --set-header "X-Original-URL: /admin"
node caido-client.ts edit <id> --remove-header "X-CSRF-Token"
```

### 4. Fuzzing with Automate

```bash
node caido-client.ts create-automate-session <request-id>
# Configure payload markers and wordlists in Caido UI
node caido-client.ts fuzz <session-id>
```

### 5. Filter + Analyze Pattern

```bash
# Save useful filters
node caido-client.ts create-filter "API 4xx" --query 'req.path.cont:"/api/" AND resp.code.gte:400 AND resp.code.lt:500'
node caido-client.ts create-filter "Large Responses" --query 'resp.len.gt:100000'
node caido-client.ts create-filter "Sensitive Data" --query '"password" OR "secret" OR "api_key" OR "token"'

# Quick search using preset alias
node caido-client.ts search 'preset:"API 4xx"' --limit 20
```

---

## Instructions for Claude

1. **PREFER `edit` OVER `replay --raw`** - preserves cookies/auth automatically
2. **Workflow**: Search → find request with valid auth → use that ID for all tests via `edit`
3. **Don't dump raw requests into context** - use `--compact` or `--headers-only` when exploring
4. **Always check auth first**: `health` to verify connection, then `recent --limit 1`
5. **ALWAYS NAME REPLAY TABS**: `rename-session <id> "idor-user-profile"`
6. **Create findings** for anything interesting - they show up in Caido's Findings tab
7. **Use `export-curl`** when building PoCs for reports
8. **Create filter presets** for recurring searches to save typing
9. **Use environments** to store test data (victim IDs, tokens, etc.)
10. **Output is JSON** - parse response fields as needed

## Performance & Context Optimization

- `search`/`recent` omit `raw` field (~200 bytes per request, safe for 100+)
- `get` fetches `raw` (~5-20KB per request, fetch only what you need)
- Use `--limit` aggressively (start with 5-10)
- Use `--compact` flag for quick exploration
- Filter server-side with HTTPQL, not client-side

## Error Handling

- **Auth errors**: Run `node caido-client.ts auth-status` to check, re-setup with `node caido-client.ts setup <pat>`
- **Connection refused**: Caido not running → `node caido-client.ts health`
- **InstanceNotReadyError**: Caido is starting up, wait and retry

## Related Skills

- `caido-plugin-dev` - For building Caido plugins (backend + frontend)
- `spider` - Crawling with Katana (uses Caido as proxy)
- `website-fuzzing` - Remote ffuf fuzzing on hunt6
- `JsAnalyzer` - JS analysis for traffic-discovered files
