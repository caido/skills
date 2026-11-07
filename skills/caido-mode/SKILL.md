---
name: caido-mode
description: Use Caido for HTTP history, authenticated proxy testing, named replay handoffs, Match & Replace, workflows, WebSocket history, Intercept, Automate and native synchronized replay through the official SDK. PAT auth recommended.
tags: [worker]
---

# Caido Mode

From the installed skill directory, run `npx tsx caido-client.ts <command>`. Install dependencies once with `npm install`. Replace `<skill-root>` in reference examples with that directory.

Start with `auth-status` or the requested operation. Use compact history and bounded results. Ordinary commands reuse cached capabilities; refresh only for a concrete mismatch. Honor the selected proxy, scope and request limits; do not change egress for a large batch.

Prefer curl through Caido for one-off HTTP probes, named Replay sessions/collections for user handoff, workflows for persistent/reusable checks, and native pipelines for synchronized sends. Script a simpler one-off. Choose once and execute; revisit after a concrete failure or changed requirement.

Read only the relevant reference:

- [Setup/auth](references/setup.md): instance selection, proxy and diagnosis.
- [History/curl](references/requests.md): faithful static auth, explicit Content-Type, exact paths and output limits; [HTTPQL](references/httpql.md) for filters.
- [Replay](references/replay.md): named handoffs and explicit name-change intent.
- [Match & Replace](references/matchreplace.md): preview and scoped rule management.
- [Workflows](references/workflows.md): build, test, create and run convert/active/passive graphs using live node definitions.
- [Automation](references/automation.md): finite payload budgets and native races.
- [Intercept/WebSockets](references/traffic.md): queue ownership and frame history.
- [Commands](references/commands.md): existing management commands and full CLI help; [improvements](references/improve.md) only when requested.
