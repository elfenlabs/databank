import { entityResolvers } from "./entities.ts";
import { relationResolvers } from "./relations.ts";
import { pathResolvers } from "./path.ts";
import { edgeResolvers } from "./edges.ts";
import { registryResolvers } from "./registry.ts";
import { maintenanceResolvers } from "./maintenance.ts";
import { memoryStreamResolvers } from "./memory-stream.ts";

/**
 * Deep-merge all resolver maps into a single object.
 * Handles Query + Mutation namespaces from each module.
 */
function mergeResolvers(
  ...maps: Array<Record<string, Record<string, Function>>>
): Record<string, Record<string, Function>> {
  const result: Record<string, Record<string, Function>> = {};

  for (const map of maps) {
    for (const [typeName, fields] of Object.entries(map)) {
      result[typeName] = { ...result[typeName], ...fields };
    }
  }

  return result;
}

const nodeResolver = {
  Node: {
    __resolveType(obj: any) {
      if ("content" in obj && "source" in obj) return "MemoryStreamEntry";
      if ("name" in obj) return "Entity";
      if ("sourceId" in obj || "source_id" in obj) return "Edge";
      return null;
    },
  },
};

/**
 * Consumer resolvers — cherry-picks only the queries and mutations visible
 * in the consumer schema. We must be precise because graphql-tools enforces
 * resolver–schema parity (no extra resolvers allowed).
 */
export const consumerResolvers = mergeResolvers(
  { Query: { entities: entityResolvers.Query.entities } },
  { Query: { relations: relationResolvers.Query.relations } },
  pathResolvers,
  { Query: { schema: maintenanceResolvers.Query.schema } },
  {
    Query: { memoryStream: memoryStreamResolvers.Query.memoryStream },
    Mutation: { appendMemory: memoryStreamResolvers.Mutation.appendMemory },
  },
  nodeResolver,
);

/**
 * Admin resolvers — full set including entity/edge CRUD,
 * registry management, and maintenance queries.
 */
export const adminResolvers = mergeResolvers(
  entityResolvers,
  relationResolvers,
  pathResolvers,
  edgeResolvers,
  registryResolvers,
  maintenanceResolvers,
  memoryStreamResolvers,
  nodeResolver,
);

/** @deprecated Use `adminResolvers` or `consumerResolvers` explicitly. */
export const resolvers = adminResolvers;
