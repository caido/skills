/**
 * Caido SDK client with URL-keyed (multi-instance) auth.
 *
 * Credentials live in ~/.claude/config/secrets.json under `.caido`, keyed by
 * instance URL so two Caido instances on one machine never clobber each other:
 *
 *   "caido": {
 *     "default": "http://localhost:8080",
 *     "instances": {
 *       "http://localhost:8080": { "pat": "...", "proxy": "...", "cachedToken": {...} },
 *       "http://localhost:8081": { "pat": "...", "cachedToken": {...} }
 *     }
 *   }
 *
 * Active instance = CAIDO_URL env → stored `default` → http://localhost:8080.
 * The legacy flat shape ({ url, pat, cachedToken, ... }) is migrated on read.
 */

import { Client, type TokenCache, type CachedToken } from "@caido/sdk-client";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

const SECRETS_PATH = join(homedir(), ".claude", "config", "secrets.json");
const DEFAULT_URL = "http://localhost:8080";

/**
 * Canonicalize an instance URL used as a storage key, so the same instance
 * referenced as `…:8080`, `…:8080/`, or with a differently-cased host all map
 * to one entry. Strips trailing slashes and lowercases the scheme+authority,
 * leaving any path untouched.
 */
export function canonicalUrl(u: string): string {
  const s = u.trim().replace(/\/+$/, "");
  return s.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+)/, (m) => m.toLowerCase());
}

export type AuthMode = "pat" | "cached-token";

export interface CaidoConfig {
  url: string;
  pat: string;         // empty string when authMode === "cached-token"
  authMode: AuthMode;
}

export interface CaidoInstance {
  pat?: string;
  proxy?: string;
  cachedToken?: CachedToken;
}

export interface CaidoRoot {
  default?: string;
  instances?: Record<string, CaidoInstance>;
}

/** Read the whole secrets.json (all services), tolerating a missing/corrupt file. */
function readSecretsFile(): Record<string, any> {
  if (!existsSync(SECRETS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, "utf-8")) || {};
  } catch {
    return {};
  }
}

/** Migrate the legacy flat `.caido` ({ url, pat, proxy, cachedToken, …dead keys }) to URL-keyed. */
function normalizeRoot(raw: any): CaidoRoot {
  if (!raw || typeof raw !== "object") return { instances: {} };
  if (raw.instances && typeof raw.instances === "object" && !Array.isArray(raw.instances)) {
    return { default: raw.default, instances: raw.instances };
  }

  const url = canonicalUrl(typeof raw.url === "string" ? raw.url : DEFAULT_URL);
  const inst: CaidoInstance = {};
  if (raw.pat) inst.pat = raw.pat;
  if (raw.proxy) inst.proxy = raw.proxy;
  if (raw.cachedToken?.accessToken) inst.cachedToken = raw.cachedToken;
  const hasAny = inst.pat || inst.proxy || inst.cachedToken;
  return { default: url, instances: hasAny ? { [url]: inst } : {} };
}

/** Read + normalize the `.caido` root from secrets.json. */
export function readCaidoRoot(): CaidoRoot {
  return normalizeRoot(readSecretsFile().caido);
}

/**
 * Persist the normalized `.caido` root, leaving other services' secrets intact.
 * Writes a temp file and renames it into place (atomic on the same filesystem) so a
 * concurrent reader/writer can never observe or persist a torn secrets.json — which
 * matters because the file is shared across services.
 */
function writeCaidoRoot(root: CaidoRoot): void {
  const dir = dirname(SECRETS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const secrets = readSecretsFile();
  secrets.caido = { default: root.default, instances: root.instances ?? {} };
  const tmp = `${SECRETS_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(secrets, null, 2));
  renameSync(tmp, SECRETS_PATH);
}

/** Create/merge one instance's config (and optionally make it the default/active one). */
export function upsertCaidoInstance(url: string, patch: Partial<CaidoInstance>, setDefault = false): void {
  const key = canonicalUrl(url);
  const root = readCaidoRoot();
  root.instances = root.instances ?? {};
  root.instances[key] = { ...root.instances[key], ...patch };
  if (setDefault || !root.default) root.default = key;
  writeCaidoRoot(root);
}

export function getCaidoInstance(root: CaidoRoot, url: string): CaidoInstance {
  return root.instances?.[canonicalUrl(url)] ?? {};
}

/** Active instance URL: CAIDO_URL env → stored default → localhost:8080. */
export function resolveActiveUrl(): string {
  if (process.env.CAIDO_URL) return canonicalUrl(process.env.CAIDO_URL);
  return readCaidoRoot().default || DEFAULT_URL;
}

export function isCachedTokenValid(instance: CaidoInstance): boolean {
  const t = instance.cachedToken;
  if (!t?.accessToken || !t.expiresAt) return false;
  const exp = Date.parse(t.expiresAt);
  return Number.isFinite(exp) && exp > Date.now();
}

/**
 * Resolve Caido's proxy listener for `curl -x` for the ACTIVE instance.
 * Caido's proxy and API share an address, so it defaults to the instance URL.
 * Precedence: CAIDO_PROXY env → instance.proxy → the instance URL.
 */
export function resolveProxy(): string {
  if (process.env.CAIDO_PROXY) return process.env.CAIDO_PROXY;
  const url = resolveActiveUrl();
  return getCaidoInstance(readCaidoRoot(), url).proxy || url;
}

/**
 * URL-keyed token cache: persists the access token under instances[url].cachedToken,
 * so concurrent/alternating instances on one machine never overwrite each other's auth.
 * Construct one per active URL.
 */
export class SecretsTokenCache implements TokenCache {
  private _cachedToken: CachedToken | null = null;
  constructor(private readonly url: string) {}

  async load(): Promise<CachedToken | undefined> {
    if (this._cachedToken) return this._cachedToken;
    const instance = getCaidoInstance(readCaidoRoot(), this.url);
    // Only hand back a still-valid token — never an expired one, so the SDK
    // falls through to PAT auth and re-mints instead of using a dead token.
    if (instance.cachedToken?.accessToken && isCachedTokenValid(instance)) {
      this._cachedToken = instance.cachedToken;
      return this._cachedToken;
    }
    return undefined;
  }

  async save(token: CachedToken): Promise<void> {
    this._cachedToken = token;
    upsertCaidoInstance(this.url, { cachedToken: token });
  }

  async clear(): Promise<void> {
    this._cachedToken = null;
    const root = readCaidoRoot();
    if (root.instances?.[this.url]) {
      delete root.instances[this.url].cachedToken;
      writeCaidoRoot(root);
    }
  }
}

export function loadConfig(): CaidoConfig {
  const url = resolveActiveUrl();
  const instance = getCaidoInstance(readCaidoRoot(), url);

  const envPat = process.env.CAIDO_PAT;
  if (envPat) return { url, pat: envPat, authMode: "pat" };
  if (instance.pat) return { url, pat: instance.pat, authMode: "pat" };
  if (isCachedTokenValid(instance)) return { url, pat: "", authMode: "cached-token" };

  if (instance.cachedToken?.accessToken) {
    console.error(`Error: Cached access token for ${url} expired at ${instance.cachedToken.expiresAt}.`);
    console.error(`Re-run: npx tsx caido-client.ts setup <pat> ${url}`);
  } else {
    console.error(`Error: No Caido auth found for instance ${url}.`);
    console.error("  - No PAT in env (CAIDO_PAT) or stored for this instance");
    console.error("  - No unexpired cached token for this instance");
    console.error("");
    console.error(`Setup: npx tsx caido-client.ts setup <pat> ${url}`);
    console.error(`(Select an instance with CAIDO_URL or the stored default.)`);
  }
  process.exit(1);
}

/**
 * Keep the SDK's chatter (e.g. "[caido] Loaded token from cache") off stdout so command
 * output stays pure JSON. Warnings/errors still surface on stderr.
 */
export const QUIET_LOGGER = {
  debug() {},
  info() {},
  warn: (message: string, ...args: unknown[]) => console.error(message, ...args),
  error: (message: string, ...args: unknown[]) => console.error(message, ...args),
};

let _client: Client | null = null;

export async function getClient(): Promise<Client> {
  if (_client) return _client;

  const config = loadConfig();
  const cache = new SecretsTokenCache(config.url);

  _client = new Client({
    url: config.url,
    auth: { pat: config.pat, cache },
    logger: QUIET_LOGGER,
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
