---
name: caido-mode
description: Full Caido SDK integration for Claude Code. Search HTTP history with HTTPQL, test with curl proxied through Caido (caching auth in reusable static curl config files), add match & replace rules, and organize handoffs into named replay sessions and collections - all via the official @caido/sdk-client. PAT auth recommended.
tags: [worker]
---

# Caido Mode Skill

A CLI over Caido's API (built on the official `@caido/sdk-client`) for HTTP-history-driven
testing. The tool lives at `~/.claude/skills/caido-mode/caido-client.ts`; every command is
`npx tsx caido-client.ts <command>` and outputs JSON unless noted.

## How to operate (read this first)

There are **two distinct modes**:

1. **Testing → use `curl`, always proxied through Caido.** Find a real authenticated request in
   history, cache its auth into a reusable curl config (a faithful static snapshot of its headers
   + cookies), then probe with `curl -K auth.cfg "$BASE/path"`. **All traffic must go through
   Caido** (the config carries the
   proxy), so every request lands in HTTP history.
2. **Handoff → use replay sessions + collections.** Only when handing a request (or a set) to the
   *user* do you materialize it as a named replay session inside a named collection.

Hard rules:

- **Everything goes through Caido — except high-volume bruteforce/fuzzing.** Never curl a single
  target request directly; always via the Caido proxy (the generated config does this; otherwise add
  `-x <proxy>`). **The one exception:** don't proxy bruteforce/fuzzing tools (`ffuf`, etc.) or any
  batch of **100+ requests at once** through Caido — it bloats HTTP history. Run those **direct** (no
  `-x`), then bring any interesting hit *back* into Caido (re-send it through the proxy / promote to
  Replay) to investigate and hand off.
- **Test with `curl`.** Don't spin up replay sessions for probing — that's handoff only.
- **To show the operator a request, send it to Replay.** Whenever you want the operator to *see* a
  specific request, create a **named replay session** for it (in a named collection if there's more
  than one) — that's how they inspect and re-run it in Caido. A request you tested via curl only
  becomes something the operator can work with once you promote it into Replay
  (`create-session <id> --name …`, or `send-raw … --name …` for a crafted one).
- **Cache auth in files, don't re-paste it.** Use `export-curl --config` once per target; then
  reference the config. Don't dump cookies/JWTs into every command (or repeatedly into context).
- **If you hand the operator a runnable command, make it a FULL self-contained curl** (all headers
  inline, via `export-curl`) — for a PoC or something they'll run outside Caido. The `-K` config is
  for your internal testing only; never hand them a `curl -K /tmp/…` line.
- **Replay session names are mandatory**, and editing a session forces explicit name intent.
- **Use collections for multi-request handoffs**; refer to sessions/collections by **name, not ID**.

---

## The primary workflow (do this by default)

```bash
# 1. Find a base request that already has the auth/cookies you need.
npx tsx caido-client.ts search 'req.host.cont:"target.com" AND req.path.cont:"/api/user"' --compact
#    → 8431  200  GET target.com/api/user/me

# 2. ONCE per target: cache its auth into a reusable curl config.
npx tsx caido-client.ts export-curl 8431 --config
#    → writes /tmp/caido/target.com/auth.cfg — a FAITHFUL STATIC snapshot:
#      proxy + insecure + compressed + ALL the request's auth/identity headers
#      (cookies, Authorization, Origin/Referer, X-*, Sec-*, app-specific headers)
#      and prints BASE + the captured header list

# 3. Test with curl. -K carries the proxy + auth, so it goes through Caido into history.
BASE=https://target.com
curl -K /tmp/caido/target.com/auth.cfg "$BASE/api/user/999"                 # IDOR
curl -K /tmp/caido/target.com/auth.cfg -X POST "$BASE/api/profile" \
     -H 'Content-Type: application/json' --data-binary @/tmp/caido/target.com/body.json
```

Iterate step 3 freely — it's cheap, it's all in Caido, and the big auth blob stays in the file.
Confirm a probe landed in Caido with `search 'req.host.cont:"target.com"' --compact`.

### Send the path exactly as written

When testing **path traversal / path-normalization** (`../`, `/..`, `/./`, encoded variants), pass
**`curl --path-as-is`** — otherwise curl collapses `../` and `/./` *client-side* before sending, so
the server never sees the payload and the test silently passes. Keep the path verbatim:

```bash
curl --path-as-is -K /tmp/caido/target.com/auth.cfg "$BASE/api/../../../etc/passwd"
```

(Likewise add `-g`/`--globoff` if the URL contains `[ ] { }` you don't want curl to interpret.)

### The config is a faithful STATIC snapshot (important)

`export-curl --config` captures **every** auth/identity header from the base request (not a
curated subset) and **inlines the cookies statically**. Two deliberate choices, both learned the
hard way:

- **All headers, not an allowlist.** Modern apps gate authorization on app-specific headers you
  can't predict — `x-goog-ext-*`, `X-Browser-Validation`, `X-Client-Data`, `Origin`, `Referer`,
  `X-Same-Domain`, `Sec-*`, … A narrow allowlist silently drops these and you get opaque
  `403`/`PERMISSION_DENIED`. The config now mirrors what actually authorized the request. Only
  truly per-request/volatile headers are dropped: `Host`, `Content-Length`, `Content-Type`,
  `Connection`, `Accept-Encoding` (curl manages these per request).
  - **⚠ Because `Content-Type` is dropped, you MUST pass it yourself on every POST/PUT/PATCH:**
    `curl -K auth.cfg -X POST "$BASE/path" -H 'Content-Type: application/json' --data-binary @body`.
    Use the exact `Content-Type` the endpoint expects (e.g. Google `batchexecute` needs
    `application/x-www-form-urlencoded;charset=UTF-8`) — a wrong/missing one is a common cause of
    `400`/`403`. curl sets `Content-Length` itself; don't add it.
- **Static cookies, no jar.** It does **not** use `cookie-jar` by default, so curl never writes a
  response's rotated `Set-Cookie` back over your captured-good cookies (servers like Google rotate
  on *every* response, including error responses — a write-back jar drifts the session into
  failure). Need to follow rotation? `export-curl <id> --config --cookie-jar` opts in.

To drop a specific header: `--exclude <name>` (repeatable). To omit cookies entirely (e.g. when a
Match & Replace rule injects auth): `--exclude cookie`.

### Other conventions

- **Per-target scratch dir:** `/tmp/caido/<host>/` holds `auth.cfg`, body files, notes.
- **`$BASE`:** set `BASE=https://<host>` once; write requests as `"$BASE/path"`.
- **Bodies in files:** save large/complex bodies once and send with `--data-binary @body.json`
  (the correct use of `--data-binary` — a byte-exact *body*). Add `-H 'Content-Type: …'` per
  request since the config omits it.
- **Lazy refresh:** the snapshot is static, so when a request starts returning **401/403** (token
  expired / cookies aged out), re-run `export-curl <fresh-id> --config` to re-snapshot, then retry.
- **CSRF:** the matching `X-CSRF*`/double-submit header is captured automatically. For tokens that
  rotate per action, fetch fresh: `T=$(curl -sK auth.cfg "$BASE/csrf" | jq -r .token)`.
- **Proxy-injected auth (alternative):** instead of a config, a Match & Replace rule can inject
  `Authorization`/cookies on all proxied traffic — then `curl -x <proxy> -k "$BASE/path"` needs no
  headers. See **Match & Replace**.

### Giving commands to the user

To surface a request *inside Caido* for the operator, send it to **Replay** (see "Replay sessions"
below) — that's the default. This section is for the other case: handing them a runnable **command**
(a PoC, or something to run outside Caido). Then **always produce a full, self-contained curl** —
every header inline, no `-K`:

```bash
npx tsx caido-client.ts export-curl 8431      # full curl, all headers inline (portable PoC)
```

Drop `-x`/`-k` for a portable PoC the user can run anywhere; keep them only if the user is meant
to run it through their own Caido. **Never hand the user a `curl -K /tmp/...` line** — that file
is yours.

---

## The proxy

All curl testing must go through Caido's proxy. Its address **defaults to the Caido URL** (proxy
and API share an address). Discover/confirm it any time:

```bash
npx tsx caido-client.ts auth-status     # prints "proxy": "http://localhost:8080"
```

`export-curl --config` bakes the proxy into the config (`proxy = "…"`). For an ad-hoc curl, add
`-x <proxy> -k` yourself. Override the proxy only if its listener differs from the API URL —
`setup --proxy <addr>` or `export CAIDO_PROXY=<addr>`.

> Get the proxy from `auth-status` (the `proxy`/`activeUrl` fields) — **don't parse `secrets.json`
> directly.** Auth is URL-keyed now: the address lives under `.caido.default` / `.caido.instances`,
> not `.caido.url`.

---

## Authentication setup

```bash
# One-time: create a PAT in Caido (Dashboard → Developer → Personal Access Tokens), then:
npx tsx caido-client.ts setup <your-pat>
npx tsx caido-client.ts setup <pat> http://192.168.1.100:8080            # non-default instance
npx tsx caido-client.ts setup <pat> http://localhost:8080 --proxy http://localhost:8080

# Or env vars
export CAIDO_PAT=caido_xxxxx
export CAIDO_URL=http://localhost:8080
export CAIDO_PROXY=http://localhost:8080   # only if the proxy differs from the URL

npx tsx caido-client.ts auth-status        # check (also prints the proxy)
npx tsx caido-client.ts health             # verify instance is up
```

`setup` validates the PAT via the SDK's device-code flow (auto-approved by the PAT), then caches
the PAT + access token (+ proxy) to `~/.claude/config/secrets.json`. Subsequent runs use the
cached token; a valid cached token works even without the PAT.

### Multiple Caido instances

Credentials are **keyed by instance URL** — two instances on one machine never clobber each other.
`setup <pat> <url>` stores that instance under its URL (and makes it the active default);
setting up a second URL adds a second entry rather than overwriting the first.

```bash
npx tsx caido-client.ts setup <pat-a> http://localhost:8080
npx tsx caido-client.ts setup <pat-b> http://localhost:8081     # added, not overwritten
npx tsx caido-client.ts auth-status                              # lists configuredInstances + activeUrl
```

The **active instance** is `CAIDO_URL` env → stored default → `http://localhost:8080`. Select per
shell/agent with `CAIDO_URL` (concurrency-safe — no shared "current instance" to race on), e.g.
`CAIDO_URL=http://localhost:8081 npx tsx caido-client.ts recent`. `CAIDO_PAT`/`CAIDO_PROXY` env
override the active instance's stored values.

---

## Searching HTTP history (HTTPQL)

```bash
npx tsx caido-client.ts search 'req.method.eq:"POST" AND resp.code.eq:200' --compact
npx tsx caido-client.ts search 'req.host.cont:"api"' --limit 50
npx tsx caido-client.ts search 'req.host.cont:"api"' --asc --limit 50   # oldest first (rarely wanted)
npx tsx caido-client.ts recent --compact            # newest requests, one line each
npx tsx caido-client.ts get 8431 --compact          # full details (JSON) when you need them
npx tsx caido-client.ts get-response 8431 --compact
npx tsx caido-client.ts raw 8431 --out /tmp/caido/target.com/body.json   # dump bytes (e.g. a body)
```

- **`search` is NEWEST FIRST by default** (descending by request id). `--limit N` therefore returns
  the newest N matches. Pass `--asc` (alias `--oldest`) only when you actually want oldest first.
- **To get "the most recent matching X", just run `search '<filter>' --limit N`** — do NOT pull a
  large `--limit` and re-sort client-side (e.g. `jq 'sort_by(.createdAt) | reverse'`). That sorts
  only the truncated window you fetched, so any request newer than the Nth result is silently
  invisible — you'll mistake stale traffic for the latest. Let Caido do the ordering.
- `recent` is always newest-first but takes **no filter**; use `search --limit N` for newest-matching-a-filter.
- `--compact` → one terse line per request (`id  status  METHOD host/path`).
- Prefer `search`/`recent --compact` for browsing; `get`/`export-curl` once you've picked one.

See the **HTTPQL Reference** below for the full query language.

---

## Replay sessions — for handoff only

Use these when giving a request to the **user**. Normal testing uses curl (above), not sessions.
Sessions created from a raw request have their **header line endings normalized to CRLF
automatically** — a handoff session is never built with bare-LF (`\n`) endings.

```bash
# Create a NAMED session from a history request (name is REQUIRED).
npx tsx caido-client.ts create-session 8431 --name "IDOR /api/user/:id"
npx tsx caido-client.ts sessions                                   # list (alias: replay-sessions)
npx tsx caido-client.ts rename-session "IDOR /api/user/:id" "IDOR - confirmed"
npx tsx caido-client.ts move-session "IDOR - confirmed" "Vuln chain - IDOR to ATO"

# Build a handoff session from a raw request file (CRLF auto-normalized):
npx tsx caido-client.ts send-raw --host target.com --raw @/tmp/req.txt --name "crafted repro"
```

### Editing a session forces name intent

If the user asks you to test *inside* Replay, use `edit` / `edit-session`. Because an edit changes
what a session contains, declare what happens to its **name** — pass exactly one of
`--no-name-change` (`--nonach`) or `--new-name "<name>"`:

```bash
npx tsx caido-client.ts edit 8431 --path /api/user/999 --name "IDOR victim 999"        # new session
npx tsx caido-client.ts edit-session "IDOR victim 999" --body '{"role":"admin"}' --nonach --compact
npx tsx caido-client.ts edit 8431 --path /api/admin --session "IDOR victim 999" --new-name "priv-esc"
```

`edit` preserves cookies/auth from the original request; it supports `--method`, `--path`,
`--set-header`, `--remove-header`, `--body` (auto Content-Length), `--replace <from>:::<to>`, and
connection overrides (`--sni`, `--connect-host`, …).

### Inspecting an existing replay tab

When a replay tab is already open in Caido and you want to work from its current state, look it
up by **name or id** (no need to re-create it):

```bash
npx tsx caido-client.ts get-session "IDOR victim 999" --compact      # session + its active entry
npx tsx caido-client.ts replay-entries "IDOR victim 999" --limit 20  # request/response history in the tab
npx tsx caido-client.ts replay-entries "IDOR victim 999" --raw --compact   # include raw bytes
```

`session-entries` is an alias for `replay-entries`. Use these to read what's in a tab; use
`edit-session` (above) to send a modified request into it.

---

## Collections — use them heavily

Collections organize sessions for handoff. **Before creating a session, list existing collections
and decide where it belongs.** Names are mandatory and collections are never auto-created.

```bash
npx tsx caido-client.ts collections                         # query first
npx tsx caido-client.ts create-collection "Swagger - petstore.yaml"
npx tsx caido-client.ts rename-collection "old name" "new name"
```

| Situation | Collection decision |
|-----------|--------------------|
| **One** request reproduced for the user | Default collection — **don't** create one. Name the session and tell the user the name. |
| A replay tab per endpoint in a **JS file** | New collection `JS File Endpoints`. |
| A replay tab per endpoint in a **Swagger spec** | New collection `Swagger - <filename>`. |
| A **multi-request chain** for a vuln | New collection `Vuln chain - <description>`, steps named `1. …`, `2. …`. |
| All endpoints under **`/api/v2`** | New collection `/api/v2/*`. |

Pass collections by **name**; the CLI resolves it (and tells you to create it first if missing):

```bash
npx tsx caido-client.ts create-session 8431 --name "1. login" --collection "Vuln chain - IDOR to ATO"
```

When you report back, name the collection and sessions — never IDs.

---

## Match & Replace — auto-rewrite traffic

Match & Replace (Caido calls these **"Tamper" rules** internally) rewrites requests/responses
**automatically as they pass through Caido**. The killer use: **inject auth at the proxy** so your
curl commands don't carry it — add a rule that sets `Authorization` on every proxied request, then
`curl -x <proxy> -k "$BASE/path"` is authenticated with no `-K`/headers at all.

A rule is one **section** (which part) × one **operation** × a **matcher** × a **replacer**, with
optional **condition** (HTTPQL scope) and **sources**:

| Piece | Choices |
|------|---------|
| **section** | req: `req-method req-path req-query req-body req-first-line req-header req-all req-sni` · resp: `resp-body resp-status resp-first-line resp-header resp-all` · ws: `ws-up ws-down` |
| **operation** | `raw` (match within the section) · `update`/`add`/`remove` (header & query only, by name) · method/status only `update` |
| **matcher** | `--match-value <str>` · `--match-regex <re>` · `--match-full` (whole section) · `--match-name <n>` (header/query update/add/remove) |
| **replacer** | `--replace <term>` (literal; `""` allowed) · `--workflow <id>` (run a workflow) |
| **condition** | `--condition '<httpql>'` — only apply when the request matches (e.g. one host) |
| **sources** | `--sources INTERCEPT,REPLAY,…` — which traffic it applies to |

Four gotchas, all defaulted for you:
- **New rules are created DISABLED.** Enable with `toggle-mr-rule <id> --on`.
- **Default collection** is Caido's "Default Collection" (override with `--collection <name|id>`).
- **Default sources** is `INTERCEPT` (proxy traffic), matching Caido. Add `--sources` to broaden.
- **JS targets — pick matcher based on what you're matching against.** `--match-value` is fine for stable literals (string constants, JSON keys, fixed API paths). Use `--match-regex` when matching near minified identifiers: symbol names rotate on every bundle deploy (e.g. `_.ex` → `_.Ww`), so a literal rule silently stops matching with no error. Anchor the regex to structurally stable neighbours — surrounding string literals, known function names, fixed JSON keys — rather than the minified identifier itself.

**Preview before committing:** `test-mr-rule` applies a rule to a raw request *without creating
anything* — use it to confirm a rule does what you expect.

```bash
# Preview: would this add the header correctly?
npx tsx caido-client.ts test-mr-rule --section req-header --operation add \
  --match-name X-Test --replace hi --raw 'GET / HTTP/1.1\r\nHost: t.com\r\n\r\n'

# Inject auth on all proxied requests to one host (then enable it)
ID=$(npx tsx caido-client.ts create-mr-rule --section req-header --operation add \
  --match-name Authorization --replace "Bearer eyJ…" \
  --condition 'req.host.eq:"target.com"' --name "auth inject" | jq -r '.created.id')
npx tsx caido-client.ts toggle-mr-rule "$ID" --on

# Other patterns
npx tsx caido-client.ts create-mr-rule --section req-header --operation remove \
  --match-name If-None-Match --sources REPLAY --name "drop INM"           # strip a header
npx tsx caido-client.ts create-mr-rule --section req-body --match-regex '"admin":false' \
  --replace '"admin":true' --name "force admin"                            # body regex
npx tsx caido-client.ts create-mr-rule --section resp-status --replace 403 --name "fake 403"  # response

npx tsx caido-client.ts mr-rules                # list rules (+ enabled state)
npx tsx caido-client.ts toggle-mr-rule <id> --off
npx tsx caido-client.ts delete-mr-rule <id>
```

Manage collections with `mr-collections`, `create-mr-collection`, `rename-mr-collection`,
`delete-mr-collection`; `move-mr-rule <id> <collection>`; `update-mr-rule <id> …` re-specs a rule
(same flags as create); `rename-mr-rule <id> <name>`.

---

## Output control (works with `get`, `get-response`, `replay`, `edit`, `send-raw`, `edit-session`)

| Flag | Description |
|------|-------------|
| `--max-body <n>` | Max response body lines (default 200, 0 = unlimited) |
| `--max-body-chars <n>` | Max body chars (default 5000, 0 = unlimited) |
| `--no-request` | Omit the request raw from output |
| `--headers-only` | Headers only, no body |
| `--compact` | Shorthand: `--no-request --max-body 50 --max-body-chars 5000` |

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
source:"replay" OR source:"intercept"           # tool-generated vs proxied traffic
req.created_at.gt:"2024-01-01T00:00:00Z"        # date filter
req.path.ncont:"/static"                        # exclude (no NOT keyword)
preset:"My Filter"                              # saved filter preset
```

---

## Other capabilities (reference)

### Findings — surface in Caido's Findings tab
```bash
npx tsx caido-client.ts findings --limit 50
npx tsx caido-client.ts create-finding 8431 --title "IDOR on /api/user/:id" \
  --description "Reads other users' profiles by changing id" --reporter "rez0" --dedupe-key "idor-user"
npx tsx caido-client.ts update-finding <id> --title "…" --description "…"
```

### Scopes / Filter presets / Environments
```bash
npx tsx caido-client.ts create-scope "Target" --allow "*.target.com" --deny "*.cdn.target.com"
npx tsx caido-client.ts create-filter "API 4xx" --query 'req.path.cont:"/api/" AND resp.code.gte:400' --alias "api4xx"
npx tsx caido-client.ts search 'preset:"API 4xx"' --compact
npx tsx caido-client.ts create-env "IDOR-Test"; npx tsx caido-client.ts env-set <env-id> victim_id "user_999"
```

### Fuzzing / intercept / projects / tasks / info
```bash
npx tsx caido-client.ts create-automate-session 8431   # configure payloads in UI, then: fuzz <session-id>
npx tsx caido-client.ts intercept-status | intercept-enable | intercept-disable
npx tsx caido-client.ts projects ; npx tsx caido-client.ts viewer ; npx tsx caido-client.ts plugins
```

---

## Full command reference

Every command (run `npx tsx caido-client.ts <command>`). Sessions/collections accept a **name or
id**; output is JSON unless noted. Run `--help` for full flag lists.

| Command | What it does |
|---|---|
| **History & testing** | |
| `search <httpql>` | Search history, **newest first**. `--limit --after --ids-only --asc/--oldest --compact` |
| `recent` | Newest requests. `--limit --compact` |
| `get <id>` / `get-response <id>` | Full request / just the response (output-control flags) |
| `raw <id>` | Dump byte-exact raw request. `--out <file> --response` |
| `export-curl <id>` | Full self-contained curl (for the user) |
| `export-curl <id> --config` | Reusable `-K` config — faithful static snapshot of all auth headers + inline cookies (internal). `--out <file>` · `--cookie-jar` (follow rotation) · `--exclude <h>` |
| **Send / edit** | |
| `replay <id> --name <n>` | Replay into a new named session. `--raw --collection` + connection overrides |
| `send-raw --host <h> --raw <s\|@file\|-> --name <n>` | Send a raw request via a new named session. `--port --tls/--no-tls --collection` |
| `edit <id>` | Edit + send into replay. `--method --path --set-header --remove-header --body --replace --session --name/--new-name/--nonach --collection` |
| `edit-session <name\|id>` | Edit + send from a session's active entry (requires `--nonach` or `--new-name`) |
| **Replay tab lookup** | |
| `get-session <name\|id>` | Session + active entry. `--compact` |
| `replay-entries <name\|id>` | Request history in a tab (alias `session-entries`). `--limit --raw` |
| **Sessions** | |
| `create-session <id> --name <n>` | New named session from a request. `--collection` |
| `rename-session <name\|id> <new>` · `move-session <s> <collection>` | Rename / move |
| `sessions` (alias `replay-sessions`) · `delete-sessions <id,id,…>` | List / delete |
| **Collections** | |
| `collections` (alias `replay-collections`) | List collections |
| `create-collection <name>` · `rename-collection <c> <new>` · `delete-collection <name\|id>` | Create / rename / delete |
| **Fuzzing** | `create-automate-session <id>` · `fuzz <session-id>` (configure payloads in UI) |
| **Findings** | `findings` · `get-finding <id>` · `create-finding <id> --title …` · `update-finding <id>` |
| **Scopes** | `scopes` · `create-scope <name> --allow --deny` · `update-scope <id>` · `delete-scope <id>` |
| **Filters** | `filters` · `create-filter <name> --query [--alias]` · `update-filter <id>` · `delete-filter <id>` |
| **Environments** | `envs` · `create-env <name>` · `env-set <env> <var> <val>` · `select-env [id]` · `delete-env <id>` |
| **Projects** | `projects` · `select-project <id>` |
| **Tasks** | `tasks` · `cancel-task <id>` |
| **Hosted files** | `hosted-files` · `delete-hosted-file <id>` |
| **Intercept** | `intercept-status` · `intercept-enable` · `intercept-disable` |
| **Match & Replace** | `mr-rules` · `mr-collections` · `create-mr-rule --section … [--operation] [--match-*] [--replace/--workflow] [--name --collection --condition --sources]` · `test-mr-rule --raw … --section …` (preview, no-op) · `toggle-mr-rule <id> --on\|--off` · `rename-mr-rule <id> <n>` · `move-mr-rule <id> <coll>` · `update-mr-rule <id> …` · `delete-mr-rule <id>` · `create-mr-collection <n>` · `rename-mr-collection <c> <n>` · `delete-mr-collection <c>` |
| **Info / auth** | `viewer` · `plugins` · `health` · `setup <pat> [url] [--proxy]` · `auth-status` |

---

## Architecture

Built on `@caido/sdk-client` v0.2.0+. No raw `fetch` — high-level SDK methods plus
`client.graphql.query/mutation` with `gql` documents for the few features the SDK doesn't expose.

```
caido-client.ts          # CLI entry — arg parsing + dispatch
lib/
  client.ts              # SDK Client singleton, SecretsTokenCache, auth, resolveProxy
  graphql.ts             # gql docs for features not in the SDK
  output.ts              # raw formatting (truncation, headers-only, raw→curl)
  types.ts               # OutputOpts
  commands/
    requests.ts          # search, recent, get, get-response, raw, export-curl (+ --config)
    replay.ts            # replay, send-raw, edit, sessions, collections (CRLF-normalized), automate
    findings.ts          # findings
    management.ts        # scopes, filters, environments, projects, hosted-files, tasks
    intercept.ts         # intercept status/enable/disable
    matchreplace.ts      # match & replace (tamper) rules — buildTamperSection + commands
    info.ts              # viewer, plugins, health, setup, auth-status
```

---

## Instructions for Claude (checklist)

1. **Test with `curl`, always through Caido** — the proxy must be in the path (config does this;
   otherwise `-x <proxy>`). **Exception:** bruteforce/fuzzing (`ffuf`) or 100+ requests at once go
   **direct** to avoid bloating HTTP history; bring interesting hits back into Caido.
2. **Cache auth once:** `export-curl <id> --config` → `/tmp/caido/<host>/auth.cfg` (faithful static
   snapshot of ALL auth headers + inline cookies). Test with `curl -K auth.cfg "$BASE/path"`.
3. **Refresh lazily** — only on 401/403/login-redirect, regenerate the config from a fresh request.
4. **Give the user FULL self-contained curl** (`export-curl <id>`); never a `-K` line.
5. **Browse with `--compact`;** `get`/`export-curl` only the request you'll work from.
6. **To show the operator a request, send it to Replay** (named session). Replay = handoff only,
   names mandatory; collections used heavily, referred to by NAME.
7. **Editing a session requires `--nonach` or `--new-name`.**
8. **Create findings** for anything real.
9. **NEVER use `NOT` in HTTPQL** — use `ne`/`ncont`/`nlike`/`nregex`.

## Operational notes (shell gotchas)

- **Don't batch CLI calls inside `while`/`for` loops.** Some shells strip `PATH` inside loop
  subshells, so `head`/`python3`/etc. become "command not found" and the loop body fails silently
  (sessions look like they weren't created). Run each `send-raw`/`create-session` as an individual
  top-level command, or as a standalone `bash` script with an explicit `export PATH=…`.
- **`search --ids-only` returns a JSON array** (`["123"]`), not a bare id — unwrap before reuse,
  e.g. `ID=$(… --ids-only | jq -r '.[0]')`.
- **`sessions` / `collections` now list everything** (paginated, not just the first page), so
  freshly-created items always appear. `--limit N` caps the count if you want a short list.

## Error handling

- **Auth errors** → `auth-status`, re-`setup <pat>` (or set `CAIDO_PAT`).
- **curl gets 401/403/login redirect** → token expired; refresh the config from a fresh request.
- **curl can't connect via proxy** → confirm the proxy with `auth-status`; Caido must be running.
- **Connection refused / not ready** → Caido isn't up or is still starting; check `health`.

