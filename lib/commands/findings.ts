/** Findings commands: list, get, create, update */

import { getClient } from "../client";

export async function cmdFindings(limit: number) {
  const client = await getClient();
  const connection = await client.finding.list().first(limit);

  const results = connection.edges.map(e => ({
    id: e.node.id,
    title: e.node.title,
    reporter: e.node.reporter,
    host: e.node.host,
    path: e.node.path,
    hidden: e.node.hidden,
    dedupeKey: e.node.dedupeKey,
    createdAt: e.node.createdAt,
  }));

  console.log(JSON.stringify({ results, count: results.length }, null, 2));
}

export async function cmdGetFinding(findingId: string) {
  const client = await getClient();
  const finding = await client.finding.get(findingId);

  if (!finding) {
    console.error(`Finding ${findingId} not found`);
    process.exit(1);
  }

  console.log(JSON.stringify(finding, null, 2));
}

export async function cmdCreateFinding(
  requestId: string,
  title: string,
  description?: string,
  reporter?: string,
  dedupeKey?: string,
) {
  const client = await getClient();
  const finding = await client.finding.create(requestId, {
    title,
    reporter: reporter || "caido-mode",
    description,
    dedupeKey,
  });

  console.log(JSON.stringify(finding, null, 2));
}

export async function cmdUpdateFinding(
  findingId: string,
  title?: string,
  description?: string,
  hidden?: boolean,
) {
  const client = await getClient();
  const existing = await client.finding.get(findingId);

  if (!existing) {
    console.error(`Finding ${findingId} not found`);
    process.exit(1);
  }

  const finding = await client.finding.update(findingId, {
    title: title ?? existing.title,
    description: description ?? existing.description ?? "",
    hidden: hidden ?? existing.hidden,
  });

  console.log(JSON.stringify(finding, null, 2));
}
