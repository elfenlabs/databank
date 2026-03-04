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

export interface TraitsTable {
  name: string;
  description: string | null;
  name_vector: Vector | null;
  usage_count: ColumnType<number, number | undefined, number>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface TraitPropertiesTable {
  trait_name: string;
  key: string;
  description: string | null;
}

export interface EntitiesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  embedding: Vector | null;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface EntityTraitsTable {
  id: Generated<string>;
  entity_id: string;
  trait_name: string;
  properties: ColumnType<Record<string, unknown>, string | undefined, string>;
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

export interface MemoryStreamTable {
  id: Generated<string>;
  content: string;
  source: string;
  priority: ColumnType<number, number | undefined, number>;
  embedding: Vector | null;
  status: ColumnType<string, string | undefined, string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  processed_at: Date | null;
}

// ---------------------------------------------------------------------------
// Database interface (used by Kysely)
// ---------------------------------------------------------------------------

export interface Database {
  relations: RelationsTable;
  traits: TraitsTable;
  trait_properties: TraitPropertiesTable;
  entities: EntitiesTable;
  entity_traits: EntityTraitsTable;
  edges: EdgesTable;
  memory_stream: MemoryStreamTable;
}
