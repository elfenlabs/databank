import { entityResolvers } from "./entities.ts";
import { relationResolvers } from "./relations.ts";
import { pathResolvers } from "./path.ts";
import { edgeResolvers } from "./edges.ts";
import { registryResolvers } from "./registry.ts";
import { maintenanceResolvers } from "./maintenance.ts";

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

export const resolvers = mergeResolvers(
  entityResolvers,
  relationResolvers,
  pathResolvers,
  edgeResolvers,
  registryResolvers,
  maintenanceResolvers,
  {
    Node: {
      __resolveType(obj: any) {
        if ("name" in obj) return "Entity";
        if ("sourceId" in obj || "source_id" in obj) return "Edge";
        return null;
      },
    },
  },
);
