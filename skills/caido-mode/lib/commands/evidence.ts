/**
 * Evidence command: render a Caido-style Request/Response panel (dark theme,
 * syntax-highlighted) into a PNG, for use as evidence in pentest reports.
 *
 * Does NOT screenshot the real Caido UI (it requires interactive login, and we
 * never automate around that). Instead it takes the real raw bytes for a
 * request/response — same SDK call as `get`/`raw` — and renders them into a
 * lookalike HTML page, captured with headless Chrome via raw CDP (no Puppeteer
 * dependency: Node's built-in `WebSocket` talks to Chrome's DevTools protocol
 * directly). The exact content height comes from `Page.getLayoutMetrics`, so
 * unlike a fixed-viewport screenshot there is no guessing and no cropping.
 */

import { getClient } from "../client";
import { decodeRaw, splitRaw } from "../output";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface EvidenceOpts {
  out: string;
  notes: string[];
  width: number;
}

// ── HTTP message parsing ─────────────────────────────────────────────────

interface HttpMessage {
  firstLine: string;
  headers: { name: string; value: string }[];
  body: string;
}

function parseHttpMessage(decoded: string): HttpMessage {
  const { headerBlock, body } = splitRaw(decoded);
  const lines = headerBlock.split(/\r\n|\n/);
  const firstLine = lines[0] ?? "";
  const headers = lines.slice(1)
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const idx = l.indexOf(":");
      if (idx < 0) return { name: l.trim(), value: "" };
      return { name: l.slice(0, idx).trim(), value: l.slice(idx + 1).trim() };
    });
  return { firstLine, headers, body: (body ?? "").replace(/^\r?\n/, "").trimEnd() };
}

// ── HTML rendering (syntax highlighting) ─────────────────────────────────

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function statusClass(firstLine: string): string {
  const m = firstLine.match(/\b([1-5]\d{2})\b/);
  if (!m) return "proto";
  const code = m[1];
  if (code.startsWith("2") || code.startsWith("3")) return "status2xx";
  if (code.startsWith("4") || code.startsWith("5")) return "statuserr";
  return "proto";
}

function highlightJsonValue(value: string): string {
  let trailing = "";
  let v = value;
  if (v.endsWith(",")) { trailing = ","; v = v.slice(0, -1); }
  if (/^"(?:[^"\\]|\\.)*"$/.test(v)) return `<span class="str">${esc(v)}</span><span class="punct">${trailing}</span>`;
  if (["{", "[", "},", "],", "}", "]"].includes(v)) return `<span class="punct">${esc(v)}</span>`;
  if (/^-?\d+(\.\d+)?$/.test(v)) return `<span class="num">${esc(v)}</span><span class="punct">${trailing}</span>`;
  if (["true", "false", "null"].includes(v)) return `<span class="bool">${esc(v)}</span><span class="punct">${trailing}</span>`;
  return `${esc(v)}<span class="punct">${trailing}</span>`;
}

function highlightJsonLine(line: string): string {
  const indentMatch = line.match(/^(\s*)/)!;
  const indent = indentMatch[1];
  const rest = line.slice(indent.length);
  const m = rest.match(/^"((?:[^"\\]|\\.)*)"(\s*:\s*)(.*)$/);
  if (m) {
    const [, key, sep, value] = m;
    return `${indent}<span class="key">"${esc(key)}"</span>${esc(sep)}${highlightJsonValue(value)}`;
  }
  return `${indent}${highlightJsonValue(rest)}`;
}

function renderBodyLines(body: string): string[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const pretty = JSON.stringify(parsed, null, 2);
    return pretty.split("\n").map(highlightJsonLine);
  } catch {
    return trimmed.split("\n").map(esc);
  }
}

function renderHeaders(headers: { name: string; value: string }[]): string[] {
  return headers.map((h) => `<span class="hname">${esc(h.name)}:</span> <span class="hval">${esc(h.value)}</span>`);
}

function buildPane(
  title: string,
  msg: HttpMessage,
  firstLineClass: string,
  tabs: string[],
  notes?: string[],
): string {
  const lines: string[] = [];
  lines.push(`<span class="${firstLineClass}">${esc(msg.firstLine)}</span>`);
  lines.push(...renderHeaders(msg.headers));
  lines.push(""); // blank separator
  lines.push(...renderBodyLines(msg.body));
  if (notes && notes.length > 0) {
    lines.push("");
    for (const n of notes) lines.push(`<span class="comment">// ${esc(n)}</span>`);
  }

  const bodyHtml = lines
    .map((l) => (l ? `<div class="line">${l}</div>` : `<div class="line blank"></div>`))
    .join("\n");
  const tabsHtml = tabs.map((t, i) => `<span class="tab${i === 0 ? " active" : ""}">${t}</span>`).join("");

  return `
  <div class="pane">
    <div class="paneHeader"><span>${title}</span><span class="tabs">${tabsHtml}</span></div>
    <div class="code">${bodyHtml}</div>
  </div>`;
}

const CSS = `
* { box-sizing: border-box; }
body { margin:0; background:#1e1f22; font-family: 'Courier New', monospace; }
.topbar { display:flex; background:#1e1f22; }
.pane { width:810px; }
.pane + .pane { border-left:1px solid #34363b; }
.paneHeader { display:flex; justify-content:space-between; align-items:center;
  padding:10px 14px; color:#d4d4d8; font-family: Arial, sans-serif; font-size:13px;
  border-bottom:1px solid #34363b; background:#232428; }
.tabs { display:flex; gap:14px; }
.tab { color:#9a9ba1; font-size:12px; }
.tab.active { color:#fff; border-bottom:2px solid #e05252; padding-bottom:2px; }
.code { padding:14px; font-size:13px; line-height:1.55; counter-reset: line; color:#c9c9cc; }
.line { white-space:pre-wrap; word-break:break-all; }
.line::before { counter-increment: line; content: counter(line); display:inline-block;
  width:26px; color:#5a5c63; user-select:none; text-align:right; margin-right:10px; }
.method { color:#4fc1e9; font-weight:bold; }
.proto { color:#9a9ba1; }
.status2xx { color:#7ec699; font-weight:bold; }
.statuserr { color:#e0705a; font-weight:bold; }
.hname { color:#e0a05a; }
.hval { color:#c9c9cc; }
.str { color:#7ec699; }
.key { color:#e0a05a; }
.punct { color:#9a9ba1; }
.num { color:#c68adf; }
.bool { color:#4fc1e9; }
.comment { color:#5a5c63; font-style:italic; }
`;

function buildHtml(req: HttpMessage, resp: HttpMessage | undefined, notes: string[]): string {
  const reqPane = buildPane("Request", req, "method", ["Pretty", "Raw"]);
  const respPane = resp
    ? buildPane("Response", resp, statusClass(resp.firstLine), ["Pretty", "Raw", "Preview"], notes)
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div class="topbar">${reqPane}${respPane}</div></body></html>`;
}

// ── Minimal CDP client (no Puppeteer) ────────────────────────────────────

function findChrome(): string {
  const candidates = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const bin of candidates) {
    try {
      const path = execFileSync("which", [bin], { encoding: "utf-8" }).trim();
      if (path) return path;
    } catch { /* not found, try next */ }
  }
  throw new Error("No se encontró google-chrome/chromium en PATH — requerido para renderizar la evidencia.");
}

class CDP {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private eventWaiters: { method: string; sessionId?: string; resolve: (v: any) => void }[] = [];

  static async connect(wsUrl: string): Promise<CDP> {
    const cdp = new CDP();
    cdp.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      cdp.ws.addEventListener("open", () => resolve());
      cdp.ws.addEventListener("error", (e) => reject(e));
    });
    cdp.ws.addEventListener("message", (ev) => cdp.onMessage(String(ev.data)));
    return cdp;
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      this.eventWaiters = this.eventWaiters.filter((w) => {
        if (w.method === msg.method && (w.sessionId === undefined || w.sessionId === msg.sessionId)) {
          w.resolve(msg.params);
          return false;
        }
        return true;
      });
    }
  }

  send(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    const payload: Record<string, any> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  waitFor(method: string, sessionId?: string, timeoutMs = 15000): Promise<any> {
    return new Promise((resolve, reject) => {
      this.eventWaiters.push({ method, sessionId, resolve });
      setTimeout(() => reject(new Error(`Timeout esperando evento ${method}`)), timeoutMs);
    });
  }

  close() {
    this.ws.close();
  }
}

async function waitForDevToolsActivePort(userDataDir: string, timeoutMs = 10000): Promise<string> {
  const file = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const content = readFileSync(file, "utf-8").split("\n");
      const port = content[0]?.trim();
      const path = content[1]?.trim() || "";
      if (port) return `ws://127.0.0.1:${port}${path}`;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Chrome no expuso DevToolsActivePort a tiempo.");
}

/** Launch headless Chrome, render `html`, screenshot the FULL content height (no
 * guessing/cropping — reads the real layout size via CDP), write PNG to `outPath`. */
async function renderPng(html: string, outPath: string, width: number): Promise<void> {
  const chrome = findChrome();
  const userDataDir = mkdtempSync(join(tmpdir(), "caido-evidence-"));
  const htmlPath = join(userDataDir, "evidence.html");
  writeFileSync(htmlPath, html, "utf-8");

  const proc = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: "ignore" });

  try {
    const wsUrl = await waitForDevToolsActivePort(userDataDir);
    const browser = await CDP.connect(wsUrl);
    try {
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });

      await browser.send("Page.enable", {}, sessionId);
      // One override, generously tall, BEFORE navigation. Re-issuing this after
      // measuring content (to "shrink to fit") raced the compositor's repaint —
      // captureScreenshot then tiled the stale, smaller framebuffer to fill the
      // new clip instead of showing the real page. Render tall once; clip below
      // to the real measured height instead of resizing the viewport a second time.
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width, height: 4000, deviceScaleFactor: 1, mobile: false,
      }, sessionId);

      const loaded = browser.waitFor("Page.loadEventFired", sessionId);
      await browser.send("Page.navigate", { url: `file://${htmlPath}` }, sessionId);
      await loaded;

      // NOT Page.getLayoutMetrics().cssContentSize — when content is shorter than
      // the (deliberately tall) viewport, that reports the viewport height, not
      // the content's real height. getBoundingClientRect on the actual container
      // gives the true rendered box regardless of viewport size.
      const { result } = await browser.send("Runtime.evaluate", {
        expression: "document.querySelector('.topbar').getBoundingClientRect().height",
        returnByValue: true,
      }, sessionId);
      const height = Math.ceil((result?.value ?? 800) + 2);

      const { data } = await browser.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width, height, scale: 1 },
        captureBeyondViewport: true,
      }, sessionId);

      writeFileSync(outPath, Buffer.from(data, "base64"));
      await browser.send("Target.closeTarget", { targetId });
    } finally {
      browser.close();
    }
  } finally {
    // Chrome still holds files open for a moment after kill(); wait for the
    // process to actually exit before removing its profile dir, otherwise
    // rmSync races it (ENOTEMPTY) and — since this runs in the outer finally —
    // would mask a screenshot that was already written successfully.
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    // Chrome's helper processes (renderer/gpu/zygote) can outlive the killed
    // main process briefly and keep files open under the profile dir — retry
    // a few times before giving up (best-effort; a leftover temp dir is
    // harmless clutter, not a reason to fail a command that already succeeded).
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (attempt === 3) {
          console.error(`Aviso: no se pudo limpiar ${userDataDir}: ${(e as Error).message}`);
        } else {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
  }
}

// ── Command entry point ──────────────────────────────────────────────────

export async function cmdEvidence(requestId: string, opts: EvidenceOpts) {
  const client = await getClient();
  const result = await client.request.get(requestId, { raw: true });

  if (!result) {
    console.error(`Request ${requestId} not found`);
    process.exit(1);
  }
  if (!result.request.raw) {
    console.error(`No raw request data for request ${requestId}`);
    process.exit(1);
  }

  const req = parseHttpMessage(decodeRaw(result.request.raw));
  const resp = result.response?.raw ? parseHttpMessage(decodeRaw(result.response.raw)) : undefined;

  const html = buildHtml(req, resp, opts.notes);
  await renderPng(html, opts.out, opts.width);
  console.error(`Guardado: ${opts.out}`);
}
