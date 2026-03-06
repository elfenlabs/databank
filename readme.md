# 🏛️ Thesauros

A headless, API-first **GraphRAG backend** — combining relational graph topology with vector-based semantic search in a single PostgreSQL instance.

Thesauros is intentionally "dumb": it stores entities, edges, traits, and embeddings, and exposes them via a **dual-endpoint GraphQL API**. It hosts no LLMs for reasoning or generation. Multi-hop graph traversals and semantic search are first-class features, while complex reasoning is delegated to the consuming agent through **round-trip exploration**.

## Quickstart

Thesauros ships as two Docker images. Build them from the repo root:

```bash
# Build the embedding sidecar (shared, run once)
docker build -t thesauros-embedder -f infra/embedder/Dockerfile infra/embedder

# Build the thesauros container (one per agent/tenant)
docker build -t thesauros -f infra/thesauros/Dockerfile .
```

Run the embedder first, then spin up as many thesauros instances as needed:

```bash
# 1. Start the shared embedder
docker run -d --name embedder -p 8100:8100 \
  -e EMBED_MODEL=BAAI/bge-small-en-v1.5 \
  thesauros-embedder

# 2. Start a thesauros instance (point it at the embedder)
docker run -d --name thesauros-1 -p 4000:4000 \
  -e EMBEDDER_URL=http://embedder:8100/embed \
  thesauros
```

Two GraphQL endpoints are exposed:

| Endpoint | Purpose |
| --- | --- |
| `/graphql` | **Consumer API** — read-heavy queries + memory stream append |
| `/graphql/admin` | **Admin API** — full CRUD, registry management, maintenance |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Embedder (shared)                   │
│        Python · FastAPI · sentence-transformers      │
│           POST /embed { text | texts } → vector(s)    │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌─────────────┐┌─────────────┐┌─────────────┐
   │ Thesauros 1 ││ Thesauros 2 ││ Thesauros N │
   │             ││             ││             │
   │ PostgreSQL  ││ PostgreSQL  ││ PostgreSQL  │
   │ + pgvector  ││ + pgvector  ││ + pgvector  │
   │ + Bun app   ││ + Bun app   ││ + Bun app   │
   │             ││             ││             │
   │ :4000       ││ :4001       ││ :400x       │
   └─────────────┘└─────────────┘└─────────────┘
```

Each **Thesauros container** is self-contained — it bundles PostgreSQL (with pgvector), runs migrations on startup via [dbmate](https://github.com/amacneil/dbmate), and seeds a starter vocabulary of traits and relations. Isolation between tenants/agents is achieved through **separate containers**, not multi-tenancy.

The **Embedder** is a stateless Python sidecar that converts text to vectors using `sentence-transformers` (default model: `BAAI/bge-small-en-v1.5`, 384 dimensions). A single embedder instance is shared across all thesauros containers.

## Data Model

Thesauros uses a **trait-based** knowledge graph:

- **Entities** — knowledge units with a `name` and optional `description` (combined and auto-embedded for semantic search)
- **Traits** — typed classifications assigned to entities (e.g. `person`, `language`, `concept`). Each trait defines a **property schema** — a set of allowed keys. Property values are scoped to the trait and validated on write.
- **Edges** — directed, typed relationships between entities with optional temporal validity windows (`valid_from`, `valid_to`)
- **Relations** — a registry of edge types with semantic search (e.g. `owns`, `depends_on`)
- **Memory Stream** — a write-ahead log for agent observations, embedded on write for semantic search. Entries have a priority and status lifecycle (`PENDING → PROCESSED | DISCARDED`).

```
Entity: "Alice"
  description: "A senior engineer at Acme"
  Trait: person     → { name: "Alice", role: "Senior Engineer" }
  Trait: employee   → { company: "Acme" }

Memory Stream Entry:
  content: "TypeScript version is now 5.8"
  source: "build-agent"
  priority: 5
  status: PENDING
```

> **Memory stream as source of truth:** Consumer agents should treat the memory stream as more recent than the knowledge graph. If TypeScript is version 5.7 in the graph but 5.8 in the memory stream, the memory stream is correct. A Librarian agent processes pending entries and updates the graph asynchronously.

## Consumer API (`/graphql`)

The consumer endpoint is designed for **agent consumption** — read-heavy queries with a single write mutation (`appendMemory`). The agent explores the graph through flat, composable queries.

### Query Loop

```
1. schema            → discover vocabulary (traits, relation types, counts)
2. entity(id)        → look up a known entity by ID
3. entities(...)     → search by name, semantics, or trait filters
4. relations(...)    → traverse the graph from an entity (depth 1–5)
5. path(from, to)    → shortest path between two entities
6. memoryStream(...) → search recent observations
7. appendMemory(...) → log a new observation
```

### Queries

| Query | Description |
| --- | --- |
| `entity(id)` | Look up a single entity by ID. Returns null if not found. |
| `entities(search, nameContains, traitFilter, first, after)` | Search entities by semantic similarity, name substring (case-insensitive), and/or trait filters (AND logic). |
| `relations(entityId, relationType, targetTraits, targetSearch, direction, temporal, depth, first, after)` | Traverse the graph from an entity. Supports multi-hop (depth 1–5), directional filtering, temporal windows, and semantic search on targets. |
| `path(fromId, toId, maxDepth, relationType)` | Shortest path between two entities via bidirectional BFS (max 5 hops). |
| `memoryStream(search, status, minPriority, first, after)` | Browse or search the memory stream. Filter by status, minimum priority, or semantic similarity. |
| `schema` | Aggregate stats: entity count, edge count, trait names, relation types. |

### Mutations

| Mutation | Description |
| --- | --- |
| `appendMemory(content, source, priority)` | Append an observation to the memory stream. Embedded on write. |

### Key Features

- **Semantic search** — on entity content and memory stream entries via pgvector cosine similarity
- **Name lookup** — case-insensitive substring filter (`nameContains`) for exact entity discovery
- **Multi-hop traversal** — `relations` supports depth 1–5 with per-hop relation/temporal filtering
- **Shortest path** — `path` finds the shortest route between any two entities
- **Temporal filters** — `AT`, `WITHIN`, `OVERLAPS` modes for time-aware edge queries
- **Relay cursor pagination** — standard `first` / `after` on all list queries
- **Alias batching** — multiple independent queries in one GraphQL request

### Example: Agent Exploration Flow

```graphql
# 1. Discover vocabulary
{ schema { traits relationTypes entityCount } }

# 2. Find an entity by name
{ entities(nameContains: "TypeScript", first: 1) {
    edges { node { id name traits { name properties } } }
} }

# 3. Traverse its relationships
{ relations(entityId: "abc-123", depth: 2, first: 10) {
    edges { edge { relationType } node { id name } }
} }

# 4. Find path between two entities
{ path(fromId: "abc-123", toId: "def-456") {
    entity { name } edge { relationType }
} }

# 5. Check recent observations
{ memoryStream(search: { query: "build error", threshold: 0.6 }, first: 5) {
    edges { node { content source priority status } }
} }

# 6. Log an observation
mutation { appendMemory(
  content: "TypeScript 5.8 released with new strictness flags"
  source: "news-agent"
  priority: 3
) { id } }
```

## Admin API (`/graphql/admin`)

The admin endpoint includes everything in the consumer API **plus** full CRUD and maintenance operations.

### Additional Queries

| Query | Description |
| --- | --- |
| `traits(match, value, threshold, first, after)` | Browse or semantically search the trait registry |
| `relationKeys(match, value, threshold, first, after)` | Browse or semantically search the relation registry |
| `orphans(first, after)` | Entities with no edges |
| `similarPairs(threshold)` | Entity pairs with high similarity but no direct edge |

### Additional Mutations

| Mutation | Description |
| --- | --- |
| `createEntity` / `updateEntity` / `deleteEntity` | Entity CRUD with trait validation |
| `createEdge` / `deleteEdge` | Edge CRUD (relation auto-registration) |
| `registerTrait` / `mergeTraits` / `deleteTrait` | Manage the trait registry |
| `addTraitProperty` / `removeTraitProperty` | Manage trait property schemas |
| `registerRelation` / `mergeRelations` / `deleteRelation` | Manage the relation registry |
| `updateMemoryStatus` | Mark memory entries as PROCESSED or DISCARDED |
| `truncateMemoryStream` | Remove old non-PENDING entries |

## MCP

Thesauros ships with an [MCP](https://modelcontextprotocol.io) server that lets any MCP-compatible agent (Claude Desktop, Cursor, Windsurf, etc.) interact with the knowledge graph. It exposes two tools:

| Tool | Description |
| --- | --- |
| `thesauros_schema` | Returns the consumer GraphQL SDL so the agent learns the API |
| `thesauros_query` | Executes a GraphQL query/mutation against the consumer endpoint |

The MCP server is a thin stdio adapter — it forwards GraphQL operations to a running Thesauros instance via HTTP.

### Configuration

Add to your MCP configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "thesauros": {
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "/path/to/thesauros",
      "env": {
        "THESAUROS_URL": "http://localhost:4000/graphql"
      }
    }
  }
}
```

## Stack

| Component | Technology |
| --- | --- |
| Runtime | [Bun](https://bun.sh) |
| API | [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) |
| Database | PostgreSQL 17 + [pgvector](https://github.com/pgvector/pgvector) |
| Query Builder | [Kysely](https://kysely.dev) |
| Migrations | [dbmate](https://github.com/amacneil/dbmate) |
| Embedder | Python · [FastAPI](https://fastapi.tiangolo.com) · [sentence-transformers](https://sbert.net) |

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | *(set by container)* | PostgreSQL connection string |
| `EMBEDDER_URL` | `http://localhost:8100/embed` | Full URL of the embedding endpoint (POST, accepts `{ text }` or `{ texts }`) |
| `PORT` | `4000` | Server port (serves both endpoints) |
| `EMBED_MODEL` | `BAAI/bge-small-en-v1.5` | HuggingFace model for the embedder |
| `THESAUROS_URL` | `http://localhost:4000/graphql` | Consumer endpoint URL (used by MCP server) |

## License

[MIT](LICENSE)
