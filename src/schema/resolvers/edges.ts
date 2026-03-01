import { sql } from "kysely";
import { embed } from "../../sidecar/client.ts";
import { toVectorLiteral, type GraphContext } from "../context.ts";

export const edgeResolvers = {
  Mutation: {
    async createEdge(
      _: unknown,
      args: {
        input: {
          sourceId: string;
          targetId: string;
          relationType: string;
          properties?: Record<string, unknown>;
          validFrom?: string;
          validTo?: string;
        };
      },
      ctx: GraphContext,
    ) {
      const { sourceId, targetId, relationType, properties, validFrom, validTo } =
        args.input;

      // Ensure relation exists — auto-register if new
      const existing = await ctx.db
        .selectFrom("relations")
        .select("name")
        .where("name", "=", relationType)
        .executeTakeFirst();

      if (!existing) {
        const relVector = toVectorLiteral(await embed(relationType));
        await ctx.db
          .insertInto("relations")
          .values({
            name: relationType,
            name_vector: sql`${relVector}::vector`,
          } as any)
          .execute();
      }

      // Increment usage count
      await ctx.db
        .updateTable("relations")
        .set({ usage_count: sql`usage_count + 1` })
        .where("name", "=", relationType)
        .execute();

      // Insert edge
      const edge = await ctx.db
        .insertInto("edges")
        .values({
          source_id: sourceId,
          target_id: targetId,
          relation_type: relationType,
          properties: JSON.stringify(properties ?? {}),
          valid_from: validFrom ? new Date(validFrom) : null,
          valid_to: validTo ? new Date(validTo) : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        id: edge.id,
        sourceId: edge.source_id,
        targetId: edge.target_id,
        relationType: edge.relation_type,
        properties: edge.properties,
        validFrom: edge.valid_from,
        validTo: edge.valid_to,
        createdAt: edge.created_at,
      };
    },

    async deleteEdge(_: unknown, args: { id: string }, ctx: GraphContext) {
      // Decrement usage count for the relation
      const edge = await ctx.db
        .selectFrom("edges")
        .select("relation_type")
        .where("id", "=", args.id)
        .executeTakeFirst();

      if (edge) {
        await ctx.db
          .updateTable("relations")
          .set({ usage_count: sql`GREATEST(usage_count - 1, 0)` })
          .where("name", "=", edge.relation_type)
          .execute();
      }

      const result = await ctx.db
        .deleteFrom("edges")
        .where("id", "=", args.id)
        .executeTakeFirst();

      return (result?.numDeletedRows ?? 0n) > 0n;
    },
  },
};
