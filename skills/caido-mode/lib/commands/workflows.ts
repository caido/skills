/** Workflow authoring, engine tests and saved workflow management. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Workflow, ConnectionInfoInput } from "@caido/sdk-client";
import { getClient } from "../client";
import { getGraph, fail, integer, jsonFile, type Graph } from "../capabilities";
import { printResult, atomicJson, type ResultOutputOpts } from "../output";

export interface WorkflowNodeDefinition {
  id: string;
  name: string;
  version: string;
  workflows: string[];
  data: { inputs?: unknown[]; outputs: { alias: string }[] };
}
interface WorkflowNodeInput {
  alias: string;
  value: { kind: "ref" | "string"; data: string };
}
export interface WorkflowBuildOpts extends ResultOutputOpts {
  name: string;
  code: string;
  kind?: "convert" | "active" | "passive";
  event?: "request" | "response";
}
export interface WorkflowTestOpts extends ResultOutputOpts {
  data?: Uint8Array;
  requestId?: string;
  request?: Uint8Array;
  response?: Uint8Array;
  host?: string;
  port?: number;
  tls?: boolean;
  raw?: boolean;
}
export interface WorkflowRunOpts extends ResultOutputOpts {
  data?: Uint8Array;
  requestId?: string;
  raw?: boolean;
}

export async function nodeDefinitions(g: Graph, refresh = false): Promise<WorkflowNodeDefinition[]> {
  const path = join(g.cfg.slot, "workflow-nodes.json");
  let nodes = refresh ? null : await jsonFile<WorkflowNodeDefinition[] | null>(path, null).catch(() => null);
  if (!Array.isArray(nodes)) {
    nodes = (await g.query("workflowNodeDefinitions", {}, "raw")).map(
      (n) => n.raw,
    );
    await atomicJson(path, nodes).catch(() => {});
  }
  return nodes;
}
export function buildWorkflow(
  { name, kind = "convert", code, event = "request" }: WorkflowBuildOpts,
  definitions: WorkflowNodeDefinition[],
) {
  if (!name || !code) fail("build-workflow needs --name and --code @file");
  if (!["convert", "active", "passive"].includes(kind))
    fail("Workflow kind must be convert, active or passive");
  const startId =
      kind === "passive"
        ? "caido/on-intercept-" + event
        : `caido/${kind}-start`,
    jsId = kind === "convert" ? "caido/code-js" : "caido/http-code-js",
    endId = `caido/${kind}-end`;
  const find = (id: string): WorkflowNodeDefinition => {
    const candidates = definitions.filter(
      (d) => d.id === id && d.workflows.includes(kind),
    );
    const d = candidates.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    )[0];
    if (!d) fail("Workflow node unavailable: " + id, "UNSUPPORTED");
    return d;
  };
  const start = find(startId),
    js = find(jsId),
    end = find(endId);
  const node = (d: WorkflowNodeDefinition, id: number, alias: string, inputs: WorkflowNodeInput[]) => ({
    id,
    alias,
    name: d.name,
    definition_id: d.id,
    version: d.version,
    inputs,
    display: { x: id * 240, y: 0 },
  });
  const ref = (alias: string, data: string): WorkflowNodeInput => ({ alias, value: { kind: "ref", data } }),
    literal = (alias: string, data: string): WorkflowNodeInput => ({ alias, value: { kind: "string", data } });
  const outputs = new Set(start.data.outputs.map((o) => o.alias));
  const inputs = [
    literal("code", code),
    ...(kind === "convert"
      ? [ref("data", "$start.data")]
      : ["request", "response"]
          .filter((k) => outputs.has(k))
          .map((k) => ref(k, "$start." + k))),
  ];
  const nodes = [
    node(start, 0, "start", []),
    node(js, 1, "check", inputs),
    node(end, 2, "end", kind === "convert" ? [ref("data", "$check.data")] : []),
  ];
  const edge = (a: number, b: number) => ({
    source: { node_id: a, exec_alias: "exec" },
    target: { node_id: b, exec_alias: "exec" },
  });
  return {
    edition: 2,
    id: randomUUID(),
    name,
    description: "Created with caido-mode",
    kind,
    graph: { nodes, edges: [edge(0, 1), edge(1, 2)] },
  };
}
function summary(workflow: Workflow): Omit<Workflow, "definition"> {
  const { definition, ...rest } = workflow;
  return rest;
}

export async function cmdWorkflows(limit = 10, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  const items = (await client.workflow.list()).slice(0, integer(limit, 10, 1, 100)).map(summary);
  await printResult({ items }, opts);
}

export async function cmdGetWorkflow(id: string, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  const workflow = await client.workflow.get(id);
  if (!workflow) fail("Workflow not found", "NOT_FOUND");
  await printResult(workflow, { ...opts, maxBodyChars: 0 });
}

export async function cmdWorkflowNodes(search?: string, refresh = false, limit = 10, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  const nodes = await nodeDefinitions(await getGraph(client), refresh);
  const items = nodes.filter(n => !search || n.id.includes(search) || n.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, integer(limit, 10, 1, 100))
    .map(n => ({ id: n.id, name: n.name, version: n.version, kinds: n.workflows, inputs: n.data.inputs, outputs: n.data.outputs }));
  await printResult({ items }, opts);
}

export async function cmdBuildWorkflow(opts: WorkflowBuildOpts) {
  const client = await getClient();
  const definition = buildWorkflow(opts, await nodeDefinitions(await getGraph(client)));
  await printResult(definition, { ...opts, maxBodyChars: 0 });
}

export async function cmdCreateWorkflow(definition: Record<string, unknown>, global = false, enable = false, opts: ResultOutputOpts = {}) {
  if (!definition.kind || !definition.graph) fail("Expected workflow definition JSON; use build-workflow");
  const client = await getClient();
  let workflow = await client.workflow.create({ definition, global });
  if (workflow.enabled !== enable) workflow = await client.workflow.toggle(workflow.id, enable);
  await printResult(summary(workflow), opts);
}

export async function cmdUpdateWorkflow(id: string, definition: Record<string, unknown>, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  await printResult(summary(await client.workflow.update(id, { definition })), opts);
}

export async function cmdToggleWorkflow(id: string, enabled: boolean, opts: ResultOutputOpts = {}) {
  const client = await getClient();
  await printResult(summary(await client.workflow.toggle(id, enabled)), opts);
}

export async function cmdDeleteWorkflow(id: string) {
  const client = await getClient();
  await client.workflow.delete(id);
  console.log(JSON.stringify({ deleted: id }, null, 2));
}

export async function cmdTestWorkflow(definition: Record<string, unknown>, opts: WorkflowTestOpts) {
  const client = await getClient();
  const kind = definition.kind;
  if (kind === "convert") {
    const result = await client.workflow.test({ kind, definition, data: opts.data ?? fail("--data required") });
    await printResult({ output: opts.raw ? result.output ?? null : result.output ? Buffer.from(result.output).toString("utf8") : null, ...(opts.raw ? { runState: result.runState } : {}) }, opts);
    return;
  }
  if (kind !== "active" && kind !== "passive") fail("Workflow kind must be convert, active or passive");
  let request: { connection: ConnectionInfoInput; raw: Uint8Array };
  let response: { raw: Uint8Array } | undefined;
  if (opts.requestId) {
    const pair = await client.request.get(opts.requestId, { raw: true });
    if (!pair) fail("Request not found", "NOT_FOUND");
    request = { connection: { host: pair.request.host, port: pair.request.port, isTLS: pair.request.isTls }, raw: pair.request.raw! };
    if (pair.response?.raw) response = { raw: pair.response.raw };
  } else {
    request = {
      connection: { host: opts.host || fail("--request-id or --request @file --host required"), port: integer(opts.port, opts.tls ? 443 : 80, 1, 65535), isTLS: !!opts.tls },
      raw: opts.request ?? fail("--request required"),
    };
  }
  if (opts.response) response = { raw: opts.response };
  const result = kind === "active"
    ? await client.workflow.test({ kind: "active", definition, request, ...(response ? { response } : {}) })
    : await client.workflow.test({ kind: "passive", definition, request, ...(response ? { response } : {}) });
  await printResult(opts.raw ? result : { tested: true, kind }, opts);
}

export async function cmdRunWorkflow(id: string, opts: WorkflowRunOpts) {
  const client = await getClient();
  const workflow = await client.workflow.get(id);
  if (!workflow) fail("Workflow not found", "NOT_FOUND");
  if (workflow.kind === "CONVERT") {
    const result = await client.workflow.run({ kind: "convert", id, data: opts.data ?? fail("--data required") });
    await printResult({ output: opts.raw ? result.output ?? null : result.output ? Buffer.from(result.output).toString("utf8") : null }, opts);
    return;
  }
  if (workflow.kind !== "ACTIVE") fail("Passive workflows run on their event; use toggle-workflow");
  const task = await client.workflow.run({ kind: "active", id, requestId: opts.requestId || fail("--request-id required") });
  await printResult({ taskId: task.id, workflowId: id }, opts);
}
