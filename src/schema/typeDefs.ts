import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const typeDefs = readFileSync(
  resolve(__dirname, "schema.graphql"),
  "utf-8",
);
