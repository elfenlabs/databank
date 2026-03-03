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
      // Find entity pairs with high content vector similarity but no direct edge
      const rows = await ctx.db
        .selectFrom("entities as a")
        .innerJoin("entities as b", (join) =>
          join.on(sql`a.id < b.id`),
        )
        .select([
          "a.id as a_id",
          "a.content as a_content",
          "a.properties as a_properties",
          "a.created_at as a_created_at",
          "b.id as b_id",
          "b.content as b_content",
          "b.properties as b_properties",
          "b.created_at as b_created_at",
          sql<number>`1 - (a.content_vector <=> b.content_vector)`.as(
            "similarity",
          ),
        ])
        .where(
          sql`1 - (a.content_vector <=> b.content_vector)`,
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
              content: row.a_content,
              properties: (row as any).a_properties ?? {},
              created_at: row.a_created_at,
            } as any),
            resolveEntity(ctx.db, {
              id: row.b_id,
              content: row.b_content,
              properties: (row as any).b_properties ?? {},
              created_at: row.b_created_at,
            } as any),
          ]);
          return { entityA, entityB, similarity: row.similarity };
        }),
      );

      return pairs;
    },

    async schema(_: unknown, __: unknown, ctx: GraphContext) {
      const [labels, relationTypes, propKeys, entityCount, edgeCount] = await Promise.all([
        ctx.db
          .selectFrom("entity_labels")
          .select("label")
          .distinct()
          .execute(),
        ctx.db
          .selectFrom("relations")
          .select("name")
          .execute(),
        ctx.db
          .selectFrom("property_keys")
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
      ]);

      return {
        labels: labels.map((l) => l.label),
        relationTypes: relationTypes.map((r) => r.name),
        propertyKeys: propKeys.map((p) => p.name),
        entityCount: Number(entityCount.count),
        edgeCount: Number(edgeCount.count),
      };
    },
  },
};
