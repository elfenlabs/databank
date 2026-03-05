/**
 * Thin GraphQL fetch helpers for E2E tests.
 *
 * - gql()      → consumer endpoint  (/graphql)
 * - adminGql() → admin endpoint     (/graphql/admin)
 */

const BASE_URL = process.env.GRAPHQL_URL ?? "http://localhost:14000";

const CONSUMER_URL = `${BASE_URL}/graphql`;
const ADMIN_URL = `${BASE_URL}/graphql/admin`;

interface GqlResult<T = Record<string, unknown>> {
  data: T | null;
  errors?: Array<{ message: string; path?: string[]; extensions?: Record<string, unknown> }>;
}

async function query<T = Record<string, unknown>>(
  url: string,
  queryStr: string,
  variables?: Record<string, unknown>,
): Promise<GqlResult<T>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: queryStr, variables }),
  });

  return res.json() as Promise<GqlResult<T>>;
}

/** Execute against the consumer endpoint (/graphql). */
export function gql<T = Record<string, unknown>>(
  queryStr: string,
  variables?: Record<string, unknown>,
): Promise<GqlResult<T>> {
  return query<T>(CONSUMER_URL, queryStr, variables);
}

/** Execute against the admin endpoint (/graphql/admin). */
export function adminGql<T = Record<string, unknown>>(
  queryStr: string,
  variables?: Record<string, unknown>,
): Promise<GqlResult<T>> {
  return query<T>(ADMIN_URL, queryStr, variables);
}
