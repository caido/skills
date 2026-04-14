/** Caido SDK client singleton with SecretsTokenCache */

import { Client, type TokenCache, type CachedToken } from "@caido/sdk-client";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

const SECRETS_PATH = join(homedir(), ".claude", "config", "secrets.json");

export interface CaidoConfig {
  url: string;
  pat: string;
}

/**
 * Custom TokenCache that persists access tokens to secrets.json.
 * On first connect, the SDK exchanges the PAT for an access token via device code flow.
 * This cache saves the resulting token so subsequent runs skip the exchange.
 */
export class SecretsTokenCache implements TokenCache {
  private _cachedToken: CachedToken | null = null;

  async load(): Promise<CachedToken | undefined> {
    if (this._cachedToken) return this._cachedToken;
    try {
      if (existsSync(SECRETS_PATH)) {
        const secrets = JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
        if (secrets.caido?.cachedToken?.accessToken) {
          this._cachedToken = secrets.caido.cachedToken;
          return this._cachedToken!;
        }
      }
    } catch {}
    return undefined;
  }

  async save(token: CachedToken): Promise<void> {
    this._cachedToken = token;
    const dir = dirname(SECRETS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let secrets: Record<string, any> = {};
    try {
      if (existsSync(SECRETS_PATH)) {
        secrets = JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
      }
    } catch {}
    if (!secrets.caido) secrets.caido = {};
    secrets.caido.cachedToken = token;
    writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2));
  }

  async clear(): Promise<void> {
    this._cachedToken = null;
    try {
      if (existsSync(SECRETS_PATH)) {
        const secrets = JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
        if (secrets.caido) {
          delete secrets.caido.cachedToken;
          writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2));
        }
      }
    } catch {}
  }
}

export function loadConfig(): CaidoConfig {
  const url = process.env.CAIDO_URL || "http://localhost:8080";
  const pat = process.env.CAIDO_PAT;

  if (pat) return { url, pat };

  if (existsSync(SECRETS_PATH)) {
    try {
      const secrets = JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
      if (secrets.caido?.pat) {
        return { url: secrets.caido.url || url, pat: secrets.caido.pat };
      }
    } catch {}
  }

  console.error("Error: No Caido PAT found.\n");
  console.error("Setup:");
  console.error("  1. Open Caido → Settings → Developer → Personal Access Tokens");
  console.error("  2. Create a token");
  console.error("  3. Run: npx tsx caido-client.ts setup <token>");
  console.error("  Or set env var: export CAIDO_PAT=<token>");
  process.exit(1);
}

let _client: Client | null = null;
const _tokenCache = new SecretsTokenCache();

export async function getClient(): Promise<Client> {
  if (_client) return _client;

  const config = loadConfig();

  _client = new Client({
    url: config.url,
    auth: { pat: config.pat, cache: _tokenCache },
  });

  try {
    await _client.connect({ ready: { retries: 3, timeout: 5000, interval: 1000 } });
  } catch (err: any) {
    if (err.message?.includes("not ready")) {
      console.error("Error: Caido instance is not ready. Is Caido running?");
      console.error(`  Tried: ${config.url}`);
    } else {
      console.error(`Connection error: ${err.message}`);
    }
    process.exit(1);
  }

  return _client;
}

export { SECRETS_PATH };
