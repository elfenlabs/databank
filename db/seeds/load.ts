/**
 * Seed loader — registers starter traits and relations via GraphQL mutations.
 * Idempotent: safe to re-run on an already-seeded thesauros.
 *
 * Usage: bun run db/seeds/load.ts
 * Env:   THESAUROS_URL (default: http://localhost:4000/graphql)
 */

import seeds from "./starter.json";

const url = process.env.THESAUROS_URL ?? "http://localhost:4000/graphql";

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log(`🌱 Seeding thesauros at ${url}`);

  // Register traits
  let traitsRegistered = 0;
  for (const trait of seeds.traits) {
    const { data, errors } = await gql(
      `mutation($name: String!, $desc: String, $keys: [String!]) {
        registerTrait(name: $name, description: $desc, propertyKeys: $keys) { name }
      }`,
      { name: trait.name, desc: trait.description, keys: trait.propertyKeys },
    );

    if (errors) {
      console.error(`  ✗ trait ${trait.name}: ${errors[0].message}`);
    } else {
      console.log(`  ✓ trait ${data.registerTrait.name} (${trait.propertyKeys.length} props)`);
      traitsRegistered++;
    }
  }

  // Register relations
  let relationsRegistered = 0;
  for (const rel of seeds.relations) {
    const { data, errors } = await gql(
      `mutation($name: String!, $desc: String) {
        registerRelation(name: $name, description: $desc) { name }
      }`,
      { name: rel.name, desc: rel.description },
    );

    if (errors) {
      console.error(`  ✗ relation ${rel.name}: ${errors[0].message}`);
    } else {
      console.log(`  ✓ relation ${data.registerRelation.name}`);
      relationsRegistered++;
    }
  }

  console.log(`\n🌱 Done — ${traitsRegistered}/${seeds.traits.length} traits, ${relationsRegistered}/${seeds.relations.length} relations registered`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
