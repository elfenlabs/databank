/**
 * E2E test lifecycle — manages Docker infra + server.
 *
 * Used as a Bun preload file via bunfig or called from beforeAll/afterAll.
 */

import { spawn, type Subprocess } from "bun";
import path from "node:path";

const COMPOSE_FILE = path.join(import.meta.dir, "docker-compose.yml");
const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
const TEST_PORT = 14000;
const TEST_PG_PORT = 15432;

const DATABASE_URL = `postgres://databank:databank@localhost:${TEST_PG_PORT}/databank_test?sslmode=disable`;
const EMBED_URL = "http://localhost:18100";

let serverProc: Subprocess | null = null;

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

  // 1. Start containers (--wait blocks until healthy)
  compose("up", "-d", "--wait", "--wait-timeout", "180", "--build");

  // 2. Run migrations
  console.log("📦 Running migrations...");
  const migrateResult = Bun.spawnSync(["dbmate", "--no-dump-schema", "up"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (migrateResult.exitCode !== 0) {
    throw new Error(`dbmate migrate failed with exit code ${migrateResult.exitCode}`);
  }

  // 3. Start yoga server
  console.log("🚀 Starting test server...");
  serverProc = spawn(["bun", "run", "src/index.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DATABASE_URL,
      EMBED_URL,
      PORT: String(TEST_PORT),
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  // 4. Wait for server readiness
  await waitForServer(`http://localhost:${TEST_PORT}/graphql`);
  console.log("✅ Test infrastructure ready\n");
}

export async function teardown() {
  console.log("\n🧹 Tearing down test infrastructure...");

  // Kill server
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }

  // Stop containers — keep hf_cache volume so subsequent runs skip model download
  compose("down", "--remove-orphans");
  console.log("✅ Cleanup complete\n");
}
