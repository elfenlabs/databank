# Product Requirements Document (PRD): Headless GraphRAG Databank

## 1. Product Vision & Executive Summary

The "Databank" is a headless, API-first Retrieval-Augmented Generation (RAG) backend. It acts as a dedicated structural and spatial memory store, combining the topological reasoning of a **Graph Database** with the semantic search of a **Vector Database**.

Crucially, the Databank is "dumb"—it hosts no Large Language Models (LLMs) for reasoning or text generation. It strictly manages data ingestion, embedding, vector search, and graph traversal. By decoupling the storage/retrieval layer from the reasoning layer, consumer applications and background maintenance workers can scale and swap LLMs independently.

## 2. System Architecture & Actors

The ecosystem consists of three distinct components, with the Databank serving as the central hub:

| Actor | Description | Responsibility |
| --- | --- | --- |
| **The Databank (System)** | TypeScript app serving a REST API, wrapping a Graph DB, a Vector DB, and an Embedding Sidecar. | Executes hybrid searches, stores nodes/edges, manages a relation registry, and serves structured context. |
| **Embedding Sidecar (Internal)** | A lightweight microservice (e.g., Python + `sentence-transformers`) that exposes an HTTP embedding endpoint. | Converts text into vector embeddings on demand. Called by the Databank during ingestion and query-time relation matching. |
| **Consumer App (External)** | The user-facing application (e.g., TypeScript/Next.js) powered by a heavy LLM (e.g., 120B parameter model). | Receives user queries, **decomposes them into structured Databank queries**, fetches context, and generates final answers. |
| **Librarian Agent (External)** | A lightweight background worker (e.g., Python script running a fast 7B local LLM). | Queries the Databank for unconnected nodes, infers relationships, writes edges, and **compresses/normalizes the relation registry**. |

### 2.1. Dual-Store Architecture

The Databank internally operates three backend services:

```
                 ┌──────────────────────────────────────┐
                 │        Databank (TypeScript)          │
                 │                                      │
 Consumer/       │  ┌────────────┐  ┌───────────┐       │
 Librarian ────► │  │  Vector DB │  │ Graph DB  │       │
                 │  │            │  │           │       │
                 │  │ • Node     │  │ • Nodes   │       │
                 │  │   vectors  │  │ • Edges   │       │
                 │  │ • Relation │  │ • Props   │       │
                 │  │   vectors  │  │           │       │
                 │  └────────────┘  └───────────┘       │
                 │                                      │
                 │  ┌─────────────────────────────────┐ │
                 │  │  Embedding Sidecar (Python)      │ │
                 │  │  POST /embed { text } → vector   │ │
                 │  └─────────────────────────────────┘ │
                 └──────────────────────────────────────┘
```

| Component | Responsibility |
| --- | --- |
| **Vector DB** | Stores embeddings for node content, node labels, and relation names. Handles ANN (approximate nearest neighbor) similarity search. Three logical collections: `node_content`, `node_labels`, and `relations`. |
| **Graph DB** | Stores the knowledge graph topology: nodes (with properties), directed edges (with temporal metadata), and labels. Handles traversals and Cypher-style queries. |
| **Embedding Sidecar** | Converts text → vector embeddings via HTTP. Stateless microservice, independently deployable and swappable. Decouples the ML runtime from the Databank's TypeScript process. |

> **Stack Note:** The concrete databases are intentionally left abstract. Candidates under exploration include Neo4j + a dedicated vector DB (e.g., Qdrant, ChromaDB), or a unified PostgreSQL approach using Apache AGE (graph) + pgvector (vectors). The Databank API abstracts this choice away from consumers.

## 3. Core Features & Requirements

### 3.1. Data Ingestion & Indexing

* **Node Vectorization:** The Databank must convert incoming text into vector embeddings by calling the Embedding Sidecar before storing the vector in the Vector DB and node data in the Graph DB.
* **Atomic Operations:** Ability to add isolated nodes (documents/chunks) and explicitly draw edges (relationships) between existing nodes.

### 3.2. Relation Vectorization (Core)

Relationship names in knowledge graphs are inherently non-structured and ambiguous (e.g., `"creates"`, `"constructs"`, `"builds"` may all express the same intent). The Databank addresses this with a **Relation Registry**:

* **Approach:** Store-raw, resolve-at-query-time (Approach C). When an edge is created with a new relation type, the Databank embeds the relation name and adds it to the `relations` collection in the Vector DB. **No normalization or synonym resolution is performed**—this is strictly the Librarian Agent's responsibility.
* **Query-Time Resolution:** When a query includes a semantic relation match, the Databank embeds the query's relation term, searches the relation registry for the top matches above a given threshold, and uses those matches to filter graph traversals.

### 3.3. Temporal Relationships

Edges carry temporal metadata:

* **`valid_from`** (`datetime`, required): Set automatically on edge creation.
* **`valid_to`** (`datetime | null`): `null` indicates the relationship is currently active.

Relationships fall into two temporal categories:

| Category | Example | `valid_from` | `valid_to` |
| --- | --- | --- | --- |
| **State** | `User LIVES_IN Japan` | When it became true | When it stopped being true (`null` = still active) |
| **Event** | `Lily CONSUMED Ramen` | When it happened | Same as `valid_from` (point-in-time) or end of event |

**Three query-time temporal modes:**

| Mode | Semantics | Filter Logic |
| --- | --- | --- |
| **`at`** | "Is this edge valid at time T?" | `valid_from ≤ T` AND (`valid_to IS NULL` OR `valid_to > T`) |
| **`within`** | "Does this edge fit entirely inside [T₁, T₂]?" | `valid_from ≥ T₁` AND `valid_to ≤ T₂` |
| **`overlaps`** | "Was this edge active at any point during [T₁, T₂]?" | `valid_from ≤ T₂` AND (`valid_to IS NULL` OR `valid_to ≥ T₁`) |

Omitting the temporal filter returns all edges regardless of time.

The Databank does **not** manage temporal conflict resolution (e.g., closing a previous `LIVES_IN` edge when a new one is created)—that is the Consumer App's or Librarian Agent's responsibility. The Databank also does **not** classify edges as state vs. event—the querying agent decides which temporal mode to use.

### 3.4. Waterfall Search (Relation-Cascade Retrieval)

The primary retrieval strategy for structured queries:

```
Input: node=<ref>, relation≈"Build", threshold=0.8, limit=5, as_of=now

Step 1 — Relation Resolution:
   Embed "Build" → search relation registry (threshold ≥ 0.8)
   Result: ["Builds" (0.97), "Constructs" (0.91), "Creates" (0.85)]

Step 2 — Cascading Graph Queries:
   For each matched relation (descending by score):
     Query graph: node -[relation]-> ? WHERE temporally valid
     Accumulate results until limit is reached
     Stop early if limit is satisfied

Step 3 — Return results with provenance:
   Each result tagged with matched relation name + similarity score
```

> **Efficiency Note:** This waterfall approach is intentionally simple (Approach C trade-off). As the Librarian Agent normalizes synonym relations over time, cascades become shorter organically.

### 3.5. Graph Maintenance Support

* **Orphan Detection:** Must identify and serve nodes that lack relationship edges to feed the external Librarian Agent's queue.
* **Similarity Detection:** Must identify node pairs that have high vector similarity but no explicit graph edge, flagging potential duplicates or implicit relationships.

## 4. API Specification

The Databank exposes a **pure REST API**. All endpoints communicate via JSON.

**Design Philosophy:** The consumer is an intelligent agent capable of multi-step reasoning. Instead of providing a complex query language with nested traversals, the API embraces **round-trip exploration** — each endpoint does one thing well, and the agent chains calls together with reasoning between steps. This keeps the Databank "dumb" and pushes all intelligence to the caller.

```
┌──────────────────────────────────────────┐
│          Databank (TypeScript)            │
│                                          │
│   /api/v1/*  ← REST endpoints            │
│     • Query: node search, connections    │
│     • CRUD: nodes, edges                 │
│     • Relation registry management       │
│     • Maintenance / Librarian queue      │
└──────────────────────────────────────────┘
```

### 4.1. Query Layer (Round-Trip Exploration)

The agent explores the graph one step at a time, reasoning between each call.

**Example flow** — *"What libraries did Alice use in projects she created?"*:

```
Round 1: POST /api/v1/search/nodes
  { "match": "exact", "property": "name", "value": "Alice" }
  → [{ "node_id": "alice_123", "labels": ["Person"], ... }]

Round 2: POST /api/v1/connections
  { "node_id": "alice_123",
    "relation": { "match": "semantic", "value": "create", "threshold": 0.8 },
    "target": { "match": "semantic", "on": "label", "value": "project", "threshold": 0.7 },
    "direction": "outgoing", "limit": 5 }
  → [{ "node_id": "proj_alpha", ... }, { "node_id": "proj_beta", ... }]
  Agent reasons: "Got the projects. Now I need their libraries."

Round 3: POST /api/v1/connections
  { "node_id": "proj_alpha",
    "relation": { "match": "semantic", "value": "use", "threshold": 0.8 },
    "direction": "outgoing", "limit": 10 }
  → [{ "node_id": "react_1", ... }, { "node_id": "nodejs_1", ... }]

  Agent synthesizes final answer from accumulated context.
```

#### `POST /api/v1/search/nodes`

Discover nodes by property match or semantic similarity.

* **Payload:**
  ```json
  {
    "match": "exact" | "semantic",
    "property": string,       // required for exact match (e.g., "name")
    "value": string,          // the search term
    "threshold": float,       // required for semantic match (0.0–1.0)
    "labels": [string],       // optional label filter
    "limit": int              // max results (default: 10)
  }
  ```
* **Exact match:** Filters nodes where the specified property equals the value.
* **Semantic match:** Embeds the value via Sidecar, searches the `node_content` vector collection.
* **Returns:** List of matching nodes with `node_id`, `content`, `labels`, `metadata`.

#### `POST /api/v1/connections`

Get connections of a known node with semantic relation matching and optional target filtering.

* **Payload:**
  ```json
  {
    "node_id": string,
    "relation": {
      "match": "exact" | "semantic",
      "value": string,
      "threshold": float        // required for semantic match
    },
    "target": {                  // optional target filter
      "match": "semantic",
      "on": "content" | "label", // search against node content or label vectors
      "value": string,
      "threshold": float
    },
    "direction": "outgoing" | "incoming" | "both",
    "temporal": {                // optional temporal filter
      "mode": "at" | "within" | "overlaps",
      "at": datetime,           // required for "at" mode
      "from": datetime,         // required for "within" / "overlaps" modes
      "to": datetime            // required for "within" / "overlaps" modes
    },
    "limit": int                 // max results (default: 10)
  }
  ```
* **Relation matching:** When `match: "semantic"`, uses the waterfall search strategy — embeds the value, searches the relation registry, cascades through matches in descending similarity order.
* **Target filtering:** When present, filters target nodes by semantic similarity on either their content or label vectors. The agent chooses which vector space to search against.
* **Temporal filtering:** Three modes — `at` (edge valid at a point in time), `within` (edge fits entirely inside a range), `overlaps` (edge active at any point during a range). Omitting the temporal field returns all edges regardless of time.
* **Returns:** List of connections with `node_id`, `content`, `labels`, `relation_type`, `relation_score`, `valid_from`, `valid_to`.

### 4.2. Data Layer (Ingestion)

* **`POST /api/v1/nodes`**
  * **Payload:** `{"text": string, "metadata": object, "labels": string[]}`
  * **Action:** Calls Embedding Sidecar to embed text and labels → stores vectors in Vector DB, node in Graph DB.
  * **Returns:** `{"node_id": string}`

* **`POST /api/v1/edges`**
  * **Payload:** `{"source_id": string, "target_id": string, "relation_type": string, "properties": object}`
  * **Action:** Creates a directed relationship. Sets `valid_from` automatically. If the relation type is new, embeds it and adds to the relation registry.
  * **Returns:** `{"status": "success", "edge_id": string}`

### 4.3. Relation Registry (Librarian Support)

* **`GET /api/v1/relations`** — List all known relation types with usage counts.
* **`POST /api/v1/relations`** — Explicitly register a canonical relation type and embed it.
  * **Payload:** `{"name": string}`
* **`POST /api/v1/relations/merge`** — Re-label all edges from `sources` to `target`. Remove sources from the registry.
  * **Payload:** `{"sources": string[], "target": string}`
* **`DELETE /api/v1/relations/{name}`** — Remove a relation type (only if no edges reference it).

### 4.4. Maintenance Layer (Librarian Queue)

* **`GET /api/v1/maintenance/orphans`** — Nodes with 0 edges.
* **`GET /api/v1/maintenance/similar-pairs`** — Unconnected node pairs above a similarity threshold.
  * **Payload:** `{"similarity_threshold": float}`
* **`GET /api/v1/schema`** — Summary of all active node labels and relationship types.

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
* **REST Framework:** TBD (candidates: Fastify, Express, Hono).
* **Graph Database:** Abstract (candidates: Neo4j Community Edition, Apache AGE over PostgreSQL).
* **Vector Database:** Abstract (candidates: pgvector over PostgreSQL, Qdrant, ChromaDB).
* **Embedding Sidecar:** Python microservice using HuggingFace `sentence-transformers` (e.g., `bge-small-en-v1.5`). Exposes a single `POST /embed` endpoint. Independently deployable.

> **Exploration Note:** A unified PostgreSQL approach (Apache AGE + pgvector) is a candidate for collapsing both stores into a single engine. This requires further research into AGE's openCypher support completeness and AGE-pgvector interop before committing.
