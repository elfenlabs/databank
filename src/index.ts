import { createSchema, createYoga } from "graphql-yoga";
import { createServer } from "node:http";
import { db } from "./db/client.ts";
import { typeDefs } from "./schema/typeDefs.ts";
import { resolvers } from "./schema/resolvers/index.ts";
import type { GraphContext } from "./schema/context.ts";

const yoga = createYoga<GraphContext>({
  schema: createSchema({ typeDefs, resolvers }),
  context: () => ({ db }),
});

const port = parseInt(process.env.PORT ?? "4000", 10);
const server = createServer(yoga);

server.listen(port, () => {
  console.log(`🏦 Databank running at http://localhost:${port}/graphql`);
});
