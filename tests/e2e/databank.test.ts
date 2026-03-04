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

const entityIds = { ts: "", rust: "", pg: "" };
let edgeId = "";
let edgeId2 = "";

// ---------------------------------------------------------------------------
// Tests — run sequentially, each builds on previous state
// ---------------------------------------------------------------------------

describe("Databank E2E", () => {
  // 1. Schema query — fresh DB (seeded traits + relations, no entities/edges)
  test("schema returns seeded state", async () => {
    const { data, errors } = await gql<{
      schema: { entityCount: number; edgeCount: number; traits: string[]; relationTypes: string[] };
    }>(`{ schema { entityCount edgeCount traits relationTypes } }`);

    expect(errors).toBeUndefined();
    expect(data!.schema.entityCount).toBe(0);
    expect(data!.schema.edgeCount).toBe(0);
    // Starter traits and relations are seeded at boot
    expect(data!.schema.traits.length).toBeGreaterThanOrEqual(7);
    expect(data!.schema.traits).toContain("person");
    expect(data!.schema.traits).toContain("concept");
    expect(data!.schema.relationTypes.length).toBeGreaterThanOrEqual(11);
    expect(data!.schema.relationTypes).toContain("owns");
    expect(data!.schema.relationTypes).toContain("depends_on");
  });

  // 2. Create entities with traits
  test("createEntity returns correct fields with traits", async () => {
    const { data, errors } = await gql<{
      ts: { id: string; name: string; details: string; traits: Array<{ name: string; properties: Record<string, string> }> };
      rust: { id: string; name: string; traits: Array<{ name: string }> };
      pg: { id: string; name: string; traits: Array<{ name: string }> };
    }>(`
      mutation {
        ts: createEntity(input: {
          name: "TypeScript"
          details: "A typed superset of JavaScript"
          traits: [
            { name: "item", properties: { name: "TypeScript", version: "5.0" } },
            { name: "concept" }
          ]
        }) { id name details traits { name properties } }

        rust: createEntity(input: {
          name: "Rust"
          details: "A systems programming language focused on safety"
          traits: [
            { name: "item", properties: { name: "Rust" } }
          ]
        }) { id name traits { name } }

        pg: createEntity(input: {
          name: "PostgreSQL"
          details: "A powerful relational database"
          traits: [
            { name: "item", properties: { name: "PostgreSQL" } }
          ]
        }) { id name traits { name } }
      }
    `);

    expect(errors).toBeUndefined();
    expect(data!.ts.name).toBe("TypeScript");
    expect(data!.ts.details).toBe("A typed superset of JavaScript");
    expect(data!.ts.traits.length).toBe(2);
    const itemTrait = data!.ts.traits.find((t) => t.name === "item");
    expect(itemTrait).toBeTruthy();
    expect(itemTrait!.properties).toEqual({ name: "TypeScript", version: "5.0" });
    const conceptTrait = data!.ts.traits.find((t) => t.name === "concept");
    expect(conceptTrait).toBeTruthy();
    expect(data!.rust.id).toBeTruthy();
    expect(data!.pg.id).toBeTruthy();

    // Save IDs for later tests
    entityIds.ts = data!.ts.id;
    entityIds.rust = data!.rust.id;
    entityIds.pg = data!.pg.id;
  });

  // 3. Property validation — reject unknown keys
  test("createEntity rejects unknown property keys", async () => {
    const { errors } = await gql(`
      mutation {
        createEntity(input: {
          name: "Should fail"
          traits: [
            { name: "person", properties: { name: "Alice", unknown_field: "bad" } }
          ]
        }) { id }
      }
    `);

    expect(errors).toBeDefined();
    expect(errors![0]!.message).toContain("does not define property key");
    expect(errors![0]!.message).toContain("unknown_field");
  });

  // 4. Filter by trait + properties
  test("entities filters by traitFilter", async () => {
    const { data, errors } = await gql<{
      entities: { totalCount: number; edges: Array<{ node: { id: string; name: string } }> };
    }>(`{
      entities(traitFilter: [{ trait: "item", properties: { name: "TypeScript" } }], first: 10) {
        totalCount
        edges { node { id name } }
      }
    }`);

    expect(errors).toBeUndefined();
    expect(data!.entities.totalCount).toBe(1);
    expect(data!.entities.edges[0]!.node.id).toBe(entityIds.ts);
  });

  // 5. Semantic search
  test("entities semantic search finds similar content", async () => {
    const { data, errors } = await gql<{
      entities: { totalCount: number; edges: Array<{ node: { id: string; traits: Array<{ name: string }> } }> };
    }>(`{
      entities(search: { query: "programming language", threshold: 0.3 }, first: 10) {
        totalCount
        edges { node { id traits { name } } }
      }
    }`);

    expect(errors).toBeUndefined();
    // Should find at least TS and Rust (programming languages)
    expect(data!.entities.totalCount).toBeGreaterThanOrEqual(2);
    const ids = data!.entities.edges.map((e) => e.node.id);
    expect(ids).toContain(entityIds.ts);
    expect(ids).toContain(entityIds.rust);
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
        sourceId: entityIds.ts,
        targetId: entityIds.pg,
        relationType: "runs_on",
      },
    });

    expect(errors).toBeUndefined();
    expect(data!.createEdge.sourceId).toBe(entityIds.ts);
    expect(data!.createEdge.targetId).toBe(entityIds.pg);
    expect(data!.createEdge.relationType).toBe("runs_on");
    edgeId = data!.createEdge.id;
  });

  // 7. Relations query
  test("relations returns outgoing edges with full edge object", async () => {
    const { data, errors } = await gql<{
      relations: {
        totalCount: number;
        edges: Array<{ node: { id: string }; edge: { id: string; relationType: string } }>;
      };
    }>(`
      query($entityId: ID!) {
        relations(entityId: $entityId, direction: OUTGOING) {
          totalCount
          edges { node { id } edge { id relationType } }
        }
      }
    `, { entityId: entityIds.ts });

    expect(errors).toBeUndefined();
    expect(data!.relations.totalCount).toBe(1);
    expect(data!.relations.edges[0]!.node.id).toBe(entityIds.pg);
    expect(data!.relations.edges[0]!.edge.relationType).toBe("runs_on");
    expect(data!.relations.edges[0]!.edge.id).toBeTruthy();
  });

  // 7b. Create second edge for multi-hop chain: Rust →(depends_on)→ TS →(runs_on)→ PG
  test("createEdge builds multi-hop chain", async () => {
    const { data, errors } = await gql<{
      createEdge: { id: string; relationType: string };
    }>(`
      mutation($input: CreateEdgeInput!) {
        createEdge(input: $input) { id relationType }
      }
    `, {
      input: {
        sourceId: entityIds.rust,
        targetId: entityIds.ts,
        relationType: "depends_on",
      },
    });

    expect(errors).toBeUndefined();
    expect(data!.createEdge.relationType).toBe("depends_on");
    edgeId2 = data!.createEdge.id;
  });

  // 7c. Multi-hop: depth 2 outgoing from Rust → should reach PG
  test("relations depth 2 returns terminal entities", async () => {
    const { data, errors } = await gql<{
      relations: {
        totalCount: number;
        edges: Array<{ node: { id: string }; edge: { relationType: string } }>;
      };
    }>(`
      query($entityId: ID!) {
        relations(entityId: $entityId, direction: OUTGOING, depth: 2) {
          totalCount
          edges { node { id } edge { relationType } }
        }
      }
    `, { entityId: entityIds.rust });

    expect(errors).toBeUndefined();
    expect(data!.relations.totalCount).toBe(1);
    expect(data!.relations.edges[0]!.node.id).toBe(entityIds.pg);
    // The edge should be the last hop's edge (runs_on)
    expect(data!.relations.edges[0]!.edge.relationType).toBe("runs_on");
  });

  // 7d. Multi-hop with relationType filter: depends_on at every hop → no results
  test("relations depth 2 with relationType filters every hop", async () => {
    const { data, errors } = await gql<{
      relations: { totalCount: number };
    }>(`
      query($entityId: ID!) {
        relations(entityId: $entityId, direction: OUTGOING, depth: 2, relationType: "depends_on") {
          totalCount
        }
      }
    `, { entityId: entityIds.rust });

    expect(errors).toBeUndefined();
    // Second hop is runs_on, not depends_on → no terminal entity
    expect(data!.relations.totalCount).toBe(0);
  });

  // 7e. Default depth (1) unchanged
  test("relations default depth returns direct neighbors only", async () => {
    const { data, errors } = await gql<{
      relations: {
        totalCount: number;
        edges: Array<{ node: { id: string } }>;
      };
    }>(`
      query($entityId: ID!) {
        relations(entityId: $entityId, direction: OUTGOING) {
          totalCount
          edges { node { id } }
        }
      }
    `, { entityId: entityIds.rust });

    expect(errors).toBeUndefined();
    expect(data!.relations.totalCount).toBe(1);
    expect(data!.relations.edges[0]!.node.id).toBe(entityIds.ts);
  });

  // 7f. Shortest path: Rust → TS → PG
  test("path finds shortest path between two entities", async () => {
    const { data, errors } = await gql<{
      path: Array<{ entity: { id: string }; edge: { relationType: string } | null }>;
    }>(`
      query($from: ID!, $to: ID!) {
        path(fromId: $from, toId: $to) {
          entity { id }
          edge { relationType }
        }
      }
    `, { from: entityIds.rust, to: entityIds.pg });

    expect(errors).toBeUndefined();
    expect(data!.path.length).toBe(3);
    // First step: start entity (no edge)
    expect(data!.path[0]!.entity.id).toBe(entityIds.rust);
    expect(data!.path[0]!.edge).toBeNull();
    // Middle step
    expect(data!.path[1]!.entity.id).toBe(entityIds.ts);
    expect(data!.path[1]!.edge).toBeTruthy();
    // Last step
    expect(data!.path[2]!.entity.id).toBe(entityIds.pg);
    expect(data!.path[2]!.edge).toBeTruthy();
  });

  // 7g. Path with no connection → empty array
  test("path returns empty array when no path exists", async () => {
    // Create an isolated entity
    const { data: created } = await gql<{ createEntity: { id: string } }>(`
      mutation {
        createEntity(input: { name: "Isolated node", traits: [{ name: "concept" }] }) { id }
      }
    `);

    const { data, errors } = await gql<{
      path: Array<{ entity: { id: string } }>;
    }>(`
      query($from: ID!, $to: ID!) {
        path(fromId: $from, toId: $to) {
          entity { id }
        }
      }
    `, { from: entityIds.rust, to: created!.createEntity.id });

    expect(errors).toBeUndefined();
    expect(data!.path).toEqual([]);

    // Cleanup
    await gql(`mutation($id: ID!) { deleteEntity(id: $id) }`, { id: created!.createEntity.id });
  });

  // 8. Relation keys list
  test("relationKeys lists registered types with usage counts", async () => {
    const { data, errors } = await gql<{
      relationKeys: { edges: Array<{ node: { name: string; usageCount: number } }> };
    }>(`{ relationKeys { edges { node { name usageCount } } } }`);

    expect(errors).toBeUndefined();
    const runsOn = data!.relationKeys.edges.find((e) => e.node.name === "runs_on");
    expect(runsOn).toBeTruthy();
    expect(runsOn!.node.usageCount).toBe(1);
  });

  // 9. Traits query — check seeded traits have property schemas
  test("traits query returns trait definitions with property keys", async () => {
    const { data, errors } = await gql<{
      traits: { edges: Array<{ node: { name: string; propertyKeys: string[]; usageCount: number } }> };
    }>(`{ traits { edges { node { name propertyKeys usageCount } } } }`);

    expect(errors).toBeUndefined();
    const itemTrait = data!.traits.edges.find((e) => e.node.name === "item");
    expect(itemTrait).toBeTruthy();
    expect(itemTrait!.node.propertyKeys).toContain("name");
    expect(itemTrait!.node.propertyKeys).toContain("version");
    // item is used by TS, Rust, PG = 3
    expect(itemTrait!.node.usageCount).toBe(3);
  });

  // 10. Register trait with description
  test("registerTrait creates entry with description and propertyKeys", async () => {
    const { data, errors } = await gql<{
      registerTrait: { name: string; description: string; propertyKeys: string[] };
    }>(`
      mutation {
        registerTrait(name: "language", description: "A programming language", propertyKeys: ["name", "paradigm"]) {
          name description propertyKeys
        }
      }
    `);

    expect(errors).toBeUndefined();
    expect(data!.registerTrait.name).toBe("language");
    expect(data!.registerTrait.description).toBe("A programming language");
    expect(data!.registerTrait.propertyKeys).toContain("name");
    expect(data!.registerTrait.propertyKeys).toContain("paradigm");
  });

  // 10b. Register relation with description
  test("registerRelation creates entry with description", async () => {
    const { data, errors } = await gql<{
      registerRelation: { name: string; description: string };
    }>(`
      mutation {
        registerRelation(name: "depends_on", description: "A dependency relationship between software components") {
          name description
        }
      }
    `);

    expect(errors).toBeUndefined();
    expect(data!.registerRelation.name).toBe("depends_on");
    expect(data!.registerRelation.description).toBe("A dependency relationship between software components");
  });

  // 11. Orphans — all entities have edges now
  test("orphans returns unconnected entities", async () => {
    const { data, errors } = await gql<{
      orphans: { totalCount: number; edges: Array<{ node: { id: string } }> };
    }>(`{ orphans { totalCount edges { node { id } } } }`);

    expect(errors).toBeUndefined();
    // All 3 entities have edges now (Rust→TS→PG)
    const ids = data!.orphans.edges.map((e) => e.node.id);
    expect(ids).not.toContain(entityIds.ts);
    expect(ids).not.toContain(entityIds.rust);
    expect(ids).not.toContain(entityIds.pg);
  });

  // 12. Delete edges + entity
  test("deleteEdge and deleteEntity work", async () => {
    // Delete both edges
    const delEdge1 = await gql<{ deleteEdge: boolean }>(`
      mutation($id: ID!) { deleteEdge(id: $id) }
    `, { id: edgeId });
    expect(delEdge1.errors).toBeUndefined();
    expect(delEdge1.data!.deleteEdge).toBe(true);

    const delEdge2 = await gql<{ deleteEdge: boolean }>(`
      mutation($id: ID!) { deleteEdge(id: $id) }
    `, { id: edgeId2 });
    expect(delEdge2.errors).toBeUndefined();
    expect(delEdge2.data!.deleteEdge).toBe(true);

    // Delete an entity
    const delEntity = await gql<{ deleteEntity: boolean }>(`
      mutation($id: ID!) { deleteEntity(id: $id) }
    `, { id: entityIds.rust });
    expect(delEntity.errors).toBeUndefined();
    expect(delEntity.data!.deleteEntity).toBe(true);

    // Verify schema counts
    const { data } = await gql<{
      schema: { entityCount: number; edgeCount: number };
    }>(`{ schema { entityCount edgeCount } }`);
    expect(data!.schema.entityCount).toBe(2); // TS + PG remain
    expect(data!.schema.edgeCount).toBe(0); // both edges deleted
  });
});
