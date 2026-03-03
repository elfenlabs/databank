-- migrate:up

-- Relation registry (must come first — edges reference it)
CREATE TABLE relations (
  name            TEXT PRIMARY KEY,
  description     TEXT,
  name_vector     vector(384),
  usage_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Property key registry (lightweight vocabulary — no embeddings)
CREATE TABLE property_keys (
  name            TEXT PRIMARY KEY,
  description     TEXT,
  usage_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Entities
CREATE TABLE entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content         TEXT NOT NULL,
  content_vector  vector(384),
  properties      JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_entities_properties ON entities USING GIN (properties);

-- Entity labels (one row per label, each with its own embedding)
CREATE TABLE entity_labels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  label_vector    vector(384),
  UNIQUE(entity_id, label)
);

-- Edges (directed relationships with temporal metadata)
CREATE TABLE edges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID NOT NULL REFERENCES entities(id),
  target_id       UUID NOT NULL REFERENCES entities(id),
  relation_type   TEXT NOT NULL REFERENCES relations(name),
  properties      JSONB NOT NULL DEFAULT '{}',
  valid_from      TIMESTAMPTZ,
  valid_to        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migrate:down

DROP TABLE IF EXISTS edges;
DROP TABLE IF EXISTS entity_labels;
DROP TABLE IF EXISTS entities;
DROP TABLE IF EXISTS property_keys;
DROP TABLE IF EXISTS relations;
