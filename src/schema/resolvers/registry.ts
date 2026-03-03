import { sql } from "kysely";
import { GraphQLError } from "graphql";
import { embed } from "../../embedder/client.ts";
import {
  decodeCursor,
  encodeCursor,
  toVectorLiteral,
  type GraphContext,
} from "../context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toEntry(row: any) {
  return {
    name: row.name,
    description: row.description ?? null,
    usageCount: row.usage_count,
    createdAt: row.created_at,
  };
}

function formatResult<T>(
  rows: T[],
  totalCount: number,
  offset: number,
  limit: number,
  getScore: (row: T) => number,
) {
  const edges = rows.map((row, i) => ({
    node: toEntry(row),
    score: getScore(row),
    cursor: encodeCursor(offset + i),
  }));

  return {
    edges,
    pageInfo: {
      hasNextPage: offset + limit < totalCount,
      hasPreviousPage: offset > 0,
      startCursor: edges.length > 0 ? edges[0]!.cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
    },
    totalCount,
  };
}

// ---------------------------------------------------------------------------
// Relations registry (with semantic search via name_vector)
// ---------------------------------------------------------------------------

const relationResolvers = {
  async query(
    _: unknown,
    args: {
      match?: "EXACT" | "SEMANTIC";
      value?: string;
      threshold?: number;
      first?: number;
      after?: string;
    },
    ctx: GraphContext,
  ) {
    const limit = args.first ?? 20;
    const offset = args.after ? decodeCursor(args.after) + 1 : 0;

    // No filter → return all entries paginated
    if (!args.match || !args.value) {
      const countResult = await ctx.db
        .selectFrom("relations")
        .select(sql<number>`count(*)`.as("count"))
        .executeTakeFirstOrThrow();
      const totalCount = Number(countResult.count);

      const rows = await ctx.db
        .selectFrom("relations")
        .selectAll()
        .orderBy("usage_count", "desc")
        .offset(offset)
        .limit(limit)
        .execute();

      return formatResult(rows, totalCount, offset, limit, () => 1.0);
    }

    if (args.match === "EXACT") {
      const countResult = await ctx.db
        .selectFrom("relations")
        .select(sql<number>`count(*)`.as("count"))
        .where("name", "=", args.value)
        .executeTakeFirstOrThrow();
      const totalCount = Number(countResult.count);

      const rows = await ctx.db
        .selectFrom("relations")
        .selectAll()
        .where("name", "=", args.value)
        .offset(offset)
        .limit(limit)
        .execute();

      return formatResult(rows, totalCount, offset, limit, () => 1.0);
    }

    // SEMANTIC match
    if (args.threshold == null) {
      throw new GraphQLError(
        "'threshold' is required for SEMANTIC match",
        { extensions: { code: "BAD_REQUEST" } },
      );
    }

    const queryVector = await embed(args.value);
    const vecLiteral = toVectorLiteral(queryVector);

    const countResult = await ctx.db
      .selectFrom("relations")
      .select(sql<number>`count(*)`.as("count"))
      .where(
        sql`1 - (name_vector <=> ${vecLiteral}::vector)`,
        ">=",
        args.threshold,
      )
      .executeTakeFirstOrThrow();
    const totalCount = Number(countResult.count);

    const rows = await ctx.db
      .selectFrom("relations")
      .selectAll()
      .select(
        sql<number>`1 - (name_vector <=> ${vecLiteral}::vector)`.as(
          "similarity",
        ),
      )
      .where(
        sql`1 - (name_vector <=> ${vecLiteral}::vector)`,
        ">=",
        args.threshold,
      )
      .orderBy(sql`name_vector <=> ${vecLiteral}::vector`, "asc")
      .offset(offset)
      .limit(limit)
      .execute();

    return formatResult(
      rows,
      totalCount,
      offset,
      limit,
      (r) => (r as any).similarity ?? 1.0,
    );
  },

  async register(
    _: unknown,
    args: { name: string; description?: string },
    ctx: GraphContext,
  ) {
    const nameVector = toVectorLiteral(await embed(args.name));

    const row = await ctx.db
      .insertInto("relations")
      .values({
        name: args.name,
        description: args.description ?? null,
        name_vector: sql`${nameVector}::vector`,
      } as any)
      .onConflict((oc) =>
        oc.column("name").doUpdateSet({
          description: args.description ?? sql`relations.description`,
          name_vector: sql`${nameVector}::vector`,
        } as any),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return toEntry(row);
  },

  async merge(
    _: unknown,
    args: { sources: string[]; target: string },
    ctx: GraphContext,
  ) {
    // Ensure target exists
    const existing = await ctx.db
      .selectFrom("relations")
      .select("name")
      .where("name", "=", args.target)
      .executeTakeFirst();

    if (!existing) {
      const nameVector = toVectorLiteral(await embed(args.target));
      await ctx.db
        .insertInto("relations")
        .values({
          name: args.target,
          name_vector: sql`${nameVector}::vector`,
        } as any)
        .execute();
    }

    // Re-label edge references
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

    // Delete source entries
    await ctx.db
      .deleteFrom("relations")
      .where("name", "in", args.sources)
      .execute();

    const result = await ctx.db
      .selectFrom("relations")
      .selectAll()
      .where("name", "=", args.target)
      .executeTakeFirstOrThrow();

    return toEntry(result);
  },

  async delete(
    _: unknown,
    args: { name: string },
    ctx: GraphContext,
  ) {
    // Check if any edges still reference this relation
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
};

// ---------------------------------------------------------------------------
// Property keys registry (simple vocabulary — no embeddings)
// ---------------------------------------------------------------------------

const propertyResolvers = {
  async query(
    _: unknown,
    args: {
      first?: number;
      after?: string;
    },
    ctx: GraphContext,
  ) {
    const limit = args.first ?? 20;
    const offset = args.after ? decodeCursor(args.after) + 1 : 0;

    const countResult = await ctx.db
      .selectFrom("property_keys")
      .select(sql<number>`count(*)`.as("count"))
      .executeTakeFirstOrThrow();
    const totalCount = Number(countResult.count);

    const rows = await ctx.db
      .selectFrom("property_keys")
      .selectAll()
      .orderBy("usage_count", "desc")
      .offset(offset)
      .limit(limit)
      .execute();

    return formatResult(rows, totalCount, offset, limit, () => 1.0);
  },

  async register(
    _: unknown,
    args: { name: string; description?: string },
    ctx: GraphContext,
  ) {
    const row = await ctx.db
      .insertInto("property_keys")
      .values({
        name: args.name,
        description: args.description ?? null,
      })
      .onConflict((oc) =>
        oc.column("name").doUpdateSet({
          description: args.description ?? sql`property_keys.description`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return toEntry(row);
  },

  async merge(
    _: unknown,
    args: { sources: string[]; target: string },
    ctx: GraphContext,
  ) {
    // Ensure target exists
    const existing = await ctx.db
      .selectFrom("property_keys")
      .select("name")
      .where("name", "=", args.target)
      .executeTakeFirst();

    if (!existing) {
      await ctx.db
        .insertInto("property_keys")
        .values({ name: args.target })
        .execute();
    }

    // Re-label JSONB keys in entities: rename source keys to target
    for (const source of args.sources) {
      await sql`
        UPDATE entities
        SET properties = properties - ${source} || jsonb_build_object(${args.target}, properties->${source})
        WHERE properties ? ${source}
      `.execute(ctx.db);
    }

    // Sum usage counts from sources into target
    const sourceCounts = await ctx.db
      .selectFrom("property_keys")
      .select(sql<number>`COALESCE(SUM(usage_count), 0)`.as("total"))
      .where("name", "in", args.sources)
      .executeTakeFirstOrThrow();

    await ctx.db
      .updateTable("property_keys")
      .set({
        usage_count: sql`usage_count + ${Number(sourceCounts.total)}`,
      })
      .where("name", "=", args.target)
      .execute();

    // Delete source entries
    await ctx.db
      .deleteFrom("property_keys")
      .where("name", "in", args.sources)
      .execute();

    const result = await ctx.db
      .selectFrom("property_keys")
      .selectAll()
      .where("name", "=", args.target)
      .executeTakeFirstOrThrow();

    return toEntry(result);
  },

  async delete(
    _: unknown,
    args: { name: string },
    ctx: GraphContext,
  ) {
    // Check if any entities still use this key in their JSONB properties
    const usedBy = await sql<{ count: number }>`
      SELECT count(*) as count FROM entities WHERE properties ? ${args.name}
    `.execute(ctx.db);

    const count = Number(usedBy.rows[0]?.count ?? 0);
    if (count > 0) {
      throw new GraphQLError(
        `Cannot delete property '${args.name}': still referenced by ${count} entity(ies)`,
        { extensions: { code: "CONFLICT" } },
      );
    }

    const result = await ctx.db
      .deleteFrom("property_keys")
      .where("name", "=", args.name)
      .executeTakeFirst();

    return (result?.numDeletedRows ?? 0n) > 0n;
  },
};

// ---------------------------------------------------------------------------
// Exported resolvers
// ---------------------------------------------------------------------------

export const registryResolvers = {
  Query: {
    relationKeys: relationResolvers.query,
    propertyKeys: propertyResolvers.query,
  },
  Mutation: {
    registerRelation: relationResolvers.register,
    mergeRelations: relationResolvers.merge,
    deleteRelation: relationResolvers.delete,
    registerProperty: propertyResolvers.register,
    mergeProperties: propertyResolvers.merge,
    deleteProperty: propertyResolvers.delete,
  },
};
