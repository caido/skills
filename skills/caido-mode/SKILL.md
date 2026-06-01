---
name: caido-mode
description: Full Caido SDK integration for Claude Code. Search HTTP history with HTTPQL, pull base requests to raw files, lint + send them byte-exact with curl/ncat, and organize handoffs into named replay sessions and collections - all via the official @caido/sdk-client. PAT auth recommended.
tags: [worker]
---

# Caido Mode Skill

A CLI over Caido's API (built on the official `@caido/sdk-client`) for HTTP-history-driven
testing. The tool lives at `~/.claude/skills/caido-mode/caido-client.ts`; every command is
`npx tsx caido-client.ts <command>` and outputs JSON unless noted.

## How to operate (read this first)

There are **two distinct modes**, and you must not blur them:

1. **Testing → use `curl` / raw sockets.** Pull a real authenticated request out of Caido's
   history into a file, tweak it, **lint it**, and send the bytes yourself. This is fast,
   ephemeral, and leaves Caido's Replay panel clean. **This is the default for all probing.**
2. **Handoff → use replay sessions + collections.** Only when you are handing a request (or a
   set of requests) to the *user* do you materialize it as a named replay session, organized
   into a named collection. These persist in Caido's UI for the user to pick up.

Hard rules:

- **Never refer to replay sessions or collections by ID** when talking to the user — always by
  **name**. (The CLI accepts names everywhere too.)
- **Replay session names are mandatory.** Editing a session forces you to declare name intent.
- **Collections are mandatory for multi-request handoffs.** Query existing collections first,
  then decide where requests go (or create a new, named collection).
- **`lint` must be run before sending a crafted raw request.** You may override it and send
  anyway if a finding *is* the malformation (e.g. request smuggling), but run it first.

---

## The primary workflow (do this by default)

```bash
# 1. Find a base request that already has the auth/cookies/headers you need.
#    HTTPQL + --recent + --compact keeps this fast and low-token.
npx tsx caido-client.ts search 'req.host.cont:"target.com" AND req.path.cont:"/api/user"' --recent --compact
#    → 8431  200  GET target.com/api/user/me

# 2. Pull its byte-exact raw into a file (no JSON wrapper).
npx tsx caido-client.ts raw 8431 --out /tmp/req.txt

# 3. Tweak /tmp/req.txt however you need (path, method, body, headers, an injected param…).
#    Use Edit/Write or sed — whatever. Keep the auth headers intact.

# 4. Lint, then send byte-exact. The && means a malformed file blocks the send.
npx tsx caido-client.ts lint /tmp/req.txt && ncat --ssl target.com 443 < /tmp/req.txt
```

Iterate on steps 3–4 as many times as you need. Nothing here touches Replay, so you can fire
hundreds of probes without cluttering the UI.

### Sending the bytes

The raw file is a complete HTTP/1.1 request and must go on the wire **verbatim** (that's why
`lint` checks CRLF framing — `curl --data-binary` alone can't do this; it rebuilds the request
line and headers and only sends a body). Pick the transport:

| Need | Command |
|------|---------|
| TLS target (default) | `npx tsx caido-client.ts lint /tmp/req.txt && ncat --ssl target.com 443 < /tmp/req.txt` |
| TLS, no ncat | `... && openssl s_client -quiet -connect target.com:443 < /tmp/req.txt` |
| Plaintext target | `... && ncat target.com 80 < /tmp/req.txt` |
| Reconstruct with curl (body-only file, headers as flags) | `... && curl -X POST 'https://target.com/api/x' -H 'Authorization: …' --data-binary @/tmp/body.txt` |
| Keep it in Caido history | `send-raw --raw @/tmp/req.txt --name "…"` (creates a replay session) or curl `-x http://127.0.0.1:<proxy>` through Caido's proxy listener |

Default to `ncat --ssl` / `openssl s_client` for byte-exact testing. Reach for `send-raw` only
when the user specifically wants the request to appear in Caido, accepting that it spawns a
named replay session.

---

## Linting raw requests (mandatory before send)

`lint` is a **pure file check** — it does not connect to Caido, so it works even when Caido is
down. It exits non-zero on errors (so `lint f && send` blocks a bad send) and zero on
warnings-only.

```bash
npx tsx caido-client.ts lint /tmp/req.txt           # human-readable + exit code
npx tsx caido-client.ts lint /tmp/req.txt --json     # machine-readable
npx tsx caido-client.ts lint /tmp/req.txt --fix      # rewrite normalized in place
npx tsx caido-client.ts lint /tmp/req.txt --fix --out /tmp/req.fixed.txt
```

**Errors** (block the send): bare-LF line endings in headers, LF-only header/body separator,
missing `\r\n\r\n` terminator, `Content-Length` that doesn't match the actual body byte length,
malformed request line / missing HTTP version, header lines with no `:`.

**Warnings** (safe to send): missing `Host`, body without `Content-Length`, and the
smuggling-relevant ones — **multiple `Content-Length`** and **`Transfer-Encoding` + `Content-Length`
together**. These are warnings precisely because you may be testing them on purpose.

`--fix` normalizes line endings to CRLF, repairs the separator, and recomputes `Content-Length`
— but it deliberately leaves `Content-Length`/`Transfer-Encoding` untouched when smuggling
indicators are present, so it won't destroy an intentional smuggling payload.

You have the authority to ignore a lint result and send anyway (e.g. you *want* the malformed
framing). The rule is only that you **run it first**.

---

## Searching HTTP history (HTTPQL)

```bash
npx tsx caido-client.ts search 'req.method.eq:"POST" AND resp.code.eq:200' --recent --compact
npx tsx caido-client.ts search 'req.host.cont:"api"' --limit 50
npx tsx caido-client.ts search 'req.path.cont:"/admin"' --ids-only
npx tsx caido-client.ts recent --compact            # newest requests, one line each
npx tsx caido-client.ts get 8431 --compact          # full details (JSON) when you need them
npx tsx caido-client.ts get-response 8431 --compact
```

- `--compact` → one terse line per request (`id  status  METHOD host/path`), ideal for scanning.
- `--recent` (alias `--desc`/`--latest`) → newest first.
- Prefer `search`/`recent --compact` for browsing; only `get`/`raw` a request once you've picked it.

See the **HTTPQL Reference** near the bottom for the full query language.

---

## Replay sessions — for handoff only

Use these when you are giving a request to the **user** (a PoC, a reproduction, an endpoint to
poke at). Normal testing should **not** create sessions — use the curl/raw workflow above.

```bash
# Create a NAMED session from a history request (name is REQUIRED).
npx tsx caido-client.ts create-session 8431 --name "IDOR /api/user/:id"

# List sessions (by name).
npx tsx caido-client.ts sessions            # alias: replay-sessions

# Rename / move (refer to the session by NAME or id).
npx tsx caido-client.ts rename-session "IDOR /api/user/:id" "IDOR - confirmed"
npx tsx caido-client.ts move-session "IDOR - confirmed" "Vuln chain - IDOR to ATO"
npx tsx caido-client.ts delete-sessions <id,id>
```

### Editing a session forces name intent

If the user explicitly asks you to test *inside* Replay, use `edit` / `edit-session`. Because an
edit changes what a session contains, you must declare what happens to its **name** — pass
exactly one of:

- `--no-name-change` (alias `--nonach`) — keep the current name
- `--new-name "<name>"` — rename it

```bash
# Edit a history request into a NEW named session (handoff):
npx tsx caido-client.ts edit 8431 --path /api/user/999 --name "IDOR victim 999"

# Edit an EXISTING session (must say what to do with its name):
npx tsx caido-client.ts edit-session "IDOR victim 999" --body '{"role":"admin"}' --nonach --compact
npx tsx caido-client.ts edit 8431 --path /api/admin --session "IDOR victim 999" --new-name "priv-esc admin"
```

`edit` preserves cookies/auth from the original request automatically; it supports
`--method`, `--path`, `--set-header`, `--remove-header`, `--body` (auto Content-Length),
`--replace <from>:::<to>`, and the connection overrides (`--sni`, `--connect-host`, …).

---

## Collections — use them heavily

Collections organize sessions for handoff. **Before creating a session, list existing
collections and decide where it belongs.** Collection names are mandatory and collections are
never auto-created — create one explicitly when you need it.

```bash
npx tsx caido-client.ts collections                         # query first (alias: replay-collections)
npx tsx caido-client.ts create-collection "Swagger - petstore.yaml"
npx tsx caido-client.ts rename-collection "old name" "new name"
npx tsx caido-client.ts delete-collection "Swagger - petstore.yaml"
```

### Where does a session go?

| Situation | Collection decision |
|-----------|--------------------|
| **One** request reproduced for the user | Default collection — **don't** create one. Just name the session and tell the user the name. |
| A replay tab per endpoint in a **JS file** | New collection `JS File Endpoints`, put them all there. |
| A replay tab per endpoint in a **Swagger spec** | New collection `Swagger - <filename>`. |
| A **multi-request chain** demonstrating a vuln | New collection `Vuln chain - <description>`, all steps inside (name them `1. …`, `2. …`). |
| All endpoints under **`/api/v2`** | New collection `/api/v2/*`, all requests inside. |

Always pass the collection by **name** when creating/moving sessions; the CLI resolves it (and
errors with a "create it first" hint if the name doesn't exist):

```bash
npx tsx caido-client.ts create-session 8431 --name "1. login" --collection "Vuln chain - IDOR to ATO"
```

When you report back to the user, name the collection and the sessions — e.g. *"I put the 5-step
chain in the **Vuln chain - IDOR to ATO** collection: 1. login, 2. fetch token, …"* — never IDs.

---

## Authentication setup

```bash
# One-time: create a PAT in Caido (Dashboard → Developer → Personal Access Tokens), then:
npx tsx caido-client.ts setup <your-pat>
npx tsx caido-client.ts setup <pat> http://192.168.1.100:8080   # non-default instance

# Or env vars
export CAIDO_PAT=caido_xxxxx
export CAIDO_URL=http://localhost:8080

npx tsx caido-client.ts auth-status        # check
npx tsx caido-client.ts health             # verify instance is up
```

`setup` validates the PAT via the SDK's device-code flow (auto-approved by the PAT), then caches
both the PAT and the resulting access token to `~/.claude/config/secrets.json`. Subsequent runs
use the cached token; a valid cached token works even without the PAT. Auth resolution order:
`CAIDO_PAT` env → secrets.json PAT → valid cached token → error.

If authorization isn't working, the environment also provides `CAIDO_TEAM_PAT` and
`CAIDO_PERSONAL_PAT`.

---

## Output control (works with `get`, `get-response`, `replay`, `edit`, `send-raw`, `edit-session`)

| Flag | Description |
|------|-------------|
| `--max-body <n>` | Max response body lines (default 200, 0 = unlimited) |
| `--max-body-chars <n>` | Max body chars (default 5000, 0 = unlimited) |
| `--no-request` | Omit the request raw from output |
| `--headers-only` | Headers only, no body |
| `--compact` | Shorthand: `--no-request --max-body 50 --max-body-chars 5000` |

`raw <id>` and `search/recent --compact` are separate, terser primitives — prefer them for the
testing loop; reach for the JSON `get` only when you need structured fields.

---

## HTTPQL Reference

Caido's query language for searching HTTP history.

**CRITICAL**: String values MUST be quoted; integers are NOT.

**CRITICAL**: HTTPQL has NO `NOT` operator. Use the negated operator variant instead:
- `ncont` (not contains), `nlike`, `nregex`, `ne` (not equals)
- Wrong: `NOT req.path.cont:"/admin"` — Right: `req.path.ncont:"/admin"`

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

- **String:** `eq`, `ne`, `cont`, `ncont`, `like`, `nlike`, `regex`, `nregex`
- **Integer:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`
- **Boolean:** `eq`, `ne`
- **Logical:** `AND`, `OR`, parentheses for grouping

### Examples

```httpql
req.method.eq:"POST" AND resp.code.eq:200       # POSTs with 200s
req.host.cont:"api" OR req.path.cont:"/api/"    # API traffic
"password" OR "secret" OR "api_key"             # bare string searches req AND resp raw
resp.code.gte:400 AND resp.code.lt:500          # 4xx
resp.len.gt:100000                              # large responses (data exposure)
req.path.regex:"/(login|auth|signin|oauth)/"    # auth endpoints
source:"replay" OR source:"automate"            # tool-generated traffic
req.created_at.gt:"2024-01-01T00:00:00Z"        # date filter
req.path.ncont:"/static"                        # exclude (no NOT keyword)
req.method.ne:"OPTIONS"                         # not-equals
preset:"My Filter"                              # saved filter preset
```

---

## Other capabilities (reference)

### Findings — surface in Caido's Findings tab
```bash
npx tsx caido-client.ts findings --limit 50
npx tsx caido-client.ts get-finding <id>
npx tsx caido-client.ts create-finding 8431 --title "IDOR on /api/user/:id" \
  --description "Can read other users' profiles by changing id" --reporter "rez0" --dedupe-key "idor-user"
npx tsx caido-client.ts update-finding <id> --title "…" --description "…"
```

### Scopes (glob allowlist/denylist)
```bash
npx tsx caido-client.ts scopes
npx tsx caido-client.ts create-scope "Target" --allow "*.target.com,*.target.io" --deny "*.cdn.target.com"
npx tsx caido-client.ts update-scope <id> --allow "*.target.com"
npx tsx caido-client.ts delete-scope <id>
```

### Filter presets
```bash
npx tsx caido-client.ts filters
npx tsx caido-client.ts create-filter "API 4xx" --query 'req.path.cont:"/api/" AND resp.code.gte:400' --alias "api4xx"
npx tsx caido-client.ts search 'preset:"API 4xx"' --recent --compact
```

### Environments (persistent test variables)
```bash
npx tsx caido-client.ts envs
npx tsx caido-client.ts create-env "IDOR-Test"
npx tsx caido-client.ts env-set <env-id> victim_id "user_999"
npx tsx caido-client.ts select-env <env-id>
```

### Fuzzing (Automate)
```bash
npx tsx caido-client.ts create-automate-session 8431
# configure payload markers + wordlists in the Caido UI, then:
npx tsx caido-client.ts fuzz <session-id>
```

### Intercept / projects / tasks / hosted files / info
```bash
npx tsx caido-client.ts intercept-status | intercept-enable | intercept-disable
npx tsx caido-client.ts projects ; npx tsx caido-client.ts select-project <id>
npx tsx caido-client.ts tasks ; npx tsx caido-client.ts cancel-task <id>
npx tsx caido-client.ts hosted-files ; npx tsx caido-client.ts delete-hosted-file <id>
npx tsx caido-client.ts viewer ; npx tsx caido-client.ts plugins ; npx tsx caido-client.ts export-curl 8431
```

---

## Architecture

Built on `@caido/sdk-client` v0.2.0+. No raw `fetch` anywhere — high-level SDK methods plus
`client.graphql.query/mutation` with `gql` documents for the few features the SDK doesn't expose.

```
caido-client.ts          # CLI entry — arg parsing + dispatch
lib/
  client.ts              # SDK Client singleton, SecretsTokenCache, auth
  graphql.ts             # gql docs for features not in the SDK (intercept, plugins, automate, raw replay)
  output.ts              # raw formatting (truncation, headers-only, raw→curl)
  types.ts               # OutputOpts
  commands/
    requests.ts          # search, recent, get, get-response, raw, export-curl
    lint.ts              # lint (+ --fix) — pure raw-request validation, no Caido connection
    replay.ts            # replay, send-raw, edit, sessions, collections, automate/fuzz
    findings.ts          # findings
    management.ts        # scopes, filters, environments, projects, hosted-files, tasks
    intercept.ts         # intercept status/enable/disable
    info.ts              # viewer, plugins, health, setup, auth-status
```

---

## Instructions for Claude (checklist)

1. **Test with curl / raw sockets, not Replay.** Search → `raw <id> --out file` → tweak →
   `lint && ncat`. Keep Replay clean.
2. **Always `lint` a crafted raw file before sending.** Override only deliberately (e.g.
   smuggling), and run it regardless.
3. **Browse with `--recent --compact`;** only `raw`/`get` the one request you'll work from.
4. **Replay sessions are for handing requests to the user** — and their **names are mandatory**.
5. **Use collections heavily.** Query existing collections first; one-off → default collection,
   multi-request → a new named collection (see the decision table).
6. **Refer to sessions and collections by NAME, never ID**, in everything you say to the user.
7. **Editing a session requires `--nonach` or `--new-name`.** Decide intent every time.
8. **Create findings** for anything real — they show up in Caido's Findings tab.
9. **NEVER use `NOT` in HTTPQL** — use `ne`/`ncont`/`nlike`/`nregex`.

## Error handling

- **Auth errors** → `auth-status`, re-`setup <pat>` (or set `CAIDO_PAT`).
- **Connection refused / not ready** → Caido isn't running or is still starting; check `health`.
- **`lint` works offline** — if Caido is down you can still craft and validate request files.

## Related skills

- `hacking` — offensive workflow conventions (cookies, sessions, tooling)
- `bugbounty-report` — turn a confirmed finding into a report
- `JsAnalyzer` / `waymore` / `spider` — recon feeding into Caido history
