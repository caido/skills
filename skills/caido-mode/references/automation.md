# Automate and native Replay Pipelines

Use the original `npx tsx <skill-root>/caido-client.ts <command>` entry. Keep the operator's selected egress, scope, concurrency and request budget. Reduce or isolate large batches while preserving the selected egress. Use finite payloads, bounded result pages and owned sessions on shared instances.

## Automate

Configure payloads through the CLI:

```console
npx tsx <skill-root>/caido-client.ts create-automate-session REQUEST_ID --name "Selected parameter"
npx tsx <skill-root>/caido-client.ts configure-automate-session SESSION_ID --match FUZZ --payloads @strings.json --workers 1 --delay 100 --max-requests 100
npx tsx <skill-root>/caido-client.ts start-automate-task SESSION_ID --max-requests 100 --max-workers 20
npx tsx <skill-root>/caido-client.ts automate-results SESSION_ID
```

The baseline request must contain the replacement token. `strings.json` is a finite array of strings; marker ranges use byte offsets, including multibyte prefixes. The shorthand uses one payload set with strategy `ALL`, replacing all token occurrences with the same value per request and preserving connection settings, including SNI. Inspect `get-automate-session ID` to verify settings. For advanced payloads/preprocessors, inspect `schema AutomateSettingsInput` and provide a complete `configure-automate-session ID --input @update.json`.

Start checks the saved settings against request and worker limits before launching. The estimate accounts for placeholder strategy, finite payload counts, retries and redirects. Unknown-size hosted payloads need a finite list. `automate-sessions` lists sessions; `automate-tasks` returns task IDs; `pause-automate-task TASK_ID`, `resume-automate-task TASK_ID` and `cancel-automate-task TASK_ID` act on one task. `delete-automate-session SESSION_ID` removes the selected session. The original `fuzz SESSION_ID` uses the same bounded start.

`automate-results SESSION_ID` pages requests from one latest run. Select an older run with `--entry ENTRY_ID`; it must belong to that session. `--limit` caps the returned request rows. The API lists run metadata without pagination; if timestamps do not identify one latest run, select its ID explicitly.

## Native races

```console
npx tsx <skill-root>/caido-client.ts create-pipeline --requests REQUEST_ID,REQUEST_ID --name "Controlled race" --strategy last-byte --max-requests 20
npx tsx <skill-root>/caido-client.ts run-pipeline SESSION_ID --max-requests 20
npx tsx <skill-root>/caido-client.ts get-pipeline SESSION_ID
```

Strategies are `sequential`, `last-byte` and `single-packet`. They use Caido's native pipeline engine. `--collection NAME_OR_ID` places the new session in an existing collection. The adapter discovers operation names exposed by the actual instance. `run-pipeline` checks the saved members against its request budget and returns a task ID promptly; `get-pipeline` reports individual responses. `delete-pipeline ID` verifies the session is a pipeline before deleting it.

Single-packet requires Caido's HTTP/2 stack and a compatible connection path. Inspect `settings` before a transport change; `set-settings --input @patch.json` changes shared configuration only when requested. Last-byte may work when HTTP/2 does not. A receiver accepting multiple requests proves acceptance, not packet synchronization; verify transport on a controlled receiver before claiming a synchronized race.
