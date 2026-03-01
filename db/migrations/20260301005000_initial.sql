-- migrate:up

-- Relation registry (must come first — edges reference it)
CREATE TABLE relations (
  name            TEXT PRIMARY KEY,
  name_vector     vector(384),
  usage_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Nodes
CREATE TABLE nodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content         TEXT NOT NULL,
  content_vector  vector(384),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Node labels (one row per label, each with its own embedding)
CREATE TABLE node_labels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id         UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  label_vector    vector(384),
  UNIQUE(node_id, label)
);

-- Node properties (normalized key-value pairs)
CREATE TABLE node_properties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id         UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  UNIQUE(node_id, key)
);
CREATE INDEX idx_node_properties_lookup ON node_properties(key, value);

-- Edges (directed relationships with temporal metadata)
CREATE TABLE edges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID NOT NULL REFERENCES nodes(id),
  target_id       UUID NOT NULL REFERENCES nodes(id),
  relation_type   TEXT NOT NULL REFERENCES relations(name),
  properties      JSONB NOT NULL DEFAULT '{}',
  valid_from      TIMESTAMPTZ,
  valid_to        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migrate:down

DROP TABLE IF EXISTS edges;
DROP TABLE IF EXISTS node_properties;
DROP TABLE IF EXISTS node_labels;
DROP TABLE IF EXISTS nodes;
DROP TABLE IF EXISTS relations;
