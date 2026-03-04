import { sql } from "kysely";
import { GraphQLError } from "graphql";
import { embed, embedBatch } from "../../embedder/client.ts";
import {
  decodeCursor,
  paginate,
  toVectorLiteral,
  type GraphContext,
} from "../context.ts";
import { resolveEntity, resolveEntities } from "./shared.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the text that gets embedded: "{name}: {details}" or just "{name}". */
function embedText(name: string, details?: string | null): string {
  return details ? `${name}: ${details}` : name;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate that all trait names exist and all property keys are allowed.
 * Throws GraphQLError on any violation.
 */
async function validateTraits(
  ctx: GraphContext,
  traits: Array<{ name: string; properties?: Record<string, unknown> | null }>,
) {
  if (traits.length === 0) return;

  const traitNames = traits.map((t) => t.name);

  // 1. Check all trait names exist
  const existing = await ctx.db
    .selectFrom("traits")
    .select("name")
    .where("name", "in", traitNames)
    .execute();

  const existingSet = new Set(existing.map((r) => r.name));
  const missing = traitNames.filter((n) => !existingSet.has(n));
  if (missing.length > 0) {
    throw new GraphQLError(
      `Unknown trait(s): ${missing.join(", ")}`,
      { extensions: { code: "BAD_REQUEST" } },
    );
  }

  // 2. For each trait with properties, validate keys against trait_properties
  for (const trait of traits) {
    const props = trait.properties;
    if (!props || Object.keys(props).length === 0) continue;

    const allowedKeys = await ctx.db
      .selectFrom("trait_properties")
      .select("key")
      .where("trait_name", "=", trait.name)
      .execute();

    const allowedSet = new Set(allowedKeys.map((r) => r.key));
    const unknown = Object.keys(props).filter((k) => !allowedSet.has(k));
    if (unknown.length > 0) {
      throw new GraphQLError(
        `Trait '${trait.name}' does not define property key(s): ${unknown.join(", ")}`,
        { extensions: { code: "BAD_REQUEST" } },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

export const entityResolvers = {
  Query: {
    async entities(
      _: unknown,
      args: {
        search?: { query: string; threshold: number };
        traitFilter?: Array<{ trait: string; properties?: Record<string, unknown> }>;
        first: number;
        after?: string;
      },
      ctx: GraphContext,
    ) {
      const limit = args.first;
      const offset = args.after ? decodeCursor(args.after) + 1 : 0;

      let query = ctx.db.selectFrom("entities");

      // Trait filter: each filter is an AND (entity must match all)
      if (args.traitFilter && args.traitFilter.length > 0) {
        for (const filter of args.traitFilter) {
          let subquery = ctx.db
            .selectFrom("entity_traits")
            .select("entity_id")
            .where("trait_name", "=", filter.trait);

          // Optional JSONB containment on trait properties
          if (filter.properties && Object.keys(filter.properties).length > 0) {
            const jsonFilter = JSON.stringify(filter.properties);
            subquery = subquery.where(({ eb }) =>
              eb(sql`properties @> ${jsonFilter}::jsonb`, "=", sql`true`),
            ) as any;
          }

          query = query.where("entities.id", "in", subquery);
        }
      }

      // Semantic search (vector similarity)
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

      // Fetch rows — order by similarity if searching, otherwise by recency
      let dataQuery = query.selectAll("entities");
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
        dataQuery = dataQuery.orderBy("entities.created_at", "desc");
      }

      const rows = await dataQuery.offset(offset).limit(limit).execute();
      const scores = vecLiteral
        ? rows.map((r: any) => r.score as number)
        : undefined;
      const entities = await resolveEntities(ctx.db, rows);
      return paginate(entities, totalCount, offset, limit, scores);
    },
  },

  Mutation: {
    async createEntity(
      _: unknown,
      args: {
        input: {
          name: string;
          details?: string | null;
          traits: Array<{ name: string; properties?: Record<string, unknown> }>;
        };
      },
      ctx: GraphContext,
    ) {
      // Validate traits + property keys
      await validateTraits(ctx, args.input.traits);

      // Embed composite text
      const text = embedText(args.input.name, args.input.details);
      const vector = toVectorLiteral(await embed(text));

      // Insert entity
      const entity = await ctx.db
        .insertInto("entities")
        .values({
          name: args.input.name,
          details: args.input.details ?? null,
          embedding: sql`${vector}::vector`,
        } as any)
        .returningAll()
        .executeTakeFirstOrThrow();

      // Insert trait assignments
      if (args.input.traits.length > 0) {
        await ctx.db
          .insertInto("entity_traits")
          .values(
            args.input.traits.map((t) => ({
              entity_id: entity.id,
              trait_name: t.name,
              properties: JSON.stringify(t.properties ?? {}),
            })),
          )
          .execute();

        // Increment usage counts
        await ctx.db
          .updateTable("traits")
          .set({ usage_count: sql`usage_count + 1` })
          .where("name", "in", args.input.traits.map((t) => t.name))
          .execute();
      }

      return resolveEntity(ctx.db, entity);
    },

    async updateEntity(
      _: unknown,
      args: {
        id: string;
        input: {
          name?: string;
          details?: string;
          traits?: Array<{ name: string; properties?: Record<string, unknown> }>;
        };
      },
      ctx: GraphContext,
    ) {
      const { id, input } = args;

      // Re-embed if name or details changed
      if (input.name != null || input.details != null) {
        // Fetch current row to combine with partial update
        const current = await ctx.db
          .selectFrom("entities")
          .select(["name", "details"])
          .where("id", "=", id)
          .executeTakeFirstOrThrow();

        const newName = input.name ?? current.name;
        const newDetails = input.details !== undefined ? input.details : current.details;
        const text = embedText(newName, newDetails);
        const vector = toVectorLiteral(await embed(text));

        await ctx.db
          .updateTable("entities")
          .set({
            name: newName,
            details: newDetails,
            embedding: sql`${vector}::vector`,
          } as any)
          .where("id", "=", id)
          .execute();
      }

      // Replace traits if provided
      if (input.traits != null) {
        await validateTraits(ctx, input.traits);

        // Get old trait names for decrement
        const oldTraits = await ctx.db
          .selectFrom("entity_traits")
          .select("trait_name")
          .where("entity_id", "=", id)
          .execute();

        // Delete old trait assignments
        await ctx.db
          .deleteFrom("entity_traits")
          .where("entity_id", "=", id)
          .execute();

        // Decrement old usage counts
        if (oldTraits.length > 0) {
          await ctx.db
            .updateTable("traits")
            .set({ usage_count: sql`GREATEST(usage_count - 1, 0)` })
            .where("name", "in", oldTraits.map((t) => t.trait_name))
            .execute();
        }

        // Insert new trait assignments
        if (input.traits.length > 0) {
          await ctx.db
            .insertInto("entity_traits")
            .values(
              input.traits.map((t) => ({
                entity_id: id,
                trait_name: t.name,
                properties: JSON.stringify(t.properties ?? {}),
              })),
            )
            .execute();

          await ctx.db
            .updateTable("traits")
            .set({ usage_count: sql`usage_count + 1` })
            .where("name", "in", input.traits.map((t) => t.name))
            .execute();
        }
      }

      const row = await ctx.db
        .selectFrom("entities")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();

      return resolveEntity(ctx.db, row);
    },

    async deleteEntity(_: unknown, args: { id: string }, ctx: GraphContext) {
      // Decrement trait usage counts before deletion
      const oldTraits = await ctx.db
        .selectFrom("entity_traits")
        .select("trait_name")
        .where("entity_id", "=", args.id)
        .execute();

      if (oldTraits.length > 0) {
        await ctx.db
          .updateTable("traits")
          .set({ usage_count: sql`GREATEST(usage_count - 1, 0)` })
          .where("name", "in", oldTraits.map((t) => t.trait_name))
          .execute();
      }

      const result = await ctx.db
        .deleteFrom("entities")
        .where("id", "=", args.id)
        .executeTakeFirst();
      return (result?.numDeletedRows ?? 0n) > 0n;
    },
  },
};
