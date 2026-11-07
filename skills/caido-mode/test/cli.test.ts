/** CLI guards run before authentication or a write to the selected instance. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { main } from "../caido-client.ts";
import { printResult } from "../lib/output.ts";

test("help works without an authenticated instance", async () => {
  const previous = console.log;
  const lines: string[] = [];
  console.log = value => lines.push(String(value));
  try {
    await main(["--help"]);
    assert.match(lines.join("\n"), /build-workflow/);
  } finally { console.log = previous; }
});

test("flag-like request bodies retain the original CLI behavior", async () => {
  const directory = await mkdtemp(join(tmpdir(), "caido-cli-"));
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    for (const body of ["-h", "--help", "--url", "--timeout=10"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "caido-client.ts", "edit", "1", "--name", "fixture", "--body", body], {
        cwd: root, encoding: "utf8",
        env: { ...process.env, CAIDO_CONFIG: join(directory, "missing.json"), CAIDO_PAT: "", CAIDO_URL: "http://fixture.invalid" },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /No Caido auth/);
      assert.equal(result.stdout, "");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the source entry works through a skill directory link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "caido-link-"));
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const link = join(directory, "skill");
  try {
    await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
    const result = spawnSync(process.execPath, ["--import", "tsx", join(link, "caido-client.ts"), "--help"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Caido SDK Client/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing values and IDs fail before command handlers run", async () => {
  await assert.rejects(() => main(["run-pipeline"]), /Session ID required/);
  await assert.rejects(() => main(["create-pipeline", "--requests", "1,2", "--name", "--strategy", "sequential"]), /--name requires a value/);
  await assert.rejects(() => main(["test-workflow", "--input", "--raw"]), /--input requires a value/);
});

test("output artifacts retain full results with a short stdout handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "caido-output-"));
  const path = join(directory, "result.json");
  const previous = console.log;
  const lines: string[] = [];
  console.log = value => lines.push(String(value));
  try {
    await printResult({ output: "abcdef" }, { output: path, maxBodyChars: 2 });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { output: "abcdef" });
    assert.deepEqual(JSON.parse(lines.join("\n")), { outputFile: path });
  } finally {
    console.log = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
