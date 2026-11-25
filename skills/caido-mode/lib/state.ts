/** Non-secret, per-instance metadata. Credentials remain in the original secrets file. */
import { createHash, randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import type { Health, SemverLiteral } from "@caido/sdk-client";

export const stateHome = process.env.CAIDO_MODE_HOME || (platform() === "win32"
  ? join(process.env.LOCALAPPDATA || homedir(), "caido-mode")
  : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "caido-mode"));

export function instanceSlot(url: string): string {
  return join(stateHome, "instances", createHash("sha256").update(url).digest("hex").slice(0, 24));
}

export function readKnownVersion(url: string): SemverLiteral | undefined {
  try {
    const metadata = JSON.parse(readFileSync(join(instanceSlot(url), "instance.json"), "utf8")) as { version?: unknown };
    const version = metadata.version;
    return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version as SemverLiteral : undefined;
  }
  catch { return undefined; }
}

export function saveInstanceHealth(url: string, health: Health): void {
  const slot = instanceSlot(url);
  const path = join(slot, "instance.json");
  const previous = readKnownVersion(url);
  const tmp = path + "." + randomUUID() + ".tmp";
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(health), { mode: 0o600 });
    renameSync(tmp, path);
    if (previous && health.version && previous !== health.version) {
      for (const file of ["schema.json", "workflow-nodes.json"]) {
        try { unlinkSync(join(slot, file)); } catch { /* absent cache */ }
      }
    }
  } catch {
    try { unlinkSync(tmp); } catch { /* Optional cache. */ }
  }
}
