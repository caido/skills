/** Authentication compatibility and the ordinary-command network budget. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

function isolatedAuth(home: string, code: string, config = "") {
  const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  return execFileSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';
     os.homedir = () => process.env.CAIDO_AUTH_TEST_HOME; syncBuiltinESMExports();
     const auth = await import('./lib/client.ts');
     if (!auth.SECRETS_PATH.startsWith(process.env.CAIDO_AUTH_TEST_HOME)) throw new Error('Auth test escaped its sandbox');
     ${code}`,
  ], { cwd: skillRoot, env: { ...process.env, CAIDO_CONFIG: config, CAIDO_AUTH_TEST_HOME: home }, encoding: "utf8" }).trim();
}

test("config override is optional and defaults to the harness-independent location", () => {
  assert.equal(auth.SECRETS_PATH, join(sandbox, "secrets.json"));
  const home = join(sandbox, "empty-home");
  assert.equal(isolatedAuth(home, "console.log(auth.SECRETS_PATH);"), join(home, ".config", "caido", "secrets.json"));
});

test("legacy secrets fall back and migrate on write without losing existing services", () => {
  const home = join(sandbox, "legacy-home");
  const legacy = join(home, ".claude", "config", "secrets.json");
  const modern = join(home, ".config", "caido", "secrets.json");
  const secrets = { anotherService: { value: "preserve-me" }, caido: { url: fixtureUrl, pat: "legacy-fixture-pat" } };
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, JSON.stringify(secrets));
  const output = isolatedAuth(home, `console.log(JSON.stringify(auth.readCaidoRoot()));
    auth.upsertCaidoInstance('http://other.invalid:8080', {pat: 'other-fixture-pat'});`);
  assert.equal(JSON.parse(output).instances[fixtureUrl].pat, "legacy-fixture-pat");
  const migrated = JSON.parse(readFileSync(modern, "utf8"));
  assert.deepEqual(migrated.anotherService, secrets.anotherService);
  assert.equal(migrated.caido.instances[fixtureUrl].pat, "legacy-fixture-pat");
  assert.equal(migrated.caido.instances[otherUrl].pat, "other-fixture-pat");
  assert.deepEqual(JSON.parse(readFileSync(legacy, "utf8")), secrets);
});

test("modern secrets take precedence and an explicit missing config never falls back", () => {
  const home = join(sandbox, "precedence-home");
  for (const [path, pat] of [
    [join(home, ".claude", "config", "secrets.json"), "legacy-fixture-pat"],
    [join(home, ".config", "caido", "secrets.json"), "modern-fixture-pat"],
  ]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ caido: { url: fixtureUrl, pat } }));
  }
  const output = isolatedAuth(home, "console.log(JSON.stringify(auth.readCaidoRoot()));");
  assert.equal(JSON.parse(output).instances[fixtureUrl].pat, "modern-fixture-pat");
  const overridden = isolatedAuth(home, "console.log(JSON.stringify(auth.readCaidoRoot()));", join(home, "missing.json"));
  assert.deepEqual(JSON.parse(overridden).instances, {});
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
