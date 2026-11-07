// Benchmark-only instrumentation. Never records headers, bodies or credentials.
import { appendFileSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
if (process.env.CAIDO_BENCH_BASELINE_HOME) {
  os.homedir = () => process.env.CAIDO_BENCH_BASELINE_HOME;
  syncBuiltinESMExports();
}
const original = globalThis.fetch;
globalThis.fetch = async function (url, options) {
  const result = await original(url, options);
  if (process.env.CAIDO_BENCH_METRICS) {
    const path = new URL(typeof url === "string" ? url : url.url || url.href)
      .pathname;
    appendFileSync(
      process.env.CAIDO_BENCH_METRICS,
      JSON.stringify({
        path,
        introspection:
          typeof options?.body === "string" &&
          /__schema|__type\b/.test(options.body),
      }) + "\n",
    );
  }
  return result;
};
