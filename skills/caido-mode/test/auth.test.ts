/** Authentication compatibility and the ordinary-command network budget. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "@caido/sdk-client";

const sandbox = mkdtempSync(join(tmpdir(), "caido-mode-auth-"));
const originalEnv = Object.fromEntries(
  ["CAIDO_CONFIG", "CAIDO_MODE_HOME", "CAIDO_URL", "CAIDO_PAT", "CAIDO_PROXY"].map((key) => [key, process.env[key]]),
);
process.env.CAIDO_CONFIG = join(sandbox, "secrets.json");
process.env.CAIDO_MODE_HOME = join(sandbox, "state");
delete process.env.CAIDO_URL;
delete process.env.CAIDO_PAT;
delete process.env.CAIDO_PROXY;

const auth = await import("../lib/client.ts");
const info = await import("../lib/commands/info.ts");
const state = await import("../lib/state.ts");
const fixtureUrl = "http://fixture.invalid:8080";
const otherUrl = "http://other.invalid:8080";
const validToken = { accessToken: "fixture-access-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

test("config override is optional and keeps the original default location", () => {
  assert.equal(auth.SECRETS_PATH, join(sandbox, "secrets.json"));
  const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const output = execFileSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    "import { SECRETS_PATH } from './lib/client.ts'; console.log(SECRETS_PATH);",
  ], { cwd: skillRoot, env: { ...process.env, CAIDO_CONFIG: "" }, encoding: "utf8" });
  assert.equal(output.trim(), join(homedir(), ".claude", "config", "secrets.json"));
});

test("legacy auth migrates without losing other services or instance credentials", () => {
  writeFileSync(auth.SECRETS_PATH, JSON.stringify({
    anotherService: { value: "preserve-me" },
    caido: { url: "HTTP://FIXTURE.INVALID:8080/", pat: "fixture-pat", cachedToken: validToken },
  }));
  assert.equal(auth.resolveActiveUrl(), fixtureUrl);
  assert.equal(auth.loadConfig().pat, "fixture-pat");
  auth.upsertCaidoInstance(otherUrl, { pat: "other-fixture-pat" });
  const stored = JSON.parse(readFileSync(auth.SECRETS_PATH, "utf8"));
  assert.deepEqual(stored.anotherService, { value: "preserve-me" });
  assert.equal(stored.caido.instances[fixtureUrl].cachedToken.accessToken, validToken.accessToken);
  assert.equal(stored.caido.instances[otherUrl].pat, "other-fixture-pat");
  assert.equal(stored.caido.default, fixtureUrl);
  if (process.platform !== "win32") assert.equal(statSync(auth.SECRETS_PATH).mode & 0o777, 0o600);
});

test("token cache isolates instances, canonicalizes clears and rejects expired auth", async () => {
  const fixtureCache = new auth.SecretsTokenCache("HTTP://FIXTURE.INVALID:8080/");
  const otherCache = new auth.SecretsTokenCache(otherUrl);
  await otherCache.save({ ...validToken, accessToken: "other-access-token" });
  assert.equal((await fixtureCache.load())?.accessToken, validToken.accessToken);
  await fixtureCache.clear();
  assert.equal(await fixtureCache.load(), undefined);
  assert.equal((await otherCache.load())?.accessToken, "other-access-token");
  auth.upsertCaidoInstance(fixtureUrl, {
    cachedToken: { accessToken: "expired-token", expiresAt: "2000-01-01T00:00:00.000Z" },
  });
  assert.equal(await new auth.SecretsTokenCache(fixtureUrl).load(), undefined);
  auth.upsertCaidoInstance(fixtureUrl, { cachedToken: validToken });
});

test("cached auth and version add zero startup calls; health explicitly refreshes metadata", async () => {
  state.saveInstanceHealth(fixtureUrl, { name: "fixture", version: "0.57.0", ready: true });
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = url.endsWith("/health")
      ? { name: "fixture", version: "0.58.0", ready: true }
      : { data: { viewer: { __typename: "GuestUser", id: "fixture-user" } } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const previousLog = console.log;
  try {
    const client = await auth.getClient();
    assert.deepEqual(calls, []);
    assert.equal(await client.version.get(), "0.57.0");
    assert.deepEqual(calls, []);
    assert.equal((await client.user.viewer())?.id, "fixture-user");
    assert.equal(calls.length, 1);
    assert.ok(calls.every((url) => !url.endsWith("/health")));
    console.log = () => {};
    await info.cmdHealth();
    assert.equal(calls.filter((url) => url.endsWith("/health")).length, 1);
    assert.equal(state.readKnownVersion(fixtureUrl), "0.58.0");
    const metadata = readFileSync(join(state.instanceSlot(fixtureUrl), "instance.json"), "utf8");
    assert.ok(!metadata.includes(validToken.accessToken));
    assert.ok(!metadata.includes("fixture-pat"));
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
  }
});

test("setup retains readiness validation, stores health and never prints PAT fragments", async () => {
  const pat = "setup-fixture-private-value";
  const previousConnect = Client.prototype.connect;
  const previousHealth = Client.prototype.health;
  const userPrototype = Object.getPrototypeOf(new Client({ url: fixtureUrl }).user);
  const previousViewer = userPrototype.viewer;
  const previousLog = console.log;
  const output: string[] = [];
  const options: unknown[] = [];
  Client.prototype.connect = async function (value) { options.push(value); };
  Client.prototype.health = async () => ({ name: "setup", version: "0.58.1", ready: true });
  userPrototype.viewer = async () => ({ id: "setup-user" });
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  try {
    await info.cmdSetup(pat, "HTTP://SETUP.INVALID:8080/");
    assert.deepEqual(options, [{ ready: { retries: 3, timeout: 5000, interval: 1000 } }]);
    assert.equal(state.readKnownVersion("http://setup.invalid:8080"), "0.58.1");
    assert.equal(auth.readCaidoRoot().default, "http://setup.invalid:8080");
    assert.equal(auth.getCaidoInstance(auth.readCaidoRoot(), "http://setup.invalid:8080").pat, pat);
    assert.ok(!output.join("\n").includes(pat));
    assert.ok(!output.join("\n").includes(pat.slice(0, 12)));
  } finally {
    Client.prototype.connect = previousConnect;
    Client.prototype.health = previousHealth;
    userPrototype.viewer = previousViewer;
    console.log = previousLog;
  }
});

test("setup failure redacts a PAT included in a connection error", async () => {
  const pat = "failed-setup-private-value";
  const previousConnect = Client.prototype.connect;
  const previousExit = process.exit;
  const previousLog = console.log;
  const previousError = console.error;
  const output: string[] = [];
  Client.prototype.connect = async () => { throw new Error(`Authentication failed for ${pat}`); };
  process.exit = (() => { throw new Error("fixture-exit"); }) as typeof process.exit;
  console.log = console.error = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  try {
    await assert.rejects(info.cmdSetup(pat, "http://failure.invalid:8080"), /fixture-exit/);
    assert.ok(output.join("\n").includes("[redacted]"));
    assert.ok(!output.join("\n").includes(pat));
    assert.ok(!output.join("\n").includes(pat.slice(0, 12)));
  } finally {
    Client.prototype.connect = previousConnect;
    process.exit = previousExit;
    console.log = previousLog;
    console.error = previousError;
  }
});
