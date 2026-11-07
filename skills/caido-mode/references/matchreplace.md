# Match & Replace — auto-rewrite traffic

Command examples use the installed skill root. Preview a rule on a controlled request, scope it to the intended traffic and enable only the exact rule the task needs.

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

Defaults and matcher choice:

- **New rules are created DISABLED.** Enable with `toggle-mr-rule <id> --on`.
- **Default collection** is Caido's "Default Collection" (override with `--collection <name|id>`).
- **Default sources** is `INTERCEPT` (proxy traffic), matching Caido. Add `--sources` to broaden.
- **JS targets — pick matcher based on what you're matching against.** `--match-value` is fine for stable literals (string constants, JSON keys, fixed API paths). Use `--match-regex` when matching near minified identifiers: symbol names rotate on every bundle deploy (e.g. `_.ex` → `_.Ww`), so a literal rule silently stops matching with no error. Anchor the regex to structurally stable neighbours — surrounding string literals, known function names, fixed JSON keys — rather than the minified identifier itself.

**Preview before creating:** `test-mr-rule` applies a rule to raw input without creating a
persistent rule. A workflow replacer executes that workflow's code.

```bash
# Preview: would this add the header correctly?
npx tsx <skill-root>/caido-client.ts test-mr-rule --section req-header --operation add \
  --match-name X-Test --replace hi --raw 'GET / HTTP/1.1\r\nHost: t.com\r\n\r\n'

# Inject auth on all proxied requests to one host (then enable it)
ID=$(npx tsx <skill-root>/caido-client.ts create-mr-rule --section req-header --operation add \
  --match-name Authorization --replace "Bearer eyJ…" \
  --condition 'req.host.eq:"target.com"' --name "auth inject" | jq -r '.created.id')
npx tsx <skill-root>/caido-client.ts toggle-mr-rule "$ID" --on

# Other patterns
npx tsx <skill-root>/caido-client.ts create-mr-rule --section req-header --operation remove \
  --match-name If-None-Match --sources REPLAY --name "drop INM"           # strip a header
npx tsx <skill-root>/caido-client.ts create-mr-rule --section req-body --match-regex '"admin":false' \
  --replace '"admin":true' --name "force admin"                            # body regex
npx tsx <skill-root>/caido-client.ts create-mr-rule --section resp-status --replace 403 --name "fake 403"  # response

npx tsx <skill-root>/caido-client.ts mr-rules                # list rules (+ enabled state)
npx tsx <skill-root>/caido-client.ts toggle-mr-rule <id> --off
npx tsx <skill-root>/caido-client.ts delete-mr-rule <id>
```

Manage collections with `mr-collections`, `create-mr-collection`, `rename-mr-collection`,
`delete-mr-collection`; `move-mr-rule <id> <collection>`; `update-mr-rule <id> …` re-specs a rule
(same flags as create); `rename-mr-rule <id> <name>`.
