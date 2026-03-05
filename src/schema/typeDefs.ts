import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const consumerTypeDefs = readFileSync(
  resolve(__dirname, "schema.consumer.graphql"),
  "utf-8",
);

export const adminTypeDefs = readFileSync(
  resolve(__dirname, "schema.graphql"),
  "utf-8",
);

/** @deprecated Use `adminTypeDefs` or `consumerTypeDefs` explicitly. */
export const typeDefs = adminTypeDefs;
