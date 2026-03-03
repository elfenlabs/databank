import { sql } from "kysely";
import { GraphQLError } from "graphql";
import type { GraphContext } from "../context.ts";
import { resolveEntity } from "./shared.ts";

/** Map a raw edges row to a GraphQL Edge object. */
function toEdge(row: any) {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relationType: row.relation_type,
    properties: row.properties,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdAt: row.created_at,
  };
}

export const pathResolvers = {
  Query: {
    async path(
      _: unknown,
      args: {
        fromId: string;
        toId: string;
        maxDepth?: number;
        relationType?: string;
      },
      ctx: GraphContext,
    ) {
      const maxDepth = Math.min(Math.max(args.maxDepth ?? 5, 1), 5);

      if (args.fromId === args.toId) {
        // Same entity — return single-step path
        const row = await ctx.db
          .selectFrom("entities")
          .selectAll()
          .where("id", "=", args.fromId)
          .executeTakeFirst();
        if (!row) {
          throw new GraphQLError("Entity not found", {
            extensions: { code: "NOT_FOUND" },
          });
        }
        return [{ entity: await resolveEntity(ctx.db, row), edge: null }];
      }

      let result: { rows: Array<{ visited: string[]; edge_path: string[] }> };

      if (args.relationType) {
        // BFS with relation type filter
        result = await sql<{
          visited: string[];
          edge_path: string[];
        }>`
          WITH RECURSIVE search AS (
            SELECT
              CASE WHEN e.source_id = ${args.fromId} THEN e.target_id ELSE e.source_id END AS entity_id,
              e.id AS edge_id,
              ARRAY[${args.fromId}::text] AS visited,
              ARRAY[e.id::text] AS edge_path,
              1 AS depth
            FROM edges e
            WHERE (e.source_id = ${args.fromId} OR e.target_id = ${args.fromId})
              AND e.relation_type = ${args.relationType}

            UNION ALL

            SELECT
              CASE WHEN e.source_id = s.entity_id THEN e.target_id ELSE e.source_id END,
              e.id,
              s.visited || s.entity_id::text,
              s.edge_path || e.id::text,
              s.depth + 1
            FROM edges e
            JOIN search s ON (e.source_id = s.entity_id OR e.target_id = s.entity_id)
            WHERE s.depth < ${maxDepth}
              AND NOT (CASE WHEN e.source_id = s.entity_id THEN e.target_id ELSE e.source_id END)::text = ANY(s.visited)
              AND e.relation_type = ${args.relationType}
          )
          SELECT visited || entity_id::text AS visited, edge_path
          FROM search
          WHERE entity_id = ${args.toId}
          ORDER BY depth
          LIMIT 1
        `.execute(ctx.db);
      } else {
        // BFS without relation type filter
        result = await sql<{
          visited: string[];
          edge_path: string[];
        }>`
          WITH RECURSIVE search AS (
            SELECT
              CASE WHEN e.source_id = ${args.fromId} THEN e.target_id ELSE e.source_id END AS entity_id,
              e.id AS edge_id,
              ARRAY[${args.fromId}::text] AS visited,
              ARRAY[e.id::text] AS edge_path,
              1 AS depth
            FROM edges e
            WHERE (e.source_id = ${args.fromId} OR e.target_id = ${args.fromId})

            UNION ALL

            SELECT
              CASE WHEN e.source_id = s.entity_id THEN e.target_id ELSE e.source_id END,
              e.id,
              s.visited || s.entity_id::text,
              s.edge_path || e.id::text,
              s.depth + 1
            FROM edges e
            JOIN search s ON (e.source_id = s.entity_id OR e.target_id = s.entity_id)
            WHERE s.depth < ${maxDepth}
              AND NOT (CASE WHEN e.source_id = s.entity_id THEN e.target_id ELSE e.source_id END)::text = ANY(s.visited)
          )
          SELECT visited || entity_id::text AS visited, edge_path
          FROM search
          WHERE entity_id = ${args.toId}
          ORDER BY depth
          LIMIT 1
        `.execute(ctx.db);
      }

      if (result.rows.length === 0) {
        return []; // no path found
      }

      const { visited, edge_path } = result.rows[0]!;

      // Hydrate: fetch all entities and edges in parallel
      const [entityRows, edgeRows] = await Promise.all([
        ctx.db
          .selectFrom("entities")
          .selectAll()
          .where("id", "in", visited)
          .execute(),
        ctx.db
          .selectFrom("edges")
          .selectAll()
          .where("id", "in", edge_path)
          .execute(),
      ]);

      // Build lookup maps
      const entityMap = new Map(entityRows.map((r) => [r.id, r]));
      const edgeMap = new Map(edgeRows.map((r) => [r.id, r]));

      // Resolve entities and assemble PathStep[]
      const steps = await Promise.all(
        visited.map(async (entityId, i) => {
          const entityRow = entityMap.get(entityId);
          if (!entityRow) {
            throw new GraphQLError(`Entity ${entityId} not found in path`, {
              extensions: { code: "NOT_FOUND" },
            });
          }
          const entity = await resolveEntity(ctx.db, entityRow);
          const edgeId = edge_path[i - 1]; // first step has no edge
          const rawEdge = edgeId ? edgeMap.get(edgeId) : undefined;

          return {
            entity,
            edge: rawEdge ? toEdge(rawEdge) : null,
          };
        }),
      );

      return steps;
    },
  },
};
