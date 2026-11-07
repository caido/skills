# HTTP history and curl testing

Use the selected Caido proxy for ordinary HTTP probes. Honor the operator's egress and request limits for batches; reduce or isolate high-volume traffic rather than silently switching to direct egress. Use an OS-appropriate scratch directory or `--out` when the shown `/tmp` paths are unsuitable. Examples use shell syntax; adapt variables and quoting to the current shell.

## Primary workflow

```bash
# 1. Find a base request that already has the auth/cookies you need.
npx tsx <skill-root>/caido-client.ts search 'req.host.cont:"target.com" AND req.path.cont:"/api/user"' --compact
#    → 8431  200  GET target.com/api/user/me

# 2. ONCE per target: cache its auth into a reusable curl config.
npx tsx <skill-root>/caido-client.ts export-curl 8431 --config
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

Reuse the config for the planned probes within the task's request budget.
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
  `403`/`PERMISSION_DENIED`. The config mirrors what authorized the request. It drops
  `Content-Type` and curl-managed transport headers: `Host`, `Content-Length`,
  `Accept-Encoding`, `Connection`, `Transfer-Encoding`, `Proxy-Connection`, `Keep-Alive`,
  `Upgrade` and `TE`.
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
  headers. See [matchreplace.md](matchreplace.md).

### Giving commands to the user

To surface a request *inside Caido* for the operator, send it to **Replay** (see [replay.md](replay.md)) — that's the default. This section is for the other case: handing them a runnable **command**
(a PoC, or something to run outside Caido). Then **always produce a full, self-contained curl** —
every header inline, no `-K`:

```bash
npx tsx <skill-root>/caido-client.ts export-curl 8431      # full curl, all headers inline (portable PoC)
```

Include proxy and TLS flags according to the intended reproduction environment and the operator's egress requirements. **Never hand the user a `curl -K /tmp/...` line** — that file
is yours.

## Searching history

```bash
npx tsx <skill-root>/caido-client.ts search 'req.method.eq:"POST" AND resp.code.eq:200' --compact
npx tsx <skill-root>/caido-client.ts search 'req.host.cont:"api"' --limit 50
npx tsx <skill-root>/caido-client.ts search 'req.host.cont:"api"' --asc --limit 50   # oldest first (rarely wanted)
npx tsx <skill-root>/caido-client.ts recent --compact            # newest requests, one line each
npx tsx <skill-root>/caido-client.ts get 8431 --compact          # full details (JSON) when you need them
npx tsx <skill-root>/caido-client.ts get-response 8431 --compact
npx tsx <skill-root>/caido-client.ts raw 8431 --out /tmp/caido/target.com/request.http   # full raw request
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

See [httpql.md](httpql.md) for query syntax.

## Output control

These flags apply to `get`, `get-response`, `replay`, `edit`, `send-raw` and `edit-session`.

| Flag | Description |
|------|-------------|
| `--max-body <n>` | Max response body lines (default 200, 0 = unlimited) |
| `--max-body-chars <n>` | Max body chars (default 5000, 0 = unlimited) |
| `--no-request` | Omit the request raw from output |
| `--headers-only` | Headers only, no body |
| `--compact` | Shorthand: `--no-request --max-body 50 --max-body-chars 5000` |

## Operational notes

- If a loop's subshell loses `PATH`, run the affected calls individually or use a standalone
  script with an explicit runtime path. Check command failures rather than assuming the sessions
  were created.
- **`search --ids-only` returns a JSON array** (`["123"]`), not a bare id — unwrap before reuse,
  e.g. `ID=$(… --ids-only | jq -r '.[0]')`.
- **`sessions` / `collections` now list everything** (paginated, not just the first page), so
  freshly-created items always appear. `--limit N` caps the count if you want a short list.

## Troubleshooting

- **Auth errors** → `auth-status`, re-`setup <pat>` (or set `CAIDO_PAT`).
- **curl gets 401/403/login redirect** → token expired; refresh the config from a fresh request.
- **curl can't connect via proxy** → confirm the proxy with `auth-status`; Caido must be running.
- **Connection refused / not ready** → Caido isn't up or is still starting; check `health`.
