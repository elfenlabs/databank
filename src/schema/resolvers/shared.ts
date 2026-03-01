import type { Kysely } from "kysely";
import type { Database } from "../../db/types.ts";

/**
 * Resolve a raw nodes row into a full GraphQL Node (with labels + properties).
 */
export async function resolveNode(
  db: Kysely<Database>,
  row: { id: string; content: string; created_at: Date },
) {
  const [labels, properties] = await Promise.all([
    db
      .selectFrom("node_labels")
      .select("label")
      .where("node_id", "=", row.id)
      .execute(),
    db
      .selectFrom("node_properties")
      .select(["key", "value"])
      .where("node_id", "=", row.id)
      .execute(),
  ]);

  return {
    id: row.id,
    content: row.content,
    labels: labels.map((l) => l.label),
    properties: Object.fromEntries(properties.map((p) => [p.key, p.value])),
    createdAt: row.created_at,
  };
}

/**
 * Resolve multiple node rows in parallel.
 */
export async function resolveNodes(
  db: Kysely<Database>,
  rows: Array<{ id: string; content: string; created_at: Date }>,
) {
  return Promise.all(rows.map((r) => resolveNode(db, r)));
}
