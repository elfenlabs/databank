import { createSchema, createYoga } from "graphql-yoga";
import { createServer } from "node:http";
import { db } from "./db/client.ts";
import { consumerTypeDefs, adminTypeDefs } from "./schema/typeDefs.ts";
import {
  consumerResolvers,
  adminResolvers,
} from "./schema/resolvers/index.ts";
import type { GraphContext } from "./schema/context.ts";

const consumerYoga = createYoga<GraphContext>({
  schema: createSchema({
    typeDefs: consumerTypeDefs,
    resolvers: consumerResolvers,
  }),
  graphqlEndpoint: "/graphql",
  context: () => ({ db }),
});

const adminYoga = createYoga<GraphContext>({
  schema: createSchema({
    typeDefs: adminTypeDefs,
    resolvers: adminResolvers,
  }),
  graphqlEndpoint: "/graphql/admin",
  context: () => ({ db }),
});

const port = parseInt(process.env.PORT ?? "4000", 10);

const server = createServer((req, res) => {
  if (req.url?.startsWith("/graphql/admin")) {
    return adminYoga(req, res);
  }
  return consumerYoga(req, res);
});

server.listen(port, () => {
  console.log(`🏛️ Thesauros running at http://localhost:${port}/graphql`);
  console.log(`🔑 Admin endpoint at http://localhost:${port}/graphql/admin`);
});
