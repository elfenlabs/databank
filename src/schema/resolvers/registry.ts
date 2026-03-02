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
// Generic registry resolver factory
// ---------------------------------------------------------------------------

type RegistryTable = "relations" | "property_keys";

/** What table to check for usage when deleting a registry entry. */
interface UsageGuard {
  table: "edges" | "node_properties";
  column: string;
  label: string; // human-readable name for error messages
}

interface RegistryConfig {
  registryTable: RegistryTable;
  usageGuard: UsageGuard;
}

function makeRegistryResolvers(config: RegistryConfig) {
  const { registryTable, usageGuard } = config;

  return {
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
          .selectFrom(registryTable)
          .select(sql<number>`count(*)`.as("count"))
          .executeTakeFirstOrThrow();
        const totalCount = Number(countResult.count);

        const rows = await ctx.db
          .selectFrom(registryTable)
          .selectAll()
          .orderBy("usage_count", "desc")
          .offset(offset)
          .limit(limit)
          .execute();

        return formatResult(rows, totalCount, offset, limit, () => 1.0);
      }

      if (args.match === "EXACT") {
        const countResult = await ctx.db
          .selectFrom(registryTable)
          .select(sql<number>`count(*)`.as("count"))
          .where("name", "=", args.value)
          .executeTakeFirstOrThrow();
        const totalCount = Number(countResult.count);

        const rows = await ctx.db
          .selectFrom(registryTable)
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
        .selectFrom(registryTable)
        .select(sql<number>`count(*)`.as("count"))
        .where(
          sql`1 - (name_vector <=> ${vecLiteral}::vector)`,
          ">=",
          args.threshold,
        )
        .executeTakeFirstOrThrow();
      const totalCount = Number(countResult.count);

      const rows = await ctx.db
        .selectFrom(registryTable)
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
        .insertInto(registryTable)
        .values({
          name: args.name,
          description: args.description ?? null,
          name_vector: sql`${nameVector}::vector`,
        } as any)
        .onConflict((oc) =>
          oc.column("name").doUpdateSet({
            description: args.description ?? sql`${registryTable}.description`,
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
        .selectFrom(registryTable)
        .select("name")
        .where("name", "=", args.target)
        .executeTakeFirst();

      if (!existing) {
        const nameVector = toVectorLiteral(await embed(args.target));
        await ctx.db
          .insertInto(registryTable)
          .values({
            name: args.target,
            name_vector: sql`${nameVector}::vector`,
          } as any)
          .execute();
      }

      // Re-label references from sources → target
      if (registryTable === "relations") {
        await ctx.db
          .updateTable("edges")
          .set({ relation_type: args.target })
          .where("relation_type", "in", args.sources)
          .execute();
      } else {
        await ctx.db
          .updateTable("node_properties")
          .set({ key: args.target })
          .where("key", "in", args.sources)
          .execute();
      }

      // Sum usage counts from sources into target
      const sourceCounts = await ctx.db
        .selectFrom(registryTable)
        .select(sql<number>`COALESCE(SUM(usage_count), 0)`.as("total"))
        .where("name", "in", args.sources)
        .executeTakeFirstOrThrow();

      await ctx.db
        .updateTable(registryTable)
        .set({
          usage_count: sql`usage_count + ${Number(sourceCounts.total)}`,
        })
        .where("name", "=", args.target)
        .execute();

      // Delete source entries
      await ctx.db
        .deleteFrom(registryTable)
        .where("name", "in", args.sources)
        .execute();

      const result = await ctx.db
        .selectFrom(registryTable)
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
      // Check if any references still exist
      const usedBy = await ctx.db
        .selectFrom(usageGuard.table as any)
        .select(sql<number>`count(*)`.as("count"))
        .where(usageGuard.column as any, "=", args.name)
        .executeTakeFirstOrThrow();

      if (Number(usedBy.count) > 0) {
        throw new GraphQLError(
          `Cannot delete ${usageGuard.label} '${args.name}': still referenced by ${usedBy.count} row(s)`,
          { extensions: { code: "CONFLICT" } },
        );
      }

      const result = await ctx.db
        .deleteFrom(registryTable)
        .where("name", "=", args.name)
        .executeTakeFirst();

      return (result?.numDeletedRows ?? 0n) > 0n;
    },
  };
}

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
// Auto-register helper (used by node resolvers)
// ---------------------------------------------------------------------------

/**
 * Auto-register property keys into the property_keys registry.
 * Inserts new keys and increments usage_count for each occurrence.
 */
export async function autoRegisterPropertyKeys(
  ctx: GraphContext,
  keys: string[],
) {
  for (const key of keys) {
    const existing = await ctx.db
      .selectFrom("property_keys")
      .select("name")
      .where("name", "=", key)
      .executeTakeFirst();

    if (!existing) {
      const nameVector = toVectorLiteral(await embed(key));
      await ctx.db
        .insertInto("property_keys")
        .values({
          name: key,
          name_vector: sql`${nameVector}::vector`,
        } as any)
        .onConflict((oc) => oc.column("name").doNothing())
        .execute();
    }

    await ctx.db
      .updateTable("property_keys")
      .set({ usage_count: sql`usage_count + 1` })
      .where("name", "=", key)
      .execute();
  }
}

/**
 * Decrement usage_count for property keys (used during updateNode property replacement).
 */
export async function decrementPropertyKeys(
  ctx: GraphContext,
  keys: string[],
) {
  for (const key of keys) {
    await ctx.db
      .updateTable("property_keys")
      .set({ usage_count: sql`GREATEST(usage_count - 1, 0)` })
      .where("name", "=", key)
      .execute();
  }
}

// ---------------------------------------------------------------------------
// Instantiate resolvers for both registries
// ---------------------------------------------------------------------------

const relations = makeRegistryResolvers({
  registryTable: "relations",
  usageGuard: { table: "edges", column: "relation_type", label: "relation" },
});

const properties = makeRegistryResolvers({
  registryTable: "property_keys",
  usageGuard: { table: "node_properties", column: "key", label: "property" },
});

export const registryResolvers = {
  Query: {
    relationKeys: relations.query,
    propertyKeys: properties.query,
  },
  Mutation: {
    registerRelation: relations.register,
    mergeRelations: relations.merge,
    deleteRelation: relations.delete,
    registerProperty: properties.register,
    mergeProperties: properties.merge,
    deleteProperty: properties.delete,
  },
};
