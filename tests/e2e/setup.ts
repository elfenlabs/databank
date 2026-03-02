/**
 * E2E test lifecycle — manages Docker infra.
 *
 * The databank container handles PG, migrations, and the GraphQL server
 * internally.  Setup just needs to bring compose up and wait for the
 * health-checked endpoint.
 */

import path from "node:path";

const COMPOSE_FILE = path.join(import.meta.dir, "docker-compose.yml");
const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
const TEST_PORT = 14000;

function compose(...args: string[]) {
  const result = Bun.spawnSync(["docker", "compose", "-f", COMPOSE_FILE, ...args], {
    cwd: PROJECT_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed with exit code ${result.exitCode}`);
  }
}

async function waitForServer(url: string, maxRetries = 30, intervalMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Server at ${url} did not become ready in ${maxRetries * intervalMs}ms`);
}

export async function setup() {
  console.log("\n🐳 Starting test infrastructure...");

  // Start containers (--wait blocks until healthy)
  compose("up", "-d", "--wait", "--wait-timeout", "180", "--build");

  // Verify GraphQL endpoint is responding
  await waitForServer(`http://localhost:${TEST_PORT}/graphql`);
  console.log("✅ Test infrastructure ready\n");
}

export async function teardown() {
  console.log("\n🧹 Tearing down test infrastructure...");
  compose("down", "--remove-orphans");
  console.log("✅ Cleanup complete\n");
}
