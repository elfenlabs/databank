import { sql } from "kysely";
import { GraphQLError } from "graphql";
import { embed } from "../../embedder/client.ts";
import {
  decodeCursor,
  paginate,
  toVectorLiteral,
  type GraphContext,
} from "../context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set(["PROCESSED", "DISCARDED"]);

function formatEntry(row: any) {
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

export const memoryStreamResolvers = {
  Query: {
    async memoryStream(
      _: unknown,
      args: {
        search?: { query: string; threshold: number };
        status?: string;
        first?: number;
        after?: string;
      },
      ctx: GraphContext,
    ) {
      const limit = args.first ?? 20;
      const offset = args.after ? decodeCursor(args.after) + 1 : 0;

      let query = ctx.db.selectFrom("memory_stream");

      // Optional status filter
      if (args.status) {
        query = query.where("status", "=", args.status);
      }

      // Semantic search
      let vecLiteral: string | null = null;
      if (args.search) {
        const queryVector = await embed(args.search.query);
        vecLiteral = toVectorLiteral(queryVector);
        query = query.where(
          sql`1 - (embedding <=> ${vecLiteral}::vector)`,
          ">=",
          args.search.threshold,
        );
      }

      // Count
      const countResult = await query
        .select(sql<number>`count(*)`.as("count"))
        .executeTakeFirstOrThrow();
      const totalCount = Number(countResult.count);

      // Fetch rows
      let dataQuery = query.selectAll();
      if (vecLiteral) {
        dataQuery = dataQuery
          .select(
            sql<number>`1 - (embedding <=> ${vecLiteral}::vector)`.as("score"),
          )
          .orderBy(
            sql`embedding <=> ${vecLiteral}::vector`,
            "asc",
          ) as any;
      } else {
        dataQuery = dataQuery.orderBy("created_at", "desc");
      }

      const rows = await dataQuery.offset(offset).limit(limit).execute();
      const scores = vecLiteral
        ? rows.map((r: any) => r.score as number)
        : undefined;
      const entries = rows.map(formatEntry);
      return paginate(entries, totalCount, offset, limit, scores);
    },
  },

  Mutation: {
    async appendMemory(
      _: unknown,
      args: { content: string; source: string; priority?: number },
      ctx: GraphContext,
    ) {
      // Embed content
      const vector = toVectorLiteral(await embed(args.content));

      const row = await ctx.db
        .insertInto("memory_stream")
        .values({
          content: args.content,
          source: args.source,
          priority: args.priority ?? 0,
          embedding: sql`${vector}::vector`,
        } as any)
        .returningAll()
        .executeTakeFirstOrThrow();

      return formatEntry(row);
    },

    async updateMemoryStatus(
      _: unknown,
      args: { ids: string[]; status: string },
      ctx: GraphContext,
    ) {
      if (!VALID_STATUSES.has(args.status)) {
        throw new GraphQLError(
          `Invalid status '${args.status}'. Must be one of: ${[...VALID_STATUSES].join(", ")}`,
          { extensions: { code: "BAD_REQUEST" } },
        );
      }

      const result = await ctx.db
        .updateTable("memory_stream")
        .set({
          status: args.status,
          processed_at: sql`NOW()`,
        } as any)
        .where("id", "in", args.ids)
        .executeTakeFirst();

      return Number(result?.numUpdatedRows ?? 0n);
    },

    async truncateMemoryStream(
      _: unknown,
      args: { before: string },
      ctx: GraphContext,
    ) {
      const result = await ctx.db
        .deleteFrom("memory_stream")
        .where("status", "!=", "PENDING")
        .where("created_at", "<", new Date(args.before))
        .executeTakeFirst();

      return Number(result?.numDeletedRows ?? 0n);
    },
  },
};
