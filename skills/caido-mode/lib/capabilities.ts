/** Schema-aware capabilities shared by the native CLI commands. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as graphql from "graphql";
import type { Client } from "@caido/sdk-client";
import type {
  GraphQLSchema, IntrospectionField, IntrospectionQuery, IntrospectionType,
  IntrospectionTypeRef, OperationDefinitionNode,
} from "graphql";
import { getClient, resolveActiveUrl } from "./client";
import { instanceSlot } from "./state";
import { atomicJson } from "./output";

export type OperationKind = "query" | "mutation";

export interface InstanceMetadata {
  slot: string;
}

export interface GraphContext {
  client: Client;
  cfg?: InstanceMetadata;
}

export interface CapabilitySummary {
  schemaHash: string;
  history: boolean;
  matchReplace: boolean;
  websockets: boolean;
  intercept: boolean;
  automate: boolean;
  workflows: boolean;
  pipelines: boolean;
  pipelineOperation: string | null;
}

export function fail(message: string, code = "INVALID_INPUT"): never {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  throw e;
}
export async function jsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}
function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function integer(v: unknown, fallback: number, min = 1, max = 100): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    fail(`Expected integer ${min}..${max}, got ${v}`);
  return n;
}
export function input(value: unknown, options: { json: true; bytes?: boolean }): Promise<any>;
export function input(value: unknown, options: { json?: false; bytes: true }): Promise<Buffer>;
export function input(value: unknown, options?: { json?: false; bytes?: false }): Promise<string>;
export async function input(value: unknown, { json = false, bytes = false }: { json?: boolean; bytes?: boolean } = {}): Promise<unknown> {
  if (value === undefined || value === true)
    fail("Provide a value, @file, or - for stdin");
  let b: Buffer;
  if (String(value) === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    b = Buffer.concat(chunks);
  } else
    b = String(value).startsWith("@")
      ? await readFile(String(value).slice(1))
      : Buffer.from(String(value));
  return json ? JSON.parse(b.toString("utf8")) : bytes ? b : b.toString("utf8");
}
function typeName(type: IntrospectionTypeRef): string {
  return type.kind === "NON_NULL" || type.kind === "LIST" ? typeName(type.ofType) : type.name;
}

function typeText(type: IntrospectionTypeRef): string {
  if (type.kind === "NON_NULL") return typeText(type.ofType) + "!";
  if (type.kind === "LIST") return "[" + typeText(type.ofType) + "]";
  return type.name;
}

function fieldsOf(type: IntrospectionType | undefined): readonly IntrospectionField[] {
  return type?.kind === "OBJECT" || type?.kind === "INTERFACE" ? type.fields : [];
}

export class Graph {
  client: Client;
  cfg: InstanceMetadata;
  data: IntrospectionQuery;
  types: Map<string, IntrospectionType>;
  schema?: GraphQLSchema;

  constructor(ctx: GraphContext, data: IntrospectionQuery) {
    this.client = ctx.client;
    this.cfg = ctx.cfg ?? { slot: instanceSlot(resolveActiveUrl()) };
    this.data = data;
    this.types = new Map(data.__schema.types.map((t) => [t.name, t]));
  }
  field(kind: OperationKind, name: string): IntrospectionField | undefined {
    const root = kind === "query" ? this.data.__schema.queryType : this.data.__schema.mutationType;
    return root ? fieldsOf(this.types.get(root.name)).find((f) => f.name === name) : undefined;
  }
  choose(kind: OperationKind, names: string[]): string {
    const n = names.find((n) => this.field(kind, n));
    if (!n)
      fail("Instance does not expose " + names.join(" / "), "UNSUPPORTED");
    return n;
  }
  has(kind: OperationKind, name: string): boolean {
    return !!this.field(kind, name);
  }
  selection(name: string, depth = 2, seen: Set<string> = new Set()): string {
    const t = this.types.get(name);
    if (!t) return "__typename";
    if (t.kind === "UNION" || t.kind === "INTERFACE")
      return (
        "__typename " +
        (t.possibleTypes || [])
          .map(
            (x) =>
              `... on ${x.name} { ${this.selection(x.name, depth, new Set(seen))} }`,
          )
          .join(" ")
      );
    const omit = new Set([
      "raw",
      "definition",
      "editorState",
      "requests",
      "entries",
      "messages",
      "nodes",
      "edges",
      "parent",
      "collection",
      "workflow",
      "project",
      "request",
      "response",
      "stream",
      "head",
      "tail",
      "edits",
    ]);
    return (
      fieldsOf(t)
        .filter(
          (f) =>
            !(f.args || []).some(
              (a) => a.type.kind === "NON_NULL" && a.defaultValue == null,
            ),
        )
        .flatMap((f) => {
          const sub = this.types.get(typeName(f.type));
          if (sub?.kind === "SCALAR" || sub?.kind === "ENUM")
            return omit.has(f.name)
              ? []
              : [f.name === "reason" ? name + "Reason: reason" : f.name];
          if (
            depth < 1 ||
            (omit.has(f.name) && seen.size > 0) ||
            seen.has(typeName(f.type))
          )
            return [];
          return [
            `${f.name} { ${this.selection(typeName(f.type), depth - 1, new Set([...seen, name]))} }`,
          ];
        })
        .join(" ") || "__typename"
    );
  }
  async call(kind: OperationKind, name: string, args: Record<string, unknown> = {}, selection?: string): Promise<any> {
    const field = this.field(kind, name);
    if (!field)
      fail(
        `Instance has no ${name}; run capabilities --refresh`,
        "UNSUPPORTED",
      );
    const declarations: string[] = [];
    const uses: string[] = [];
    const vars: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined) continue;
      const a = field.args.find((a) => a.name === k);
      if (!a) fail(`${name} has no argument ${k}`, "SCHEMA_MISMATCH");
      declarations.push("$" + k + ":" + typeText(a.type));
      uses.push(k + ":$" + k);
      vars[k] = v;
    }
    const output = this.types.get(typeName(field.type));
    if (!output) fail("Unknown result type for " + name, "SCHEMA_MISMATCH");
    const select = selection ?? this.selection(output.name);
    const text = `${kind}${declarations.length ? "(" + declarations.join(",") + ")" : ""}{${name}${uses.length ? "(" + uses.join(",") + ")" : ""}${["SCALAR", "ENUM"].includes(output.kind) ? "" : "{" + select + "}"}}`;
    const document = graphql.parse(text);
    this.schema ??= graphql.buildClientSchema(this.data);
    const errors = graphql.validate(this.schema, document);
    if (errors.length)
      fail(errors.map((e) => e.message).join("; "), "SCHEMA_MISMATCH");
    const variableErrors = graphql.getVariableValues(
      this.schema,
      (document.definitions[0] as OperationDefinitionNode).variableDefinitions || [],
      vars,
    ).errors;
    if (variableErrors?.length)
      fail(variableErrors.map((e) => e.message).join("; "), "INVALID_INPUT");
    const result: any = await this.client.graphql[kind](document, vars);
    const payload = result[name];
    if (payload?.error) fail(JSON.stringify(payload.error), "CAIDO_OPERATION");
    return payload;
  }
  async query(name: string, args: Record<string, unknown> = {}, selection?: string): Promise<any> {
    return this.call("query", name, args, selection);
  }
  async mutation(name: string, args: Record<string, unknown> = {}, selection?: string): Promise<any> {
    return this.call("mutation", name, args, selection);
  }
  describe(name: string): IntrospectionType {
    const t = this.types.get(name);
    if (!t) fail("Unknown schema type " + name);
    return t;
  }
}
export async function getGraph(client?: Client, { refresh = false }: { refresh?: boolean } = {}): Promise<Graph> {
  const url = resolveActiveUrl();
  const activeClient = client ?? await getClient();
  const cfg = { slot: instanceSlot(url) };
  const path = join(cfg.slot, "schema.json");
  let data = refresh ? null : await jsonFile<IntrospectionQuery | null>(path, null);
  if (!data?.__schema?.queryType?.name || !Array.isArray(data.__schema.types)) data = null;
  if (!data) {
    data = await activeClient.graphql.query<IntrospectionQuery, Record<string, never>>(
      graphql.parse(graphql.getIntrospectionQuery()),
      {},
    );
    try { await atomicJson(path, data); } catch { /* Optional cache. */ }
  }
  return new Graph({ client: activeClient, cfg }, data);
}
export function capabilities(g: Graph): CapabilitySummary {
  const need = (kind: OperationKind, ...names: string[]): boolean => names.every((n) => g.has(kind, n));
  const pipeline = [
    "createReplayPipelineHttpSession",
    "createReplayPipelineHttpOneSession",
  ].find((n) => g.has("mutation", n));
  return {
    schemaHash: hash(JSON.stringify(g.data)),
    history: need("query", "requests"),
    matchReplace: need("mutation", "createTamperRule", "testTamperRule"),
    websockets: need("query", "streams", "streamWsMessages"),
    intercept: need(
      "mutation",
      "forwardInterceptMessage",
      "dropInterceptMessage",
    ),
    automate: need("mutation", "updateAutomateSession", "startAutomateTask"),
    workflows: need("mutation", "createWorkflow", "runActiveWorkflow"),
    pipelines: !!pipeline,
    pipelineOperation: pipeline ?? null,
  };
}
export interface ConnectionResult<T> {
  edges?: Array<{ node: T }>;
  nodes?: T[];
  count?: number;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

export interface ConnectionPage<T> {
  items: T[];
  count?: number;
  nextCursor: string | null;
}

export function connectionPage<T>(result: ConnectionResult<T>): ConnectionPage<T> {
  return {
    items: result.edges?.map((e) => e.node) ?? result.nodes ?? [],
    count: result.count,
    nextCursor: result.pageInfo?.hasNextPage ? result.pageInfo.endCursor ?? null : null,
  };
}
export function pageArgs(opts: { limit?: number; after?: string }): { first: number; after?: string } {
  return { first: integer(opts.limit, 10, 1, 100), after: opts.after };
}
