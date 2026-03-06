/**
 * Thesauros MCP Server — a thin protocol adapter that exposes
 * the Thesauros GraphQL API to any MCP-speaking agent.
 *
 * Two tools:
 *   thesauros_schema  — returns the GraphQL SDL so the agent learns the API
 *   thesauros_query   — executes a raw GraphQL query/mutation against Thesauros
 *
 * Usage:
 *   THESAUROS_URL=http://localhost:4000/graphql bun run src/mcp.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { consumerTypeDefs } from "./schema/typeDefs.ts";

const THESAUROS_URL =
  process.env.THESAUROS_URL ?? "http://localhost:4000/graphql";

const server = new McpServer({
  name: "thesauros",
  version: "1.0.0",
});

// --- Tool: thesauros_schema -------------------------------------------

server.tool(
  "thesauros_schema",
  "Returns the GraphQL schema (SDL) of the Thesauros consumer API. " +
    "Call this first to understand what queries and mutations are available, " +
    "their input types, and response shapes. Then use thesauros_query to execute them.",
  async () => ({
    content: [{ type: "text", text: consumerTypeDefs }],
  }),
);

// --- Tool: thesauros_query --------------------------------------------

server.tool(
  "thesauros_query",
  "Execute a GraphQL query or mutation against the Thesauros. " +
    "Pass a valid GraphQL operation string. Use GraphQL aliases to batch " +
    "multiple independent operations in a single request.",
  { query: z.string(), variables: z.record(z.string(), z.unknown()).optional() },
  async ({ query, variables }) => {
    const res = await fetch(THESAUROS_URL, {
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
