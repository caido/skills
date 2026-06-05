# Caido Mode

Full SDK CLI for [Caido](https://caido.io) built on [`@caido/sdk-client`](https://github.com/caido/sdk-js). Search HTTP history, edit/replay requests with preserved auth, manage scopes/filters/environments, create findings, export curl, control intercept, and fuzz — all from the terminal.

## Why?

Cookies and auth tokens are huge. Instead of copy-pasting 2KB of session cookies into every test request:

1. Find an organic request in Caido's history that already has valid auth
2. Use `edit` to change just the path/method/body while keeping all auth intact
3. Send it — full response comes back, request shows up in Caido

## What's Covered

| Category | Commands |
|----------|----------|
| **HTTP History** | `search`, `recent`, `get`, `get-response`, `export-curl` |
| **Edit & Replay** | `edit`, `replay`, `send-raw`, `edit-session` |
| **Replay Tab Lookup** | `get-session`, `replay-entries`, `session-entries` |
| **Sessions** | `create-session`, `rename-session`, `move-session`, `replay-sessions`, `delete-sessions` |
| **Collections** | `replay-collections`, `create-collection`, `rename-collection`, `delete-collection` |
| **Fuzzing** | `create-automate-session`, `edit-automate-session`, `set-placeholder`, `set-payload`, `fuzz`, `automate-results`, `automate-sessions`, `automate-tasks`, `pause-task`, `resume-task`, `cancel-task-automate`, `duplicate-automate-session`, `delete-automate-session` |
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

Requires [Node.js](https://nodejs.org) (v24+), a running Caido instance, and a [PAT](https://docs.caido.io/dashboard/guides/create_pat.html).

```bash
npm install

# Create a PAT in Dashboard > Developer > Personal Access Tokens, then:
npx tsx caido-client.ts setup <your-pat>

# Verify
npx tsx caido-client.ts health
npx tsx caido-client.ts recent --limit 1

# Or use env var instead
export CAIDO_PAT=<your-pat>
```

The `setup` command validates the PAT via the SDK, caches the access token to `~/.claude/config/secrets.json`. Subsequent runs load the cached token directly.

## File Structure

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
    composite.ts         # multi-step: idor-chain, fuzz-automate, bulk-replay, discover-auth
    findings.ts          # findings, get-finding, create-finding, update-finding
    management.ts        # scopes, filters, environments, projects, hosted-files, tasks
    intercept.ts         # intercept-status, intercept-enable, intercept-disable
    info.ts              # viewer, plugins, health, setup, auth-status
```

## Usage

All commands output JSON. Run `npx tsx caido-client.ts --help` for the complete list.

### Search & Browse

```bash
npx tsx caido-client.ts search 'req.method.eq:"POST" AND resp.code.eq:200'
npx tsx caido-client.ts search 'req.host.cont:"api"' --limit 50
npx tsx caido-client.ts recent --limit 10
npx tsx caido-client.ts get <request-id>
npx tsx caido-client.ts get-response <request-id>
```

### Edit & Replay (the main feature)

Take an existing authenticated request and modify only what you need. Cookies, auth headers, User-Agent — everything else is preserved.

```bash
# Change path (IDOR testing)
npx tsx caido-client.ts edit <id> --path /api/user/999

# Change method + body (privilege escalation)
npx tsx caido-client.ts edit <id> --method POST --body '{"role":"admin"}'

# Add/remove headers (bypass testing)
npx tsx caido-client.ts edit <id> --set-header "X-Forwarded-For: 127.0.0.1"
npx tsx caido-client.ts edit <id> --remove-header "X-CSRF-Token"

# Find/replace text anywhere in the request
npx tsx caido-client.ts edit <id> --replace "user123:::user456"

# Reuse a replay session while iterating
npx tsx caido-client.ts edit <id> --path /api/user/456 --session <session-id> --compact
```

`edit`, `replay`, and `send-raw` support connection overrides: `--sni`, `--connect-host`, `--connect-port`, `--connect-tls`, `--connect-no-tls`.

### Fuzzing

Full CLI pipeline — no Caido UI needed. The workflow is: create session, inject FUZZ markers into the request, set placeholders to find them, set payloads per placeholder, run.

```bash
# 1. Create session
npx tsx caido-client.ts create-automate-session <request-id> --name "log4j-scan"

# 2. Edit the raw body — replace target values with FUZZ markers
npx tsx caido-client.ts edit-automate-session <session-id> --replace 'true:::"FUZZ"'

# 3. Set placeholders — search for FUZZ markers
npx tsx caido-client.ts set-placeholder <session-id> search FUZZ

# 4. Set payloads
npx tsx caido-client.ts set-payload <session-id> --list 'payload1,payload2'

# 5. Run
npx tsx caido-client.ts fuzz <session-id>

# 6. Get results
npx tsx caido-client.ts automate-results <session-id>
```

#### Multi-placeholder fuzzing (MATRIX strategy)

For testing multiple fields simultaneously:

```bash
# Create with MATRIX strategy
npx tsx caido-client.ts create-automate-session <request-id> --strategy MATRIX --name "upload-bypass"

# Edit body — inject multiple FUZZ markers
npx tsx caido-client.ts edit-automate-session <session-id> \
  --replace 'filename="shell.jpg":::filename="FUZZ"' \
  --replace 'content_type="image/jpeg":::content_type="FUZZ"'

# Set placeholders — finds both FUZZ markers
npx tsx caido-client.ts set-placeholder <session-id> search FUZZ

# Set one payload set per placeholder (index = placeholder position)
npx tsx caido-client.ts set-payload <session-id> --index 0 --list "shell.php,shell.phtml,shell.php5"
npx tsx caido-client.ts set-payload <session-id> --index 1 --list "application/x-php,application/php"

# Run — MATRIX runs the cartesian product of all sets
npx tsx caido-client.ts fuzz <session-id>
```

#### Strategy rules

| Strategy | Payload Sets | Behavior |
|----------|-------------|----------|
| `ALL` (default) | 1 | Every placeholder gets every payload from the single set |
| `SEQUENTIAL` | 1 | Same as ALL |
| `PARALLEL` | N (one per placeholder) | Simultaneous iteration — all sets must be same length |
| `MATRIX` | N (one per placeholder) | Cartesian product — sets can be different lengths |

#### Payload types

```bash
# Simple string list
npx tsx caido-client.ts set-payload <session-id> --list "a,b,c"

# Number range
npx tsx caido-client.ts set-payload <session-id> --index 0 --range "1-1000:10"

# Full config from JSON file
npx tsx caido-client.ts set-payload <session-id> --json @payloads.json
```

JSON schema (`@payloads.json`):
```json
{
  "strategy": "MATRIX",
  "strategyOptions": { "workers": 5, "delay": 100 },
  "payloads": [
    { "index": 0, "type": "simpleList", "list": ["admin", "user", "test"] },
    { "index": 1, "type": "number", "range": { "min": 1, "max": 100, "step": 1 } }
  ]
}
```

#### Placeholder modes

```bash
# Search for pattern — creates placeholder at every match
npx tsx caido-client.ts set-placeholder <session-id> search FUZZ

# Limit matches
npx tsx caido-client.ts set-placeholder <session-id> search FUZZ --count 2

# Explicit byte ranges
npx tsx caido-client.ts set-placeholder <session-id> range 142 146
npx tsx caido-client.ts set-placeholder <session-id> list 142:146 287:291

# Inspect current placeholders and raw request
npx tsx caido-client.ts set-placeholder <session-id> show-raw

# Manage
npx tsx caido-client.ts set-placeholder <session-id> clear
npx tsx caido-client.ts set-placeholder <session-id> remove 1
npx tsx caido-client.ts set-placeholder <session-id> replace 0 100 110
```

#### CRITICAL — Placeholder byte ranges must preserve JSON structure

Caido replaces the exact byte range with the payload. If the range includes surrounding quote characters, the quotes are replaced too — producing malformed JSON.

**WRONG**: body `"remember":true` → placeholder covers `true` → payload `${jndi:...}` produces `"remember":${jndi:...}` (invalid JSON)

**RIGHT**: body `"remember":"FUZZ"` → placeholder covers just `FUZZ` → payload `${jndi:...}` produces `"remember":"${jndi:...}"` (valid JSON)

The FUZZ marker pattern:
1. Replace each fuzz target with `"FUZZ"` — quotes stay outside the placeholder range
2. `set-placeholder search FUZZ` covers exactly the 4 FUZZ bytes
3. Payloads should NOT carry their own quotes when the body provides them

### Export to curl

```bash
npx tsx caido-client.ts export-curl <request-id>
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

### Scopes, Filters, Environments

```bash
npx tsx caido-client.ts create-scope "Target" --allow "*.target.com" --deny "*.cdn.target.com"
npx tsx caido-client.ts create-filter "API Errors" --query 'req.path.cont:"/api/" AND resp.code.gte:400'
npx tsx caido-client.ts create-env "IDOR-Test"
npx tsx caido-client.ts env-set <env-id> victim_id "user_456"
```

### Sessions & Collections

```bash
npx tsx caido-client.ts create-session <request-id>
npx tsx caido-client.ts rename-session <session-id> "idor-user-profile"
npx tsx caido-client.ts replay-sessions
npx tsx caido-client.ts create-collection "IDOR Tests"
```

### Raw Replay

```bash
npx tsx caido-client.ts send-raw --host example.com --raw "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"
npx tsx caido-client.ts send-raw --host example.com --raw @request.txt --name "G /"
cat request.txt | npx tsx caido-client.ts send-raw --host example.com --raw -
npx tsx caido-client.ts replay <id> --connect-host 10.0.0.5 --connect-port 8443 --sni example.com
```

`--raw` accepts a string with C-style escapes, `@file`, or `-` for stdin.

### Output Control

| Flag | Default | Description |
|------|---------|-------------|
| `--max-body <n>` | 200 | Max response body lines (0 = unlimited) |
| `--max-body-chars <n>` | 5000 | Max response body chars (0 = unlimited) |
| `--no-request` | off | Skip request raw in output |
| `--headers-only` | off | Show only HTTP headers, no body |
| `--compact` | off | Shorthand for `--no-request --max-body 50` |

## HTTPQL Quick Reference

Caido's query language for searching HTTP history. String values must be quoted, integers are not. There is no `NOT` operator — use negated variants: `ne`, `ncont`, `nlike`, `nregex`.

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
req.path.ncont:"/static"                      # Exclude paths (no NOT operator)
```

## Architecture

Built on `@caido/sdk-client` v0.2.0+. Multi-file architecture:

- **High-level SDK methods** for most features (requests, replay, findings, scopes, filters, environments, projects, hosted files, tasks, user)
- **`client.graphql.query()`/`mutation()`** with `gql` tagged templates for features not yet in SDK (intercept, plugins, automate/fuzz)
- **No raw fetch anywhere** — everything goes through the SDK

## Agent Integration

This tool is designed for use by AI agents. The `SKILL.md` file provides full context on every command, HTTPQL syntax, and testing workflows. All commands output structured JSON for programmatic consumption.

## License

MIT
