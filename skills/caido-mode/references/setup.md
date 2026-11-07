# Setup and diagnosis

Run commands from the installed caido-mode directory to use its dependencies. Replace `<skill-root>` in examples with that directory. Install dependencies once:

```console
npm install
npx tsx caido-client.ts setup <pat> http://localhost:8080
npx tsx caido-client.ts auth-status
npx tsx caido-client.ts health
```

Node.js 24+ and a running Caido instance are required. Create a PAT in Caido's Dashboard → Developer → Personal Access Tokens. Scripts may also use `node --import tsx caido-client.ts <command>` from the skill directory; Node resolves the `tsx` loader from the working directory.

`setup` validates the PAT through the SDK's device-code flow, auto-approved by the PAT, then caches the PAT and access token in `~/.claude/config/secrets.json`. `CAIDO_CONFIG` overrides this file. A valid cached token works without the PAT. Treat both the config and exported curl files as credentials; do not print their contents merely to discover an address.

Credentials are keyed by instance URL. `setup <pat> <url>` adds that instance and makes it the stored default without replacing other URLs. The active URL is `CAIDO_URL` → stored default → `http://localhost:8080`. Select `CAIDO_URL` per process or shell when working concurrently. `CAIDO_PAT` and `CAIDO_PROXY` override the active instance's saved values. Preserve other instances when changing credentials.

The API and proxy share an address by default. Read `auth-status`'s `proxy` and `activeUrl` fields to discover them. Set a different listener with `setup <pat> <url> --proxy <proxy-url>` or `CAIDO_PROXY`. Exported curl configs include the selected proxy. Do not infer the current address from the legacy `.caido.url` shape; config is URL-keyed.

`capabilities --refresh` discovers the actual instance schema; `schema TYPE` exposes a selected cached type for advanced inputs. The first operation needing schema metadata also caches it. Nonsecret metadata lives outside the source checkout; `CAIDO_MODE_HOME` overrides its directory. Ordinary operations reuse cached metadata. Refresh for an actual version/schema mismatch, rather than before each operation. `check-updates` is an explicit improvement action; see [improve.md](improve.md).

On authentication failure, inspect `auth-status` and refresh the selected instance's credentials. On connection refusal/not-ready, check `health` and the listener. An initial Caido account claim is an interactive Caido account step; a PAT does not bypass it. For a denied or missing capability, distinguish authentication, entitlement and schema support before retrying.
