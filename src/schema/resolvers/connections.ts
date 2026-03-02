import { sql } from "kysely";
import { GraphQLError } from "graphql";
import { embed } from "../../embedder/client.ts";
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
        first?: number;
        after?: string;
      },
      ctx: GraphContext,
    ) {
      const limit = args.first ?? 10;
      const offset = args.after ? decodeCursor(args.after) + 1 : 0;
      const direction = args.direction ?? "OUTGOING";

      // Build edge query
      let edgeQuery = ctx.db.selectFrom("edges").selectAll("edges");

      // Direction filter
      if (direction === "OUTGOING") {
        edgeQuery = edgeQuery.where("source_id", "=", args.nodeId);
      } else if (direction === "INCOMING") {
        edgeQuery = edgeQuery.where("target_id", "=", args.nodeId);
      } else {
        edgeQuery = edgeQuery.where((eb) =>
          eb.or([
            eb("source_id", "=", args.nodeId),
            eb("target_id", "=", args.nodeId),
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
            .selectFrom("node_labels")
            .select("node_id")
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
            .selectFrom("nodes")
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

      // Resolve target nodes
      const results = await Promise.all(
        edgeRows.map(async (edge, i) => {
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

          const resolved = await resolveNode(ctx.db, nodeRow);
          return {
            node: resolved,
            relationType: edge.relation_type,
            validFrom: edge.valid_from,
            validTo: edge.valid_to,
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
