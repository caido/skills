/** Info commands: viewer, plugins, health, setup, auth-status */

import { Client } from "@caido/sdk-client";
import {
  getClient, resolveProxy, resolveActiveUrl, readCaidoRoot, getCaidoInstance,
  upsertCaidoInstance, SecretsTokenCache, SECRETS_PATH, isCachedTokenValid, QUIET_LOGGER,
} from "../client";
import { PLUGIN_PACKAGES_QUERY } from "../graphql";

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
  console.log(JSON.stringify(health, null, 2));
}

export async function cmdSetup(pat: string, url: string, proxy?: string) {
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
  } catch (err: any) {
    console.error(`Failed to connect: ${err.message}`);
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
  console.log(`PAT: ${pat.slice(0, 12)}...`);
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
    await client.connect({ ready: { retries: 2, timeout: 3000, interval: 1000 } });
    const viewer = await client.user.viewer();
    const health = await client.health();
    console.log(JSON.stringify({ authenticated: true, ...base, user: viewer, health }, null, 2));
  } catch (err: any) {
    console.log(JSON.stringify({ authenticated: false, ...base, error: err.message }, null, 2));
  }
}
