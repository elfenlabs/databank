import type { Kysely } from "kysely";
import type { Database } from "../../db/types.ts";

/**
 * Resolve a raw entities row into a full GraphQL Entity (with traits).
 */
export async function resolveEntity(
  db: Kysely<Database>,
  row: { id: string; content: string; created_at: Date },
) {
  const traitRows = await db
    .selectFrom("entity_traits")
    .select(["trait_name", "properties"])
    .where("entity_id", "=", row.id)
    .execute();

  return {
    id: row.id,
    content: row.content,
    traits: traitRows.map((t) => ({
      name: t.trait_name,
      properties: t.properties ?? {},
    })),
    createdAt: row.created_at,
  };
}

/**
 * Resolve multiple entity rows in parallel.
 */
export async function resolveEntities(
  db: Kysely<Database>,
  rows: Array<{ id: string; content: string; created_at: Date }>,
) {
  return Promise.all(rows.map((r) => resolveEntity(db, r)));
}
