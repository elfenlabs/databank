/**
 * Thin GraphQL fetch helper for E2E tests.
 */

const GRAPHQL_URL =
  process.env.GRAPHQL_URL ?? "http://localhost:14000/graphql";

interface GqlResult<T = Record<string, unknown>> {
  data: T | null;
  errors?: Array<{ message: string; path?: string[]; extensions?: Record<string, unknown> }>;
}

export async function gql<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<GqlResult<T>> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  return res.json() as Promise<GqlResult<T>>;
}
