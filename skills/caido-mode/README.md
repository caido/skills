# Caido Mode

A Caido agent skill built on the official [`@caido/sdk-client`](https://github.com/caido/sdk-js). Search HTTP history, preserve authenticated requests for curl testing, hand off named Replay sessions, manage Match & Replace, build workflows, inspect WebSocket frames, control Intercept, configure Automate and run native Replay Pipelines.

## Setup

Requires Node.js 24+, a running Caido instance and a [personal access token](https://docs.caido.io/dashboard/guides/create_pat.html). From this directory:

```console
npm install
npx tsx caido-client.ts setup <your-pat> http://localhost:8080
npx tsx caido-client.ts health
npx tsx caido-client.ts recent --limit 1 --compact
```

Run commands from the skill directory to use its installed dependencies. Scripts can also use `node --import tsx caido-client.ts <command>` from that directory.

Install this directory as `caido-mode` in your agent client's skill location and run `npm install` there. `SKILL.md` supports automatic discovery without mentions in another project's skills.

`setup` validates the PAT and stores URL-keyed credentials and cached access tokens in `~/.claude/config/secrets.json`; `CAIDO_CONFIG` overrides that path. Existing instances retain separate credentials. Select a URL per process with `CAIDO_URL`; `CAIDO_PAT` and `CAIDO_PROXY` override the selected instance's stored values. The proxy defaults to the API URL. Use `auth-status` to inspect the selected URL/proxy without exposing credentials.

Nonsecret capability metadata lives outside the checkout; `CAIDO_MODE_HOME` overrides its directory. `capabilities --refresh` or the first command needing schema metadata discovers the actual instance's schema. Later operations use the cache, and release checks happen only through explicit `check-updates`. See [setup and diagnosis](references/setup.md).

## Common use

Find an authenticated request, cache its auth once, then test through the selected proxy:

```console
npx tsx caido-client.ts search 'req.host.cont:"target.com"' --limit 10 --compact
npx tsx caido-client.ts export-curl 8431 --config --out auth.cfg
curl -K auth.cfg https://target.com/api/user/999
curl -K auth.cfg -X POST https://target.com/api/profile -H 'Content-Type: application/json' --data-binary @body.json
```

The config captures all auth/identity headers and static cookies, omitting per-request headers such as Content-Type. Supply the endpoint's exact Content-Type for POST/PUT/PATCH. Use `--path-as-is` for path-normalization tests and `-g` for literal URL braces/brackets. Refresh the snapshot from a fresh request when its auth expires. Keep the operator's egress and volume limits for batches. [History/curl reference](references/requests.md)

Give the user named sessions in named collections for multi-request handoffs. Editing an existing session requires exactly one of `--nonach`/`--no-name-change` or `--new-name`. A runnable curl handoff should be self-contained, with inline headers rather than your local `-K` file. [Replay reference](references/replay.md)

Use workflows for reusable checks or passive observation, scripts for simpler one-offs, and native pipelines when synchronization matters. Choose the useful mechanism and execute; reconsider after a concrete failure or changed requirement.

## Capabilities and references

| Capability | Commands and guidance |
|---|---|
| HTTP history and curl | `search`, `recent`, `get`, `get-response`, `raw`, `export-curl`; [history/curl](references/requests.md), [HTTPQL](references/httpql.md) |
| Edit, Replay and handoff | `edit`, `replay`, `send-raw`, `get-session`, `edit-session`, `replay-entries`, sessions and collections; [Replay](references/replay.md) |
| Match & Replace | Original `mr-rules`, `create-mr-rule`, `test-mr-rule`, update/toggle/delete and collection commands; [rules](references/matchreplace.md) |
| Workflow authoring | `build-workflow`, `test-workflow`, `create-workflow`, `run-workflow`, `workflow-nodes` and lifecycle commands for convert/active/passive graphs; [workflows](references/workflows.md) |
| Automate | `create-automate-session`, `configure-automate-session`, `start-automate-task`, results and task control; [automation](references/automation.md) |
| Native pipelines | `create-pipeline`, `run-pipeline`, `get-pipeline`, `delete-pipeline`, with sequential/last-byte/single-packet strategies; [automation](references/automation.md) |
| Intercept and WebSockets | Intercept queue/settings, `streams`, `ws-messages`, `get-ws-message`; [traffic](references/traffic.md) |
| Findings and management | Findings, scopes, filters, environments, projects, hosted files and tasks; [full command reference](references/commands.md) |
| Instance metadata | `capabilities [--refresh]`, `schema TYPE`; [setup](references/setup.md) |
| Network stack | `settings` reports `network.stack`; `set-settings --input @patch.json` applies supplied instance settings |
| Explicit improvements | `check-updates`; [improvement workflow](references/improve.md) |

Run `npx tsx caido-client.ts --help` for full CLI flags. Legacy commands remain available, including `create-automate-session`, `fuzz`, `intercept-status`, `intercept-enable` (pause/queue) and `intercept-disable` (resume/forward). Preserve other clients' queues, tasks and global settings when working on a shared instance.

## Development

```console
npm test
```

Live tests are opt-in: set `CAIDO_URL` and `CAIDO_TEST_URL` to the same loopback fixture, authenticate it with `setup`, and select a disposable project named `caido-mode isolated fixtures` (or set `CAIDO_TEST_PROJECT`). Then run `npm test`. `CAIDO_CONFIG` and `CAIDO_MODE_HOME` can isolate its auth and metadata. The tests require a controlled instance because they exercise Intercept, workflows, Automate and network settings; they restore settings and remove their sessions. The HTTP/2 case requires OpenSSL (`CAIDO_TEST_OPENSSL` can select its executable).

For performance comparisons, run `node --import tsx test/benchmark.mjs` from the skill directory with that fixture. Set `CAIDO_CONFIG` explicitly to its credential file and `CAIDO_BENCH_BASELINE` to an unmodified, dependency-installed `caido-client.ts`. It runs 30 interleaved fresh processes per command, counts API/introspection calls without recording payloads, and uses the same controlled response delay for both versions. `CAIDO_BENCH_OUTPUT` saves the report.

The source uses the official SDK's high-level methods and GraphQL query/mutation interface where needed. Capability adapters inspect the live schema for version-dependent inputs and operation names. Keep normal startup free of release checks and repeated schema discovery.

```text
caido-client.ts          CLI parsing and dispatch
lib/client.ts           SDK singleton, URL-keyed auth and proxy selection
lib/capabilities.ts     cached schema and native capability helpers
lib/state.ts            per-instance nonsecret metadata
lib/graphql.ts          GraphQL documents
lib/output.ts           bounded HTTP output and curl formatting
lib/types.ts            shared output options
lib/commands/
  requests.ts           HTTP history, raw requests and curl exports
  replay.ts             named Replay sessions, collections and legacy fuzzing
  matchreplace.ts       Match & Replace preview and rule management
  workflows.ts          live-node workflow authoring and execution
  streams.ts            WebSocket history
  automate.ts           payload configuration, budgets and task control
  pipelines.ts          native Replay Pipelines
  intercept.ts          forwarding state, queue and message operations
  findings.ts           findings
  management.ts         scopes, filters, environments, projects and tasks
  info.ts               setup, auth status, health and instance info
references/             task-specific operational guidance
```

Test feature mutations on an isolated instance and a controlled target. See [improvement guidance](references/improve.md) before extending an adapter or changing the shared execution path.

## License

MIT
