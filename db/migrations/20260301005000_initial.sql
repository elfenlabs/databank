-- migrate:up

-- Relation registry (must come first — edges reference it)
CREATE TABLE relations (
  name            TEXT PRIMARY KEY,
  description     TEXT,
  name_vector     vector(384),
  usage_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trait registry (replaces labels + property_keys)
CREATE TABLE traits (
  name            TEXT PRIMARY KEY,
  description     TEXT,
  name_vector     vector(384),
  usage_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trait property definitions (schema for each trait)
CREATE TABLE trait_properties (
  trait_name      TEXT NOT NULL REFERENCES traits(name) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  description     TEXT,
  PRIMARY KEY (trait_name, key)
);

-- Entities
CREATE TABLE entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  details         TEXT,
  embedding       vector(384),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Entity-trait assignments (replaces entity_labels + entity.properties)
CREATE TABLE entity_traits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  trait_name      TEXT NOT NULL REFERENCES traits(name),
  properties      JSONB NOT NULL DEFAULT '{}',
  UNIQUE(entity_id, trait_name)
);
CREATE INDEX idx_entity_traits_properties ON entity_traits USING GIN (properties);

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
DROP TABLE IF EXISTS entity_traits;
DROP TABLE IF EXISTS entities;
DROP TABLE IF EXISTS trait_properties;
DROP TABLE IF EXISTS traits;
DROP TABLE IF EXISTS relations;
