import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setup, teardown } from "./setup.ts";
import { gql } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setup();
}, 120_000); // embedder build + model download can take a while

afterAll(async () => {
  await teardown();
});

// ---------------------------------------------------------------------------
// Shared state across sequential tests
// ---------------------------------------------------------------------------

const nodeIds = { ts: "", rust: "", pg: "" };
let edgeId = "";

// ---------------------------------------------------------------------------
// Tests — run sequentially, each builds on previous state
// ---------------------------------------------------------------------------

describe("Databank E2E", () => {
  // 1. Schema query — empty DB
  test("schema returns empty counts", async () => {
    const { data, errors } = await gql<{
      schema: { nodeCount: number; edgeCount: number; labels: string[]; relationTypes: string[]; propertyKeys: string[] };
    }>(`{ schema { nodeCount edgeCount labels relationTypes propertyKeys } }`);

    expect(errors).toBeUndefined();
    expect(data!.schema.nodeCount).toBe(0);
    expect(data!.schema.edgeCount).toBe(0);
    expect(data!.schema.labels).toEqual([]);
    expect(data!.schema.relationTypes).toEqual([]);
    expect(data!.schema.propertyKeys).toEqual([]);
  });

  // 2. Create nodes
  test("createNode returns correct fields", async () => {
    const { data, errors } = await gql<{
      ts: { id: string; content: string; labels: string[]; properties: Record<string, string> };
      rust: { id: string; content: string; labels: string[] };
      pg: { id: string; content: string; labels: string[] };
    }>(`
      mutation {
        ts: createNode(input: {
          content: "TypeScript is a typed superset of JavaScript"
          labels: ["language", "programming"]
          properties: { name: "TypeScript", paradigm: "multi-paradigm" }
        }) { id content labels properties }

        rust: createNode(input: {
          content: "Rust is a systems programming language focused on safety"
          labels: ["language", "programming"]
          properties: { name: "Rust" }
        }) { id content labels }

        pg: createNode(input: {
          content: "PostgreSQL is a powerful relational database"
          labels: ["database", "infrastructure"]
          properties: { name: "PostgreSQL" }
        }) { id content labels }
      }
    `);

    expect(errors).toBeUndefined();
    expect(data!.ts.content).toBe("TypeScript is a typed superset of JavaScript");
    expect(data!.ts.labels).toEqual(["language", "programming"]);
    expect(data!.ts.properties).toEqual({ name: "TypeScript", paradigm: "multi-paradigm" });
    expect(data!.rust.id).toBeTruthy();
    expect(data!.pg.id).toBeTruthy();

    // Save IDs for later tests
    nodeIds.ts = data!.ts.id;
    nodeIds.rust = data!.rust.id;
    nodeIds.pg = data!.pg.id;
  });

  // 3. Property keys auto-registered
  test("propertyKeys auto-registered from createNode", async () => {
    const { data, errors } = await gql<{
      propertyKeys: { totalCount: number; edges: Array<{ node: { name: string; usageCount: number } }> };
    }>(`{ propertyKeys { totalCount edges { node { name usageCount } } } }`);

    expect(errors).toBeUndefined();
    expect(data!.propertyKeys.totalCount).toBeGreaterThanOrEqual(2);
    const keys = data!.propertyKeys.edges.map((e) => e.node.name);
    expect(keys).toContain("name");
    expect(keys).toContain("paradigm");

    // "name" used 3 times (TS, Rust, PG), "paradigm" used 1 time
    const nameEntry = data!.propertyKeys.edges.find((e) => e.node.name === "name");
    expect(nameEntry!.node.usageCount).toBe(3);
    const paradigmEntry = data!.propertyKeys.edges.find((e) => e.node.name === "paradigm");
    expect(paradigmEntry!.node.usageCount).toBe(1);
  });

  // 4. Filter by property
  test("nodes filters by property", async () => {
    const { data, errors } = await gql<{
      nodes: { totalCount: number; edges: Array<{ node: { id: string; content: string } }> };
    }>(`{
      nodes(properties: [{ key: "name", value: "TypeScript" }], first: 10) {
        totalCount
        edges { node { id content } }
      }
    }`);

    expect(errors).toBeUndefined();
    expect(data!.nodes.totalCount).toBe(1);
    expect(data!.nodes.edges[0]!.node.id).toBe(nodeIds.ts);
  });

  // 5. Semantic search
  test("nodes semantic search finds similar content", async () => {
    const { data, errors } = await gql<{
      nodes: { totalCount: number; edges: Array<{ node: { id: string; labels: string[] } }> };
    }>(`{
      nodes(search: { query: "programming language", threshold: 0.3 }, first: 10) {
        totalCount
        edges { node { id labels } }
      }
    }`);

    expect(errors).toBeUndefined();
    // Should find at least TS and Rust (programming languages)
    expect(data!.nodes.totalCount).toBeGreaterThanOrEqual(2);
    const ids = data!.nodes.edges.map((e) => e.node.id);
    expect(ids).toContain(nodeIds.ts);
    expect(ids).toContain(nodeIds.rust);
  });

  // 6. Create edge + auto-register relation
  test("createEdge auto-registers relation", async () => {
    const { data, errors } = await gql<{
      createEdge: { id: string; sourceId: string; targetId: string; relationType: string };
    }>(`
      mutation($input: CreateEdgeInput!) {
        createEdge(input: $input) { id sourceId targetId relationType }
      }
    `, {
      input: {
        sourceId: nodeIds.ts,
        targetId: nodeIds.pg,
        relationType: "RUNS_ON",
      },
    });

    expect(errors).toBeUndefined();
    expect(data!.createEdge.sourceId).toBe(nodeIds.ts);
    expect(data!.createEdge.targetId).toBe(nodeIds.pg);
    expect(data!.createEdge.relationType).toBe("RUNS_ON");
    edgeId = data!.createEdge.id;
  });

  // 7. Connections query
  test("connections returns outgoing edges", async () => {
    const { data, errors } = await gql<{
      connections: {
        totalCount: number;
        edges: Array<{ node: { id: string }; relationType: string }>;
      };
    }>(`
      query($nodeId: ID!) {
        connections(nodeId: $nodeId, direction: OUTGOING) {
          totalCount
          edges { node { id } relationType }
        }
      }
    `, { nodeId: nodeIds.ts });

    expect(errors).toBeUndefined();
    expect(data!.connections.totalCount).toBe(1);
    expect(data!.connections.edges[0]!.node.id).toBe(nodeIds.pg);
    expect(data!.connections.edges[0]!.relationType).toBe("RUNS_ON");
  });

  // 8. Relation keys list
  test("relationKeys lists registered types with usage counts", async () => {
    const { data, errors } = await gql<{
      relationKeys: { edges: Array<{ node: { name: string; usageCount: number } }> };
    }>(`{ relationKeys { edges { node { name usageCount } } } }`);

    expect(errors).toBeUndefined();
    const runsOn = data!.relationKeys.edges.find((e) => e.node.name === "RUNS_ON");
    expect(runsOn).toBeTruthy();
    expect(runsOn!.node.usageCount).toBe(1);
  });

  // 9. Register property with description
  test("registerProperty creates entry with description", async () => {
    const { data, errors } = await gql<{
      registerProperty: { name: string; description: string; usageCount: number };
    }>(`
      mutation {
        registerProperty(name: "version", description: "The version number of the software") {
          name description usageCount
        }
      }
    `);

    expect(errors).toBeUndefined();
    expect(data!.registerProperty.name).toBe("version");
    expect(data!.registerProperty.description).toBe("The version number of the software");
  });

  // 10. Register relation with description
  test("registerRelation creates entry with description", async () => {
    const { data, errors } = await gql<{
      registerRelation: { name: string; description: string };
    }>(`
      mutation {
        registerRelation(name: "DEPENDS_ON", description: "A dependency relationship between software components") {
          name description
        }
      }
    `);

    expect(errors).toBeUndefined();
    expect(data!.registerRelation.name).toBe("DEPENDS_ON");
    expect(data!.registerRelation.description).toBe("A dependency relationship between software components");
  });

  // 11. Orphans — Rust has no edges
  test("orphans returns unconnected nodes", async () => {
    const { data, errors } = await gql<{
      orphans: { totalCount: number; edges: Array<{ node: { id: string } }> };
    }>(`{ orphans { totalCount edges { node { id } } } }`);

    expect(errors).toBeUndefined();
    expect(data!.orphans.totalCount).toBeGreaterThanOrEqual(1);
    const ids = data!.orphans.edges.map((e) => e.node.id);
    expect(ids).toContain(nodeIds.rust);
    // TS and PG have edges, so they should NOT be orphans
    expect(ids).not.toContain(nodeIds.ts);
    expect(ids).not.toContain(nodeIds.pg);
  });

  // 12. Delete edge + node
  test("deleteEdge and deleteNode work", async () => {
    // Delete the edge
    const delEdge = await gql<{ deleteEdge: boolean }>(`
      mutation($id: ID!) { deleteEdge(id: $id) }
    `, { id: edgeId });
    expect(delEdge.errors).toBeUndefined();
    expect(delEdge.data!.deleteEdge).toBe(true);

    // Delete a node
    const delNode = await gql<{ deleteNode: boolean }>(`
      mutation($id: ID!) { deleteNode(id: $id) }
    `, { id: nodeIds.rust });
    expect(delNode.errors).toBeUndefined();
    expect(delNode.data!.deleteNode).toBe(true);

    // Verify schema counts
    const { data } = await gql<{
      schema: { nodeCount: number; edgeCount: number };
    }>(`{ schema { nodeCount edgeCount } }`);
    expect(data!.schema.nodeCount).toBe(2); // TS + PG remain
    expect(data!.schema.edgeCount).toBe(0); // edge deleted
  });
});
