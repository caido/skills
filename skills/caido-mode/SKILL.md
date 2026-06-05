---
name: caido-mode
description: Full Caido SDK CLI for AI agents. Search HTTP history, replay/edit requests, manage scopes/filters/environments, create findings, export curl, control intercept, and fuzz — all via @caido/sdk-client. PAT auth recommended.
tags: [worker]
---

# Caido Mode Skill

## Overview

Full-coverage CLI for Caido's API, built on `@caido/sdk-client`. Covers HTTP history, replay/edit with preserved auth, scopes, filters, environments, findings, intercept, and the complete Automate fuzzing pipeline. All commands output JSON.

### Core Principle

Cookies and auth tokens are huge. Rather than copy-pasting 2KB of session cookies:

1. **Find an organic request** in Caido's HTTP history with valid auth
2. **Use `edit` to modify just what you need** (path, method, body) while keeping all auth headers intact
3. **Send it** — response comes back with full context preserved

## Authentication Setup

```bash
# One-time setup (validates PAT, caches access token)
npx tsx caido-client.ts setup <your-pat>

# Non-default Caido instance
npx tsx caido-client.ts setup <pat> http://192.168.1.100:8080

# Or set env var
export CAIDO_PAT=caido_xxxxx

# Check status
npx tsx caido-client.ts auth-status
```

Auth resolution: `CAIDO_PAT` env var → `secrets.json` PAT → valid cached access token → error with setup instructions.

---

## HTTP History & Testing

### search — Search HTTP history with HTTPQL

```bash
npx tsx caido-client.ts search 'req.method.eq:"POST" AND resp.code.eq:200'
npx tsx caido-client.ts search 'req.host.cont:"api"' --limit 50
npx tsx caido-client.ts search 'req.path.cont:"/admin"' --ids-only
npx tsx caido-client.ts search 'resp.raw.cont:"password"' --after <cursor>
```

### recent — Get recent requests

```bash
npx tsx caido-client.ts recent
npx tsx caido-client.ts recent --limit 50
```

### get / get-response — Retrieve full details

```bash
npx tsx caido-client.ts get <request-id>
npx tsx caido-client.ts get <request-id> --headers-only
npx tsx caido-client.ts get-response <request-id>
npx tsx caido-client.ts get-response <request-id> --compact
```

### edit — Edit and replay (KEY FEATURE)

Preserves all cookies/auth headers. Modify only what you need:

```bash
npx tsx caido-client.ts edit <id> --path /api/user/999                          # IDOR test
npx tsx caido-client.ts edit <id> --method POST --body '{"admin":true}'         # priv-esc
npx tsx caido-client.ts edit <id> --set-header "X-Forwarded-For: 127.0.0.1"    # bypass
npx tsx caido-client.ts edit <id> --remove-header "X-CSRF-Token"                # CSRF removal
npx tsx caido-client.ts edit <id> --replace "user123:::user456"                 # find/replace
npx tsx caido-client.ts edit <id> --session <session-id> --compact              # reuse session
```

| Option | Description |
|--------|-------------|
| `--method <METHOD>` | Change HTTP method |
| `--path <path>` | Change request path |
| `--set-header <N:V>` | Add or replace header (repeatable) |
| `--remove-header <Name>` | Remove header (repeatable) |
| `--body <content>` | Set request body (auto-updates Content-Length) |
| `--replace <from>:::<to>` | Find/replace in raw request (repeatable) |
| `--session <id>` | Reuse existing replay session |
| `--collection <id>` | Put new session in a collection |
| `--sni <host>` | Override TLS SNI |
| `--connect-host <host>` | Connect to different host |
| `--connect-port <port>` | Connect to different port |
| `--connect-tls` / `--connect-no-tls` | Force TLS/plaintext |

### replay / send-raw — Send requests

```bash
npx tsx caido-client.ts replay <request-id>
npx tsx caido-client.ts replay <id> --raw "GET /modified HTTP/1.1\r\nHost: example.com\r\n\r\n"
npx tsx caido-client.ts send-raw --host example.com --port 443 --tls --raw "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"
npx tsx caido-client.ts send-raw --host example.com --raw @request.txt --name "G /"
cat request.txt | npx tsx caido-client.ts send-raw --host example.com --raw -
npx tsx caido-client.ts replay <id> --connect-host 10.0.0.5 --connect-port 8443 --sni example.com
```

`--raw` accepts a string with `\r\n` escapes, `@file`, or `-` for stdin.

### export-curl — Convert to curl for PoCs

```bash
npx tsx caido-client.ts export-curl <request-id>
```

---

## Replay Tab Lookup

```bash
npx tsx caido-client.ts get-session <session-id-or-name> --compact
npx tsx caido-client.ts replay-entries <session-id-or-name> --limit 20
npx tsx caido-client.ts replay-entries <session-id-or-name> --raw --compact
npx tsx caido-client.ts edit-session <session-id-or-name> --body '{"test":true}' --compact
```

`session-entries` is an alias for `replay-entries`.

---

## Replay Sessions & Collections

```bash
# Sessions
npx tsx caido-client.ts create-session <request-id>
npx tsx caido-client.ts create-session <request-id> --collection <collection-id>
npx tsx caido-client.ts rename-session <session-id> "idor-user-profile"
npx tsx caido-client.ts move-session <session-id> <collection-id>
npx tsx caido-client.ts replay-sessions --limit 50
npx tsx caido-client.ts delete-sessions <id-1>,<id-2>

# Collections
npx tsx caido-client.ts replay-collections
npx tsx caido-client.ts create-collection "IDOR Testing"
npx tsx caido-client.ts rename-collection <id> "Auth Bypass Tests"
npx tsx caido-client.ts delete-collection <id>
```

---

## Fuzzing (Automate)

Full CLI pipeline — no Caido UI needed. The workflow:

```
create → edit (inject FUZZ markers) → set-placeholder → set-payload → fuzz → results
```

### create-automate-session

```bash
npx tsx caido-client.ts create-automate-session <request-id>
npx tsx caido-client.ts create-automate-session <request-id> --name "log4j-scan" --strategy MATRIX
npx tsx caido-client.ts create-automate-session <request-id> --strategy PARALLEL --strategy-options '{"workers":10,"delay":50}'
```

| Flag | Description |
|------|-------------|
| `--name <str>` | Session name |
| `--strategy <ALL\|SEQUENTIAL\|PARALLEL\|MATRIX>` | Strategy (default: ALL) |
| `--strategy-options <json>` | `{"workers":5,"delay":100,"redirectStrategy":"NEVER"}` |

### edit-automate-session

Unified edit — rename, change strategy, modify request body, headers, method, path:

```bash
# Rename
npx tsx caido-client.ts edit-automate-session <id> --name "new-name"

# Inject FUZZ markers
npx tsx caido-client.ts edit-automate-session <id> --replace 'true:::"FUZZ"'
npx tsx caido-client.ts edit-automate-session <id> --replace 'user_id=123:::user_id=FUZZ' --replace 'role=user:::role=FUZZ'

# Change strategy
npx tsx caido-client.ts edit-automate-session <id> --strategy MATRIX

# Full body replacement
npx tsx caido-client.ts edit-automate-session <id> --body '{"userId":"FUZZ","roleId":"FUZZ"}'

# Headers / method / path
npx tsx caido-client.ts edit-automate-session <id> --set-header "X-Forwarded-For:FUZZ" --method POST
```

| Flag | Description |
|------|-------------|
| `--name <str>` | Rename session |
| `--strategy <ALL\|SEQUENTIAL\|PARALLEL\|MATRIX>` | Change strategy |
| `--strategy-options <json>` | `{"workers":5,"delay":100}` |
| `--replace <from>:::<to>` | Find/replace in raw request (repeatable) |
| `--set-header <N:V>` | Set/replace header (repeatable) |
| `--remove-header <name>` | Remove header (repeatable) |
| `--body <raw-body>` | Full body replacement |
| `--method <METHOD>` | Change HTTP method |
| `--path <path>` | Change request path |

### set-placeholder

Mode-based. Marks injection points in the raw request.

```bash
# Search for pattern — creates placeholder at every occurrence
npx tsx caido-client.ts set-placeholder <id> search FUZZ
npx tsx caido-client.ts set-placeholder <id> search FUZZ --count 2

# Explicit byte ranges
npx tsx caido-client.ts set-placeholder <id> range 142 146
npx tsx caido-client.ts set-placeholder <id> list 142:146 287:291 411:415

# Inspect
npx tsx caido-client.ts set-placeholder <id> show-raw

# Manage
npx tsx caido-client.ts set-placeholder <id> clear
npx tsx caido-client.ts set-placeholder <id> remove 1
npx tsx caido-client.ts set-placeholder <id> replace 0 100 110
```

| Mode | Description |
|------|-------------|
| `search <pattern> [--count N]` | Find all occurrences, create placeholder at each |
| `range <start> <end>` | Single placeholder at byte range |
| `list <start:end>...` | Multiple explicit ranges |
| `show-raw` | Display raw request with byte offsets and current placeholders |
| `clear` | Remove all placeholders |
| `remove <index>` | Remove placeholder at index |
| `replace <index> <start> <end>` | Replace placeholder at index |

### set-payload

Assign payloads to placeholders.

```bash
# Single set (backward compat, for ALL/SEQUENTIAL)
npx tsx caido-client.ts set-payload <id> --list "admin,user,test"

# Set payload at placeholder index (for PARALLEL/MATRIX)
npx tsx caido-client.ts set-payload <id> --index 0 --list "admin,user,test"
npx tsx caido-client.ts set-payload <id> --index 1 --list "true,false"

# Number range at index
npx tsx caido-client.ts set-payload <id> --index 0 --range "1-1000:10"

# Remove set at index
npx tsx caido-client.ts set-payload <id> --index 2 --remove

# Full config from JSON
npx tsx caido-client.ts set-payload <id> --json @payloads.json
```

| Flag | Description |
|------|-------------|
| `--list "a,b,c"` | Comma-separated payload values |
| `--json @file` | Full config from JSON file |
| `--index N` | Target payload set at index (add/replace) |
| `--range "min-max[:step]"` | Number range (`:step` optional, default 1) |
| `--index N --remove` | Remove payload set at index |

### Strategy Rules

| Strategy | Payload Sets | Behavior | Constraint |
|----------|-------------|----------|------------|
| `ALL` (default) | 1 | Every placeholder gets every payload | — |
| `SEQUENTIAL` | 1 | Same as ALL | — |
| `PARALLEL` | N (one per placeholder) | Simultaneous iteration | All sets must be same length |
| `MATRIX` | N (one per placeholder) | Cartesian product | — |

PARALLEL and MATRIX require one payload set per placeholder. The CLI validates this.

### Payload JSON Schema

```json
{
  "strategy": "MATRIX",
  "strategyOptions": { "workers": 5, "delay": 100, "redirectStrategy": "NEVER" },
  "payloads": [
    { "index": 0, "type": "simpleList", "list": ["admin", "user", "test"] },
    { "index": 1, "type": "number", "range": { "min": 1, "max": 100, "step": 1 } },
    { "index": 2, "type": "simpleList", "list": [".php", ".phtml"], "preprocessors": ["urlencode"] }
  ]
}
```

Types: `simpleList` (string list), `number` (range with min/max/step).

### fuzz / results / lifecycle

```bash
npx tsx caido-client.ts fuzz <session-id>
npx tsx caido-client.ts automate-results <session-id>
npx tsx caido-client.ts automate-sessions --limit 50
npx tsx caido-client.ts automate-tasks
npx tsx caido-client.ts pause-task <task-id>
npx tsx caido-client.ts resume-task <task-id>
npx tsx caido-client.ts cancel-task-automate <task-id>
npx tsx caido-client.ts duplicate-automate-session <id>
npx tsx caido-client.ts delete-automate-session <id>
npx tsx caido-client.ts rename-automate-entry <entry-id> "popped"
npx tsx caido-client.ts delete-automate-entries <id-1>,<id-2>
```

### CRITICAL — Placeholder byte ranges and JSON structure

Caido replaces the exact byte range. If the range includes quotes, they get replaced too — malformed JSON.

**WRONG**: `"remember":true` → placeholder on `true` → payload `${jndi:...}` → `"remember":${jndi:...}` (broken)

**RIGHT**: `"remember":"FUZZ"` → placeholder on `FUZZ` (4 bytes, quotes outside) → payload `${jndi:...}` → `"remember":"${jndi:...}"` (valid)

**The FUZZ marker pattern**:
1. Replace each target with `"FUZZ"` — quotes stay outside the 4-byte range
2. `set-placeholder search FUZZ` covers exactly those 4 bytes
3. Payloads carry no quotes when the body provides them — `"FUZZ"` + payload `${jndi:...}` = `"${jndi:...}"`

---

## Scope Management

```bash
npx tsx caido-client.ts scopes
npx tsx caido-client.ts create-scope "Target Corp" --allow "*.target.com,*.target.io" --deny "*.cdn.target.com"
npx tsx caido-client.ts update-scope <id> --allow "*.target.com,*.api.target.com"
npx tsx caido-client.ts delete-scope <id>
```

---

## Filter Presets

```bash
npx tsx caido-client.ts filters
npx tsx caido-client.ts create-filter "API Errors" --query 'req.path.cont:"/api/" AND resp.code.gte:400'
npx tsx caido-client.ts create-filter "Auth Endpoints" --query 'req.path.regex:"/(login|auth|oauth)/"' --alias "auth"
npx tsx caido-client.ts update-filter <id> --query 'req.path.cont:"/api/" AND resp.code.gte:500'
npx tsx caido-client.ts delete-filter <id>
```

---

## Environment Variables

```bash
npx tsx caido-client.ts envs
npx tsx caido-client.ts create-env "IDOR-Test"
npx tsx caido-client.ts env-set <env-id> victim_user_id "user_456"
npx tsx caido-client.ts env-set <env-id> attacker_token "eyJhbG..."
npx tsx caido-client.ts select-env <env-id>
npx tsx caido-client.ts select-env           # deselect
npx tsx caido-client.ts delete-env <env-id>
```

---

## Findings

```bash
npx tsx caido-client.ts findings
npx tsx caido-client.ts findings --limit 50
npx tsx caido-client.ts get-finding <id>
npx tsx caido-client.ts create-finding <request-id> --title "IDOR in user profile" --description "Can access other users' data" --reporter "rez0"
npx tsx caido-client.ts create-finding <request-id> --title "Auth bypass" --dedupe-key "admin-auth-bypass"
npx tsx caido-client.ts update-finding <id> --title "Updated title" --description "Updated description"
```

---

## Tasks

```bash
npx tsx caido-client.ts tasks
npx tsx caido-client.ts cancel-task <task-id>
```

---

## Projects

```bash
npx tsx caido-client.ts projects
npx tsx caido-client.ts select-project <project-id>
```

---

## Hosted Files

```bash
npx tsx caido-client.ts hosted-files
npx tsx caido-client.ts delete-hosted-file <file-id>
```

---

## Intercept

```bash
npx tsx caido-client.ts intercept-status
npx tsx caido-client.ts intercept-enable
npx tsx caido-client.ts intercept-disable
```

---

## Info & Health

```bash
npx tsx caido-client.ts viewer
npx tsx caido-client.ts plugins
npx tsx caido-client.ts health
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

**CRITICAL**: No `NOT` operator. Use negated variants: `ne`, `ncont`, `nlike`, `nregex`.

### Fields

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
| `source` | — | special | `"intercept"`, `"replay"`, `"automate"`, `"workflow"` |
| `preset` | — | special | Filter preset reference |

### Operators

**String:** `eq`, `ne`, `cont`, `ncont`, `like`, `nlike`, `regex`, `nregex`
**Integer:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`
**Boolean:** `eq`, `ne`
**Logical:** `AND`, `OR`, parentheses for grouping

### Example Queries

```
req.method.eq:"POST" AND resp.code.eq:200
req.host.cont:"api" OR req.path.cont:"/api/"
"password" OR "secret" OR "api_key"
resp.code.gte:400 AND resp.code.lt:500
resp.len.gt:100000
req.path.regex:"/(login|auth|signin|oauth)/"
source:"replay" OR source:"automate"
req.created_at.gt:"2024-01-01T00:00:00Z"
req.path.ncont:"/static"
req.method.ne:"OPTIONS"
req.path.ncont:"/health" AND req.path.ncont:"/metrics"
```

---

## SDK Architecture

Built on `@caido/sdk-client` v0.2.0+ with a clean multi-file architecture:

```
caido-client.ts          # CLI entry point — arg parsing + command dispatch
lib/
  client.ts              # SDK Client singleton, SecretsTokenCache, auth config
  graphql.ts             # gql documents for features not yet in SDK
  output.ts              # Output formatting (truncation, headers-only, raw→curl)
  types.ts               # Shared types (OutputOpts)
  commands/
    requests.ts          # search, recent, get, get-response, export-curl
    replay.ts            # replay, send-raw, edit, sessions, collections
    automate.ts          # create/edit sessions, placeholders, payloads, fuzz, results
    composite.ts         # idor-chain, fuzz-automate, bulk-replay, discover-auth
    findings.ts          # findings, get-finding, create-finding, update-finding
    management.ts        # scopes, filters, environments, projects, hosted-files, tasks
    intercept.ts         # intercept-status, intercept-enable, intercept-disable
    info.ts              # viewer, plugins, health, setup, auth-status
```

Most features use the high-level SDK directly. Automate/fuzz, intercept, and plugins use `client.graphql.query()`/`client.graphql.mutation()` with typed `gql` documents — no raw fetch anywhere.

---

## Agent Instructions

1. **Prefer `edit` over `replay --raw`** — preserves cookies/auth automatically
2. **Workflow**: search → find request with valid auth → use that ID via `edit`
3. **Don't dump raw requests into context** — use `--compact` or `--headers-only`
4. **Always check auth first**: `health` → `recent --limit 1`
5. **Always name replay sessions**: `rename-session <id> "descriptive-name"`
6. **Create findings** for anything interesting
7. **Use `export-curl`** for PoCs
8. **Create filter presets** for recurring searches
9. **Use environments** to store test data
10. **Never use `NOT` in HTTPQL** — use `ne`, `ncont`, `nlike`, `nregex`
11. **FUZZ marker pattern**: replace targets with `"FUZZ"`, quotes outside the range, placeholder covers just `FUZZ`
12. **Payloads carry no quotes when body provides them**: `"FUZZ"` + `${jndi:...}` = `"${jndi:...}"`

## Performance

- `search`/`recent` omit `raw` field (~200 bytes/request, safe for 100+)
- `get` fetches `raw` (~5-20KB/request — fetch only what you need)
- Use `--limit` aggressively (start with 5-10)
- Use `--compact` for quick exploration
- Filter server-side with HTTPQL, not client-side

## Error Handling

- **Auth errors**: `auth-status` to check, `setup <pat>` to re-setup
- **Connection refused**: Caido not running → `health`
- **InstanceNotReadyError**: Caido starting up, wait and retry
