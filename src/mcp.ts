/**
 * Databank MCP Server — a thin protocol adapter that exposes
 * the Databank GraphQL API to any MCP-speaking agent.
 *
 * Two tools:
 *   databank_schema  — returns the GraphQL SDL so the agent learns the API
 *   databank_query   — executes a raw GraphQL query/mutation against Databank
 *
 * Usage:
 *   DATABANK_URL=http://localhost:4000/graphql bun run src/mcp.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { typeDefs } from "./schema/typeDefs.ts";

const DATABANK_URL =
  process.env.DATABANK_URL ?? "http://localhost:4000/graphql";

const server = new McpServer({
  name: "databank",
  version: "1.0.0",
});

// --- Tool: databank_schema -------------------------------------------

server.tool(
  "databank_schema",
  "Returns the full GraphQL schema (SDL) of the Databank API. " +
    "Call this first to understand what queries and mutations are available, " +
    "their input types, and response shapes. Then use databank_query to execute them.",
  async () => ({
    content: [{ type: "text", text: typeDefs }],
  }),
);

// --- Tool: databank_query --------------------------------------------

server.tool(
  "databank_query",
  "Execute a GraphQL query or mutation against the Databank. " +
    "Pass a valid GraphQL operation string. Use GraphQL aliases to batch " +
    "multiple independent operations in a single request.",
  { query: z.string(), variables: z.record(z.string(), z.unknown()).optional() },
  async ({ query, variables }) => {
    const res = await fetch(DATABANK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    const json: { data?: unknown; errors?: unknown[] } = await res.json();
    const hasErrors = Array.isArray(json.errors) && json.errors.length > 0;

    return {
      content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
      isError: hasErrors,
    };
  },
);

// --- Start -----------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
