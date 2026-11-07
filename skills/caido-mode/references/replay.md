# Replay sessions and collections

Use named sessions when giving a request to the **user**, or when explicitly testing inside Replay. Prefer [curl](requests.md) for ordinary one-off probes; use [native pipelines](automation.md) when synchronization matters.
Sessions created from a raw request have their **header line endings normalized to CRLF
automatically** — a handoff session is never built with bare-LF (`\n`) endings.

```bash
# Create a NAMED session from a history request (name is REQUIRED).
npx tsx <skill-root>/caido-client.ts create-session 8431 --name "IDOR /api/user/:id"
npx tsx <skill-root>/caido-client.ts sessions                                   # list (alias: replay-sessions)
npx tsx <skill-root>/caido-client.ts rename-session "IDOR /api/user/:id" "IDOR - confirmed"
npx tsx <skill-root>/caido-client.ts move-session "IDOR - confirmed" "Vuln chain - IDOR to ATO"

# Build a handoff session from a raw request file (CRLF auto-normalized):
npx tsx <skill-root>/caido-client.ts send-raw --host target.com --raw @/tmp/req.txt --name "crafted repro"
```

### Editing a session forces name intent

If the user asks you to test *inside* Replay, use `edit` / `edit-session`. Because an edit changes
what a session contains, declare what happens to its **name** — pass exactly one of
`--no-name-change` (`--nonach`) or `--new-name "<name>"`:

```bash
npx tsx <skill-root>/caido-client.ts edit 8431 --path /api/user/999 --name "IDOR victim 999"        # new session
npx tsx <skill-root>/caido-client.ts edit-session "IDOR victim 999" --body '{"role":"admin"}' --nonach --compact
npx tsx <skill-root>/caido-client.ts edit 8431 --path /api/admin --session "IDOR victim 999" --new-name "priv-esc"
```

`edit` preserves cookies/auth from the original request; it supports `--method`, `--path`,
`--set-header`, `--remove-header`, `--body` (auto Content-Length), `--replace <from>:::<to>`, and
connection overrides (`--sni`, `--connect-host`, `--connect-port`, `--connect-tls`,
`--connect-no-tls`).

### Inspecting an existing replay tab

When a replay tab is already open in Caido and you want to work from its current state, look it
up by **name or id** (no need to re-create it):

```bash
npx tsx <skill-root>/caido-client.ts get-session "IDOR victim 999" --compact      # session + its active entry
npx tsx <skill-root>/caido-client.ts replay-entries "IDOR victim 999" --limit 20  # request/response history in the tab
npx tsx <skill-root>/caido-client.ts replay-entries "IDOR victim 999" --raw --compact   # include raw bytes
```

`session-entries` is an alias for `replay-entries`. Use these to read what's in a tab; use
`edit-session` (above) to send a modified request into it.

---

## Collections — use them heavily

Collections organize sessions for handoff. **Before creating a session, list existing collections
and decide where it belongs.** Names are mandatory and collections are never auto-created.

```bash
npx tsx <skill-root>/caido-client.ts collections                         # query first
npx tsx <skill-root>/caido-client.ts create-collection "Swagger - petstore.yaml"
npx tsx <skill-root>/caido-client.ts rename-collection "old name" "new name"
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
npx tsx <skill-root>/caido-client.ts create-session 8431 --name "1. login" --collection "Vuln chain - IDOR to ATO"
```

When you report back, name the collection and sessions — never IDs.
