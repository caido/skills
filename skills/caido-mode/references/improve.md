# Improve caido-mode when asked

Run `check-updates` only for an explicit update/improvement request. Ordinary operations use cached capability metadata and do not browse release notes or launch an agent, daemon or scheduler.

Work in the actual caido-mode source checkout. Compare the requested gap with official Caido documentation, SDK types, the instance's schema (`capabilities --refresh`, `schema TYPE`) and upstream changes. Release notes identify candidates; they do not prove support on the selected instance. Prefer an existing SDK method; add a validated GraphQL adapter through the official SDK only for a real gap. An unavailable API remains unsupported.

Preserve the upstream flat commands and typed `cmd*` handler conventions, URL-keyed auth, exported curl fidelity and explicit replay naming. Add a regression for the concrete failure and run `npm test`. Verify the selected feature against an isolated Caido instance and controlled target; keep mutation tests out of another client's active project. Demonstrate output and task/resource cleanup where applicable.

Benchmark common fresh-process commands against the working version with cached metadata and equivalent auth. Compare interleaved samples, medians and tail latency; ordinary commands should add no capability discovery calls. Keep optional functionality lazy and preserve the original source invocation.

Update only the relevant feature reference and CLI help. Keep `SKILL.md` short and automatically discoverable. Keep caido-mode self-contained, with its existing command namespace and credential store. Publishing or opening a PR remains a separate explicit action.
