import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { main } from "../caido-client.ts";
import { getGraph } from "../lib/capabilities.ts";

const baseline = process.env.CAIDO_BENCH_BASELINE;
if (!baseline || !process.env.CAIDO_TEST_URL || !process.env.CAIDO_CONFIG)
  throw new Error(
    "Set CAIDO_BENCH_BASELINE, CAIDO_TEST_URL and CAIDO_CONFIG for the isolated fixture",
  );
const count = Number(process.env.CAIDO_BENCH_SAMPLES || 30),
  dir = await mkdtemp(join(tmpdir(), "caido-mode-benchmark-"));
assert.ok(count >= 30);
const root = dirname(fileURLToPath(import.meta.url)),
  launcher = resolve(root, "../caido-client.ts");
const preloader = pathToFileURL(join(root, "metrics-preload.mjs")).href;
const require = createRequire(join(dirname(baseline), "package.json")),
  tsx = pathToFileURL(require.resolve("tsx")).href;
const baselineHome = join(dir, "baseline-home"),
  url = process.env.CAIDO_TEST_URL;
const cache = {
  accessToken: JSON.parse(await readFile(process.env.CAIDO_CONFIG, "utf8")).caido.instances[url].cachedToken.accessToken,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};
await mkdir(join(baselineHome, ".claude", "config"), { recursive: true });
await writeFile(
  join(baselineHome, ".claude", "config", "secrets.json"),
  JSON.stringify({
    caido: { default: url, instances: { [url]: { cachedToken: cache } } },
  }),
  { mode: 0o600 },
);
const responseDelayMs = Number(process.env.CAIDO_BENCH_DELAY || 50);
const origin = createServer((req, res) =>
  setTimeout(() => res.end("benchmark fixture"), responseDelayMs),
);
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
const port = origin.address().port;
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
assert.equal(process.env.CAIDO_URL, url);
const current = await (await getGraph()).query("currentProject", {}, "project {name}");
assert.equal(current?.project?.name, process.env.CAIDO_TEST_PROJECT || "caido-mode isolated fixtures");
async function cli(...args) {
  const lines = [], original = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  try { await main(args); } finally { console.log = original; }
  return JSON.parse(lines.join("\n"));
}
let sessionA, sessionB;
async function timed(tool, args, index) {
  const metrics = join(dir, `${tool}-${index}.jsonl`),
    env = {
      ...process.env,
      CAIDO_URL: url,
      CAIDO_BENCH_METRICS: metrics,
      NODE_OPTIONS: `--import=${preloader}`,
    };
  if (tool === "baseline") {
    env.CAIDO_BENCH_BASELINE_HOME = baselineHome;
    delete env.CAIDO_PAT;
    delete env.CAIDO_TOKEN;
  }
  const command = process.execPath;
  const argv =
    tool === "baseline"
      ? ["--import", tsx, baseline, ...args]
      : ["--import", "tsx", launcher, ...args];
  const start = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env, windowsHide: true });
    let stdout = "",
      stderr = "";
    const deadline = setTimeout(() => child.kill(), 20000);
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", (e) => {
      clearTimeout(deadline);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolve({ code, stdout, stderr });
    });
  });
  const ms = performance.now() - start;
  if (result.code !== 0)
    throw new Error(
      tool +
        " benchmark command failed/timed out (output received: " +
        !!result.stdout +
        "): " +
        result.stderr,
    );
  const calls = (await readFile(metrics, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  return {
    ms,
    calls: calls.length,
    introspection: calls.filter((c) => c.introspection).length,
  };
}
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const stats = (rows) => ({
  medianMs: percentile(
    rows.map((r) => r.ms),
    0.5,
  ),
  p95Ms: percentile(
    rows.map((r) => r.ms),
    0.95,
  ),
  maxApiCalls: Math.max(...rows.map((r) => r.calls)),
  introspectionCalls: rows.reduce((a, r) => a + r.introspection, 0),
});
try {
  const raw = join(dir, "request.txt");
  await writeFile(
    raw,
    `GET /bench HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
  );
  const initial = await cli(
    "send-raw",
    "--no-tls",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--raw",
    "@" + raw,
    "--name",
    "caido-mode benchmark A",
  );
  sessionA = initial.sessionId;
  const request = (await cli("search", `req.port.eq:${port}`)).results[0].id;
  sessionB = (
    await cli(
      "edit",
      request,
      "--path",
      "/bench",
      "--name",
      "caido-mode benchmark B",
    )
  ).sessionId;
  const cases = [
    ["health", ["health"], ["health"]],
    [
      "history",
      ["search", `req.port.eq:${port}`, "--limit", "5"],
      ["search", `req.port.eq:${port}`, "--limit", "5"],
    ],
    [
      "edit-replay",
      ["edit", request, "--session", sessionB, "--no-name-change", "--path", "/bench", "--compact"],
      [
        "edit",
        request,
        "--session",
        sessionA,
        "--no-name-change",
        "--path",
        "/bench",
        "--compact",
      ],
    ],
  ];
  const report = {
    samplesPerCase: count,
    mode: "fresh processes, cached auth/metadata, interleaved order",
    responseDelayMs,
    node: process.version,
    platform: process.platform,
    ...(process.env.CAIDO_BENCH_NOTE ? { note: process.env.CAIDO_BENCH_NOTE } : {}),
    cases: {},
  };
  for (const [name, ours, old] of cases) {
    const rows = { modified: [], baseline: [] },
      first = {};
    first.modified = await timed("modified", ours, name + "-first-new");
    first.baseline = await timed("baseline", old, name + "-first-old");
    for (let i = 0; i < count; i++) {
      const order = i % 2 ? ["baseline", "modified"] : ["modified", "baseline"];
      for (const tool of order)
        rows[tool].push(
          await timed(tool, tool === "baseline" ? old : ours, name + "-" + i),
        );
    }
    const current = stats(rows.modified),
      previous = stats(rows.baseline);
    const passed =
      current.medianMs <=
        previous.medianMs + Math.max(50, previous.medianMs * 0.1) &&
      current.p95Ms <= previous.p95Ms + Math.max(50, previous.p95Ms * 0.1) &&
      current.maxApiCalls <= previous.maxApiCalls &&
      current.introspectionCalls === 0;
    report.cases[name] = {
      firstCall: first,
      modified: current,
      upstream: previous,
      passed,
    };
    if (process.env.CAIDO_BENCH_OUTPUT)
      await writeFile(
        process.env.CAIDO_BENCH_OUTPUT,
        JSON.stringify(report, null, 2),
      );
    console.error(
      name +
        ": " +
        (passed ? "PASS" : "FAIL") +
        " median " +
        current.medianMs.toFixed(1) +
        " / " +
        previous.medianMs.toFixed(1) +
        " ms",
    );
  }
  report.passed = Object.values(report.cases).every((c) => c.passed);
  if (process.env.CAIDO_BENCH_OUTPUT)
    await writeFile(
      process.env.CAIDO_BENCH_OUTPUT,
      JSON.stringify(report, null, 2),
    );
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  if (sessionA) await cli("delete-sessions", sessionA);
  if (sessionB) await cli("delete-sessions", sessionB);
  origin.closeAllConnections();
  origin.close();
  await rm(dir, { recursive: true, force: true });
}
