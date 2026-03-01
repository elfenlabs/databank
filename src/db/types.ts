import type { ColumnType, Generated } from "kysely";

/** Raw pgvector column — stored as string in Kysely, cast to vector by pg. */
type Vector = string;

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

export interface RelationsTable {
  name: string;
  name_vector: Vector | null;
  usage_count: ColumnType<number, number | undefined, number>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface NodesTable {
  id: Generated<string>;
  content: string;
  content_vector: Vector | null;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface NodeLabelsTable {
  id: Generated<string>;
  node_id: string;
  label: string;
  label_vector: Vector | null;
}

export interface NodePropertiesTable {
  id: Generated<string>;
  node_id: string;
  key: string;
  value: string;
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
  nodes: NodesTable;
  node_labels: NodeLabelsTable;
  node_properties: NodePropertiesTable;
  edges: EdgesTable;
}
