import type { Kysely } from "kysely";
import type { Database } from "../db/types.ts";

export interface GraphContext {
  db: Kysely<Database>;
}

// ---------------------------------------------------------------------------
// Cursor helpers (opaque base64-encoded offset)
// ---------------------------------------------------------------------------

export function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`).toString("base64");
}

export function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64").toString("utf-8");
  const offset = parseInt(decoded.replace("cursor:", ""), 10);
  if (Number.isNaN(offset) || offset < 0) {
    throw new Error(`Invalid cursor: ${cursor}`);
  }
  return offset;
}

/**
 * Build a Relay-style PageInfo + edges wrapper from a full result set.
 */
export function paginate<T>(
  rows: T[],
  totalCount: number,
  offset: number,
  limit: number,
  scores?: (number | null)[],
) {
  const edges = rows.map((node, i) => ({
    node,
    score: scores?.[i] ?? null,
    cursor: encodeCursor(offset + i),
  }));

  return {
    edges,
    pageInfo: {
      hasNextPage: offset + limit < totalCount,
      hasPreviousPage: offset > 0,
      startCursor: edges.length > 0 ? edges[0]!.cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
    },
    totalCount,
  };
}

/**
 * Format a vector as a pgvector literal string: "[0.1,0.2,...]"
 */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
