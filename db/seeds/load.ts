/**
 * Seed loader — registers starter relations via GraphQL mutations.
 * Idempotent: safe to re-run on an already-seeded databank.
 *
 * Usage: bun run db/seeds/load.ts
 * Env:   DATABANK_URL (default: http://localhost:4000/graphql)
 */

import seeds from "./starter.json";

const url = process.env.DATABANK_URL ?? "http://localhost:4000/graphql";

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
  console.log(`🌱 Seeding databank at ${url}`);

  // Register relations (labels are reference-only, no mutation needed)
  let registered = 0;
  for (const rel of seeds.relations) {
    const { data, errors } = await gql(
      `mutation($name: String!, $desc: String) {
        registerRelation(name: $name, description: $desc) { name }
      }`,
      { name: rel.name, desc: rel.description },
    );

    if (errors) {
      console.error(`  ✗ ${rel.name}: ${errors[0].message}`);
    } else {
      console.log(`  ✓ ${data.registerRelation.name}`);
      registered++;
    }
  }

  console.log(`\n🌱 Done — ${registered}/${seeds.relations.length} relations registered`);
  console.log(`📋 Starter labels (reference): ${seeds.labels.join(", ")}`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
