import { sql } from "kysely";
import { embed, embedBatch } from "../../embedder/client.ts";
import {
  decodeCursor,
  paginate,
  toVectorLiteral,
  type GraphContext,
} from "../context.ts";
import { resolveNode, resolveNodes } from "./shared.ts";
import { autoRegisterPropertyKeys, decrementPropertyKeys } from "./registry.ts";

export const nodeResolvers = {
  Query: {
    async nodes(
      _: unknown,
      args: {
        search?: { query: string; threshold: number };
        labels?: string[];
        properties?: Array<{ key: string; value: string }>;
        first: number;
        after?: string;
      },
      ctx: GraphContext,
    ) {
      const limit = args.first;
      const offset = args.after ? decodeCursor(args.after) + 1 : 0;

      let query = ctx.db.selectFrom("nodes");

      // Labels filter (cheap, indexed)
      if (args.labels && args.labels.length > 0) {
        query = query.where(
          "nodes.id",
          "in",
          ctx.db
            .selectFrom("node_labels")
            .select("node_id")
            .where("label", "in", args.labels),
        );
      }

      // Properties filter (cheap, indexed) — each filter is an AND
      if (args.properties && args.properties.length > 0) {
        for (const { key, value } of args.properties) {
          query = query.where(
            "nodes.id",
            "in",
            ctx.db
              .selectFrom("node_properties")
              .select("node_id")
              .where("key", "=", key)
              .where("value", "=", value),
          );
        }
      }

      // Semantic search (vector similarity)
      let vecLiteral: string | null = null;
      if (args.search) {
        const queryVector = await embed(args.search.query);
        vecLiteral = toVectorLiteral(queryVector);
        query = query.where(
          sql`1 - (content_vector <=> ${vecLiteral}::vector)`,
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
      let dataQuery = query.selectAll("nodes");
      if (vecLiteral) {
        dataQuery = dataQuery.orderBy(
          sql`content_vector <=> ${vecLiteral}::vector`,
          "asc",
        );
      } else {
        dataQuery = dataQuery.orderBy("nodes.created_at", "desc");
      }

      const rows = await dataQuery.offset(offset).limit(limit).execute();
      const nodes = await resolveNodes(ctx.db, rows);
      return paginate(nodes, totalCount, offset, limit);
    },
  },

  Mutation: {
    async createNode(
      _: unknown,
      args: {
        input: {
          text: string;
          labels: string[];
          properties?: Record<string, string>;
        };
      },
      ctx: GraphContext,
    ) {
      // Embed content + labels in one batch call
      const textsToEmbed = [args.input.content, ...args.input.labels];
      const vectors = await embedBatch(textsToEmbed);
      const contentVector = toVectorLiteral(vectors[0]!);
      const labelVectors = vectors.slice(1);

      // Insert node
      const node = await ctx.db
        .insertInto("nodes")
        .values({
          content: args.input.content,
          content_vector: sql`${contentVector}::vector`,
        } as any)
        .returningAll()
        .executeTakeFirstOrThrow();

      // Insert labels
      if (args.input.labels.length > 0) {
        await ctx.db
          .insertInto("node_labels")
          .values(
            args.input.labels.map((label, i) => ({
              node_id: node.id,
              label,
              label_vector: sql`${toVectorLiteral(labelVectors[i]!)}::vector`,
            } as any)),
          )
          .execute();
      }

      // Insert properties + auto-register keys
      if (args.input.properties) {
        const entries = Object.entries(args.input.properties);
        if (entries.length > 0) {
          await ctx.db
            .insertInto("node_properties")
            .values(
              entries.map(([key, value]) => ({
                node_id: node.id,
                key,
                value,
              })),
            )
            .execute();

          await autoRegisterPropertyKeys(ctx, entries.map(([k]) => k));
        }
      }

      return resolveNode(ctx.db, node);
    },

    async updateNode(
      _: unknown,
      args: {
        id: string;
        input: {
          text?: string;
          labels?: string[];
          properties?: Record<string, string>;
        };
      },
      ctx: GraphContext,
    ) {
      const { id, input } = args;

      // Re-embed content if changed
      if (input.content != null) {
        const contentVector = toVectorLiteral(await embed(input.content));
        await ctx.db
          .updateTable("nodes")
          .set({
            content: input.content,
            content_vector: sql`${contentVector}::vector`,
          } as any)
          .where("id", "=", id)
          .execute();
      }

      // Replace labels if provided
      if (input.labels != null) {
        await ctx.db
          .deleteFrom("node_labels")
          .where("node_id", "=", id)
          .execute();

        if (input.labels.length > 0) {
          const labelVectors = await embedBatch(input.labels);
          await ctx.db
            .insertInto("node_labels")
            .values(
              input.labels.map((label, i) => ({
                node_id: id,
                label,
                label_vector: sql`${toVectorLiteral(labelVectors[i]!)}::vector`,
              } as any)),
            )
            .execute();
        }
      }

      // Replace properties if provided
      if (input.properties != null) {
        // Get old keys for decrementing
        const oldProps = await ctx.db
          .selectFrom("node_properties")
          .select("key")
          .where("node_id", "=", id)
          .execute();

        await ctx.db
          .deleteFrom("node_properties")
          .where("node_id", "=", id)
          .execute();

        // Decrement old keys
        if (oldProps.length > 0) {
          await decrementPropertyKeys(ctx, oldProps.map((p) => p.key));
        }

        const entries = Object.entries(input.properties);
        if (entries.length > 0) {
          await ctx.db
            .insertInto("node_properties")
            .values(
              entries.map(([key, value]) => ({
                node_id: id,
                key,
                value,
              })),
            )
            .execute();

          await autoRegisterPropertyKeys(ctx, entries.map(([k]) => k));
        }
      }

      const row = await ctx.db
        .selectFrom("nodes")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();

      return resolveNode(ctx.db, row);
    },

    async deleteNode(_: unknown, args: { id: string }, ctx: GraphContext) {
      const result = await ctx.db
        .deleteFrom("nodes")
        .where("id", "=", args.id)
        .executeTakeFirst();
      return (result?.numDeletedRows ?? 0n) > 0n;
    },
  },
};
