# Product Requirements Document (PRD): Headless GraphRAG Databank

## 1. Product Vision & Executive Summary

The "Databank" is a headless, API-first Retrieval-Augmented Generation (RAG) backend. It acts as a dedicated structural and semantic memory store, combining **relational graph topology** with **vector-based semantic search** in a single PostgreSQL database.

Crucially, the Databank is "dumb"—it hosts no Large Language Models (LLMs) for reasoning or text generation. It manages data ingestion, embedding, vector search, bounded multi-hop relationship traversal, and shortest-path queries. Complex reasoning chains are handled externally by an intelligent agent. Multi-hop traversals are bounded (max depth 5) and use PostgreSQL recursive CTEs — no graph database required. By decoupling the storage/retrieval layer from the reasoning layer, consumer applications and background maintenance workers can scale and swap LLMs independently.

## 2. System Architecture & Actors

The ecosystem consists of four components:

| Actor | Description | Responsibility |
| --- | --- | --- |
| **The Databank (System)** | TypeScript app serving a GraphQL API, backed by PostgreSQL + pgvector and an Embedding Sidecar. | Executes hybrid searches, stores nodes/edges, manages a relation registry, and serves structured context. |
| **Embedding Sidecar (Internal)** | A lightweight microservice (e.g., Python + `sentence-transformers`) that exposes an HTTP embedding endpoint. | Converts text into vector embeddings on demand. Called by the Databank during ingestion and query-time relation matching. |
| **Consumer App (External)** | The user-facing application (e.g., TypeScript/Next.js) powered by a heavy LLM (e.g., 120B parameter model). | Receives user queries, **decomposes them into structured Databank queries** via round-trip exploration, fetches context, and generates final answers. |
| **Librarian Agent (External)** | A lightweight background worker (e.g., Python script running a fast 7B local LLM). | Queries the Databank for unconnected nodes, infers relationships, writes edges, and **compresses/normalizes the relation registry**. |

### 2.1. Storage Architecture

The Databank is backed by a single **PostgreSQL** instance with the **pgvector** extension for semantic search. All data—nodes, edges, vectors, and the relation registry—lives in one database.

```
                 ┌──────────────────────────────────────┐
                 │        Databank (TypeScript)          │
                 │                                      │
 Consumer/       │  ┌─────────────────────────────────┐ │
 Librarian ────► │  │  PostgreSQL + pgvector           │ │
                 │  │                                 │ │
                 │  │  • nodes       (content, props)  │ │
                 │  │  • node_labels  (label vectors)   │ │
                 │  │  • edges       (relations, time)  │ │
                 │  │  • relations   (registry)         │ │
                 │  └─────────────────────────────────┘ │
                 │                                      │
                 │  ┌─────────────────────────────────┐ │
                 │  │  Embedding Sidecar (Python)      │ │
                 │  │  POST /embed { text } → vector   │ │
                 │  └─────────────────────────────────┘ │
                 └──────────────────────────────────────┘
```

### 2.2. Database Schema

```sql
-- Nodes: the fundamental units of knowledge
CREATE TABLE nodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content         TEXT NOT NULL,
  content_vector  vector(384),          -- pgvector: content embedding
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Node labels: one row per label, each with its own embedding for semantic label search
CREATE TABLE node_labels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id         UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  label_vector    vector(384),          -- pgvector: label embedding
  UNIQUE(node_id, label)
);

-- Node properties: normalized key-value pairs for exact match queries
CREATE TABLE node_properties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id         UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  UNIQUE(node_id, key)
);
CREATE INDEX idx_node_properties_lookup ON node_properties(key, value);

-- Edges: directed relationships between nodes
CREATE TABLE edges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID NOT NULL REFERENCES nodes(id),
  target_id       UUID NOT NULL REFERENCES nodes(id),
  relation_type   TEXT NOT NULL REFERENCES relations(name),
  properties      JSONB NOT NULL DEFAULT '{}',
  valid_from      TIMESTAMPTZ,          -- NULL = fact (always true)
  valid_to        TIMESTAMPTZ,          -- NULL = ongoing state
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Relation registry: canonical relation types with embeddings
CREATE TABLE relations (
  name            TEXT PRIMARY KEY,
  name_vector     vector(384),          -- pgvector: relation name embedding
  usage_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

> **Note:** Vector dimensions (384) correspond to `bge-small-en-v1.5`. The actual dimension is determined by the Embedding Sidecar's model. Indexes (e.g., IVFFlat or HNSW on vector columns) are an implementation concern. Edge `properties` remain JSONB since they are never queried directly — they are carried as payload.

### 2.3. Embedding Sidecar API

The sidecar exposes a single HTTP endpoint:

```
POST /embed
Content-Type: application/json

Request:  { "text": "hello world" }
Response: { "vector": [0.012, -0.034, ...] }   // 384 dimensions

// Batch variant:
Request:  { "texts": ["hello", "world"] }
Response: { "vectors": [[...], [...]] }
```

> The sidecar is stateless and independently deployable. The Databank calls it during node ingestion (embed content + labels), edge creation (embed new relation types), and query-time semantic matching.

## 3. Core Features & Requirements

### 3.1. Data Ingestion & Indexing

* **Node Vectorization:** The Databank must convert incoming text and labels into vector embeddings by calling the Embedding Sidecar before storing the vectors and node data in PostgreSQL.
* **Atomic Operations:** Ability to add isolated nodes (documents/chunks) and explicitly draw edges (relationships) between existing nodes.

### 3.2. Relation Vectorization (Core)

Relationship names in knowledge graphs are inherently non-structured and ambiguous (e.g., `"creates"`, `"constructs"`, `"builds"` may all express the same intent). The Databank addresses this with a **Relation Registry**:

* **Approach:** Store-raw, resolve-at-query-time (Approach C). When an edge is created with a new relation type, the Databank embeds the relation name and inserts it into the `relations` table. **No normalization or synonym resolution is performed**—this is strictly the Librarian Agent's responsibility.
* **Query-Time Resolution:** When a query includes a semantic relation match, the Databank embeds the query's relation term, searches the `relations` table via pgvector for the top matches above a given threshold, and uses those matches to filter edges.

### 3.3. Temporal Relationships & Facts

Edges carry temporal metadata and a `created_at` audit timestamp:

* **`valid_from`** (`datetime | null`): When the relationship became true or the event occurred. `null` = **fact** (always true).
* **`valid_to`** (`datetime | null`): When the relationship ended. `null` = ongoing (for states) or N/A (for facts).
* **`created_at`** (`datetime`, required): Set automatically on edge creation. Represents when the edge was *ingested*, not when it became true. Useful for the Librarian Agent to process only newly added data.

Edges fall into three categories based on their temporal data:

| Category | Example | `valid_from` | `valid_to` |
| --- | --- | --- | --- |
| **Fact** | `Alice IS_SISTER_OF Lisa` | `NULL` | `NULL` |
| **State** | `User LIVES_IN Japan` | When it became true | When it stopped being true (`NULL` = still active) |
| **Event** | `Lily CONSUMED Ramen` | When it happened | Same as `valid_from` (point-in-time) or end of event |

**Three query-time temporal modes:**

| Mode | Semantics | Filter Logic |
| --- | --- | --- |
| **`at`** | "Is this edge valid at time T?" | Fact → always matches. Otherwise: `valid_from ≤ T` AND (`valid_to IS NULL` OR `valid_to > T`) |
| **`within`** | "Does this edge fit entirely inside [T₁, T₂]?" | Fact → always matches. Otherwise: `valid_from ≥ T₁` AND `valid_to ≤ T₂` |
| **`overlaps`** | "Was this edge active at any point during [T₁, T₂]?" | Fact → always matches. Otherwise: `valid_from ≤ T₂` AND (`valid_to IS NULL` OR `valid_to ≥ T₁`) |

Facts (`valid_from IS NULL`) are treated as **always valid** and match every temporal mode. Omitting the temporal filter returns all edges regardless of time.

The Databank does **not** manage temporal conflict resolution (e.g., closing a previous `LIVES_IN` edge when a new one is created)—that is the Consumer App's or Librarian Agent's responsibility. The Databank also does **not** classify edges as fact, state, or event—the querying agent decides which temporal mode to use.

### 3.4. Waterfall Search (Relation-Cascade Retrieval)

The primary retrieval strategy for structured queries:

```
Input: node=<ref>, relation≈"Build", threshold=0.8, limit=5

Step 1 — Relation Resolution:
   Embed "Build" → pgvector ANN search on relations table (threshold ≥ 0.8)
   Result: ["Builds" (0.97), "Constructs" (0.91), "Creates" (0.85)]

Step 2 — Cascading Edge Queries:
   For each matched relation (descending by score):
     SELECT from edges WHERE source_id = <ref> AND relation_type = <match>
       AND (temporal filter if provided)
     Accumulate results until limit is reached
     Stop early if limit is satisfied

Step 3 — Return results with provenance:
   Each result tagged with matched relation name + similarity score
```

> **Efficiency Note:** This waterfall approach is intentionally simple (Approach C trade-off). As the Librarian Agent normalizes synonym relations over time, cascades become shorter organically.

### 3.5. Maintenance Support

* **Orphan Detection:** Must identify and serve nodes that lack relationship edges to feed the external Librarian Agent's queue.
* **Similarity Detection:** Must identify node pairs that have high vector similarity but no explicit edge, flagging potential duplicates or implicit relationships.
* **Recent Ingestion:** The Librarian Agent can filter by `created_at` to process only newly added nodes and edges.

## 4. API Specification

The Databank exposes a **flat GraphQL API** via a single `/graphql` endpoint. No nested traversals are supported — multi-hop exploration is handled by the agent via round-trip queries.

**Design Philosophy:** The consumer is an intelligent agent capable of multi-step reasoning. Instead of providing nested query capabilities, the API provides **flat queries and mutations** that the agent chains together with reasoning between steps. GraphQL is used for its type safety, schema introspection, **alias-based batching**, and **Relay cursor pagination** — not for deep traversals.

```
┌──────────────────────────────────────────┐
│          Databank (TypeScript)            │
│                                          │
│   /graphql  ← single endpoint            │
│     • Queries: searchNodes, connections  │
│     • Mutations: CRUD for nodes/edges    │
│     • Mutations: relation management     │
│     • Queries: maintenance / diagnostics │
└──────────────────────────────────────────┘
```

### 4.1. GraphQL Schema (Core Types)

```graphql
# --- Enums ---
enum MatchType { EXACT SEMANTIC }
enum Direction { OUTGOING INCOMING BOTH }
enum TemporalMode { AT WITHIN OVERLAPS }
enum TargetField { CONTENT LABEL }

# --- Inputs ---
input RelationFilter {
  match: MatchType!
  value: String!
  threshold: Float            # required for SEMANTIC match
}

input TargetFilter {
  on: TargetField!            # search against content or label vectors
  value: String!
  threshold: Float!
}

input TemporalFilter {
  mode: TemporalMode!
  at: DateTime                # required for AT mode
  from: DateTime              # required for WITHIN / OVERLAPS modes
  to: DateTime                # required for WITHIN / OVERLAPS modes
}

# --- Node Types ---
type Node {
  id: ID!
  content: String!
  labels: [String!]!          # resolved from node_labels table
  properties: JSON!           # resolved from node_properties table as { key: value }
  createdAt: DateTime!
}

# --- Connection Types (Relay-style pagination) ---
type ConnectionEdge {
  node: Node!
  relationType: String!
  relationScore: Float!
  validFrom: DateTime
  validTo: DateTime
  cursor: String!
}

type ConnectionResult {
  edges: [ConnectionEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type NodeEdge {
  node: Node!
  cursor: String!
}

type NodeResult {
  edges: [NodeEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

# --- Edge Type ---
type Edge {
  id: ID!
  sourceId: ID!
  targetId: ID!
  relationType: String!
  properties: JSON!
  validFrom: DateTime
  validTo: DateTime
  createdAt: DateTime!
}

# --- Relation Registry Type ---
type Relation {
  name: String!
  usageCount: Int!
  createdAt: DateTime!
}

# --- Maintenance Types ---
type SimilarPair {
  nodeA: Node!
  nodeB: Node!
  similarity: Float!
}

type SchemaInfo {
  labels: [String!]!            # all distinct labels in use
  relationTypes: [String!]!     # all distinct relation types in use
  nodeCount: Int!
  edgeCount: Int!
}
```

### 4.2. Queries (Round-Trip Exploration)

The agent explores the knowledge graph one step at a time, reasoning between each call. GraphQL **aliases** allow multiple independent queries in a single request.

```graphql
type Query {
  # Discover nodes by property match or semantic similarity
  searchNodes(
    match: MatchType!
    property: String          # required for EXACT match (e.g., "name")
    value: String!
    threshold: Float          # required for SEMANTIC match (0.0–1.0)
    labels: [String!]         # optional label filter
    first: Int = 10
    after: String
  ): NodeResult!

  # Get connections of a known node
  connections(
    nodeId: ID!
    relation: RelationFilter  # optional — omit to get all connections
    target: TargetFilter      # optional target filter
    direction: Direction = OUTGOING
    temporal: TemporalFilter   # optional temporal filter
    first: Int = 10
    after: String
  ): ConnectionResult!

  # --- Maintenance / Librarian Queries ---
  relations: [Relation!]!                   # all relation types with usage counts
  orphans(first: Int = 20, after: String): NodeResult!
  similarPairs(threshold: Float!): [SimilarPair!]!
  schema: SchemaInfo!
}
```

**Example flow** — *"What libraries did Alice use in projects she created?"*:

```graphql
# Round 1: Find Alice
{
  searchNodes(match: EXACT, property: "name", value: "Alice") {
    edges { node { id, labels } }
  }
}

# Round 2: Get Alice's created projects
{
  connections(
    nodeId: "alice_123"
    relation: { match: SEMANTIC, value: "create", threshold: 0.8 }
    target: { on: LABEL, value: "project", threshold: 0.7 }
    direction: OUTGOING, first: 5
  ) {
    edges { node { id, content, labels } relationType relationScore }
    pageInfo { hasNextPage, endCursor }
  }
}

# Round 3: Batch — get libraries for BOTH projects in one request via aliases
{
  alphaLibs: connections(
    nodeId: "proj_alpha"
    relation: { match: SEMANTIC, value: "uses", threshold: 0.8 }
    direction: OUTGOING, first: 10
  ) {
    edges { node { id, content, labels } relationType }
  }
  betaLibs: connections(
    nodeId: "proj_beta"
    relation: { match: SEMANTIC, value: "uses", threshold: 0.8 }
    direction: OUTGOING, first: 10
  ) {
    edges { node { id, content, labels } relationType }
  }
}
# Agent synthesizes final answer from accumulated context.
```

**Key behaviors:**

* **Relation matching:** When `match: SEMANTIC`, uses the waterfall search strategy — embeds the value, searches the relation registry, cascades through matches in descending similarity order.
* **Target filtering:** When present, filters target nodes by semantic similarity on either their content or label vectors (via the `node_labels` table). The agent chooses which vector space to search against.
* **Temporal filtering:** Three modes — `AT` (edge valid at a point in time), `WITHIN` (edge fits entirely inside a range), `OVERLAPS` (edge active at any point during a range). Facts always match. Omitting the temporal field returns all edges.
* **Pagination:** Relay cursor-style. Use `first` + `after` for forward pagination. `pageInfo.endCursor` provides the cursor for the next page.

### 4.3. Mutations (Data Management)

```graphql
type Mutation {
  # --- Node CRUD ---
  createNode(input: CreateNodeInput!): Node!
  updateNode(id: ID!, input: UpdateNodeInput!): Node!
  deleteNode(id: ID!): Boolean!

  # --- Edge CRUD ---
  createEdge(input: CreateEdgeInput!): Edge!
  deleteEdge(id: ID!): Boolean!

  # --- Relation Registry (Librarian Support) ---
  registerRelation(name: String!): Relation!
  mergeRelations(sources: [String!]!, target: String!): Relation!
  deleteRelation(name: String!): Boolean!
}

input CreateNodeInput {
  text: String!
  labels: [String!]!
  properties: JSON            # key-value pairs, e.g. { "name": "Alice", "age": "30" }
}

input UpdateNodeInput {
  text: String            # re-embeds content if changed
  labels: [String!]       # re-embeds labels if changed
  properties: JSON        # replaces all properties if provided
}

input CreateEdgeInput {
  sourceId: ID!
  targetId: ID!
  relationType: String!
  properties: JSON
  validFrom: DateTime     # omit for facts (always true)
  validTo: DateTime       # omit for ongoing states
}
```

**Mutation behaviors:**

* **`createNode`:** Calls Embedding Sidecar to embed text and labels → inserts node row, label rows, and property rows into PostgreSQL.
* **`updateNode`:** Updates specified fields. If `text` or `labels` change, re-embeds them via the Sidecar. If `properties` is provided, replaces all property rows.
* **`deleteNode`:** Removes the node and all associated edges (CASCADE). Returns `true` on success.
* **`createEdge`:** Creates a directed edge. Sets `created_at` automatically. If `validFrom` and `validTo` are omitted, the edge is stored as a **fact**. If the relation type is new, embeds it and adds to the registry.
* **`deleteEdge`:** Removes a single edge. Returns `true` on success.
* **`registerRelation`:** Embeds and registers a canonical relation type.
* **`mergeRelations`:** Re-labels all edges from `sources` to `target`. Removes source entries from the registry.
* **`deleteRelation`:** Removes a relation type (only if no edges reference it).

## 5. Out of Scope

To maintain the "dumb" architecture, the following are strictly excluded from the Databank project:

* Hosting, running, or communicating with generative LLMs (e.g., Ollama, vLLM, OpenAI).
* Executing "Agentic" workflows, reasoning loops, or prompt chaining.
* User interfaces (UI) or front-end dashboarding.
* Document parsing (e.g., converting PDFs to text). Text must be extracted *before* hitting the `/nodes` API.
* Synonym normalization or relation deduplication (Librarian Agent's job).
* Temporal conflict resolution (Consumer App / Librarian Agent's job).

## 6. Technology Stack

* **Language:** TypeScript (Node.js runtime).
* **API:** GraphQL (candidates: graphql-yoga, Apollo Server, Mercurius).
* **Database:** PostgreSQL with pgvector extension.
* **Embedding Sidecar:** Python microservice using HuggingFace `sentence-transformers` (e.g., `bge-small-en-v1.5`). Exposes a single `POST /embed` endpoint. Independently deployable.
