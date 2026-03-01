import { sql } from "kysely";
import { embed } from "../../sidecar/client.ts";
import {
  decodeCursor,
  encodeCursor,
  toVectorLiteral,
  type GraphContext,
} from "../context.ts";
import { resolveNode } from "./shared.ts";

export const connectionResolvers = {
  Query: {
    async connections(
      _: unknown,
      args: {
        nodeId: string;
        relation?: {
          match: "EXACT" | "SEMANTIC";
          value: string;
          threshold?: number;
        };
        target?: { on: "CONTENT" | "LABEL"; value: string; threshold: number };
        direction?: "OUTGOING" | "INCOMING" | "BOTH";
        temporal?: {
          mode: "AT" | "WITHIN" | "OVERLAPS";
          at?: string;
          from?: string;
          to?: string;
        };
        first?: number;
        after?: string;
      },
      ctx: GraphContext,
    ) {
      const limit = args.first ?? 10;
      const offset = args.after ? decodeCursor(args.after) + 1 : 0;
      const direction = args.direction ?? "OUTGOING";

      // Step 1 — Resolve relation types
      let matchedRelations: Array<{ name: string; score: number }> = [];

      if (args.relation) {
        if (args.relation.match === "EXACT") {
          matchedRelations = [{ name: args.relation.value, score: 1.0 }];
        } else {
          // SEMANTIC — waterfall search on relations table
          if (args.relation.threshold == null) {
            throw new Error("'threshold' is required for SEMANTIC relation match");
          }

          const relVector = await embed(args.relation.value);
          const vecLiteral = toVectorLiteral(relVector);

          const relRows = await ctx.db
            .selectFrom("relations")
            .select([
              "name",
              sql<number>`1 - (name_vector <=> ${vecLiteral}::vector)`.as(
                "score",
              ),
            ])
            .where(
              sql`1 - (name_vector <=> ${vecLiteral}::vector)`,
              ">=",
              args.relation.threshold,
            )
            .orderBy("score", "desc")
            .execute();

          matchedRelations = relRows;
        }

        if (matchedRelations.length === 0) {
          return {
            edges: [],
            pageInfo: {
              hasNextPage: false,
              hasPreviousPage: false,
              startCursor: null,
              endCursor: null,
            },
            totalCount: 0,
          };
        }
      }

      // Step 2 — Build edge query with direction + temporal filters
      let edgeQuery = ctx.db.selectFrom("edges").selectAll("edges");

      // Direction filter
      if (direction === "OUTGOING") {
        edgeQuery = edgeQuery.where("source_id", "=", args.nodeId);
      } else if (direction === "INCOMING") {
        edgeQuery = edgeQuery.where("target_id", "=", args.nodeId);
      } else {
        // BOTH
        edgeQuery = edgeQuery.where((eb) =>
          eb.or([
            eb("source_id", "=", args.nodeId),
            eb("target_id", "=", args.nodeId),
          ]),
        );
      }

      // Relation filter
      if (matchedRelations.length > 0) {
        edgeQuery = edgeQuery.where(
          "relation_type",
          "in",
          matchedRelations.map((r) => r.name),
        );
      }

      // Temporal filter
      if (args.temporal) {
        const { mode, at, from, to } = args.temporal;

        if (mode === "AT") {
          if (!at) throw new Error("'at' is required for AT temporal mode");
          // Facts (valid_from IS NULL) always match
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
          if (!from || !to) throw new Error("'from' and 'to' are required for WITHIN temporal mode");
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
          if (!from || !to) throw new Error("'from' and 'to' are required for OVERLAPS temporal mode");
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

      // Get total count
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

      // Step 3 — Build relation score map
      const scoreMap = new Map(matchedRelations.map((r) => [r.name, r.score]));

      // Step 4 — Resolve target nodes + optional target filter
      const results: Array<{
        node: Awaited<ReturnType<typeof resolveNode>>;
        relationType: string;
        relationScore: number;
        validFrom: Date | null;
        validTo: Date | null;
        cursor: string;
      }> = [];

      let targetVector: number[] | null = null;
      if (args.target) {
        targetVector = await embed(args.target.value);
      }

      for (let i = 0; i < edgeRows.length; i++) {
        const edge = edgeRows[i]!;
        // Determine target node ID based on direction
        const targetNodeId =
          direction === "INCOMING"
            ? edge.source_id
            : direction === "OUTGOING"
              ? edge.target_id
              : edge.source_id === args.nodeId
                ? edge.target_id
                : edge.source_id;

        const nodeRow = await ctx.db
          .selectFrom("nodes")
          .selectAll()
          .where("id", "=", targetNodeId)
          .executeTakeFirstOrThrow();

        // Apply target filter if present
        if (targetVector && args.target) {
          const vecLiteral = toVectorLiteral(targetVector);

          if (args.target.on === "CONTENT") {
            const sim = await ctx.db
              .selectFrom("nodes")
              .select(
                sql<number>`1 - (content_vector <=> ${vecLiteral}::vector)`.as(
                  "sim",
                ),
              )
              .where("id", "=", targetNodeId)
              .executeTakeFirstOrThrow();

            if (sim.sim < args.target.threshold) continue;
          } else {
            // LABEL — check if any label exceeds threshold
            const labelSim = await ctx.db
              .selectFrom("node_labels")
              .select(
                sql<number>`MAX(1 - (label_vector <=> ${vecLiteral}::vector))`.as(
                  "sim",
                ),
              )
              .where("node_id", "=", targetNodeId)
              .executeTakeFirstOrThrow();

            if (!labelSim.sim || labelSim.sim < args.target.threshold) continue;
          }
        }

        const resolved = await resolveNode(ctx.db, nodeRow);
        results.push({
          node: resolved,
          relationType: edge.relation_type,
          relationScore: scoreMap.get(edge.relation_type) ?? 1.0,
          validFrom: edge.valid_from,
          validTo: edge.valid_to,
          cursor: encodeCursor(offset + i),
        });
      }

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
