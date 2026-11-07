# Command reference

Original command reference (run `npx tsx <skill-root>/caido-client.ts <command>`). Sessions/collections accept a **name or
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
| **Fuzzing** | `create-automate-session <id> [--name <n>]` · `fuzz <session-id>` (bounded start; configure through CLI or UI) |
| **Findings** | `findings` · `get-finding <id>` · `create-finding <id> --title …` · `update-finding <id>` |
| **Scopes** | `scopes` · `create-scope <name> --allow --deny` · `update-scope <id>` · `delete-scope <id>` |
| **Filters** | `filters` · `create-filter <name> --query [--alias]` · `update-filter <id>` · `delete-filter <id>` |
| **Environments** | `envs` · `create-env <name>` · `env-set <env> <var> <val>` · `select-env [id]` · `delete-env <id>` |
| **Projects** | `projects` · `select-project <id>` · `get-project <id>` · `create-project <name> [--temporary]` · `rename-project <id> <name>` · `delete-project <id>` |
| **Tasks** | `tasks` · `cancel-task <id>` |
| **Hosted files** | `hosted-files` · `delete-hosted-file <id>` |
| **Intercept** | `intercept-status` · `intercept-enable` (pause/queue) · `intercept-disable` (resume/forward) |
| **Match & Replace** | `mr-rules` · `mr-collections` · `create-mr-rule --section … [--operation] [--match-*] [--replace/--workflow] [--name --collection --condition --sources]` · `test-mr-rule --raw … --section …` (preview without saving a rule) · `toggle-mr-rule <id> --on\|--off` · `rename-mr-rule <id> <n>` · `move-mr-rule <id> <coll>` · `update-mr-rule <id> …` · `delete-mr-rule <id>` · `create-mr-collection <n>` · `rename-mr-collection <c> <n>` · `delete-mr-collection <c>` |
| **Info / auth** | `viewer` · `plugins` · `health` · `setup <pat> [url] [--proxy]` · `auth-status` |

## Extended native commands

| Command | Reference |
|---|---|
| `workflows`, `get-workflow`, `workflow-nodes`, `build-workflow`, `test-workflow`, `create-workflow`, `update-workflow`, `run-workflow`, `toggle-workflow --on\|--off`, `delete-workflow` | [Workflow authoring and execution](workflows.md) |
| `streams`, `ws-messages STREAM_ID`, `get-ws-message MESSAGE_ID` | [WebSocket history](traffic.md) |
| `intercept-messages`, `get-intercept-message`, `set-intercept-options`, `forward-intercept-message`, `drop-intercept-message` | [Intercept queue and settings](traffic.md) |
| `automate-sessions`, `get-automate-session`, `configure-automate-session`, `start-automate-task`, `automate-tasks`, `automate-results`, `pause-automate-task`, `resume-automate-task`, `cancel-automate-task`, `delete-automate-session` | [Automate configuration and budgets](automation.md) |
| `create-pipeline`, `run-pipeline`, `get-pipeline`, `delete-pipeline` | [Native sequential and synchronized replay](automation.md) |
| `capabilities [--refresh]`, `schema TYPE` | [Instance capability metadata](setup.md) |
| `check-updates` | [Explicit improvement checks](improve.md) |
| `settings`, `set-settings --input @patch.json` | Read the current `network.stack`; apply only requested instance settings |

New list commands accept `--limit`/`--after` where the API exposes cursors. For large native
results, use the supported `--output FILE` flag to save full JSON; terminal bodies remain bounded.

## Management examples

### Findings — surface in Caido's Findings tab

```bash
npx tsx <skill-root>/caido-client.ts findings --limit 50
npx tsx <skill-root>/caido-client.ts create-finding 8431 --title "IDOR on /api/user/:id" \
  --description "Reads other users' profiles by changing id" --reporter "rez0" --dedupe-key "idor-user"
npx tsx <skill-root>/caido-client.ts update-finding <id> --title "…" --description "…"
```

### Scopes / Filter presets / Environments

```bash
npx tsx <skill-root>/caido-client.ts create-scope "Target" --allow "*.target.com" --deny "*.cdn.target.com"
npx tsx <skill-root>/caido-client.ts create-filter "API 4xx" --query 'req.path.cont:"/api/" AND resp.code.gte:400' --alias "api4xx"
npx tsx <skill-root>/caido-client.ts search 'preset:"API 4xx"' --compact
npx tsx <skill-root>/caido-client.ts create-env "IDOR-Test"
npx tsx <skill-root>/caido-client.ts env-set <env-id> victim_id "user_999"
```

### Fuzzing / intercept / projects / tasks / info

```bash
npx tsx <skill-root>/caido-client.ts create-automate-session 8431   # configure through CLI or UI, then: fuzz <session-id>
npx tsx <skill-root>/caido-client.ts intercept-status
npx tsx <skill-root>/caido-client.ts intercept-enable   # pause forwarding / queue
npx tsx <skill-root>/caido-client.ts intercept-disable  # resume forwarding
npx tsx <skill-root>/caido-client.ts projects
npx tsx <skill-root>/caido-client.ts viewer
npx tsx <skill-root>/caido-client.ts plugins
```
