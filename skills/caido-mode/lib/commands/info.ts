/** Info commands: viewer, plugins, health, setup, auth-status */

import { Client } from "@caido/sdk-client";
import {
  getClient, resolveProxy, resolveActiveUrl, readCaidoRoot, getCaidoInstance,
  upsertCaidoInstance, SecretsTokenCache, SECRETS_PATH, isCachedTokenValid, QUIET_LOGGER, canonicalUrl,
} from "../client";
import { PLUGIN_PACKAGES_QUERY, NETWORK_SETTINGS_QUERY, SET_NETWORK_SETTINGS } from "../graphql";
import { saveInstanceHealth } from "../state";
import { printResult, type ResultOutputOpts } from "../output";

export async function cmdCapabilities(refresh = false, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  if (refresh) saveInstanceHealth(resolveActiveUrl(), await client.health());
  const { getGraph, capabilities } = await import("../capabilities");
  await printResult(capabilities(await getGraph(client, { refresh })), opts);
}

export async function cmdSchema(name: string, refresh = false, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  const { getGraph } = await import("../capabilities");
  await printResult((await getGraph(client, { refresh })).describe(name), opts);
}

export async function cmdSettings() {
  const client = await getClient();
  const result = await client.graphql.query(NETWORK_SETTINGS_QUERY, {});
  console.log(JSON.stringify((result as any).instanceSettings, null, 2));
}

export async function cmdSetSettings(input: Record<string, unknown>) {
  const client = await getClient();
  const result = await client.graphql.mutation(SET_NETWORK_SETTINGS, { input });
  const payload = (result as any).setInstanceSettings;
  if (!payload?.settings) throw new Error("Caido did not return updated network settings");
  console.log(JSON.stringify(payload.settings, null, 2));
}

export async function cmdCheckUpdates() {
  const client = await getClient();
  const { createRequire } = await import("node:module");
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const sdkPath = createRequire(import.meta.url).resolve("@caido/sdk-client");
  const installedSdk = JSON.parse(await readFile(join(dirname(sdkPath), "..", "package.json"), "utf8")) as { version: string };
  const [npm, release] = await Promise.all([
    fetch("https://registry.npmjs.org/@caido/sdk-client/latest", { signal: AbortSignal.timeout(15000) }),
    fetch("https://api.github.com/repos/caido/caido/releases/latest", {
      signal: AbortSignal.timeout(15000), headers: { "User-Agent": "caido-mode" },
    }),
  ]);
  if (!npm.ok || !release.ok) throw new Error("Unable to read official release metadata");
  const sdk = await npm.json() as { version: string };
  const caido = await release.json() as { tag_name: string; html_url: string };
  const health = await client.health();
  saveInstanceHealth(resolveActiveUrl(), health);
  const { getGraph, capabilities } = await import("../capabilities");
  console.log(JSON.stringify({
    sdk: { installed: installedSdk.version, latest: sdk.version },
    caido: { installed: health.version, latest: caido.tag_name, notes: caido.html_url },
    capabilities: capabilities(await getGraph(client, { refresh: true })),
  }, null, 2));
}

export async function cmdViewer() {
  const client = await getClient();
  const viewer = await client.user.viewer();
  console.log(JSON.stringify(viewer, null, 2));
}

export async function cmdPlugins() {
  const client = await getClient();
  const result = await client.graphql.query(PLUGIN_PACKAGES_QUERY, {});
  console.log(JSON.stringify((result as any).pluginPackages, null, 2));
}

export async function cmdHealth() {
  const client = await getClient();
  const health = await client.health();
  saveInstanceHealth(resolveActiveUrl(), health);
  console.log(JSON.stringify(health, null, 2));
}

export async function cmdSetup(pat: string, url: string, proxy?: string) {
  url = canonicalUrl(url);
  console.log(`Connecting to ${url}...`);

  // Cache the access token under THIS instance's slot (clear any stale one first).
  const setupCache = new SecretsTokenCache(url);
  await setupCache.clear();

  const client = new Client({
    url,
    auth: { pat, cache: setupCache },
    logger: QUIET_LOGGER,
  });

  try {
    await client.connect({ ready: { retries: 3, timeout: 5000, interval: 1000 } });
    saveInstanceHealth(url, await client.health());
  } catch (err: any) {
    const message = String(err.message);
    console.error(`Failed to connect: ${pat ? message.replaceAll(pat, "[redacted]") : message}`);
    console.error("\nMake sure:");
    console.error(`  1. Caido is running at ${url}`);
    console.error("  2. The PAT was created in Caido → Settings → Developer → Personal Access Tokens");
    process.exit(1);
  }

  const viewer = await client.user.viewer();
  console.log(`Authenticated as: ${(viewer as any).username || (viewer as any).id || JSON.stringify(viewer)}`);

  // Persist PAT (+ proxy) under instances[url] and make it the active default.
  // The access token was already cached under instances[url] during connect.
  upsertCaidoInstance(url, { pat, ...(proxy ? { proxy } : {}) }, true);

  console.log(`\nSaved to ${SECRETS_PATH} (instance: ${url})`);
  console.log("PAT: saved");
  console.log(`Access token: cached`);
  console.log(`Proxy (curl -x): ${resolveProxy()}`);
  console.log(`\nActive instance is now ${url}. Switch instances per shell with CAIDO_URL=<url>.`);
}

export async function cmdAuthStatus() {
  const url = resolveActiveUrl();
  const root = readCaidoRoot();
  const instance = getCaidoInstance(root, url);

  const hasPat = !!process.env.CAIDO_PAT || !!instance.pat;
  const cachedTokenValid = isCachedTokenValid(instance);
  const cachedTokenExpiresAt = instance.cachedToken?.expiresAt ?? null;
  const authMode = hasPat ? "pat" : (cachedTokenValid ? "cached-token" : "none");

  const base = {
    activeUrl: url,
    defaultUrl: root.default ?? null,
    configuredInstances: Object.keys(root.instances ?? {}),
    authMode,
    hasPat,
    cachedTokenExpiresAt,
    cachedTokenValid,
    proxy: resolveProxy(),
  };

  if (!hasPat && !cachedTokenValid) {
    console.log(JSON.stringify({
      authenticated: false,
      ...base,
      error: `No usable auth for ${url}. Run: setup <pat> ${url}  (or set CAIDO_PAT / CAIDO_URL).`,
    }, null, 2));
    return;
  }

  const statusCache = new SecretsTokenCache(url);
  const pat = process.env.CAIDO_PAT || instance.pat || "";
  const client = new Client({ url, auth: { pat, cache: statusCache }, logger: QUIET_LOGGER });

  try {
    await client.connect({ ready: false });
    const viewer = await client.user.viewer();
    const health = await client.health();
    saveInstanceHealth(url, health);
    console.log(JSON.stringify({ authenticated: true, ...base, user: viewer, health }, null, 2));
  } catch (err: any) {
    console.log(JSON.stringify({ authenticated: false, ...base, error: err.message }, null, 2));
  }
}
