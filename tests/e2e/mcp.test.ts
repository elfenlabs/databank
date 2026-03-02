import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setup, teardown } from "./setup.ts";
import path from "node:path";

// ---------------------------------------------------------------------------
// Lifecycle — reuse the same Docker infra as databank.test.ts
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
      DATABANK_URL: "http://localhost:14000/graphql",
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

    expect(names).toContain("databank_schema");
    expect(names).toContain("databank_query");
    expect(tools.length).toBe(2);
  });

  test("databank_schema returns the GraphQL SDL", async () => {
    const result = await client.callTool({ name: "databank_schema" });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBe(1);

    const sdl = content[0]!.text;
    expect(sdl).toContain("type Query");
    expect(sdl).toContain("type Mutation");
    expect(sdl).toContain("searchNodes");
    expect(sdl).toContain("createNode");
    expect(sdl).toContain("connections");
  });

  test("databank_query executes a GraphQL query", async () => {
    const result = await client.callTool({
      name: "databank_query",
      arguments: { query: "{ schema { nodeCount edgeCount } }" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const json = JSON.parse(content[0]!.text);
    expect(json.data.schema.nodeCount).toBeNumber();
    expect(json.data.schema.edgeCount).toBeNumber();
  });

  test("databank_query executes a mutation", async () => {
    const result = await client.callTool({
      name: "databank_query",
      arguments: {
        query: `mutation {
          createNode(input: {
            text: "MCP test node"
            labels: ["test"]
            properties: { source: "mcp-e2e" }
          }) { id content labels properties }
        }`,
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const json = JSON.parse(content[0]!.text);
    expect(json.data.createNode.content).toBe("MCP test node");
    expect(json.data.createNode.labels).toEqual(["test"]);
    expect(json.data.createNode.properties).toEqual({ source: "mcp-e2e" });
  });

  test("databank_query supports variables", async () => {
    const result = await client.callTool({
      name: "databank_query",
      arguments: {
        query: `query($match: MatchType!, $prop: String, $val: String!) {
          searchNodes(match: $match, property: $prop, value: $val) {
            totalCount
            edges { node { id content } }
          }
        }`,
        variables: { match: "EXACT", prop: "source", val: "mcp-e2e" },
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const json = JSON.parse(content[0]!.text);
    expect(json.data.searchNodes.totalCount).toBeGreaterThanOrEqual(1);
  });

  test("databank_query reports GraphQL errors", async () => {
    const result = await client.callTool({
      name: "databank_query",
      arguments: { query: "{ nonExistentField }" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const json = JSON.parse(content[0]!.text);
    expect(json.errors).toBeArray();
    expect(json.errors.length).toBeGreaterThan(0);
  });
});
