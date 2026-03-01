import { sql } from "kysely";
import { GraphQLError } from "graphql";
import { embed } from "../../sidecar/client.ts";
import { toVectorLiteral, type GraphContext } from "../context.ts";

export const relationResolvers = {
  Query: {
    async relations(_: unknown, __: unknown, ctx: GraphContext) {
      const rows = await ctx.db
        .selectFrom("relations")
        .selectAll()
        .orderBy("usage_count", "desc")
        .execute();

      return rows.map((r) => ({
        name: r.name,
        usageCount: r.usage_count,
        createdAt: r.created_at,
      }));
    },
  },

  Mutation: {
    async registerRelation(
      _: unknown,
      args: { name: string },
      ctx: GraphContext,
    ) {
      const relVector = toVectorLiteral(await embed(args.name));

      const row = await ctx.db
        .insertInto("relations")
        .values({
          name: args.name,
          name_vector: sql`${relVector}::vector`,
        } as any)
        .onConflict((oc) => oc.column("name").doNothing())
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        name: row.name,
        usageCount: row.usage_count,
        createdAt: row.created_at,
      };
    },

    async mergeRelations(
      _: unknown,
      args: { sources: string[]; target: string },
      ctx: GraphContext,
    ) {
      // Ensure target relation exists
      const existing = await ctx.db
        .selectFrom("relations")
        .select("name")
        .where("name", "=", args.target)
        .executeTakeFirst();

      if (!existing) {
        const relVector = toVectorLiteral(await embed(args.target));
        await ctx.db
          .insertInto("relations")
          .values({
            name: args.target,
            name_vector: sql`${relVector}::vector`,
          } as any)
          .execute();
      }

      // Re-label all edges from sources → target
      await ctx.db
        .updateTable("edges")
        .set({ relation_type: args.target })
        .where("relation_type", "in", args.sources)
        .execute();

      // Sum usage counts from sources into target
      const sourceCounts = await ctx.db
        .selectFrom("relations")
        .select(sql<number>`COALESCE(SUM(usage_count), 0)`.as("total"))
        .where("name", "in", args.sources)
        .executeTakeFirstOrThrow();

      await ctx.db
        .updateTable("relations")
        .set({
          usage_count: sql`usage_count + ${Number(sourceCounts.total)}`,
        })
        .where("name", "=", args.target)
        .execute();

      // Delete source relations
      await ctx.db
        .deleteFrom("relations")
        .where("name", "in", args.sources)
        .execute();

      const result = await ctx.db
        .selectFrom("relations")
        .selectAll()
        .where("name", "=", args.target)
        .executeTakeFirstOrThrow();

      return {
        name: result.name,
        usageCount: result.usage_count,
        createdAt: result.created_at,
      };
    },

    async deleteRelation(
      _: unknown,
      args: { name: string },
      ctx: GraphContext,
    ) {
      // Check if any edges reference this relation
      const usedBy = await ctx.db
        .selectFrom("edges")
        .select(sql<number>`count(*)`.as("count"))
        .where("relation_type", "=", args.name)
        .executeTakeFirstOrThrow();

      if (Number(usedBy.count) > 0) {
        throw new GraphQLError(
          `Cannot delete relation '${args.name}': still referenced by ${usedBy.count} edge(s)`,
          { extensions: { code: "CONFLICT" } },
        );
      }

      const result = await ctx.db
        .deleteFrom("relations")
        .where("name", "=", args.name)
        .executeTakeFirst();

      return (result?.numDeletedRows ?? 0n) > 0n;
    },
  },
};
