import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./types.ts";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: DATABASE_URL }),
  }),
});
