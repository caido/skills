# Intercept and WebSocket history

Use `npx tsx <skill-root>/caido-client.ts <command>`. Match & Replace retains its original commands, documented in [matchreplace.md](matchreplace.md).

## Intercept

`intercept-status` reports global status. `intercept-enable` pauses forwarding, so matching traffic queues; `intercept-disable` restores forwarding.

```console
npx tsx <skill-root>/caido-client.ts intercept-messages --kind request --limit 10
npx tsx <skill-root>/caido-client.ts get-intercept-message MESSAGE_ID --kind request
npx tsx <skill-root>/caido-client.ts forward-intercept-message MESSAGE_ID
npx tsx <skill-root>/caido-client.ts forward-intercept-message MESSAGE_ID --raw @edited-request.txt --kind request
npx tsx <skill-root>/caido-client.ts drop-intercept-message MESSAGE_ID
```

Queue kinds for listing/retrieval are `request`, `response` and `stream_ws`. The API has no direct getter for a queue message, so `get-intercept-message` searches for the exact ID on a bounded page; use `--after CURSOR` for another page. Forwarding replacement bytes uses `--kind request|response|ws`. Without `--raw`, forwarding preserves the queued message.

`set-intercept-options --input @patch.json` merges supplied options into current settings. Use `schema` to inspect unfamiliar input fields. Change only requested options; a global forwarding change affects other clients. Forward/drop exact IDs, and do not resume to flush another client's queue.

## WebSocket history

```console
npx tsx <skill-root>/caido-client.ts streams --limit 10
npx tsx <skill-root>/caido-client.ts ws-messages STREAM_ID --limit 10
npx tsx <skill-root>/caido-client.ts get-ws-message MESSAGE_ID --raw
```

`--filter` uses StreamQL, `--after` follows a cursor, and `--scope` filters connections. Frame output retains direction, format and base64 payload bytes. `--raw` opts into payload content. History reads do not imply WebSocket replay support. Select Match & Replace or forwarding a queued replacement frame explicitly to alter traffic.

When a command fails, use the returned error and cached `schema TYPE`; refresh capabilities for an actual mismatch. Preserve the selected project, filters and shared settings during a retry.
