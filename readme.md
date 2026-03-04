# 🏦 Databank

A headless, API-first **GraphRAG backend** — combining relational graph topology with vector-based semantic search in a single PostgreSQL instance.

Databank is intentionally "dumb": it stores entities, edges, traits, and embeddings, and exposes them via a flat **GraphQL API**. It hosts no LLMs for reasoning or generation. Multi-hop graph traversals and semantic search are first-class features, while complex reasoning is delegated to the consuming agent through **round-trip exploration**.

## Quickstart

Databank ships as two Docker images. Build them from the repo root:

```bash
# Build the embedding sidecar (shared, run once)
docker build -t databank-embedder -f infra/embedder/Dockerfile infra/embedder

# Build the databank container (one per agent/tenant)
docker build -t databank -f infra/databank/Dockerfile .
```

Run the embedder first, then spin up as many databank instances as needed:

```bash
# 1. Start the shared embedder
docker run -d --name embedder -p 8100:8100 \
  -e EMBED_MODEL=BAAI/bge-small-en-v1.5 \
  databank-embedder

# 2. Start a databank instance (point it at the embedder)
docker run -d --name databank-1 -p 4000:4000 \
  -e EMBED_URL=http://embedder:8100 \
  databank
```

The GraphQL endpoint is available at `http://localhost:4000/graphql`.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Embedder (shared)                   │
│        Python · FastAPI · sentence-transformers      │
│              POST /embed { text } → vector           │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌────────────┐┌────────────┐┌────────────┐
   │ Databank 1 ││ Databank 2 ││ Databank N │
   │            ││            ││            │
   │ PostgreSQL ││ PostgreSQL ││ PostgreSQL │
   │ + pgvector ││ + pgvector ││ + pgvector │
   │ + Bun app  ││ + Bun app  ││ + Bun app  │
   │            ││            ││            │
   │ :4000      ││ :4001      ││ :400x      │
   └────────────┘└────────────┘└────────────┘
```

Each **Databank container** is self-contained — it bundles PostgreSQL (with pgvector), runs migrations on startup via [dbmate](https://github.com/amacneil/dbmate), and seeds a starter vocabulary of traits and relations. Isolation between tenants/agents is achieved through **separate containers**, not multi-tenancy.

The **Embedder** is a stateless Python sidecar that converts text to vectors using `sentence-transformers` (default model: `BAAI/bge-small-en-v1.5`, 384 dimensions). A single embedder instance is shared across all databank containers.

## Data Model

Databank uses a **trait-based** knowledge graph model:

- **Entities** — knowledge units with free-text content (auto-embedded for semantic search)
- **Traits** — typed classifications assigned to entities (e.g. `person`, `organization`, `concept`). Each trait defines a **property schema** — a set of allowed keys. Property values are scoped to the trait and validated on write.
- **Edges** — directed, typed relationships between entities with optional temporal validity windows
- **Relations** — a registry of edge types with semantic search (e.g. `owns`, `depends_on`)

```
Entity: "Alice is a senior engineer at Acme"
  Trait: person     → { name: "Alice", role: "Senior Engineer" }
  Trait: employee   → { company: "Acme" }
```

## API

Databank exposes a flat GraphQL API at `/graphql`. No nested traversals — the consuming agent chains flat queries with reasoning in between.

| Operation | Description |
| --- | --- |
| `entities` | Search/filter entities by semantic similarity, trait, or trait-scoped properties |
| `relations` | Traverse the graph (depth 1–5), with relation/trait/temporal/semantic filters |
| `path` | Shortest path between two entities (bidirectional BFS, max 5 hops) |
| `traits` | Browse or semantically search the trait registry |
| `relationKeys` | Browse or semantically search the relation registry |
| `orphans` / `similarPairs` / `schema` | Maintenance & diagnostics |
| `createEntity` / `updateEntity` / `deleteEntity` | Entity CRUD with trait validation |
| `createEdge` / `deleteEdge` | Edge CRUD (relation auto-registration) |
| `registerTrait` / `mergeTraits` / `deleteTrait` | Manage the trait registry |
| `addTraitProperty` / `removeTraitProperty` | Manage trait property schemas |
| `registerRelation` / `mergeRelations` / `deleteRelation` | Manage the relation registry |

Key features:
- **Trait-scoped properties** — properties are validated against the trait's schema on write; unknown keys are rejected
- **Semantic search** — on entity content, relation types, and trait names via pgvector cosine similarity
- **Multi-hop traversal** — `relations` query supports depth 1–5 with per-hop filtering
- **Shortest path** — `path` query finds the shortest route between any two entities
- **Temporal filters** — `AT`, `WITHIN`, `OVERLAPS` modes for time-aware edge queries
- **Relay cursor pagination** — standard `first` / `after` pagination
- **Alias batching** — multiple independent queries in one GraphQL request

See [`project.md`](project.md) for the full PRD, schema definitions, and example query flows.

## Stack

| Component | Technology |
| --- | --- |
| Runtime | [Bun](https://bun.sh) |
| API | [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) |
| Database | PostgreSQL 17 + [pgvector](https://github.com/pgvector/pgvector) |
| ORM | [Kysely](https://kysely.dev) |
| Migrations | [dbmate](https://github.com/amacneil/dbmate) |
| Embedder | Python · [FastAPI](https://fastapi.tiangolo.com) · [sentence-transformers](https://sbert.net) |

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | *(set by container)* | PostgreSQL connection string |
| `EMBED_URL` | `http://localhost:8100` | URL of the embedding sidecar |
| `PORT` | `4000` | GraphQL server port |
| `EMBED_MODEL` | `BAAI/bge-small-en-v1.5` | HuggingFace model for the embedder |
| `DATABANK_URL` | `http://localhost:4000/graphql` | GraphQL endpoint (used by MCP server) |

## MCP

Databank ships with an [MCP](https://modelcontextprotocol.io) server that lets any MCP-compatible agent (Claude Desktop, Cursor, Windsurf, etc.) interact with the knowledge graph. It exposes two tools:

| Tool | Description |
| --- | --- |
| `databank_schema` | Returns the full GraphQL SDL so the agent learns the API |
| `databank_query` | Executes a raw GraphQL query/mutation against Databank |

The MCP server is a thin stdio adapter — it forwards GraphQL operations to a running Databank instance via HTTP.

```bash
# Start Databank first
bun run dev

# In another terminal, test the MCP server
bun run mcp
```

### Claude Desktop / Cursor config

Add to your MCP configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "databank": {
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "/path/to/databank",
      "env": {
        "DATABANK_URL": "http://localhost:4000/graphql"
      }
    }
  }
}
```

## License

[MIT](LICENSE)
