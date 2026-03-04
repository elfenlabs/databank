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

function toRegistryEntry(row: any) {
  return {
    name: row.name,
    description: row.description ?? null,
    usageCount: row.usage_count,
    createdAt: row.created_at,
  };
}

function formatRegistryResult<T>(
  rows: T[],
  totalCount: number,
  offset: number,
  limit: number,
  getScore: (row: T) => number,
) {
  const edges = rows.map((row, i) => ({
    node: toRegistryEntry(row),
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

function toTraitEntry(row: any, propertyKeys: string[]) {
  return {
    name: row.name,
    description: row.description ?? null,
    propertyKeys,
    usageCount: row.usage_count,
    createdAt: row.created_at,
  };
}

function formatTraitResult<T>(
  rows: T[],
  totalCount: number,
  offset: number,
  limit: number,
  getScore: (row: T) => number,
  propertyKeysMap: Map<string, string[]>,
) {
  const edges = rows.map((row, i) => ({
    node: toTraitEntry(row, propertyKeysMap.get((row as any).name) ?? []),
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

/** Fetch property keys for a set of trait names. */
async function fetchPropertyKeysMap(ctx: GraphContext, traitNames: string[]) {
  if (traitNames.length === 0) return new Map<string, string[]>();
  const rows = await ctx.db
    .selectFrom("trait_properties")
    .select(["trait_name", "key"])
    .where("trait_name", "in", traitNames)
    .execute();

  const map = new Map<string, string[]>();
  for (const row of rows) {
    const arr = map.get(row.trait_name) ?? [];
    arr.push(row.key);
    map.set(row.trait_name, arr);
  }
  return map;
}

/** Resolve a single trait by name. */
async function resolveTrait(ctx: GraphContext, name: string) {
  const row = await ctx.db
    .selectFrom("traits")
    .selectAll()
    .where("name", "=", name)
    .executeTakeFirstOrThrow();

  const keys = await ctx.db
    .selectFrom("trait_properties")
    .select("key")
    .where("trait_name", "=", name)
    .execute();

  return toTraitEntry(row, keys.map((k) => k.key));
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

      return formatRegistryResult(rows, totalCount, offset, limit, () => 1.0);
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

      return formatRegistryResult(rows, totalCount, offset, limit, () => 1.0);
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
        sql<number>`1 - (name_vector <=> ${vecLiteral}::vector)`.as("similarity"),
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

    return formatRegistryResult(
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

    return toRegistryEntry(row);
  },

  async merge(
    _: unknown,
    args: { sources: string[]; target: string },
    ctx: GraphContext,
  ) {
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

    await ctx.db
      .updateTable("edges")
      .set({ relation_type: args.target })
      .where("relation_type", "in", args.sources)
      .execute();

    const sourceCounts = await ctx.db
      .selectFrom("relations")
      .select(sql<number>`COALESCE(SUM(usage_count), 0)`.as("total"))
      .where("name", "in", args.sources)
      .executeTakeFirstOrThrow();

    await ctx.db
      .updateTable("relations")
      .set({ usage_count: sql`usage_count + ${Number(sourceCounts.total)}` })
      .where("name", "=", args.target)
      .execute();

    await ctx.db
      .deleteFrom("relations")
      .where("name", "in", args.sources)
      .execute();

    const result = await ctx.db
      .selectFrom("relations")
      .selectAll()
      .where("name", "=", args.target)
      .executeTakeFirstOrThrow();

    return toRegistryEntry(result);
  },

  async delete(
    _: unknown,
    args: { name: string },
    ctx: GraphContext,
  ) {
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
// Traits registry (with semantic search + property schema)
// ---------------------------------------------------------------------------

const traitResolvers = {
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

    if (!args.match || !args.value) {
      const countResult = await ctx.db
        .selectFrom("traits")
        .select(sql<number>`count(*)`.as("count"))
        .executeTakeFirstOrThrow();
      const totalCount = Number(countResult.count);

      const rows = await ctx.db
        .selectFrom("traits")
        .selectAll()
        .orderBy("usage_count", "desc")
        .offset(offset)
        .limit(limit)
        .execute();

      const keysMap = await fetchPropertyKeysMap(ctx, rows.map((r) => r.name));
      return formatTraitResult(rows, totalCount, offset, limit, () => 1.0, keysMap);
    }

    if (args.match === "EXACT") {
      const countResult = await ctx.db
        .selectFrom("traits")
        .select(sql<number>`count(*)`.as("count"))
        .where("name", "=", args.value)
        .executeTakeFirstOrThrow();
      const totalCount = Number(countResult.count);

      const rows = await ctx.db
        .selectFrom("traits")
        .selectAll()
        .where("name", "=", args.value)
        .offset(offset)
        .limit(limit)
        .execute();

      const keysMap = await fetchPropertyKeysMap(ctx, rows.map((r) => r.name));
      return formatTraitResult(rows, totalCount, offset, limit, () => 1.0, keysMap);
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
      .selectFrom("traits")
      .select(sql<number>`count(*)`.as("count"))
      .where(
        sql`1 - (name_vector <=> ${vecLiteral}::vector)`,
        ">=",
        args.threshold,
      )
      .executeTakeFirstOrThrow();
    const totalCount = Number(countResult.count);

    const rows = await ctx.db
      .selectFrom("traits")
      .selectAll()
      .select(
        sql<number>`1 - (name_vector <=> ${vecLiteral}::vector)`.as("similarity"),
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

    const keysMap = await fetchPropertyKeysMap(ctx, rows.map((r) => r.name));
    return formatTraitResult(
      rows,
      totalCount,
      offset,
      limit,
      (r) => (r as any).similarity ?? 1.0,
      keysMap,
    );
  },

  async register(
    _: unknown,
    args: { name: string; description?: string; propertyKeys?: string[] },
    ctx: GraphContext,
  ) {
    const nameVector = toVectorLiteral(await embed(args.name));

    await ctx.db
      .insertInto("traits")
      .values({
        name: args.name,
        description: args.description ?? null,
        name_vector: sql`${nameVector}::vector`,
      } as any)
      .onConflict((oc) =>
        oc.column("name").doUpdateSet({
          description: args.description ?? sql`traits.description`,
          name_vector: sql`${nameVector}::vector`,
        } as any),
      )
      .execute();

    // Register property keys if provided
    if (args.propertyKeys && args.propertyKeys.length > 0) {
      await ctx.db
        .insertInto("trait_properties")
        .values(
          args.propertyKeys.map((key) => ({
            trait_name: args.name,
            key,
          })),
        )
        .onConflict((oc) => oc.columns(["trait_name", "key"]).doNothing())
        .execute();
    }

    return resolveTrait(ctx, args.name);
  },

  async merge(
    _: unknown,
    args: { sources: string[]; target: string },
    ctx: GraphContext,
  ) {
    // Ensure target exists
    const existing = await ctx.db
      .selectFrom("traits")
      .select("name")
      .where("name", "=", args.target)
      .executeTakeFirst();

    if (!existing) {
      const nameVector = toVectorLiteral(await embed(args.target));
      await ctx.db
        .insertInto("traits")
        .values({
          name: args.target,
          name_vector: sql`${nameVector}::vector`,
        } as any)
        .execute();
    }

    // Re-label entity trait assignments
    await ctx.db
      .updateTable("entity_traits")
      .set({ trait_name: args.target })
      .where("trait_name", "in", args.sources)
      .execute();

    // Merge trait_properties definitions (copy unique keys from sources to target)
    const sourceProps = await ctx.db
      .selectFrom("trait_properties")
      .select(["key", "description"])
      .where("trait_name", "in", args.sources)
      .execute();

    if (sourceProps.length > 0) {
      await ctx.db
        .insertInto("trait_properties")
        .values(
          sourceProps.map((p) => ({
            trait_name: args.target,
            key: p.key,
            description: p.description,
          })),
        )
        .onConflict((oc) => oc.columns(["trait_name", "key"]).doNothing())
        .execute();
    }

    // Sum usage counts
    const sourceCounts = await ctx.db
      .selectFrom("traits")
      .select(sql<number>`COALESCE(SUM(usage_count), 0)`.as("total"))
      .where("name", "in", args.sources)
      .executeTakeFirstOrThrow();

    await ctx.db
      .updateTable("traits")
      .set({ usage_count: sql`usage_count + ${Number(sourceCounts.total)}` })
      .where("name", "=", args.target)
      .execute();

    // Delete sources (cascades trait_properties)
    await ctx.db
      .deleteFrom("traits")
      .where("name", "in", args.sources)
      .execute();

    return resolveTrait(ctx, args.target);
  },

  async delete(
    _: unknown,
    args: { name: string },
    ctx: GraphContext,
  ) {
    const usedBy = await ctx.db
      .selectFrom("entity_traits")
      .select(sql<number>`count(*)`.as("count"))
      .where("trait_name", "=", args.name)
      .executeTakeFirstOrThrow();

    if (Number(usedBy.count) > 0) {
      throw new GraphQLError(
        `Cannot delete trait '${args.name}': still assigned to ${usedBy.count} entity(ies)`,
        { extensions: { code: "CONFLICT" } },
      );
    }

    const result = await ctx.db
      .deleteFrom("traits")
      .where("name", "=", args.name)
      .executeTakeFirst();

    return (result?.numDeletedRows ?? 0n) > 0n;
  },

  async addTraitProperty(
    _: unknown,
    args: { trait: string; key: string; description?: string },
    ctx: GraphContext,
  ) {
    // Ensure trait exists
    const traitExists = await ctx.db
      .selectFrom("traits")
      .select("name")
      .where("name", "=", args.trait)
      .executeTakeFirst();

    if (!traitExists) {
      throw new GraphQLError(
        `Trait '${args.trait}' does not exist`,
        { extensions: { code: "NOT_FOUND" } },
      );
    }

    await ctx.db
      .insertInto("trait_properties")
      .values({
        trait_name: args.trait,
        key: args.key,
        description: args.description ?? null,
      })
      .onConflict((oc) =>
        oc.columns(["trait_name", "key"]).doUpdateSet({
          description: args.description ?? sql`trait_properties.description`,
        }),
      )
      .execute();

    return resolveTrait(ctx, args.trait);
  },

  async removeTraitProperty(
    _: unknown,
    args: { trait: string; key: string },
    ctx: GraphContext,
  ) {
    await ctx.db
      .deleteFrom("trait_properties")
      .where("trait_name", "=", args.trait)
      .where("key", "=", args.key)
      .execute();

    return resolveTrait(ctx, args.trait);
  },
};

// ---------------------------------------------------------------------------
// Exported resolvers
// ---------------------------------------------------------------------------

export const registryResolvers = {
  Query: {
    relationKeys: relationResolvers.query,
    traits: traitResolvers.query,
  },
  Mutation: {
    registerRelation: relationResolvers.register,
    mergeRelations: relationResolvers.merge,
    deleteRelation: relationResolvers.delete,
    registerTrait: traitResolvers.register,
    mergeTraits: traitResolvers.merge,
    deleteTrait: traitResolvers.delete,
    addTraitProperty: traitResolvers.addTraitProperty,
    removeTraitProperty: traitResolvers.removeTraitProperty,
  },
};
