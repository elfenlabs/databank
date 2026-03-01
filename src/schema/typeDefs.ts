export const typeDefs = /* GraphQL */ `
  scalar DateTime
  scalar JSON

  # --- Enums ---
  enum MatchType { EXACT SEMANTIC }
  enum Direction { OUTGOING INCOMING BOTH }
  enum TemporalMode { AT WITHIN OVERLAPS }
  enum TargetField { CONTENT LABEL }

  # --- Inputs ---
  input RelationFilter {
    match: MatchType!
    value: String!
    threshold: Float
  }

  input TargetFilter {
    on: TargetField!
    value: String!
    threshold: Float!
  }

  input TemporalFilter {
    mode: TemporalMode!
    at: DateTime
    from: DateTime
    to: DateTime
  }

  input CreateNodeInput {
    text: String!
    labels: [String!]!
    properties: JSON
  }

  input UpdateNodeInput {
    text: String
    labels: [String!]
    properties: JSON
  }

  input CreateEdgeInput {
    sourceId: ID!
    targetId: ID!
    relationType: String!
    properties: JSON
    validFrom: DateTime
    validTo: DateTime
  }

  # --- Node Types ---
  type Node {
    id: ID!
    content: String!
    labels: [String!]!
    properties: JSON!
    createdAt: DateTime!
  }

  # --- Connection Types (Relay-style pagination) ---
  type ConnectionEdge {
    node: Node!
    relationType: String!
    relationScore: Float!
    validFrom: DateTime
    validTo: DateTime
    cursor: String!
  }

  type ConnectionResult {
    edges: [ConnectionEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type NodeEdge {
    node: Node!
    cursor: String!
  }

  type NodeResult {
    edges: [NodeEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  # --- Edge Type ---
  type Edge {
    id: ID!
    sourceId: ID!
    targetId: ID!
    relationType: String!
    properties: JSON!
    validFrom: DateTime
    validTo: DateTime
    createdAt: DateTime!
  }

  # --- Relation Registry ---
  type Relation {
    name: String!
    usageCount: Int!
    createdAt: DateTime!
  }

  # --- Maintenance ---
  type SimilarPair {
    nodeA: Node!
    nodeB: Node!
    similarity: Float!
  }

  type SchemaInfo {
    labels: [String!]!
    relationTypes: [String!]!
    nodeCount: Int!
    edgeCount: Int!
  }

  # --- Queries ---
  type Query {
    searchNodes(
      match: MatchType!
      property: String
      value: String!
      threshold: Float
      labels: [String!]
      first: Int = 10
      after: String
    ): NodeResult!

    connections(
      nodeId: ID!
      relation: RelationFilter
      target: TargetFilter
      direction: Direction = OUTGOING
      temporal: TemporalFilter
      first: Int = 10
      after: String
    ): ConnectionResult!

    relations: [Relation!]!
    orphans(first: Int = 20, after: String): NodeResult!
    similarPairs(threshold: Float!): [SimilarPair!]!
    schema: SchemaInfo!
  }

  # --- Mutations ---
  type Mutation {
    createNode(input: CreateNodeInput!): Node!
    updateNode(id: ID!, input: UpdateNodeInput!): Node!
    deleteNode(id: ID!): Boolean!

    createEdge(input: CreateEdgeInput!): Edge!
    deleteEdge(id: ID!): Boolean!

    registerRelation(name: String!): Relation!
    mergeRelations(sources: [String!]!, target: String!): Relation!
    deleteRelation(name: String!): Boolean!
  }
`;
