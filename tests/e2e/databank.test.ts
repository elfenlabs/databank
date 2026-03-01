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
      schema: { nodeCount: number; edgeCount: number; labels: string[]; relationTypes: string[] };
    }>(`{ schema { nodeCount edgeCount labels relationTypes } }`);

    expect(errors).toBeUndefined();
    expect(data!.schema.nodeCount).toBe(0);
    expect(data!.schema.edgeCount).toBe(0);
    expect(data!.schema.labels).toEqual([]);
    expect(data!.schema.relationTypes).toEqual([]);
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
          text: "TypeScript is a typed superset of JavaScript"
          labels: ["language", "programming"]
          properties: { name: "TypeScript", paradigm: "multi-paradigm" }
        }) { id content labels properties }

        rust: createNode(input: {
          text: "Rust is a systems programming language focused on safety"
          labels: ["language", "programming"]
          properties: { name: "Rust" }
        }) { id content labels }

        pg: createNode(input: {
          text: "PostgreSQL is a powerful relational database"
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

  // 3. EXACT search by property
  test("searchNodes EXACT finds by property", async () => {
    const { data, errors } = await gql<{
      searchNodes: { totalCount: number; edges: Array<{ node: { id: string; content: string } }> };
    }>(`{
      searchNodes(match: EXACT, property: "name", value: "TypeScript") {
        totalCount
        edges { node { id content } }
      }
    }`);

    expect(errors).toBeUndefined();
    expect(data!.searchNodes.totalCount).toBe(1);
    expect(data!.searchNodes.edges[0]!.node.id).toBe(nodeIds.ts);
  });

  // 4. SEMANTIC search
  test("searchNodes SEMANTIC finds similar content", async () => {
    const { data, errors } = await gql<{
      searchNodes: { totalCount: number; edges: Array<{ node: { id: string; labels: string[] } }> };
    }>(`{
      searchNodes(match: SEMANTIC, value: "programming language", threshold: 0.3) {
        totalCount
        edges { node { id labels } }
      }
    }`);

    expect(errors).toBeUndefined();
    // Should find at least TS and Rust (programming languages)
    expect(data!.searchNodes.totalCount).toBeGreaterThanOrEqual(2);
    const ids = data!.searchNodes.edges.map((e) => e.node.id);
    expect(ids).toContain(nodeIds.ts);
    expect(ids).toContain(nodeIds.rust);
  });

  // 5. Create edge + auto-register relation
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

  // 6. Connections query
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

  // 7. Relations list
  test("relations lists registered types with usage counts", async () => {
    const { data, errors } = await gql<{
      relations: Array<{ name: string; usageCount: number }>;
    }>(`{ relations { name usageCount } }`);

    expect(errors).toBeUndefined();
    const runsOn = data!.relations.find((r) => r.name === "RUNS_ON");
    expect(runsOn).toBeTruthy();
    expect(runsOn!.usageCount).toBe(1);
  });

  // 8. Orphans — Rust has no edges
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

  // 9. Delete edge + node
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
