import type { ColumnType, Generated } from "kysely";

/** Raw pgvector column — stored as string in Kysely, cast to vector by pg. */
type Vector = string;

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

export interface RelationsTable {
  name: string;
  description: string | null;
  name_vector: Vector | null;
  usage_count: ColumnType<number, number | undefined, number>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface PropertyKeysTable {
  name: string;
  description: string | null;
  usage_count: ColumnType<number, number | undefined, number>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface EntitiesTable {
  id: Generated<string>;
  content: string;
  content_vector: Vector | null;
  properties: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface EntityLabelsTable {
  id: Generated<string>;
  entity_id: string;
  label: string;
  label_vector: Vector | null;
}

export interface EdgesTable {
  id: Generated<string>;
  source_id: string;
  target_id: string;
  relation_type: string;
  properties: ColumnType<Record<string, unknown>, string | undefined, string>;
  valid_from: Date | null;
  valid_to: Date | null;
  created_at: ColumnType<Date, Date | undefined, never>;
}

// ---------------------------------------------------------------------------
// Database interface (used by Kysely)
// ---------------------------------------------------------------------------

export interface Database {
  relations: RelationsTable;
  property_keys: PropertyKeysTable;
  entities: EntitiesTable;
  entity_labels: EntityLabelsTable;
  edges: EdgesTable;
}
