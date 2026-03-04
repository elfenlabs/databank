import { sql } from "kysely";
import {
  decodeCursor,
  paginate,
  toVectorLiteral,
  type GraphContext,
} from "../context.ts";
import { resolveEntity, resolveEntities } from "./shared.ts";

export const maintenanceResolvers = {
  Query: {
    async orphans(
      _: unknown,
      args: { first?: number; after?: string },
      ctx: GraphContext,
    ) {
      const limit = args.first ?? 20;
      const offset = args.after ? decodeCursor(args.after) + 1 : 0;

      // Entities with no edges (neither source nor target)
      const baseQuery = ctx.db
        .selectFrom("entities")
        .where(
          "id",
          "not in",
          ctx.db
            .selectFrom("edges")
            .select("source_id as id")
            .union(ctx.db.selectFrom("edges").select("target_id as id")),
        );

      const countResult = await baseQuery
        .select(sql<number>`count(*)`.as("count"))
        .executeTakeFirstOrThrow();
      const totalCount = Number(countResult.count);

      const rows = await baseQuery
        .selectAll()
        .orderBy("created_at", "desc")
        .offset(offset)
        .limit(limit)
        .execute();

      const entities = await resolveEntities(ctx.db, rows);
      return paginate(entities, totalCount, offset, limit);
    },

    async similarPairs(
      _: unknown,
      args: { threshold: number },
      ctx: GraphContext,
    ) {
      // Find entity pairs with high embedding similarity but no direct edge
      const rows = await ctx.db
        .selectFrom("entities as a")
        .innerJoin("entities as b", (join) =>
          join.on(sql`a.id < b.id`),
        )
        .select([
          "a.id as a_id",
          "a.name as a_name",
          "a.description as a_description",
          "a.created_at as a_created_at",
          "b.id as b_id",
          "b.name as b_name",
          "b.description as b_description",
          "b.created_at as b_created_at",
          sql<number>`1 - (a.embedding <=> b.embedding)`.as(
            "similarity",
          ),
        ])
        .where(
          sql`1 - (a.embedding <=> b.embedding)`,
          ">=",
          args.threshold,
        )
        .where(
          sql<boolean>`NOT EXISTS (
            SELECT 1 FROM edges
            WHERE (edges.source_id = a.id AND edges.target_id = b.id)
               OR (edges.source_id = b.id AND edges.target_id = a.id)
          )`,
        )
        .orderBy("similarity", "desc")
        .limit(50)
        .execute();

      const pairs = await Promise.all(
        rows.map(async (row) => {
          const [entityA, entityB] = await Promise.all([
            resolveEntity(ctx.db, {
              id: row.a_id,
              name: row.a_name,
              description: (row as any).a_description,
              created_at: row.a_created_at,
            }),
            resolveEntity(ctx.db, {
              id: row.b_id,
              name: row.b_name,
              description: (row as any).b_description,
              created_at: row.b_created_at,
            }),
          ]);
          return { entityA, entityB, similarity: row.similarity };
        }),
      );

      return pairs;
    },

    async schema(_: unknown, __: unknown, ctx: GraphContext) {
      const [traitNames, relationTypes, entityCount, edgeCount, memoryStreamCount] = await Promise.all([
        ctx.db
          .selectFrom("traits")
          .select("name")
          .execute(),
        ctx.db
          .selectFrom("relations")
          .select("name")
          .execute(),
        ctx.db
          .selectFrom("entities")
          .select(sql<number>`count(*)`.as("count"))
          .executeTakeFirstOrThrow(),
        ctx.db
          .selectFrom("edges")
          .select(sql<number>`count(*)`.as("count"))
          .executeTakeFirstOrThrow(),
        ctx.db
          .selectFrom("memory_stream")
          .where("status", "=", "PENDING")
          .select(sql<number>`count(*)`.as("count"))
          .executeTakeFirstOrThrow(),
      ]);

      return {
        traits: traitNames.map((t) => t.name),
        relationTypes: relationTypes.map((r) => r.name),
        entityCount: Number(entityCount.count),
        edgeCount: Number(edgeCount.count),
        memoryStreamCount: Number(memoryStreamCount.count),
      };
    },
  },
};
