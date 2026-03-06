import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setup, teardown } from "./setup.ts";
import path from "node:path";

// ---------------------------------------------------------------------------
// Lifecycle — reuse the same Docker infra as thesauros.test.ts
// ---------------------------------------------------------------------------

const MCP_ENTRY = path.resolve(import.meta.dir, "../../src/mcp.ts");

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  await setup();

  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", MCP_ENTRY],
    env: {
      ...process.env,
      THESAUROS_URL: "http://localhost:14000/graphql",
    } as Record<string, string>,
    stderr: "ignore",
  });

  client = new Client({ name: "test", version: "1.0" });
  await client.connect(transport);
}, 120_000);

afterAll(async () => {
  await client?.close();
  await teardown();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP Server E2E", () => {
  test("lists both tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("thesauros_schema");
    expect(names).toContain("thesauros_query");
    expect(tools.length).toBe(2);
  });

  test("thesauros_schema returns the GraphQL SDL", async () => {
    const result = await client.callTool({ name: "thesauros_schema" });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBe(1);

    const sdl = content[0]!.text;
    expect(sdl).toContain("type Query");
    expect(sdl).toContain("type Mutation");
    expect(sdl).toContain("interface Node");
    expect(sdl).toContain("type Entity implements Node");
    expect(sdl).toContain("type Edge implements Node");
    expect(sdl).toContain("EntityConnection");
    expect(sdl).toContain("RelationConnection");
    expect(sdl).toContain("MemoryStreamConnection");
    // Consumer schema should NOT expose admin types
    expect(sdl).not.toContain("RegistryConnection");
    expect(sdl).not.toContain("TraitConnection");
    expect(sdl).not.toContain("createEntity");
    expect(sdl).not.toContain("deleteEntity");
  });

  test("thesauros_query executes a GraphQL query", async () => {
    const result = await client.callTool({
      name: "thesauros_query",
      arguments: { query: "{ schema { entityCount edgeCount } }" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const json = JSON.parse(content[0]!.text);
    expect(json.data.schema.entityCount).toBeNumber();
    expect(json.data.schema.edgeCount).toBeNumber();
  });

  test("thesauros_query executes a mutation (appendMemory)", async () => {
    const result = await client.callTool({
      name: "thesauros_query",
      arguments: {
        query: `mutation {
          appendMemory(content: "MCP test observation", source: "mcp-e2e") {
            id content source status
          }
        }`,
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const json = JSON.parse(content[0]!.text);
    expect(json.data.appendMemory.content).toBe("MCP test observation");
    expect(json.data.appendMemory.source).toBe("mcp-e2e");
    expect(json.data.appendMemory.status).toBe("PENDING");
  });

  test("thesauros_query rejects admin mutations via consumer endpoint", async () => {
    const result = await client.callTool({
      name: "thesauros_query",
      arguments: {
        query: `mutation {
          createEntity(input: {
            name: "Should fail"
            traits: [{ name: "concept" }]
          }) { id }
        }`,
      },
    });

    expect(result.isError).toBe(true);
  });

  test("thesauros_query supports variables", async () => {
    const result = await client.callTool({
      name: "thesauros_query",
      arguments: {
        query: `query($first: Int!) {
          memoryStream(first: $first) {
            totalCount
            edges { node { id content } }
          }
        }`,
        variables: { first: 10 },
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const json = JSON.parse(content[0]!.text);
    expect(json.data.memoryStream.totalCount).toBeGreaterThanOrEqual(1);
  });

  test("thesauros_query reports GraphQL errors", async () => {
    const result = await client.callTool({
      name: "thesauros_query",
      arguments: { query: "{ nonExistentField }" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const json = JSON.parse(content[0]!.text);
    expect(json.errors).toBeArray();
    expect(json.errors.length).toBeGreaterThan(0);
  });
});
