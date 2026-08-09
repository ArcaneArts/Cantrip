import { z } from "zod";

const MAX_JSON_BYTES = 1_000_000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_CONTAINER_ITEMS = 1_000;
const MAX_JSON_KEY_LENGTH = 256;
const MAX_JSON_STRING_LENGTH = 100_000;

export type WorkflowJsonValue =
  | boolean
  | number
  | string
  | null
  | WorkflowJsonValue[]
  | { [key: string]: WorkflowJsonValue };
export type WorkflowJsonObject = { [key: string]: WorkflowJsonValue };

function jsonValidationError(
  root: unknown,
  requireObject: boolean,
): string | null {
  if (
    requireObject &&
    (root === null || typeof root !== "object" || Array.isArray(root))
  ) {
    return "Expected a JSON object.";
  }

  const seen = new WeakSet<object>();
  const stack: Array<{ depth: number; value: unknown }> = [
    { depth: 0, value: root },
  ];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      return `JSON payloads may contain at most ${MAX_JSON_NODES} values.`;
    }
    if (current.depth > MAX_JSON_DEPTH) {
      return `JSON payloads may be nested at most ${MAX_JSON_DEPTH} levels.`;
    }

    const value = current.value;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return "JSON numbers must be finite.";
      continue;
    }
    if (typeof value === "string") {
      if (value.length > MAX_JSON_STRING_LENGTH) {
        return `JSON strings may contain at most ${MAX_JSON_STRING_LENGTH} characters.`;
      }
      continue;
    }
    if (typeof value !== "object") {
      return "Values must be JSON serializable.";
    }
    if (seen.has(value)) {
      return "JSON payloads cannot contain cycles or shared object references.";
    }
    seen.add(value);

    if (Array.isArray(value)) {
      if (value.length > MAX_CONTAINER_ITEMS) {
        return `JSON arrays may contain at most ${MAX_CONTAINER_ITEMS} items.`;
      }
      for (const item of value) {
        stack.push({ depth: current.depth + 1, value: item });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return "JSON objects must be plain objects.";
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_CONTAINER_ITEMS) {
      return `JSON objects may contain at most ${MAX_CONTAINER_ITEMS} keys.`;
    }
    for (const [key, item] of entries) {
      if (!key || key.length > MAX_JSON_KEY_LENGTH) {
        return `JSON object keys must contain 1-${MAX_JSON_KEY_LENGTH} characters.`;
      }
      stack.push({ depth: current.depth + 1, value: item });
    }
  }

  let encodedLength: number;
  try {
    encodedLength = new TextEncoder().encode(JSON.stringify(root)).length;
  } catch {
    return "Values must be JSON serializable.";
  }
  return encodedLength <= MAX_JSON_BYTES
    ? null
    : `JSON payloads may contain at most ${MAX_JSON_BYTES} encoded bytes.`;
}

export const workflowJsonValueSchema = z
  .unknown()
  .transform<WorkflowJsonValue>((value, context) => {
    const error = jsonValidationError(value, false);
    if (error) {
      context.addIssue({ code: "custom", message: error });
    }
    return value as WorkflowJsonValue;
  });

export const workflowJsonObjectSchema = z
  .unknown()
  .transform<WorkflowJsonObject>((value, context) => {
    const error = jsonValidationError(value, true);
    if (error) {
      context.addIssue({ code: "custom", message: error });
    }
    return value as WorkflowJsonObject;
  });

const idSchema = z.string().trim().min(1).max(200);
const optionalIdSchema = idSchema.nullable().default(null);
const workflowKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u);

function uniqueStrings(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const workflowScopeSchema = z.enum(["personal", "project"]);
export const workflowTrustStateSchema = z.enum([
  "untrusted",
  "trusted",
  "modified",
  "blocked",
]);
export const workflowSourceSchema = z.enum([
  "cantrip",
  "manual",
  "generated",
  "imported",
  "saved-run",
  "repository",
]);
export const workflowProvenanceOriginSchema = z.enum([
  "cantrip",
  "claude-code",
  "cursor",
  "repository",
  "workflow-run",
  "chat",
  "generated",
]);

function defaultWorkflowProvenance() {
  return {
    origin: "cantrip" as const,
    sourceId: null,
    sourceRevision: null,
    reference: null,
    importedAt: null,
    metadata: {},
  };
}

export const workflowProvenanceSchema = z.object({
  origin: workflowProvenanceOriginSchema.default("cantrip"),
  sourceId: z.string().trim().min(1).max(500).nullable().default(null),
  sourceRevision: z.string().trim().min(1).max(500).nullable().default(null),
  reference: z.string().trim().min(1).max(2_000).nullable().default(null),
  importedAt: z.string().datetime().nullable().default(null),
  metadata: workflowJsonObjectSchema.default({}),
});

function defaultWorkflowPermissionRequirements() {
  return {
    filesystem: "read-only" as const,
    network: "none" as const,
    approvalMode: "interactive" as const,
    skills: [],
    mcpServers: [],
    nativeSubagents: false,
  };
}

export const workflowPermissionRequirementsSchema = z
  .object({
    filesystem: z.enum(["read-only", "workspace-write"]).default("read-only"),
    network: z.enum(["none", "restricted", "unrestricted"]).default("none"),
    approvalMode: z
      .enum(["interactive", "preauthorized"])
      .default("interactive"),
    skills: z.array(workflowKeySchema).max(100).default([]),
    mcpServers: z.array(idSchema).max(100).default([]),
    nativeSubagents: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (!uniqueStrings(value.skills)) {
      context.addIssue({
        code: "custom",
        message: "Skill names must be unique.",
        path: ["skills"],
      });
    }
    if (!uniqueStrings(value.mcpServers)) {
      context.addIssue({
        code: "custom",
        message: "MCP server names must be unique.",
        path: ["mcpServers"],
      });
    }
  });

function defaultWorkflowBudget() {
  return {
    maxNodes: 100,
    maxAttemptsPerNode: 3,
    maxParallelism: 4,
    maxTokens: null,
    maxDurationMs: 60 * 60 * 1_000,
    maxNodeDurationMs: 15 * 60 * 1_000,
    maxEstimatedCostUsd: null,
  };
}

export const workflowBudgetSchema = z.object({
  maxNodes: z.number().int().min(1).max(1_000).default(100),
  maxAttemptsPerNode: z.number().int().min(1).max(100).default(3),
  maxParallelism: z.number().int().min(1).max(100).default(4),
  maxTokens: z
    .number()
    .int()
    .positive()
    .max(1_000_000_000)
    .nullable()
    .default(null),
  maxDurationMs: z
    .number()
    .int()
    .min(1_000)
    .max(30 * 24 * 60 * 60 * 1_000)
    .default(60 * 60 * 1_000),
  maxNodeDurationMs: z
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1_000)
    .default(15 * 60 * 1_000),
  maxEstimatedCostUsd: z
    .number()
    .positive()
    .max(1_000_000)
    .nullable()
    .default(null),
});

export const workflowMeasuredUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
  estimatedCostUsd: z.number().nonnegative().nullable().default(null),
  costAvailable: z.boolean().default(false),
});

export const workflowNodeTypeSchema = z.enum([
  "agent",
  "map",
  "pipeline",
  "reduce",
  "verify",
  "condition",
  "repeatUntil",
  "gate",
]);
export const workflowMutationModeSchema = z.enum(["read-only", "write"]);

export const workflowAgentNodeConfigurationSchema = z
  .object({
    prompt: z.string().trim().min(1).max(100_000),
    developerInstructions: z
      .string()
      .trim()
      .min(1)
      .max(100_000)
      .nullable()
      .default(null),
    includeStructuredInput: z.boolean().default(true),
    automaticRetries: z.number().int().min(0).max(99).nullable().default(null),
  })
  .strict();

export const workflowJsonPointerSchema = z
  .string()
  .max(2_000)
  .refine(
    (value) =>
      value === "" ||
      (value.startsWith("/") &&
        value
          .slice(1)
          .split("/")
          .every((segment) => /^(?:[^~/]|~[01])*$/u.test(segment))),
    "Expected an RFC 6901 JSON pointer.",
  );

export const workflowPredicateOperatorSchema = z.enum([
  "exists",
  "not-exists",
  "equals",
  "not-equals",
  "greater-than",
  "greater-than-or-equals",
  "less-than",
  "less-than-or-equals",
  "contains",
]);

export const workflowPredicateSchema = z
  .object({
    path: workflowJsonPointerSchema,
    operator: workflowPredicateOperatorSchema,
    value: workflowJsonValueSchema.optional(),
  })
  .strict()
  .superRefine((predicate, context) => {
    const unary =
      predicate.operator === "exists" || predicate.operator === "not-exists";
    const hasValue = Object.hasOwn(predicate, "value");
    if (unary && hasValue) {
      context.addIssue({
        code: "custom",
        message: `${predicate.operator} predicates cannot declare a comparison value.`,
        path: ["value"],
      });
    }
    if (!unary && !hasValue) {
      context.addIssue({
        code: "custom",
        message: `${predicate.operator} predicates require a comparison value.`,
        path: ["value"],
      });
    }
  });

export const workflowCollectionFailurePolicySchema = z.enum([
  "fail-fast",
  "continue",
]);

export const workflowMapNodeConfigurationSchema =
  workflowAgentNodeConfigurationSchema
    .extend({
      collectionPath: workflowJsonPointerSchema.default(""),
      itemInputKey: workflowKeySchema.default("item"),
      maxConcurrency: z.number().int().min(1).max(100),
      failurePolicy: workflowCollectionFailurePolicySchema.default("fail-fast"),
    })
    .strict();

export const workflowPipelineStepSchema = workflowAgentNodeConfigurationSchema
  .extend({
    key: workflowKeySchema,
    name: z.string().trim().min(1).max(200),
    outputSchema: workflowJsonObjectSchema.default({}),
  })
  .strict();

export const workflowPipelineNodeConfigurationSchema = z
  .object({
    collectionPath: workflowJsonPointerSchema.default(""),
    itemInputKey: workflowKeySchema.default("item"),
    maxConcurrency: z.number().int().min(1).max(100),
    failurePolicy: workflowCollectionFailurePolicySchema.default("fail-fast"),
    steps: z.array(workflowPipelineStepSchema).min(1).max(32),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (!uniqueStrings(configuration.steps.map(({ key }) => key))) {
      context.addIssue({
        code: "custom",
        message: "Pipeline step keys must be unique.",
        path: ["steps"],
      });
    }
  });

export const workflowReduceNodeConfigurationSchema =
  workflowAgentNodeConfigurationSchema
    .extend({
      collectionPath: workflowJsonPointerSchema.default(""),
      emptyCollection: z.enum(["fail", "complete"]).default("fail"),
    })
    .strict();

export const workflowVerifyNodeConfigurationSchema =
  workflowAgentNodeConfigurationSchema
    .extend({
      passCondition: workflowPredicateSchema,
      failurePolicy: z.enum(["fail-run", "continue"]).default("fail-run"),
    })
    .strict();

export const workflowConditionNodeConfigurationSchema = z
  .object({
    requireMatch: z.boolean().default(true),
  })
  .strict();

export const workflowRepeatUntilNodeConfigurationSchema =
  workflowAgentNodeConfigurationSchema
    .extend({
      successCondition: workflowPredicateSchema,
      progressPath: workflowJsonPointerSchema,
      maxUnchangedIterations: z.number().int().min(1).max(100),
      maxIterations: z.number().int().min(1).max(100),
      maxDurationMs: z
        .number()
        .int()
        .min(1_000)
        .max(24 * 60 * 60 * 1_000),
    })
    .strict();

export const workflowGateNodeConfigurationSchema = z
  .object({
    prompt: z.string().trim().min(1).max(5_000),
    expiresAfterMs: z
      .number()
      .int()
      .min(1_000)
      .max(30 * 24 * 60 * 60 * 1_000)
      .nullable()
      .default(null),
    denialPolicy: z.enum(["fail-run", "skip-downstream"]).default("fail-run"),
  })
  .strict();

export const workflowNodeConfigurationSchemas = {
  agent: workflowAgentNodeConfigurationSchema,
  map: workflowMapNodeConfigurationSchema,
  pipeline: workflowPipelineNodeConfigurationSchema,
  reduce: workflowReduceNodeConfigurationSchema,
  verify: workflowVerifyNodeConfigurationSchema,
  condition: workflowConditionNodeConfigurationSchema,
  repeatUntil: workflowRepeatUntilNodeConfigurationSchema,
  gate: workflowGateNodeConfigurationSchema,
} as const;

const workflowRevisionNodeInputObject = z.object({
  key: workflowKeySchema,
  type: workflowNodeTypeSchema,
  name: z.string().trim().min(1).max(200),
  configuration: workflowJsonObjectSchema.default({}),
  inputSchema: workflowJsonObjectSchema.default({}),
  outputSchema: workflowJsonObjectSchema.default({}),
  permissionRequirements: workflowPermissionRequirementsSchema.default(
    defaultWorkflowPermissionRequirements,
  ),
  mutationMode: workflowMutationModeSchema.default("read-only"),
  modelRouteId: optionalIdSchema,
  permissionProfileId: optionalIdSchema,
});

function validateNodeFilesystemAccess(node: {
  mutationMode: z.infer<typeof workflowMutationModeSchema>;
  permissionRequirements: z.infer<typeof workflowPermissionRequirementsSchema>;
}): string | null {
  const expectedFilesystem =
    node.mutationMode === "write" ? "workspace-write" : "read-only";
  return node.permissionRequirements.filesystem === expectedFilesystem
    ? null
    : `${node.mutationMode} nodes must request ${expectedFilesystem} filesystem access.`;
}

function refineWorkflowNode(
  node: z.infer<typeof workflowRevisionNodeInputObject>,
  context: z.RefinementCtx,
): void {
  const filesystemError = validateNodeFilesystemAccess(node);
  if (filesystemError) {
    context.addIssue({
      code: "custom",
      message: filesystemError,
      path: ["permissionRequirements", "filesystem"],
    });
  }
  if (
    (node.type === "condition" || node.type === "gate") &&
    node.mutationMode !== "read-only"
  ) {
    context.addIssue({
      code: "custom",
      message: `${node.type} nodes must be read-only.`,
      path: ["mutationMode"],
    });
  }
  const result = workflowNodeConfigurationSchemas[node.type].safeParse(
    node.configuration,
  );
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({
        ...issue,
        path: ["configuration", ...issue.path],
      });
    }
  }
}

function normalizeWorkflowNodeConfiguration(
  node: z.infer<typeof workflowRevisionNodeInputObject>,
) {
  return {
    ...node,
    configuration: workflowNodeConfigurationSchemas[node.type].parse(
      node.configuration,
    ),
  };
}

export const workflowRevisionNodeInputSchema = workflowRevisionNodeInputObject
  .superRefine(refineWorkflowNode)
  .transform(normalizeWorkflowNodeConfiguration);

export const workflowRevisionEdgeInputSchema = z.object({
  from: workflowKeySchema,
  to: workflowKeySchema,
  sourceOutput: z.string().trim().min(1).max(200).nullable().default(null),
  targetInput: z.string().trim().min(1).max(200).nullable().default(null),
  condition: workflowPredicateSchema.nullable().default(null),
});

export const workflowGraphSchema = z
  .object({
    version: z.literal(1),
    nodes: z.array(workflowRevisionNodeInputSchema).min(1).max(256),
    edges: z.array(workflowRevisionEdgeInputSchema).max(2_048).default([]),
  })
  .superRefine((graph, context) => {
    const keys = new Set<string>();
    for (const [index, node] of graph.nodes.entries()) {
      if (keys.has(node.key)) {
        context.addIssue({
          code: "custom",
          message: `Node key ${node.key} is duplicated.`,
          path: ["nodes", index, "key"],
        });
      }
      keys.add(node.key);
    }

    const edgeKeys = new Set<string>();
    const indegree = new Map(graph.nodes.map(({ key }) => [key, 0]));
    const outgoing = new Map(
      graph.nodes.map(({ key }) => [key, [] as string[]]),
    );
    const outgoingEdges = new Map(
      graph.nodes.map(({ key }) => [
        key,
        [] as Array<(typeof graph.edges)[number]>,
      ]),
    );
    const incomingEdges = new Map(
      graph.nodes.map(({ key }) => [
        key,
        [] as Array<(typeof graph.edges)[number]>,
      ]),
    );
    for (const [index, edge] of graph.edges.entries()) {
      if (!keys.has(edge.from)) {
        context.addIssue({
          code: "custom",
          message: `Unknown source node ${edge.from}.`,
          path: ["edges", index, "from"],
        });
      }
      if (!keys.has(edge.to)) {
        context.addIssue({
          code: "custom",
          message: `Unknown target node ${edge.to}.`,
          path: ["edges", index, "to"],
        });
      }
      if (edge.from === edge.to) {
        context.addIssue({
          code: "custom",
          message: "Workflow dependency edges cannot target the same node.",
          path: ["edges", index],
        });
      }
      const signature = [
        edge.from,
        edge.to,
        edge.sourceOutput ?? "",
        edge.targetInput ?? "",
      ].join("\u0000");
      if (edgeKeys.has(signature)) {
        context.addIssue({
          code: "custom",
          message: "Workflow dependency edges must be unique.",
          path: ["edges", index],
        });
      }
      edgeKeys.add(signature);
      if (keys.has(edge.from) && keys.has(edge.to) && edge.from !== edge.to) {
        outgoing.get(edge.from)!.push(edge.to);
        outgoingEdges.get(edge.from)!.push(edge);
        incomingEdges.get(edge.to)!.push(edge);
        indegree.set(edge.to, indegree.get(edge.to)! + 1);
      }
    }

    for (const edges of incomingEdges.values()) {
      if (edges.length < 2) continue;
      const destinations = new Set<string>();
      for (const edge of edges) {
        const destination = edge.targetInput ?? edge.from;
        if (destinations.has(destination)) {
          context.addIssue({
            code: "custom",
            message: `Dependency mappings collide at target input ${destination}.`,
            path: ["edges", graph.edges.indexOf(edge), "targetInput"],
          });
        }
        destinations.add(destination);
      }
    }

    for (const node of graph.nodes) {
      const edges = outgoingEdges.get(node.key) ?? [];
      if (node.type !== "condition") {
        for (const edge of edges) {
          if (edge.condition) {
            context.addIssue({
              code: "custom",
              message:
                "Conditional edges must originate from a condition node.",
              path: ["edges", graph.edges.indexOf(edge), "condition"],
            });
          }
        }
        continue;
      }
      if (edges.length < 2) {
        context.addIssue({
          code: "custom",
          message: "Condition nodes require at least two outgoing branches.",
          path: ["nodes", graph.nodes.findIndex(({ key }) => key === node.key)],
        });
      }
      const fallbackIndexes = edges
        .map((edge, index) => (edge.condition === null ? index : -1))
        .filter((index) => index >= 0);
      if (fallbackIndexes.length > 1) {
        context.addIssue({
          code: "custom",
          message: "Condition nodes may declare at most one fallback branch.",
          path: ["edges"],
        });
      }
      if (
        fallbackIndexes.length === 1 &&
        fallbackIndexes[0] !== edges.length - 1
      ) {
        context.addIssue({
          code: "custom",
          message: "A condition fallback branch must be ordered last.",
          path: ["edges", graph.edges.indexOf(edges[fallbackIndexes[0]!]!)],
        });
      }
      if (edges.every(({ condition }) => condition === null)) {
        context.addIssue({
          code: "custom",
          message: "Condition nodes require at least one predicate branch.",
          path: ["edges"],
        });
      }
    }

    const ready = [...indegree]
      .filter(([, count]) => count === 0)
      .map(([key]) => key);
    let visited = 0;
    while (ready.length > 0) {
      const key = ready.pop()!;
      visited += 1;
      for (const target of outgoing.get(key) ?? []) {
        const count = indegree.get(target)! - 1;
        indegree.set(target, count);
        if (count === 0) ready.push(target);
      }
    }
    if (visited !== graph.nodes.length) {
      context.addIssue({
        code: "custom",
        message: "Workflow dependency edges must form an acyclic graph.",
        path: ["edges"],
      });
    }
  });

export const workflowRevisionCreateSchema = z.object({
  graph: workflowGraphSchema,
  declaredInputs: workflowJsonObjectSchema.default({}),
  declaredOutputs: workflowJsonObjectSchema.default({}),
  defaults: workflowJsonObjectSchema.default({}),
  permissionRequirements: workflowPermissionRequirementsSchema.default(
    defaultWorkflowPermissionRequirements,
  ),
  source: workflowSourceSchema.default("cantrip"),
  provenance: workflowProvenanceSchema.default(defaultWorkflowProvenance),
  trustState: workflowTrustStateSchema.default("untrusted"),
});

const workflowDefinitionCreateObject = z.object({
  scope: workflowScopeSchema,
  projectId: optionalIdSchema,
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5_000).nullable().default(null),
  source: workflowSourceSchema.default("cantrip"),
  provenance: workflowProvenanceSchema.default(defaultWorkflowProvenance),
  trustState: workflowTrustStateSchema.default("untrusted"),
  revision: workflowRevisionCreateSchema,
});

export const workflowDefinitionCreateSchema =
  workflowDefinitionCreateObject.superRefine((workflow, context) => {
    if (workflow.scope === "project" && !workflow.projectId) {
      context.addIssue({
        code: "custom",
        message: "Project workflows require a project id.",
        path: ["projectId"],
      });
    }
    if (workflow.scope === "personal" && workflow.projectId) {
      context.addIssue({
        code: "custom",
        message: "Personal workflows cannot belong to a project.",
        path: ["projectId"],
      });
    }
    if (
      workflow.source !== workflow.revision.source ||
      canonicalJson(workflow.provenance) !==
        canonicalJson(workflow.revision.provenance) ||
      workflow.trustState !== workflow.revision.trustState
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The initial revision must use the workflow source, provenance, and trust state.",
        path: ["revision"],
      });
    }
  });

export const workflowDefinitionUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5_000).nullable().optional(),
    trustState: workflowTrustStateSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one workflow metadata update.",
  });

export const workflowRevisionSummarySchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  revision: z.number().int().positive(),
  source: workflowSourceSchema,
  provenance: workflowProvenanceSchema,
  trustState: workflowTrustStateSchema,
  contentHash: z.string().min(1).max(200),
  createdByUserId: idSchema.nullable(),
  createdAt: z.string().datetime(),
});

export const workflowDefinitionSummarySchema = z.object({
  id: idSchema,
  ownerId: idSchema,
  projectId: idSchema.nullable(),
  scope: workflowScopeSchema,
  slug: workflowDefinitionCreateObject.shape.slug,
  name: workflowDefinitionCreateObject.shape.name,
  description: z.string().max(5_000).nullable(),
  source: workflowSourceSchema,
  provenance: workflowProvenanceSchema,
  trustState: workflowTrustStateSchema,
  archivedAt: z.string().datetime().nullable(),
  latestRevision: workflowRevisionSummarySchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const workflowRevisionNodeSchema = workflowRevisionNodeInputObject
  .extend({
    id: idSchema,
    revisionId: idSchema,
    position: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .superRefine(refineWorkflowNode)
  .transform(normalizeWorkflowNodeConfiguration);

export const workflowRevisionEdgeSchema = z.object({
  id: idSchema,
  revisionId: idSchema,
  fromNodeId: idSchema,
  toNodeId: idSchema,
  from: workflowKeySchema,
  to: workflowKeySchema,
  sourceOutput: z.string().min(1).max(200).nullable(),
  targetInput: z.string().min(1).max(200).nullable(),
  condition: workflowPredicateSchema.nullable(),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export const workflowRevisionSchema = workflowRevisionSummarySchema.extend({
  graph: workflowGraphSchema,
  declaredInputs: workflowJsonObjectSchema,
  declaredOutputs: workflowJsonObjectSchema,
  defaults: workflowJsonObjectSchema,
  permissionRequirements: workflowPermissionRequirementsSchema,
  nodes: z.array(workflowRevisionNodeSchema).max(256),
  edges: z.array(workflowRevisionEdgeSchema).max(2_048),
});

export const workflowDefinitionDetailSchema = z.object({
  workflow: workflowDefinitionSummarySchema,
  revision: workflowRevisionSchema.nullable(),
});
export const workflowDefinitionListSchema = z.array(
  workflowDefinitionSummarySchema,
);
export const workflowRevisionListSchema = z.array(
  workflowRevisionSummarySchema,
);

const queryBooleanSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const workflowDefinitionQuerySchema = z.object({
  scope: workflowScopeSchema.optional(),
  projectId: idSchema.optional(),
  includeArchived: queryBooleanSchema.default(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const workflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "paused",
  "cancelling",
  "cancelled",
  "failed",
  "completed",
  "recovering",
]);
export const workflowRecoveryStateSchema = z.enum([
  "stable",
  "pending",
  "recovering",
  "blocked",
]);
export const workflowTriggerTypeSchema = z.enum([
  "manual",
  "api",
  "schedule",
  "webhook",
  "git",
  "saved-command",
]);
export const workflowTriggerProvenanceSchema = z.object({
  type: workflowTriggerTypeSchema.default("manual"),
  sourceId: z.string().trim().min(1).max(500).nullable().default(null),
  actorType: z.enum(["user", "server", "api", "schedule", "webhook", "git"]),
  actorId: z.string().trim().min(1).max(500).nullable().default(null),
  deliveredAt: z.string().datetime(),
  metadata: workflowJsonObjectSchema.default({}),
});

export const workflowRunCreateSchema = z.object({
  workflowRevisionId: idSchema,
  projectId: optionalIdSchema,
  structuredInput: workflowJsonObjectSchema.default({}),
  budget: workflowBudgetSchema.default(defaultWorkflowBudget),
  permissionManifest: workflowPermissionRequirementsSchema.default(
    defaultWorkflowPermissionRequirements,
  ),
  selectedModelRouteId: optionalIdSchema,
  selectedPermissionProfileId: optionalIdSchema,
  trigger: workflowTriggerProvenanceSchema,
  idempotencyKey: z.string().trim().min(1).max(200),
});

const nullableTimestamp = z.string().datetime().nullable();
export const workflowRunSchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  workflowRevisionId: idSchema,
  ownerId: idSchema,
  projectId: idSchema.nullable(),
  status: workflowRunStatusSchema,
  trigger: workflowTriggerProvenanceSchema,
  idempotencyKey: z.string().min(1).max(200),
  structuredInput: workflowJsonValueSchema,
  structuredResult: workflowJsonValueSchema.nullable(),
  budget: workflowBudgetSchema,
  measuredUsage: workflowMeasuredUsageSchema,
  permissionManifest: workflowPermissionRequirementsSchema,
  selectedModelRouteId: idSchema.nullable(),
  selectedPermissionProfileId: idSchema.nullable(),
  workerId: idSchema.nullable(),
  worktreeId: idSchema.nullable(),
  codexThreadId: idSchema.nullable(),
  errorCode: z.string().max(200).nullable(),
  errorMessage: z.string().max(5_000).nullable(),
  pauseReason: z.string().max(2_000).nullable(),
  cancelReason: z.string().max(2_000).nullable(),
  recoveryState: workflowRecoveryStateSchema,
  queuedAt: z.string().datetime(),
  startedAt: nullableTimestamp,
  pausedAt: nullableTimestamp,
  cancelRequestedAt: nullableTimestamp,
  completedAt: nullableTimestamp,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const workflowRunNodeStatusSchema = z.enum([
  "blocked",
  "ready",
  "queued",
  "running",
  "waiting-for-approval",
  "paused",
  "cancelling",
  "cancelled",
  "failed",
  "completed",
  "retrying",
  "recovering",
  "skipped",
]);

export const workflowRunNodeSchema = z.object({
  id: idSchema,
  runId: idSchema,
  revisionNodeId: idSchema,
  nodeKey: workflowKeySchema,
  nodeType: workflowNodeTypeSchema,
  status: workflowRunNodeStatusSchema,
  dependencyState: workflowJsonObjectSchema,
  structuredInput: workflowJsonValueSchema,
  structuredResult: workflowJsonValueSchema.nullable(),
  budget: workflowBudgetSchema,
  measuredUsage: workflowMeasuredUsageSchema,
  permissionManifest: workflowPermissionRequirementsSchema,
  workerId: idSchema.nullable(),
  worktreeId: idSchema.nullable(),
  modelRouteId: idSchema.nullable(),
  permissionProfileId: idSchema.nullable(),
  codexThreadId: idSchema.nullable(),
  codexTurnId: idSchema.nullable(),
  writeCapable: z.boolean(),
  executionLeaseKey: z.string().max(500).nullable(),
  attemptCount: z.number().int().nonnegative(),
  notBefore: nullableTimestamp,
  timeoutAt: nullableTimestamp,
  readyAt: nullableTimestamp,
  startedAt: nullableTimestamp,
  waitingAt: nullableTimestamp,
  completedAt: nullableTimestamp,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const workflowDependencyStatusSchema = z.enum([
  "blocked",
  "ready",
  "satisfied",
  "failed",
  "skipped",
]);
export const workflowRunNodeDependencySchema = z.object({
  id: idSchema,
  runId: idSchema,
  revisionEdgeId: idSchema.nullable(),
  fromNodeId: idSchema,
  toNodeId: idSchema,
  status: workflowDependencyStatusSchema,
  resultMapping: workflowJsonObjectSchema,
  satisfiedAt: nullableTimestamp,
  createdAt: z.string().datetime(),
});

export const workflowNodeAttemptStatusSchema = z.enum([
  "queued",
  "running",
  "waiting-for-approval",
  "cancelled",
  "failed",
  "completed",
  "timed-out",
  "interrupted",
  "orphaned",
]);
export const workflowRunNodeItemStatusSchema = z.enum([
  "ready",
  "running",
  "waiting-for-approval",
  "cancelled",
  "failed",
  "completed",
  "recovering",
  "skipped",
]);
export const workflowPipelineCompletedStepSchema = z.object({
  key: workflowKeySchema,
  name: z.string().trim().min(1).max(200),
  position: z.number().int().nonnegative(),
  structuredResult: workflowJsonValueSchema,
  measuredUsage: workflowMeasuredUsageSchema,
  codexThreadId: idSchema,
  codexTurnId: idSchema,
  completedAt: z.string().datetime(),
});
export const workflowRunNodeItemExecutionStateSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("map") }).strict(),
    z
      .object({
        kind: z.literal("pipeline"),
        currentStepPosition: z.number().int().nonnegative(),
        currentStepAttemptCount: z.number().int().nonnegative(),
        completedSteps: z.array(workflowPipelineCompletedStepSchema).max(32),
      })
      .strict(),
  ])
  .superRefine((state, context) => {
    if (state.kind !== "pipeline") return;
    if (state.currentStepPosition !== state.completedSteps.length) {
      context.addIssue({
        code: "custom",
        message:
          "The pipeline cursor must immediately follow its completed-step ledger.",
        path: ["currentStepPosition"],
      });
    }
    const completedKeys = new Set<string>();
    state.completedSteps.forEach((step, index) => {
      if (step.position !== index) {
        context.addIssue({
          code: "custom",
          message: "Pipeline completed-step positions must be contiguous.",
          path: ["completedSteps", index, "position"],
        });
      }
      if (completedKeys.has(step.key)) {
        context.addIssue({
          code: "custom",
          message: "Pipeline completed-step keys must be unique.",
          path: ["completedSteps", index, "key"],
        });
      }
      completedKeys.add(step.key);
    });
  });
export const workflowRunNodeItemSchema = z.object({
  id: idSchema,
  runNodeId: idSchema,
  itemKey: z.string().max(10_000),
  position: z.number().int().nonnegative(),
  status: workflowRunNodeItemStatusSchema,
  executionState: workflowRunNodeItemExecutionStateSchema,
  structuredInput: workflowJsonValueSchema,
  structuredResult: workflowJsonValueSchema.nullable(),
  measuredUsage: workflowMeasuredUsageSchema,
  errorCode: z.string().max(200).nullable(),
  errorMessage: z.string().max(5_000).nullable(),
  workerId: idSchema.nullable(),
  worktreeId: idSchema.nullable(),
  modelRouteId: idSchema.nullable(),
  permissionProfileId: idSchema.nullable(),
  codexThreadId: idSchema.nullable(),
  codexTurnId: idSchema.nullable(),
  executionLeaseKey: z.string().max(500).nullable(),
  attemptCount: z.number().int().nonnegative(),
  notBefore: nullableTimestamp,
  timeoutAt: nullableTimestamp,
  readyAt: nullableTimestamp,
  startedAt: nullableTimestamp,
  waitingAt: nullableTimestamp,
  completedAt: nullableTimestamp,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const workflowNodeAttemptSchema = z.object({
  id: idSchema,
  runNodeId: idSchema,
  runNodeItemId: idSchema.nullable().default(null),
  executionUnitKey: workflowKeySchema.nullable().default(null),
  attempt: z.number().int().positive(),
  status: workflowNodeAttemptStatusSchema,
  idempotencyKey: z.string().min(1).max(200),
  structuredInput: workflowJsonValueSchema,
  structuredResult: workflowJsonValueSchema.nullable(),
  measuredUsage: workflowMeasuredUsageSchema,
  errorCode: z.string().max(200).nullable(),
  errorMessage: z.string().max(5_000).nullable(),
  workerId: idSchema.nullable(),
  worktreeId: idSchema.nullable(),
  modelRouteId: idSchema.nullable(),
  permissionProfileId: idSchema.nullable(),
  codexThreadId: idSchema.nullable(),
  codexTurnId: idSchema.nullable(),
  startingRevision: z.string().max(500).nullable(),
  endingRevision: z.string().max(500).nullable(),
  worktreeDirty: z.boolean().nullable(),
  producedChanges: workflowJsonObjectSchema,
  startedAt: nullableTimestamp,
  heartbeatAt: nullableTimestamp,
  completedAt: nullableTimestamp,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const workflowRunEventSchema = z.object({
  id: z.number().int().positive(),
  runId: idSchema,
  runNodeId: idSchema.nullable(),
  attemptId: idSchema.nullable(),
  sequence: z.number().int().nonnegative(),
  eventKey: z.string().min(1).max(500),
  type: z.string().min(1).max(200),
  payload: workflowJsonObjectSchema,
  actorType: z.string().min(1).max(100),
  actorId: z.string().max(500).nullable(),
  createdAt: z.string().datetime(),
});

export const workflowApprovalGateStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
export const workflowApprovalGateSchema = z
  .object({
    id: idSchema,
    runId: idSchema,
    runNodeId: idSchema.nullable(),
    gateKey: z.string().min(1).max(200),
    status: workflowApprovalGateStatusSchema,
    prompt: z.string().min(1).max(10_000),
    permissionManifest: workflowPermissionRequirementsSchema,
    interactionRequestId: idSchema.nullable(),
    requestedByType: z.string().min(1).max(100),
    requestedById: z.string().max(500).nullable(),
    decision: z.enum(["approved", "denied"]).nullable(),
    decidedByUserId: idSchema.nullable(),
    decisionReason: z.string().max(5_000).nullable(),
    expiresAt: nullableTimestamp,
    decidedAt: nullableTimestamp,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((gate, context) => {
    const decided = gate.status === "approved" || gate.status === "denied";
    if (decided !== Boolean(gate.decision && gate.decidedAt)) {
      context.addIssue({
        code: "custom",
        message: "Approved and denied gates require matching decision data.",
        path: ["decision"],
      });
    }
    if (gate.decision && gate.decision !== gate.status) {
      context.addIssue({
        code: "custom",
        message: "Gate decision must match its terminal status.",
        path: ["decision"],
      });
    }
  });

export const workflowRunDetailSchema = z.object({
  run: workflowRunSchema,
  nodes: z.array(workflowRunNodeSchema).max(1_000),
  items: z.array(workflowRunNodeItemSchema).max(10_000).default([]),
  dependencies: z.array(workflowRunNodeDependencySchema).max(10_000),
  attempts: z.array(workflowNodeAttemptSchema).max(10_000),
  gates: z.array(workflowApprovalGateSchema).max(1_000),
});
export const workflowRunListSchema = z.array(workflowRunSchema);
export const workflowRunQuerySchema = z.object({
  workflowId: idSchema.optional(),
  projectId: idSchema.optional(),
  status: workflowRunStatusSchema.optional(),
  recoveryState: workflowRecoveryStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const workflowRunEventQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().min(1).max(1_000).default(200),
});
export const workflowRunEventPageSchema = z.object({
  events: z.array(workflowRunEventSchema).max(1_000),
  nextSequence: z.number().int().nonnegative().nullable(),
});

export const workflowRunStatusUpdateSchema = z.object({
  expectedStatus: workflowRunStatusSchema,
  status: workflowRunStatusSchema,
  recoveryState: workflowRecoveryStateSchema.optional(),
  structuredResult: workflowJsonValueSchema.nullable().optional(),
  measuredUsage: workflowMeasuredUsageSchema.optional(),
  errorCode: z.string().trim().min(1).max(200).nullable().optional(),
  errorMessage: z.string().trim().min(1).max(5_000).nullable().optional(),
  reason: z.string().trim().min(1).max(2_000).nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const workflowRunCancelSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const workflowNodeRetrySchema = z.object({
  reason: z.string().trim().min(1).max(2_000).nullable().default(null),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const workflowGateDecisionSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  reason: z.string().trim().min(1).max(5_000).nullable().default(null),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const workflowNodeExecutionRequestSchema = z.object({
  workflowRunId: idSchema,
  runNodeId: idSchema,
  attemptId: idSchema,
  idempotencyKey: z.string().trim().min(1).max(200),
  worktreeId: optionalIdSchema,
  cwd: z.string().trim().min(1).max(8_192),
  threadId: optionalIdSchema,
  prompt: z.string().trim().min(1).max(100_000),
  developerInstructions: z
    .string()
    .trim()
    .min(1)
    .max(100_000)
    .nullable()
    .default(null),
  skillNames: z.array(workflowKeySchema).max(64).default([]),
  outputSchema: workflowJsonObjectSchema.default({}),
  mutationMode: workflowMutationModeSchema,
  networkAccess: workflowPermissionRequirementsSchema.shape.network,
  approvalMode: workflowPermissionRequirementsSchema.shape.approvalMode,
  permissionProfileId: optionalIdSchema,
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1_000),
});

export const workflowNodeExecutionResultSchema = z.object({
  threadId: idSchema,
  turnId: idSchema,
  text: z.string().max(1_000_000),
  structuredResult: workflowJsonValueSchema,
  measuredUsage: workflowMeasuredUsageSchema,
  status: z.literal("completed"),
});

export const workflowNodeInterruptResultSchema = z.object({
  interrupted: z.boolean(),
});

export type WorkflowScope = z.infer<typeof workflowScopeSchema>;
export type WorkflowTrustState = z.infer<typeof workflowTrustStateSchema>;
export type WorkflowSource = z.infer<typeof workflowSourceSchema>;
export type WorkflowProvenance = z.infer<typeof workflowProvenanceSchema>;
export type WorkflowPermissionRequirements = z.infer<
  typeof workflowPermissionRequirementsSchema
>;
export type WorkflowBudget = z.infer<typeof workflowBudgetSchema>;
export type WorkflowMeasuredUsage = z.infer<typeof workflowMeasuredUsageSchema>;
export type WorkflowNodeType = z.infer<typeof workflowNodeTypeSchema>;
export type WorkflowMutationMode = z.infer<typeof workflowMutationModeSchema>;
export type WorkflowAgentNodeConfiguration = z.infer<
  typeof workflowAgentNodeConfigurationSchema
>;
export type WorkflowJsonPointer = z.infer<typeof workflowJsonPointerSchema>;
export type WorkflowPredicateOperator = z.infer<
  typeof workflowPredicateOperatorSchema
>;
export type WorkflowPredicate = z.infer<typeof workflowPredicateSchema>;
export type WorkflowCollectionFailurePolicy = z.infer<
  typeof workflowCollectionFailurePolicySchema
>;
export type WorkflowMapNodeConfiguration = z.infer<
  typeof workflowMapNodeConfigurationSchema
>;
export type WorkflowPipelineStep = z.infer<typeof workflowPipelineStepSchema>;
export type WorkflowPipelineNodeConfiguration = z.infer<
  typeof workflowPipelineNodeConfigurationSchema
>;
export type WorkflowReduceNodeConfiguration = z.infer<
  typeof workflowReduceNodeConfigurationSchema
>;
export type WorkflowVerifyNodeConfiguration = z.infer<
  typeof workflowVerifyNodeConfigurationSchema
>;
export type WorkflowConditionNodeConfiguration = z.infer<
  typeof workflowConditionNodeConfigurationSchema
>;
export type WorkflowRepeatUntilNodeConfiguration = z.infer<
  typeof workflowRepeatUntilNodeConfigurationSchema
>;
export type WorkflowGateNodeConfiguration = z.infer<
  typeof workflowGateNodeConfigurationSchema
>;
type WorkflowNodeConfigurationSchema =
  (typeof workflowNodeConfigurationSchemas)[keyof typeof workflowNodeConfigurationSchemas];
export type WorkflowNodeConfiguration =
  z.infer<WorkflowNodeConfigurationSchema>;
export type WorkflowRevisionNodeInput = z.infer<
  typeof workflowRevisionNodeInputSchema
>;
export type WorkflowRevisionEdgeInput = z.infer<
  typeof workflowRevisionEdgeInputSchema
>;
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;
export type WorkflowRevisionCreate = z.infer<
  typeof workflowRevisionCreateSchema
>;
export type WorkflowDefinitionCreate = z.infer<
  typeof workflowDefinitionCreateSchema
>;
export type WorkflowDefinitionUpdate = z.infer<
  typeof workflowDefinitionUpdateSchema
>;
export type WorkflowRevisionSummary = z.infer<
  typeof workflowRevisionSummarySchema
>;
export type WorkflowDefinitionSummary = z.infer<
  typeof workflowDefinitionSummarySchema
>;
export type WorkflowRevisionNode = z.infer<typeof workflowRevisionNodeSchema>;
export type WorkflowRevisionEdge = z.infer<typeof workflowRevisionEdgeSchema>;
export type WorkflowRevision = z.infer<typeof workflowRevisionSchema>;
export type WorkflowDefinitionDetail = z.infer<
  typeof workflowDefinitionDetailSchema
>;
export type WorkflowDefinitionQuery = z.infer<
  typeof workflowDefinitionQuerySchema
>;
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;
export type WorkflowRecoveryState = z.infer<typeof workflowRecoveryStateSchema>;
export type WorkflowTriggerType = z.infer<typeof workflowTriggerTypeSchema>;
export type WorkflowTriggerProvenance = z.infer<
  typeof workflowTriggerProvenanceSchema
>;
export type WorkflowRunCreate = z.infer<typeof workflowRunCreateSchema>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type WorkflowRunNodeStatus = z.infer<typeof workflowRunNodeStatusSchema>;
export type WorkflowRunNode = z.infer<typeof workflowRunNodeSchema>;
export type WorkflowDependencyStatus = z.infer<
  typeof workflowDependencyStatusSchema
>;
export type WorkflowRunNodeDependency = z.infer<
  typeof workflowRunNodeDependencySchema
>;
export type WorkflowRunNodeItemStatus = z.infer<
  typeof workflowRunNodeItemStatusSchema
>;
export type WorkflowPipelineCompletedStep = z.infer<
  typeof workflowPipelineCompletedStepSchema
>;
export type WorkflowRunNodeItemExecutionState = z.infer<
  typeof workflowRunNodeItemExecutionStateSchema
>;
export type WorkflowRunNodeItem = z.infer<typeof workflowRunNodeItemSchema>;
export type WorkflowNodeAttemptStatus = z.infer<
  typeof workflowNodeAttemptStatusSchema
>;
export type WorkflowNodeAttempt = z.infer<typeof workflowNodeAttemptSchema>;
export type WorkflowRunEvent = z.infer<typeof workflowRunEventSchema>;
export type WorkflowApprovalGateStatus = z.infer<
  typeof workflowApprovalGateStatusSchema
>;
export type WorkflowApprovalGate = z.infer<typeof workflowApprovalGateSchema>;
export type WorkflowRunDetail = z.infer<typeof workflowRunDetailSchema>;
export type WorkflowRunQuery = z.infer<typeof workflowRunQuerySchema>;
export type WorkflowRunEventQuery = z.infer<typeof workflowRunEventQuerySchema>;
export type WorkflowRunEventPage = z.infer<typeof workflowRunEventPageSchema>;
export type WorkflowRunStatusUpdate = z.infer<
  typeof workflowRunStatusUpdateSchema
>;
export type WorkflowRunCancel = z.infer<typeof workflowRunCancelSchema>;
export type WorkflowNodeRetry = z.infer<typeof workflowNodeRetrySchema>;
export type WorkflowGateDecision = z.infer<typeof workflowGateDecisionSchema>;
export type WorkflowNodeExecutionRequest = z.infer<
  typeof workflowNodeExecutionRequestSchema
>;
export type WorkflowNodeExecutionResult = z.infer<
  typeof workflowNodeExecutionResultSchema
>;
export type WorkflowNodeInterruptResult = z.infer<
  typeof workflowNodeInterruptResultSchema
>;
