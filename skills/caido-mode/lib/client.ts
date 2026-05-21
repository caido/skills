/** Caido SDK client singleton with SecretsTokenCache */

import { Client, type TokenCache, type CachedToken } from "@caido/sdk-client";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

const SECRETS_PATH = join(homedir(), ".claude", "config", "secrets.json");

export type AuthMode = "pat" | "cached-token";

export interface CaidoConfig {
  url: string;
  pat: string;         // empty string when authMode === "cached-token"
  authMode: AuthMode;
}

export interface CaidoSecrets {
  url?: string;
  pat?: string;
  cachedToken?: { accessToken?: string; expiresAt?: string };
}

function readCaidoSecrets(): CaidoSecrets {
  if (!existsSync(SECRETS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
    return (parsed?.caido ?? {}) as CaidoSecrets;
  } catch {
    return {};
  }
}

export function isCachedTokenValid(secrets: CaidoSecrets): boolean {
  const token = secrets.cachedToken;
  if (!token?.accessToken || !token.expiresAt) return false;
  const exp = Date.parse(token.expiresAt);
  return Number.isFinite(exp) && exp > Date.now();
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
  const envPat = process.env.CAIDO_PAT;

  if (envPat) return { url, pat: envPat, authMode: "pat" };

  const secrets = readCaidoSecrets();
  const resolvedUrl = secrets.url || url;

  if (secrets.pat) {
    return { url: resolvedUrl, pat: secrets.pat, authMode: "pat" };
  }

  const tokenValid = isCachedTokenValid(secrets);
  if (tokenValid) {
    return { url: resolvedUrl, pat: "", authMode: "cached-token" };
  }

  const hasExpired = !!secrets.cachedToken?.accessToken;
  if (hasExpired) {
    console.error(`Error: Cached access token expired at ${secrets.cachedToken?.expiresAt}.`);
    console.error("Re-run: npx tsx caido-client.ts setup <pat>");
  } else {
    console.error("Error: No Caido auth found.");
    console.error("  - No PAT in env (CAIDO_PAT) or secrets.json");
    console.error("  - No unexpired cached token in secrets.json");
    console.error("");
    console.error("Setup: npx tsx caido-client.ts setup <pat>");
  }
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
