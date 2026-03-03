import { sql } from "kysely";
import { GraphQLError } from "graphql";
import { embed } from "../../embedder/client.ts";
import {
  decodeCursor,
  encodeCursor,
  toVectorLiteral,
  type GraphContext,
} from "../context.ts";
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

// ---------------------------------------------------------------------------
// Temporal filter builder (shared by depth 1 and multi-hop)
// ---------------------------------------------------------------------------

function buildTemporalSql(temporal: {
  mode: "AT" | "WITHIN" | "OVERLAPS";
  at?: string;
  from?: string;
  to?: string;
}) {
  const { mode, at, from, to } = temporal;

  if (mode === "AT") {
    if (!at) throw new GraphQLError("'at' is required for AT temporal mode", { extensions: { code: "BAD_REQUEST" } });
    const d = new Date(at);
    return sql`AND (e.valid_from IS NULL OR (e.valid_from <= ${d} AND (e.valid_to IS NULL OR e.valid_to > ${d})))`;
  }
  if (mode === "WITHIN") {
    if (!from || !to) throw new GraphQLError("'from' and 'to' are required for WITHIN temporal mode", { extensions: { code: "BAD_REQUEST" } });
    return sql`AND (e.valid_from IS NULL OR (e.valid_from >= ${new Date(from)} AND e.valid_to <= ${new Date(to)}))`;
  }
  if (mode === "OVERLAPS") {
    if (!from || !to) throw new GraphQLError("'from' and 'to' are required for OVERLAPS temporal mode", { extensions: { code: "BAD_REQUEST" } });
    return sql`AND (e.valid_from IS NULL OR (e.valid_from <= ${new Date(to)} AND (e.valid_to IS NULL OR e.valid_to >= ${new Date(from)})))`;
  }
  return sql``;
}

// ---------------------------------------------------------------------------
// Multi-hop resolver (depth > 1) using recursive CTE
// ---------------------------------------------------------------------------

async function resolveMultiHop(
  args: {
    entityId: string;
    relationType?: string;
    targetLabels?: string[];
    targetSearch?: { query: string; threshold: number };
    direction: "OUTGOING" | "INCOMING" | "BOTH";
    temporal?: { mode: "AT" | "WITHIN" | "OVERLAPS"; at?: string; from?: string; to?: string };
    depth: number;
    first: number;
    after?: string;
  },
  ctx: GraphContext,
) {
  const limit = args.first;
  const offset = args.after ? decodeCursor(args.after) + 1 : 0;

  // Build direction-specific SQL fragments
  const dirBase =
    args.direction === "OUTGOING"
      ? sql`e.source_id = ${args.entityId}`
      : args.direction === "INCOMING"
        ? sql`e.target_id = ${args.entityId}`
        : sql`(e.source_id = ${args.entityId} OR e.target_id = ${args.entityId})`;

  const neighborCol = (tableAlias: string) =>
    args.direction === "OUTGOING"
      ? sql`${sql.raw(tableAlias)}.target_id`
      : args.direction === "INCOMING"
        ? sql`${sql.raw(tableAlias)}.source_id`
        : sql`CASE WHEN ${sql.raw(tableAlias)}.source_id = h.entity_id THEN ${sql.raw(tableAlias)}.target_id ELSE ${sql.raw(tableAlias)}.source_id END`;

  const baseNeighborCol =
    args.direction === "OUTGOING"
      ? sql`e.target_id`
      : args.direction === "INCOMING"
        ? sql`e.source_id`
        : sql`CASE WHEN e.source_id = ${args.entityId} THEN e.target_id ELSE e.source_id END`;

  const dirRecursive =
    args.direction === "OUTGOING"
      ? sql`e.source_id = h.entity_id`
      : args.direction === "INCOMING"
        ? sql`e.target_id = h.entity_id`
        : sql`(e.source_id = h.entity_id OR e.target_id = h.entity_id)`;

  const relFilter = args.relationType
    ? sql`AND e.relation_type = ${args.relationType}`
    : sql``;

  const temporalFilter = args.temporal ? buildTemporalSql(args.temporal) : sql``;

  // Recursive CTE: find terminal entities at exactly `depth` hops
  const cteResult = await sql<{
    entity_id: string;
    edge_id: string;
  }>`
    WITH RECURSIVE hops AS (
      SELECT
        ${baseNeighborCol} AS entity_id,
        e.id AS edge_id,
        1 AS depth,
        e.created_at AS edge_created_at
      FROM edges e
      WHERE ${dirBase}
        ${relFilter}
        ${temporalFilter}

      UNION ALL

      SELECT
        ${neighborCol("e")} AS entity_id,
        e.id AS edge_id,
        h.depth + 1,
        e.created_at AS edge_created_at
      FROM edges e
      JOIN hops h ON ${dirRecursive}
      WHERE h.depth < ${args.depth}
        AND ${neighborCol("e")} != ${args.entityId}
        ${relFilter}
        ${temporalFilter}
    )
    SELECT DISTINCT ON (entity_id) entity_id, edge_id, edge_created_at
    FROM hops
    WHERE depth = ${args.depth}
    ORDER BY entity_id, edge_created_at DESC
  `.execute(ctx.db);

  let terminalRows = cteResult.rows;

  // Apply target labels filter on terminal entities
  if (args.targetLabels && args.targetLabels.length > 0) {
    const entityIds = terminalRows.map((r) => r.entity_id);
    if (entityIds.length > 0) {
      const matchingIds = await ctx.db
        .selectFrom("entity_labels")
        .select("entity_id")
        .where("entity_id", "in", entityIds)
        .where("label", "in", args.targetLabels)
        .execute();
      const matchSet = new Set(matchingIds.map((r) => r.entity_id));
      terminalRows = terminalRows.filter((r) => matchSet.has(r.entity_id));
    }
  }

  // Apply target semantic search filter on terminal entities
  let targetVecLiteral: string | null = null;
  if (args.targetSearch) {
    const targetVector = await embed(args.targetSearch.query);
    targetVecLiteral = toVectorLiteral(targetVector);
    const entityIds = terminalRows.map((r) => r.entity_id);
    if (entityIds.length > 0) {
      const simResults = await ctx.db
        .selectFrom("entities")
        .select(["id", sql<number>`1 - (content_vector <=> ${targetVecLiteral}::vector)`.as("sim")])
        .where("id", "in", entityIds)
        .where(sql`1 - (content_vector <=> ${targetVecLiteral}::vector)`, ">=", args.targetSearch.threshold)
        .execute();
      const simMap = new Map(simResults.map((r) => [r.id, r.sim]));
      terminalRows = terminalRows.filter((r) => simMap.has(r.entity_id));
    }
  }

  const totalCount = terminalRows.length;

  // Sort by edge creation time (desc) — re-fetch edge_created_at for sorting
  // (already in CTE result, but we need to re-sort after filtering)
  const paged = terminalRows.slice(offset, offset + limit);

  // Resolve entities and edges
  const results = await Promise.all(
    paged.map(async (row, i) => {
      const [entityRow, edgeRow] = await Promise.all([
        ctx.db.selectFrom("entities").selectAll().where("id", "=", row.entity_id).executeTakeFirstOrThrow(),
        ctx.db.selectFrom("edges").selectAll().where("id", "=", row.edge_id).executeTakeFirstOrThrow(),
      ]);

      const resolved = await resolveEntity(ctx.db, entityRow);

      let score: number | null = null;
      if (targetVecLiteral) {
        const simResult = await ctx.db
          .selectFrom("entities")
          .select(sql<number>`1 - (content_vector <=> ${targetVecLiteral}::vector)`.as("sim"))
          .where("id", "=", row.entity_id)
          .executeTakeFirstOrThrow();
        score = simResult.sim;
      }

      return {
        node: resolved,
        edge: toEdge(edgeRow),
        score,
        cursor: encodeCursor(offset + i),
      };
    }),
  );

  return {
    edges: results,
    pageInfo: {
      hasNextPage: offset + limit < totalCount,
      hasPreviousPage: offset > 0,
      startCursor: results.length > 0 ? results[0]!.cursor : null,
      endCursor: results.length > 0 ? results[results.length - 1]!.cursor : null,
    },
    totalCount,
  };
}

// ---------------------------------------------------------------------------
// Exported resolver
// ---------------------------------------------------------------------------

export const relationResolvers = {
  Query: {
    async relations(
      _: unknown,
      args: {
        entityId: string;
        relationType?: string;
        targetLabels?: string[];
        targetSearch?: { query: string; threshold: number };
        direction?: "OUTGOING" | "INCOMING" | "BOTH";
        temporal?: {
          mode: "AT" | "WITHIN" | "OVERLAPS";
          at?: string;
          from?: string;
          to?: string;
        };
        depth?: number;
        first?: number;
        after?: string;
      },
      ctx: GraphContext,
    ) {
      const depth = Math.min(Math.max(args.depth ?? 1, 1), 5);
      const limit = args.first ?? 10;
      const offset = args.after ? decodeCursor(args.after) + 1 : 0;
      const direction = args.direction ?? "OUTGOING";

      // Multi-hop: delegate to recursive CTE path
      if (depth > 1) {
        return resolveMultiHop(
          { ...args, direction, depth, first: limit, after: args.after },
          ctx,
        );
      }

      // --- Depth 1: existing optimized single-hop logic ---

      // Build edge query
      let edgeQuery = ctx.db.selectFrom("edges").selectAll("edges");

      // Direction filter
      if (direction === "OUTGOING") {
        edgeQuery = edgeQuery.where("source_id", "=", args.entityId);
      } else if (direction === "INCOMING") {
        edgeQuery = edgeQuery.where("target_id", "=", args.entityId);
      } else {
        edgeQuery = edgeQuery.where((eb) =>
          eb.or([
            eb("source_id", "=", args.entityId),
            eb("target_id", "=", args.entityId),
          ]),
        );
      }

      // Relation type filter (exact)
      if (args.relationType) {
        edgeQuery = edgeQuery.where("relation_type", "=", args.relationType);
      }

      // Target labels filter — only include edges whose target has matching labels
      if (args.targetLabels && args.targetLabels.length > 0) {
        const targetIdCol =
          direction === "INCOMING" ? "source_id" : "target_id";
        edgeQuery = edgeQuery.where(
          targetIdCol,
          "in",
          ctx.db
            .selectFrom("entity_labels")
            .select("entity_id")
            .where("label", "in", args.targetLabels),
        );
      }

      // Target semantic search — only include edges whose target matches
      let targetVecLiteral: string | null = null;
      if (args.targetSearch) {
        const targetVector = await embed(args.targetSearch.query);
        targetVecLiteral = toVectorLiteral(targetVector);
        const targetIdCol =
          direction === "INCOMING" ? "source_id" : "target_id";
        edgeQuery = edgeQuery.where(
          targetIdCol,
          "in",
          ctx.db
            .selectFrom("entities")
            .select("id")
            .where(
              sql`1 - (content_vector <=> ${targetVecLiteral}::vector)`,
              ">=",
              args.targetSearch.threshold,
            ),
        );
      }

      // Temporal filter
      if (args.temporal) {
        const { mode, at, from, to } = args.temporal;

        if (mode === "AT") {
          if (!at)
            throw new GraphQLError("'at' is required for AT temporal mode", {
              extensions: { code: "BAD_REQUEST" },
            });
          edgeQuery = edgeQuery.where((eb) =>
            eb.or([
              eb("valid_from", "is", null),
              eb.and([
                eb("valid_from", "<=", new Date(at)),
                eb.or([
                  eb("valid_to", "is", null),
                  eb("valid_to", ">", new Date(at)),
                ]),
              ]),
            ]),
          );
        } else if (mode === "WITHIN") {
          if (!from || !to)
            throw new GraphQLError(
              "'from' and 'to' are required for WITHIN temporal mode",
              { extensions: { code: "BAD_REQUEST" } },
            );
          edgeQuery = edgeQuery.where((eb) =>
            eb.or([
              eb("valid_from", "is", null),
              eb.and([
                eb("valid_from", ">=", new Date(from)),
                eb("valid_to", "<=", new Date(to)),
              ]),
            ]),
          );
        } else if (mode === "OVERLAPS") {
          if (!from || !to)
            throw new GraphQLError(
              "'from' and 'to' are required for OVERLAPS temporal mode",
              { extensions: { code: "BAD_REQUEST" } },
            );
          edgeQuery = edgeQuery.where((eb) =>
            eb.or([
              eb("valid_from", "is", null),
              eb.and([
                eb("valid_from", "<=", new Date(to)),
                eb.or([
                  eb("valid_to", "is", null),
                  eb("valid_to", ">=", new Date(from)),
                ]),
              ]),
            ]),
          );
        }
      }

      // Count
      const countResult = await edgeQuery
        .clearSelect()
        .select(sql<number>`count(*)`.as("count"))
        .executeTakeFirstOrThrow();
      const totalCount = Number(countResult.count);

      // Fetch edge rows
      const edgeRows = await edgeQuery
        .orderBy("edges.created_at", "desc")
        .offset(offset)
        .limit(limit)
        .execute();

      // Resolve target entities + build full edge objects
      const results = await Promise.all(
        edgeRows.map(async (edgeRow, i) => {
          const targetEntityId =
            direction === "INCOMING"
              ? edgeRow.source_id
              : direction === "OUTGOING"
                ? edgeRow.target_id
                : edgeRow.source_id === args.entityId
                  ? edgeRow.target_id
                  : edgeRow.source_id;

          const entityRow = await ctx.db
            .selectFrom("entities")
            .selectAll()
            .where("id", "=", targetEntityId)
            .executeTakeFirstOrThrow();

          const resolved = await resolveEntity(ctx.db, entityRow);

          // Compute score if semantic search was used
          let score: number | null = null;
          if (targetVecLiteral) {
            const simResult = await ctx.db
              .selectFrom("entities")
              .select(
                sql<number>`1 - (content_vector <=> ${targetVecLiteral}::vector)`.as("sim"),
              )
              .where("id", "=", targetEntityId)
              .executeTakeFirstOrThrow();
            score = simResult.sim;
          }

          return {
            node: resolved,
            edge: toEdge(edgeRow),
            score,
            cursor: encodeCursor(offset + i),
          };
        }),
      );

      return {
        edges: results,
        pageInfo: {
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
          startCursor: results.length > 0 ? results[0]!.cursor : null,
          endCursor:
            results.length > 0 ? results[results.length - 1]!.cursor : null,
        },
        totalCount,
      };
    },
  },
};
