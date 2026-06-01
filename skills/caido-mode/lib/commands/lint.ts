/**
 * lint — validate a raw HTTP/1.1 request file before sending it byte-exact
 * (e.g. `ncat --ssl host 443 < req.txt`, `openssl s_client`, or send-raw).
 *
 * Pure file validation — does NOT connect to Caido, so it works even when
 * Caido is down. Reads bytes 1:1 (latin1) so offsets == byte offsets and
 * Content-Length math is exact for arbitrary payloads.
 *
 * Exit codes: 0 = no errors (warnings allowed), 1 = errors found, 2 = usage/file error.
 * Designed for `lint req.txt && <send>` chaining — errors block the send.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

export interface LintIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  line?: number;
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Analyze raw request bytes (as a latin1 string, 1 char == 1 byte). */
export function lintRaw(text: string): { issues: LintIssue[] } {
  const issues: LintIssue[] = [];
  const err = (code: string, message: string, line?: number) =>
    issues.push({ level: "error", code, message, line });
  const warn = (code: string, message: string, line?: number) =>
    issues.push({ level: "warning", code, message, line });

  if (text.length === 0) {
    err("empty", "File is empty.");
    return { issues };
  }

  // Leading blank line(s) before the request line.
  if (text[0] === "\r" || text[0] === "\n") {
    err("leading-blank", "File starts with a blank line; the request line must come first.");
  }

  // Locate the header/body separator. Prefer CRLFCRLF; flag LF-only.
  const idxCrlf = text.indexOf("\r\n\r\n");
  const idxLf = text.indexOf("\n\n");
  let headerBlock: string;
  let body: string;
  let separatorOk = false;

  if (idxCrlf >= 0 && (idxLf < 0 || idxCrlf <= idxLf)) {
    headerBlock = text.slice(0, idxCrlf);
    body = text.slice(idxCrlf + 4);
    separatorOk = true;
  } else if (idxLf >= 0) {
    headerBlock = text.slice(0, idxLf);
    body = text.slice(idxLf + 2);
    err(
      "separator-lf",
      "Headers/body are separated by a bare LF (\\n\\n) instead of CRLF (\\r\\n\\r\\n).",
    );
  } else {
    // No blank line at all — request is not terminated.
    headerBlock = text.replace(/\r?\n$/, "");
    body = "";
    err(
      "no-terminator",
      "Request has no blank line terminating the headers. It must end the header block with \\r\\n\\r\\n.",
    );
  }

  // Split header block into lines on LF; each must have ended with CR (CRLF).
  const headerLines = headerBlock.split("\n");
  headerLines.forEach((ln, i) => {
    // The last element has no trailing \n in the source; before the separator
    // every line was \r\n-terminated, so it must end in \r here.
    const isLast = i === headerLines.length - 1;
    if (!isLast && !ln.endsWith("\r")) {
      err("bare-lf", `Header line ${i + 1} ends with a bare LF; use CRLF (\\r\\n).`, i + 1);
    }
  });

  // Strip trailing \r from each header line for parsing.
  const lines = headerLines.map((l) => l.replace(/\r$/, ""));
  const requestLine = lines[0] ?? "";

  // Request line: METHOD SP request-target SP HTTP/x.y
  const rlParts = requestLine.split(" ");
  if (rlParts.length !== 3) {
    err("request-line", `Malformed request line (expected "METHOD target HTTP/1.1"): "${requestLine}"`, 1);
  } else {
    const [method, , version] = rlParts;
    if (!/^[A-Z]+$/.test(method)) {
      warn("method-case", `Method "${method}" is not uppercase ASCII.`, 1);
    }
    const vm = /^HTTP\/(\d)\.(\d)$/.exec(version);
    if (!vm) {
      err("http-version", `Request line has no valid HTTP version: "${version}"`, 1);
    } else if (vm[1] === "2" || vm[1] === "3") {
      warn(
        "http2",
        `HTTP/${vm[1]} is not a line-based wire format; raw CRLF framing does not apply to it.`,
        1,
      );
    }
  }

  // Parse headers (everything after the request line).
  const headers: Array<{ name: string; value: string; line: number }> = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === "") continue;
    // obs-fold continuation (leading SP/HT) — legal-ish, just skip strict parse.
    if (raw[0] === " " || raw[0] === "\t") continue;
    const colon = raw.indexOf(":");
    if (colon <= 0) {
      err("header-syntax", `Header line ${i + 1} is missing a ":" name/value separator: "${raw}"`, i + 1);
      continue;
    }
    const name = raw.slice(0, colon);
    if (/\s/.test(name)) {
      err("header-name-ws", `Header name on line ${i + 1} contains whitespace: "${name}"`, i + 1);
    }
    headers.push({ name, value: raw.slice(colon + 1).replace(/^ /, ""), line: i + 1 });
  }

  const findHeaders = (n: string) =>
    headers.filter((h) => h.name.toLowerCase() === n.toLowerCase());

  // Host header (HTTP/1.1 requires exactly one).
  const hosts = findHeaders("host");
  if (hosts.length === 0) {
    warn("no-host", "No Host header (HTTP/1.1 requires one; some senders add it, raw sockets do not).");
  } else if (hosts.length > 1) {
    warn("dup-host", "Multiple Host headers present.");
  }

  // Content-Length vs actual body length (the classic foot-gun).
  const cls = findHeaders("content-length");
  const te = findHeaders("transfer-encoding");
  const bodyLen = body.length;

  if (cls.length > 1) {
    warn("dup-content-length", "Multiple Content-Length headers (request-smuggling vector — intentional?).");
  }
  if (te.length > 0 && cls.length > 0) {
    warn("te-and-cl", "Both Transfer-Encoding and Content-Length present (smuggling vector — intentional?).");
  }

  const method = rlParts[0];
  if (cls.length === 1 && te.length === 0) {
    const declared = parseInt(cls[0].value.trim(), 10);
    if (!Number.isFinite(declared)) {
      err("content-length-nan", `Content-Length value is not a number: "${cls[0].value}"`, cls[0].line);
    } else if (declared !== bodyLen) {
      err(
        "content-length-mismatch",
        `Content-Length is ${declared} but the actual body is ${bodyLen} bytes.`,
        cls[0].line,
      );
    }
  } else if (cls.length === 0 && te.length === 0 && bodyLen > 0 && BODY_METHODS.has(method)) {
    warn(
      "no-length",
      `Body is present (${bodyLen} bytes) but there is no Content-Length or Transfer-Encoding header.`,
    );
  } else if (cls.length === 0 && te.length === 0 && bodyLen > 0) {
    warn("body-no-length", `Body present (${bodyLen} bytes) on a ${method} request without Content-Length.`);
  }

  // Trailing-CRLF sanity for body-less requests.
  if (separatorOk && bodyLen === 0 && !text.endsWith("\r\n\r\n")) {
    warn("trailing", "Request appears body-less but does not end with \\r\\n\\r\\n.");
  }

  return { issues };
}

/** Produce a normalized copy: CRLF line endings, proper separator, recomputed Content-Length. */
export function fixRaw(text: string): { fixed: string; notes: string[] } {
  const notes: string[] = [];

  // Split headers/body on the first blank line (CRLF or LF).
  const idxCrlf = text.indexOf("\r\n\r\n");
  const idxLf = text.indexOf("\n\n");
  let headerBlock: string;
  let body: string;
  if (idxCrlf >= 0 && (idxLf < 0 || idxCrlf <= idxLf)) {
    headerBlock = text.slice(0, idxCrlf);
    body = text.slice(idxCrlf + 4);
  } else if (idxLf >= 0) {
    headerBlock = text.slice(0, idxLf);
    body = text.slice(idxLf + 2);
    notes.push("Converted LF header/body separator to CRLF.");
  } else {
    headerBlock = text.replace(/\r?\n+$/, "");
    body = "";
    notes.push("Added missing \\r\\n\\r\\n terminator.");
  }

  // Normalize every header line ending to CRLF.
  const rawLines = headerBlock.split(/\r?\n/);
  if (headerBlock.includes("\n") && !headerBlock.includes("\r\n")) {
    notes.push("Normalized bare-LF header lines to CRLF.");
  }
  let lines = rawLines.map((l) => l.replace(/\r$/, ""));

  // Recompute Content-Length unless smuggling indicators are present.
  const lowerHas = (re: RegExp) => lines.some((l) => re.test(l.toLowerCase()));
  const teChunked = lowerHas(/^transfer-encoding\s*:/);
  const clCount = lines.filter((l) => /^content-length\s*:/i.test(l)).length;
  if (clCount === 1 && !teChunked) {
    lines = lines.map((l) => {
      if (/^content-length\s*:/i.test(l)) {
        const fixed = `Content-Length: ${body.length}`;
        if (l.trim() !== fixed) notes.push(`Recomputed Content-Length to ${body.length}.`);
        return fixed;
      }
      return l;
    });
  } else if (clCount > 1 || teChunked) {
    notes.push("Left Content-Length/Transfer-Encoding untouched (possible smuggling test).");
  }

  const fixed = lines.join("\r\n") + "\r\n\r\n" + body;
  return { fixed, notes };
}

export async function cmdLint(
  file: string,
  opts: { fix: boolean; out?: string; json: boolean },
) {
  if (!existsSync(file)) {
    console.error(`Error: file not found: ${file}`);
    process.exit(2);
  }

  // latin1 keeps bytes 1:1 so length checks are byte-accurate.
  const text = readFileSync(file).toString("latin1");

  if (opts.fix) {
    const { fixed, notes } = fixRaw(text);
    const dest = opts.out ?? file;
    writeFileSync(dest, Buffer.from(fixed, "latin1"));
    const after = lintRaw(fixed).issues;
    const remaining = after.filter((i) => i.level === "error");
    if (opts.json) {
      console.log(JSON.stringify({ fixed: dest, notes, remainingErrors: after }, null, 2));
    } else {
      console.log(`Fixed → ${dest}`);
      for (const n of notes) console.log(`  • ${n}`);
      if (!notes.length) console.log("  • (no changes needed)");
      if (remaining.length) {
        console.log(`\n${remaining.length} error(s) remain after --fix:`);
        for (const i of remaining) console.log(`  ✗ [${i.code}] ${i.message}`);
      }
    }
    process.exit(remaining.length ? 1 : 0);
  }

  const { issues } = lintRaw(text);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  if (opts.json) {
    console.log(JSON.stringify({ ok: errors.length === 0, file, errors, warnings }, null, 2));
  } else {
    if (!issues.length) {
      console.log(`✓ ${file}: looks well-formed (${text.length} bytes).`);
    } else {
      for (const i of errors) console.log(`✗ [${i.code}] ${i.message}${i.line ? ` (line ${i.line})` : ""}`);
      for (const i of warnings) console.log(`⚠ [${i.code}] ${i.message}${i.line ? ` (line ${i.line})` : ""}`);
      console.log(
        `\n${errors.length} error(s), ${warnings.length} warning(s).` +
          (errors.length
            ? " Fix errors (or run with --fix), or send anyway if intentional."
            : " Warnings only — safe to send."),
      );
    }
  }

  process.exit(errors.length ? 1 : 0);
}
