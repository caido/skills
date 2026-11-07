import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect as tcp } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { createSecureServer } from "node:http2";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { main } from "../caido-client";
import { getGraph } from "../lib/capabilities.ts";
import { getClient } from "../lib/client.ts";

const enabled = !!process.env.CAIDO_TEST_URL;
const live = (name, fn) =>
  test(name, { skip: !enabled, timeout: 15000 }, async () => {
    try {
      await fn();
    } catch (e) {
      console.error(name + ": " + e.stack);
      throw e;
    }
  });
let dir,
  origin,
  port,
  requestId,
  sessionId,
  workflowId,
  mrCollection,
  mrRule,
  automateId,
  pipelineId,
  ctx;
const seen = [],
  sockets = new Set();
async function file(name, value) {
  const p = join(dir, name);
  await writeFile(p, typeof value === "string" ? value : JSON.stringify(value));
  return "@" + p;
}
async function cli(...args) {
  const lines = [], original = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  try { await main(args); } finally { console.log = original; }
  return JSON.parse(lines.join("\n"));
}
function interceptOptions(value) {
  const { status, ...options } = value;
  return options;
}
async function until(fn, predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  let r;
  while (Date.now() < end) {
    r = await fn();
    if (predicate(r)) return r;
    await sleep(50);
  }
  assert.fail("Timed out: " + JSON.stringify(r));
}
before(async () => {
  if (!enabled) return;
  dir = await mkdtemp(join(tmpdir(), "caido-mode-test-"));
  assert.ok(["127.0.0.1", "[::1]", "localhost"].includes(new URL(process.env.CAIDO_TEST_URL).hostname), "Tests require a loopback instance");
  assert.equal(process.env.CAIDO_URL, process.env.CAIDO_TEST_URL, "Explicitly select the isolated test instance");
  ctx = await getClient();
  const selected = await (
    await getGraph(ctx)
  ).query("currentProject", {}, "project {name}");
  assert.equal(
    selected?.project?.name,
    process.env.CAIDO_TEST_PROJECT || "caido-mode isolated fixtures",
    "Live mutation tests require an explicitly selected disposable fixture project",
  );
  origin = createServer(async (req, res) => {
    seen.push({ path: req.url, headers: req.headers });
    res.setHeader("Content-Type", "text/plain");
    res.end(req.url);
  });
  origin.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  origin.on("upgrade", (req, socket) => {
    const accept = createHash("sha1")
      .update(
        req.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    socket.on("data", (data) => {
      if (data[0] === 0x88) {
        socket.end();
        return;
      }
      if (data.length >= 8) {
        const len = data[1] & 127,
          mask = data.subarray(2, 6),
          body = Buffer.from(data.subarray(6, 6 + len));
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        socket.write(
          Buffer.concat([Buffer.from([data[0], body.length]), body]),
        );
      }
    });
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  port = origin.address().port;
});
after(async () => {
  if (!enabled) return;
  const cleanup = [];
  if (pipelineId) cleanup.push(["delete-pipeline", pipelineId]);
  if (automateId) cleanup.push(["delete-automate-session", automateId]);
  if (mrRule) cleanup.push(["delete-mr-rule", mrRule]);
  if (mrCollection) cleanup.push(["delete-mr-collection", mrCollection]);
  if (workflowId) cleanup.push(["delete-workflow", workflowId]);
  if (sessionId) cleanup.push(["delete-sessions", sessionId]);
  const errors = [];
  for (const args of cleanup) {
    try { await cli(...args); } catch (error) { errors.push(error); }
  }
  for (const s of sockets) s.destroy();
  origin.closeAllConnections();
  origin.close();
  await rm(dir, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
});
live(
  "native send/edit/history retain auth and recover request IDs",
  async () => {
    const raw = await file(
      "request.txt",
      `GET /FUZZ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: fixture-only\r\nConnection: close\r\n\r\n`,
    );
    const sent = await cli(
      "send-raw",
      "--no-tls",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--raw",
      raw,
      "--name",
      "caido-mode fixture",
    );
    sessionId = sent.sessionId;
    assert.equal(sent.status, "DONE");
    const found = await cli("search", `req.port.eq:${port}`, "--desc");
    assert.ok(found.results.length);
    requestId = found.results[0].id;
    const edit = await cli(
      "edit",
      requestId,
      "--session",
      sessionId,
      "--no-name-change",
      "--path",
      "/edited",
    );
    assert.equal(edit.status, "DONE");
    assert.ok(
      seen.some(
        (s) =>
          s.path === "/edited" && s.headers.authorization === "fixture-only",
      ),
    );
  },
);
live(
  "workflow build/test/create/run/update/delete use real engine",
  async () => {
    const built = await cli(
      "build-workflow",
      "--name",
      "caido-mode uppercase",
      "--kind",
      "convert",
      "--code",
      "export function run({data},sdk){return sdk.asString(data).toUpperCase();}",
    );
    const spec = await file("workflow.json", built);
    assert.equal(
      (await cli("test-workflow", "--input", spec, "--data", "hello"))
        .output,
      "HELLO",
    );
    const made = await cli("create-workflow", "--input", spec);
    workflowId = made.id;
    assert.equal(made.enabled, false);
    assert.equal(
      (await cli("run-workflow", workflowId, "--data", "hello")).output,
      "HELLO",
    );
    built.name += " updated";
    await cli(
      "update-workflow",
      workflowId,
      "--input",
      await file("workflow2.json", built),
    );
    assert.match((await cli("get-workflow", workflowId)).name, /updated/);
  },
);
live(
  "convert workflow test/run preserve binary output",
  async () => {
    const definition = await cli("build-workflow", "--name", "caido-mode binary", "--code",
      "export function run(){return {data:new Uint8Array([0,255,128,65])};}");
    const input = await file("binary-workflow.json", definition);
    const expected = Buffer.from([0, 255, 128, 65]);
    const tested = await cli("test-workflow", "--input", input, "--data", "ignored", "--raw");
    assert.deepEqual(Buffer.from(tested.output.data, "base64"), expected);
    let id;
    try {
      id = (await cli("create-workflow", "--input", input)).id;
      const result = await cli("run-workflow", id, "--data", "ignored", "--raw");
      assert.deepEqual(Buffer.from(result.output.data, "base64"), expected);
    } finally {
      if (id) await cli("delete-workflow", id);
    }
  },
);
live(
  "active and passive workflows can be authored and engine-tested",
  async () => {
    for (const kind of ["active", "passive"]) {
      const built = await cli(
        "build-workflow",
        "--name",
        "caido-mode " + kind,
        "--kind",
        kind,
        "--code",
        "export function run({request}){return {data:request.getPath()};}",
      );
      const r = await cli(
        "test-workflow",
        "--input",
        await file(kind + ".json", built),
        "--request-id",
        requestId,
      );
      assert.equal(r.tested, true);
    }
  },
);
live(
  "M&R preview plus scoped enabled rule transforms only fixture replay",
  async () => {
    const raw = await file(
      "preview.txt",
      `GET / HTTP/1.1\r\nHost: example.invalid\r\n\r\n`,
    );
    const preview = await cli(
      "test-mr-rule",
      "--section",
      "req-header",
      "--operation",
      "add",
      "--match-name",
      "X-Fixture",
      "--replace",
      "yes",
      "--raw",
      raw,
    );
    assert.match(preview.result, /X-Fixture: yes/i);
    const collection = await cli("create-mr-collection", "caido-mode fixture");
    mrCollection = collection.id;
    const rule = await cli(
      "create-mr-rule",
      "--collection",
      mrCollection,
      "--name",
      "caido-mode fixture header",
      "--section",
      "req-header",
      "--operation",
      "add",
      "--match-name",
      "X-Fixture",
      "--replace",
      "yes",
      "--condition",
      `req.port.eq:${port}`,
      "--sources",
      "REPLAY",
    );
    mrRule = rule.created.id;
    await cli("toggle-mr-rule", mrRule, "--on");
    await cli("edit", requestId, "--session", sessionId, "--no-name-change");
    assert.equal(seen.at(-1).headers["x-fixture"], "yes");
    await cli("toggle-mr-rule", mrRule, "--off");
  },
);
live(
  "Automate configures payloads without UI and returns bounded results",
  async () => {
    const made = await cli(
      "create-automate-session",
      requestId,
      "--name",
      "caido-mode payloads",
    );
    automateId = made.id;
    await cli(
      "configure-automate-session",
      automateId,
      "--match",
      "FUZZ",
      "--payloads",
      await file("payloads.json", ["one", "two"]),
    );
    await cli("start-automate-task", automateId);
    await until(
      async () => seen.map((x) => x.path),
      (r) => r.includes("/one") && r.includes("/two"),
    );
    const results = await cli("automate-results", automateId);
    assert.ok(results.entries.length);
  },
);
live(
  "Automate payload configuration preserves custom SNI",
  async () => {
    const g = await getGraph(ctx);
    const session = await g.query("automateSession", { id: automateId }, "raw connection {host port isTLS SNI}");
    const { automateSettings } = await import("../lib/commands/automate");
    await g.mutation("updateAutomateSession", { id: automateId, input: {
      raw: session.raw,
      connection: { ...session.connection, SNI: "fixture-sni.invalid" },
      settings: automateSettings(Buffer.from(session.raw, "base64"), "FUZZ", ["one", "two"]),
    } }, "session {id}");
    await cli("configure-automate-session", automateId, "--match", "FUZZ", "--payloads", await file("sni-payloads.json", ["one", "two"]));
    assert.equal((await cli("get-automate-session", automateId)).connection.SNI, "fixture-sni.invalid");
  },
);
live(
  "native sequential and last-byte pipelines execute fixture requests",
  async () => {
    await assert.rejects(() => cli("delete-pipeline", sessionId), /HTTP pipeline .* not found/);
    assert.equal((await cli("get-session", sessionId)).id, sessionId);
    for (const strategy of ["sequential", "last-byte"]) {
      const made = await cli(
        "create-pipeline",
        "--requests",
        requestId + "," + requestId,
        "--name",
        "caido-mode " + strategy,
        "--strategy",
        strategy,
      );
      pipelineId = made.session.id;
      const before = seen.length;
      await cli("run-pipeline", pipelineId);
      await until(
        async () => seen.length,
        (n) => n >= before + 2,
      );
      const result = await cli("get-pipeline", pipelineId);
      assert.equal(result.id, pipelineId);
      const tabs = await cli("sessions", "--limit", "100");
      assert.ok(tabs.results.some((s) => s.id === pipelineId));
      assert.equal((await cli("get-session", pipelineId)).id, pipelineId);
      await cli(
        "rename-session",
        pipelineId,
        "caido-mode renamed " + strategy,
      );
      await cli("delete-pipeline", pipelineId);
      pipelineId = undefined;
    }
  },
);
live(
  "native pipelines accept named Replay collections",
  async () => {
    const collection = await cli("create-collection", "caido-mode pipeline collection");
    let id;
    try {
      id = (await cli("create-pipeline", "--requests", requestId + "," + requestId,
        "--name", "caido-mode named collection", "--collection", collection.name)).session.id;
      assert.equal((await cli("get-session", id)).collectionId, collection.id);
    } finally {
      if (id) await cli("delete-pipeline", id);
      await cli("delete-collection", collection.id);
    }
  },
);
live(
  "WebSocket history captures direction and exact frame payload",
  async () => {
    const target = new URL(process.env.CAIDO_TEST_URL);
    const socket = tcp({ host: target.hostname, port: Number(target.port) });
    const key = randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0),
      upgraded = false;
    const done = new Promise((resolve, reject) => {
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded && buffer.includes("\r\n\r\n")) {
          assert.match(buffer.toString(), /101/);
          upgraded = true;
          const body = Buffer.from("fixture"),
            mask = Buffer.from([1, 2, 3, 4]),
            masked = Buffer.from(body.map((b, i) => b ^ mask[i % 4]));
          socket.write(
            Buffer.concat([
              Buffer.from([0x81, 0x80 | body.length]),
              mask,
              masked,
            ]),
          );
          buffer = Buffer.alloc(0);
        } else if (upgraded && buffer.length >= 9) {
          socket.end();
          resolve();
        }
      });
    });
    socket.write(
      `GET http://127.0.0.1:${port}/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await done;
    const streams = await until(
      () => cli("streams"),
      (r) => r.items.some((s) => s.port === port),
    );
    const stream = streams.items.find((s) => s.port === port);
    const messages = await until(
      () => cli("ws-messages", stream.id, "--raw"),
      (r) => r.items.length >= 2,
    );
    assert.ok(
      messages.items.some(
        (m) => Buffer.from(m.head.raw.data, "base64").toString() === "fixture",
      ),
    );
    const single = await cli("get-ws-message", messages.items[0].id, "--raw");
    assert.equal(single.id, messages.items[0].id);
  },
);

live(
  "Intercept edits/forwards and drops exact queue IDs, restoring settings",
  async () => {
    const before = await cli("intercept-status");
    const proxy = new URL(process.env.CAIDO_TEST_URL);
    const pending = [];
    const send = (path) => {
      let req;
      const done = new Promise((resolve) => {
        req = httpRequest(
          {
            host: proxy.hostname,
            port: Number(proxy.port),
            path: `http://127.0.0.1:${port}${path}`,
            headers: { Host: `127.0.0.1:${port}` },
          },
          (res) => {
            let body = "";
            res.on("data", (b) => (body += b));
            res.on("end", () => resolve({ code: res.statusCode, body }));
          },
        );
        req.on("error", (e) => resolve({ error: e.message }));
        req.end();
      });
      pending.push(req);
      return done;
    };
    try {
      await cli(
        "set-intercept-options",
        "--input",
        await file("queue.json", {
          request: {
            enabled: true,
            filter: { HTTPQL: { code: `req.port.eq:${port}` } },
          },
          response: { enabled: false },
          streamWs: { enabled: false },
        }),
      );
      await cli("intercept-enable");
      const a = send("/queued");
      const queue = await until(
        () => cli("intercept-messages"),
        (r) => r.items.some((x) => x.request?.path === "/queued"),
      );
      const item = queue.items.find((x) => x.request?.path === "/queued");
      const got = await cli("get-intercept-message", item.id);
      assert.equal(got.id, item.id);
      await cli(
        "forward-intercept-message",
        item.id,
        "--kind",
        "request",
        "--raw",
        await file(
          "forward.txt",
          `GET /forwarded HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
        ),
      );
      assert.equal((await a).body, "/forwarded");
      const b = send("/dropped");
      const second = await until(
        () => cli("intercept-messages"),
        (r) => r.items.some((x) => x.request?.path === "/dropped"),
      );
      await cli(
        "drop-intercept-message",
        second.items.find((x) => x.request?.path === "/dropped").id,
      );
      await b;
      assert.ok(!seen.some((x) => x.path === "/dropped"));
      await cli(
        "set-intercept-options",
        "--input",
        await file("response-queue.json", {
          request: { enabled: false },
          response: {
            enabled: true,
            filter: { HTTPQL: { code: `req.port.eq:${port}` } },
          },
        }),
      );
      const response = send("/response-queued");
      const responses = await until(
        () => cli("intercept-messages", "--kind", "response"),
        (r) => r.items.length > 0,
      );
      const responseId = responses.items[0].id;
      assert.equal(
        (await cli("get-intercept-message", responseId, "--kind", "response")).id,
        responseId,
      );
      await cli(
        "forward-intercept-message",
        responseId,
        "--kind",
        "response",
        "--raw",
        await file(
          "response-edit.txt",
          "HTTP/1.1 202 Accepted\r\nContent-Length: 7\r\nConnection: close\r\n\r\nchanged",
        ),
      );
      assert.deepEqual(await response, { code: 202, body: "changed" });
    } finally {
      for (const req of pending) req.destroy();
      const saved = structuredClone(interceptOptions(before));
      for (const key of ["request", "response"])
        if (saved[key].filter) {
          const f = saved[key].filter;
          saved[key].filter = {
            [f.__typename === "HTTPQL" ? "HTTPQL" : "streamQL"]: {
              code: f.code,
            },
          };
        }
      await cli(
        "set-intercept-options",
        "--input",
        await file("restore.json", saved),
      );
      await cli(before.status === "RUNNING" ? "intercept-disable" : "intercept-enable");
    }
    assert.deepEqual(
      interceptOptions(await cli("intercept-status")),
      interceptOptions(before),
    );
  },
);

live(
  "Intercept forwards edited binary WebSocket frames without changing bytes",
  async () => {
    const before = await cli("intercept-status"),
      proxy = new URL(process.env.CAIDO_TEST_URL),
      socket = tcp({ host: proxy.hostname, port: Number(proxy.port) });
    const original = Buffer.from([1, 2, 3]),
      replacement = Buffer.from([0, 255, 65]);
    let upgraded = false,
      buffer = Buffer.alloc(0);
    const received = new Promise((resolve, reject) => {
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded && buffer.includes("\r\n\r\n")) {
          upgraded = true;
          buffer = Buffer.alloc(0);
          const mask = Buffer.from([1, 2, 3, 4]);
          socket.write(
            Buffer.concat([
              Buffer.from([0x82, 0x80 | original.length]),
              mask,
              Buffer.from(original.map((b, i) => b ^ mask[i % 4])),
            ]),
          );
        } else if (upgraded && buffer.length >= 5)
          resolve(buffer.subarray(2, 5));
      });
    });
    try {
      await cli(
        "set-intercept-options",
        "--input",
        await file("ws-queue.json", {
          request: { enabled: false },
          response: { enabled: false },
          streamWs: { enabled: true },
        }),
      );
      await cli("intercept-enable");
      socket.write(
        `GET http://127.0.0.1:${port}/ws-intercept HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      const first = await until(
        () => cli("intercept-messages", "--kind", "stream_ws"),
        (r) => r.items.length > 0,
      );
      const id = first.items[0].id,
        got = await cli("get-intercept-message", id, "--kind", "stream_ws");
      assert.ok(
        Buffer.from(got.message.head.raw.data, "base64").equals(original),
      );
      const changed = join(dir, "frame.bin");
      await writeFile(changed, replacement);
      await cli(
        "forward-intercept-message",
        id,
        "--kind",
        "ws",
        "--raw",
        "@" + changed,
      );
      const second = await until(
        () => cli("intercept-messages", "--kind", "stream_ws"),
        (r) => r.items.some((x) => x.id !== id),
      );
      await cli(
        "forward-intercept-message",
        second.items.find((x) => x.id !== id).id,
      );
      assert.ok((await received).equals(replacement));
    } finally {
      socket.destroy();
      const saved = structuredClone(interceptOptions(before));
      for (const key of ["request", "response"])
        if (saved[key].filter) {
          const f = saved[key].filter;
          saved[key].filter = {
            [f.__typename === "HTTPQL" ? "HTTPQL" : "streamQL"]: {
              code: f.code,
            },
          };
        }
      await cli(
        "set-intercept-options",
        "--input",
        await file("ws-restore.json", saved),
      );
      await cli(before.status === "RUNNING" ? "intercept-disable" : "intercept-enable");
    }
  },
);

live(
  "Automate start enforces actual settings budget and cancellation stops owned task",
  async () => {
    await cli(
      "configure-automate-session",
      automateId,
      "--match",
      "FUZZ",
      "--payloads",
      await file(
        "many.json",
        Array.from({ length: 30 }, (_, i) => "cancel-" + i),
      ),
      "--delay",
      "200",
    );
    await assert.rejects(
      () => cli("start-automate-task", automateId, "--max-requests", "2"),
      /budget/,
    );
    const task = await cli("start-automate-task", automateId);
    const taskId = task.automateTask.id;
    await cli("pause-automate-task", taskId);
    await cli("resume-automate-task", taskId);
    await cli("cancel-automate-task", taskId);
    const count = seen.filter((x) => x.path.startsWith("/cancel-")).length;
    await sleep(400);
    assert.equal(
      seen.filter((x) => x.path.startsWith("/cancel-")).length,
      count,
    );
    assert.ok(count < 30);
  },
);

live(
  "single-packet strategy uses native HTTP/2 pipeline on one connection",
  async () => {
    const openssl = process.env.CAIDO_TEST_OPENSSL || "openssl";
    const key = join(dir, "h2-key.pem"),
      cert = join(dir, "h2-cert.pem");
    execFileSync(
      openssl,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const receiver = createSecureServer({
        key: readFileSync(key),
        cert: readFileSync(cert),
      }),
      sessions = new Set(),
      streams = [];
    receiver.on("session", (s) => {
      sessions.add(s);
      s.on("error", () => {});
    });
    receiver.on("stream", (s, headers) => {
      streams.push({
        session: s.session,
        path: headers[":path"],
        time: process.hrtime.bigint(),
      });
      s.respond({ ":status": 200 });
      s.end("h2 fixture");
    });
    await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
    const h2port = receiver.address().port,
      g = await getGraph(ctx);
    const settings = await g.query("instanceSettings", {}, "network {stack}");
    let initial, pipe;
    try {
      await g.mutation(
        "setInstanceSettings",
        { input: { network: { stack: "V2" } } },
        "__typename",
      );
      const sent = await cli(
        "send-raw",
        "--host",
        "127.0.0.1",
        "--port",
        String(h2port),
        "--tls",
        "--raw",
        await file(
          "h2.txt",
          `GET /h2 HTTP/1.1\r\nHost: localhost:${h2port}\r\n\r\n`,
        ),
        "--name",
        "caido-mode h2 baseline",
      );
      initial = sent.sessionId;
      assert.equal(sent.status, "DONE");
      const found = await cli("search", `req.port.eq:${h2port}`);
      const id = found.results[0].id;
      const made = await cli(
        "create-pipeline",
        "--requests",
        id + "," + id,
        "--name",
        "caido-mode single packet",
        "--strategy",
        "single-packet",
      );
      pipe = made.session.id;
      const before = streams.length;
      await cli("run-pipeline", pipe);
      await until(
        async () => streams.length,
        (n) => n >= before + 2,
      );
      const pair = streams.slice(-2);
      assert.equal(pair[0].session, pair[1].session);
      const result = await cli("get-pipeline", pipe);
      assert.ok(
        JSON.stringify(result).includes("PipelineStrategySinglePacketAttack"),
      );
    } finally {
      if (pipe) await cli("delete-pipeline", pipe);
      if (initial) await cli("delete-sessions", initial);
      await g.mutation(
        "setInstanceSettings",
        { input: { network: { stack: settings.network.stack } } },
        "__typename",
      );
      for (const s of sessions) s.destroy();
      receiver.close();
    }
  },
);

live("original management commands retain SDK compatibility", async () => {
  const project = await cli("create-project", "caido-mode disposable " + port, "--temporary");
  try {
    assert.ok((await cli("projects")).some(p => p.id === project.id));
    await cli("rename-project", project.id, "caido-mode updated project");
    assert.equal((await cli("get-project", project.id)).name, "caido-mode updated project");
  } finally { await cli("delete-project", project.id); }
  const scope = await cli("create-scope", "caido-mode fixture scope", "--allow", "fixture.invalid");
  try {
    await cli("update-scope", scope.id, "--name", "caido-mode updated scope");
    assert.ok((await cli("scopes")).some(s => s.id === scope.id && s.name.includes("updated")));
  } finally { await cli("delete-scope", scope.id); }
  const filter = await cli("create-filter", "caido-mode fixture filter", "--query", 'req.host.eq:"fixture.invalid"');
  try {
    await cli("update-filter", filter.id, "--name", "caido-mode updated filter");
    assert.ok((await cli("filters")).some(f => f.id === filter.id && f.name.includes("updated")));
  } finally { await cli("delete-filter", filter.id); }
  const env = await cli("create-env", "caido-mode fixture environment");
  try {
    await cli("env-set", env.id, "fixture", "one");
    await cli("env-set", env.id, "fixture", "two");
    assert.ok((await cli("envs")).some(e => e.id === env.id));
  } finally { await cli("delete-env", env.id); }
  const finding = await cli("create-finding", requestId, "--title", "caido-mode fixture finding", "--reporter", "caido-mode-test");
  try {
    await cli("update-finding", finding.id, "--title", "caido-mode updated finding");
    assert.equal((await cli("get-finding", finding.id)).title, "caido-mode updated finding");
  } finally { await ctx.finding.delete({ids:[finding.id]}); }
});

live("workflow engine failures never report success", async () => {
  for (const kind of ["convert", "active", "passive"]) {
    const definition = await cli("build-workflow", "--name", "negative fixture", "--kind", kind, "--code", "export function run(){throw new Error('fixture-fail')}");
    const filePath = await file("negative-" + kind + ".json", definition);
    await assert.rejects(() => cli("test-workflow", "--input", filePath, "--data", "fixture", "--request-id", requestId), /fixture-fail/);
  }
});
