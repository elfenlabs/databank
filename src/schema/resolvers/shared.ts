import type { Kysely } from "kysely";
import type { Database } from "../../db/types.ts";

/**
 * Resolve a raw entities row into a full GraphQL Entity (with labels + properties).
 */
export async function resolveEntity(
  db: Kysely<Database>,
  row: { id: string; content: string; properties: Record<string, unknown>; created_at: Date },
) {
  const labels = await db
    .selectFrom("entity_labels")
    .select("label")
    .where("entity_id", "=", row.id)
    .execute();

  return {
    id: row.id,
    content: row.content,
    labels: labels.map((l) => l.label),
    properties: row.properties ?? {},
    createdAt: row.created_at,
  };
}

/**
 * Resolve multiple entity rows in parallel.
 */
export async function resolveEntities(
  db: Kysely<Database>,
  rows: Array<{ id: string; content: string; properties: Record<string, unknown>; created_at: Date }>,
) {
  return Promise.all(rows.map((r) => resolveEntity(db, r)));
}
