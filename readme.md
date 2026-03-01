# 🏦 Databank

A headless, API-first **GraphRAG backend** — combining relational graph topology with vector-based semantic search in a single PostgreSQL instance.

Databank is intentionally "dumb": it stores nodes, edges, and embeddings, and exposes them via a flat **GraphQL API**. It hosts no LLMs for reasoning or generation. Multi-hop graph traversals are handled externally by an intelligent agent through **round-trip exploration**.

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

Each **Databank container** is self-contained — it bundles PostgreSQL (with pgvector), runs migrations on startup via [dbmate](https://github.com/amacneil/dbmate), and serves the GraphQL API. Isolation between tenants/agents is achieved through **separate containers**, not multi-tenancy.

The **Embedder** is a stateless Python sidecar that converts text to vectors using `sentence-transformers` (default model: `BAAI/bge-small-en-v1.5`, 384 dimensions). A single embedder instance is shared across all databank containers.

## API

Databank exposes a flat GraphQL API at `/graphql`. No nested traversals — the consuming agent chains flat queries with reasoning in between.

| Operation | Description |
| --- | --- |
| `searchNodes` | Find nodes by exact property match or semantic similarity |
| `connections` | Get edges of a node, with optional relation/target/temporal filters |
| `createNode` / `updateNode` / `deleteNode` | Node CRUD |
| `createEdge` / `deleteEdge` | Edge CRUD |
| `registerRelation` / `mergeRelations` / `deleteRelation` | Manage the relation registry |
| `orphans` / `similarPairs` / `schema` / `relations` | Maintenance & diagnostics |

Key features:
- **Semantic relation matching** — query by meaning (e.g. `"build"` matches `"creates"`, `"constructs"`)
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

## License

[MIT](LICENSE)
