import { z } from "zod";
import { projectRootKindSchema } from "./project-foundation.js";
import { executionTargetSchema } from "./execution-targets.js";
import { permissionProfileIdSchema } from "./permission-profiles.js";

export const cantripCliArgumentsSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .refine((arguments_) => Object.keys(arguments_).length <= 20, {
    message: "Cantrip CLI commands accept at most 20 arguments.",
  });

export const cantripAgentOperationNameSchema = z.enum([
  "context.get",
  "tool.help",
  "policy.list",
  "policy.read",
  "target.list",
  "target.inspect",
  "run-configuration.list",
  "run-configuration.get",
  "run-configuration.detect",
  "run-configuration.create",
  "run-configuration.update",
  "run-configuration.delete",
  "run-configuration.start",
  "run-configuration.restart",
  "run-configuration.stop",
  "run-configuration.status",
  "run-configuration.read-output",
  "run-configuration.secret-set",
  "worktree.list",
  "worktree.status",
  "worktree.create",
  "worktree.acquire",
  "worktree.switch",
  "worktree.release",
  "worktree.remove",
  "explorer.list",
  "explorer.read",
  "explorer.write",
  "terminal.read",
  "terminal.send",
  "terminal.restart",
  "web.search",
  "web.read",
  "web.session.snapshot",
  "web.session.open",
  "web.session.click",
  "web.session.type",
  "web.session.close",
  "browser.services",
  "browser.open",
  "client.notify",
  "client.focus-project",
  "client.focus-surface",
  "client.show-interaction",
]);

export const CANTRIP_MCP_READ_OPERATIONS = [
  "context.get",
  "tool.help",
  "policy.list",
  "policy.read",
  "target.list",
  "target.inspect",
  "run-configuration.list",
  "run-configuration.get",
  "run-configuration.detect",
  "run-configuration.status",
  "run-configuration.read-output",
  "worktree.list",
  "worktree.status",
  "explorer.list",
  "explorer.read",
  "terminal.read",
  "web.search",
  "web.read",
  "web.session.snapshot",
  "browser.services",
] as const satisfies readonly z.infer<typeof cantripAgentOperationNameSchema>[];

export const CANTRIP_MCP_READ_TOOL_NAMES = [
  "context_get",
  "tool_help",
  "policy_list",
  "policy_read",
  "target_list",
  "target_inspect",
  "run_configuration_list",
  "run_configuration_get",
  "run_configuration_detect",
  "run_configuration_status",
  "run_configuration_read_output",
  "worktree_list",
  "worktree_status",
  "explorer_list",
  "explorer_read",
  "terminal_read",
  "web_search",
  "web_read",
  "web_session_snapshot",
  "browser_services",
] as const;

export const CANTRIP_MCP_WORKER_MUTATION_OPERATIONS = [
  "run-configuration.create",
  "run-configuration.update",
  "run-configuration.delete",
  "run-configuration.start",
  "run-configuration.restart",
  "run-configuration.stop",
  "run-configuration.secret-set",
  "worktree.create",
  "worktree.switch",
  "worktree.release",
  "worktree.remove",
  "explorer.write",
  "terminal.send",
  "terminal.restart",
  "web.session.open",
  "web.session.click",
  "web.session.type",
  "web.session.close",
  "browser.open",
] as const satisfies readonly z.infer<typeof cantripAgentOperationNameSchema>[];

export const CANTRIP_MCP_CLIENT_CONTROL_OPERATIONS = [
  "client.notify",
  "client.focus-project",
  "client.focus-surface",
  "client.show-interaction",
] as const satisfies readonly z.infer<typeof cantripAgentOperationNameSchema>[];

export const CANTRIP_MCP_MUTATION_OPERATIONS = [
  ...CANTRIP_MCP_WORKER_MUTATION_OPERATIONS,
  ...CANTRIP_MCP_CLIENT_CONTROL_OPERATIONS,
] as const;

export const CANTRIP_MCP_MUTATION_TOOL_NAMES = [
  "run_configuration_create",
  "run_configuration_update",
  "run_configuration_delete",
  "run_configuration_start",
  "run_configuration_restart",
  "run_configuration_stop",
  "run_configuration_secret_set",
  "worktree_create",
  "worktree_switch",
  "worktree_release",
  "worktree_remove",
  "explorer_write",
  "terminal_send",
  "terminal_restart",
  "web_session_open",
  "web_session_click",
  "web_session_type",
  "web_session_close",
  "browser_navigate",
  "client_notify",
  "client_focus_project",
  "client_focus_surface",
  "client_show_interaction",
] as const;

export const CANTRIP_MCP_OPERATIONS = [
  ...CANTRIP_MCP_READ_OPERATIONS,
  ...CANTRIP_MCP_MUTATION_OPERATIONS,
] as const;

export const CANTRIP_MCP_TOOL_NAMES = [
  ...CANTRIP_MCP_READ_TOOL_NAMES,
  ...CANTRIP_MCP_MUTATION_TOOL_NAMES,
] as const;

export const cantripMcpToolNameSchema = z.enum(CANTRIP_MCP_TOOL_NAMES);

export function cantripMcpToolNamesForOperations(
  operations: readonly z.infer<typeof cantripAgentOperationNameSchema>[],
): Array<(typeof CANTRIP_MCP_TOOL_NAMES)[number]> {
  const allowed = new Set<string>(operations);
  return CANTRIP_MCP_OPERATIONS.flatMap((operation, index) =>
    allowed.has(operation) ? [CANTRIP_MCP_TOOL_NAMES[index]!] : [],
  );
}

export function isCantripMcpMutationOperation(
  operation: z.infer<typeof cantripAgentOperationNameSchema>,
): boolean {
  return (CANTRIP_MCP_MUTATION_OPERATIONS as readonly string[]).includes(
    operation,
  );
}

export function cantripMcpOperationsForPermissionProfile(
  permissionProfileId: string,
): readonly z.infer<typeof cantripAgentOperationNameSchema>[] {
  return permissionProfileId === ":read-only"
    ? CANTRIP_MCP_READ_OPERATIONS.filter(
        (operation) => operation !== "web.session.snapshot",
      )
    : CANTRIP_MCP_OPERATIONS;
}

export const cantripAgentOperationArgumentsSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .refine((arguments_) => Object.keys(arguments_).length <= 32, {
    message: "Cantrip agent operations accept at most 32 arguments.",
  });

export const cantripAgentOperationRequestSchema = z
  .object({
    operation: cantripAgentOperationNameSchema,
    arguments: cantripAgentOperationArgumentsSchema,
  })
  .strict();

const cantripMcpBindingBaseFields = {
  bindingId: z.string().uuid(),
  ownerId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200),
  executionLaneId: z.string().min(1).max(200),
  workerId: z.string().min(1).max(200),
  permissionProfileId: permissionProfileIdSchema,
  allowedOperations: z
    .array(cantripAgentOperationNameSchema)
    .min(1)
    .max(cantripAgentOperationNameSchema.options.length)
    .refine((operations) => new Set(operations).size === operations.length, {
      message: "Cantrip MCP binding operations must be unique.",
    }),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
};

const cantripMcpProjectBindingSchema = z
  .object({
    ...cantripMcpBindingBaseFields,
    contextKind: z.literal("project"),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema,
    scratchRootId: z.null(),
  })
  .strict();

const cantripMcpStandaloneBindingSchema = z
  .object({
    ...cantripMcpBindingBaseFields,
    contextKind: z.literal("standalone"),
    projectId: z.null(),
    worktreeId: z.null(),
    rootKind: z.null(),
    scratchRootId: z.string().min(1).max(200),
  })
  .strict();

export const cantripMcpBindingSchema = z
  .discriminatedUnion("contextKind", [
    cantripMcpProjectBindingSchema,
    cantripMcpStandaloneBindingSchema,
  ])
  .superRefine((binding, context) => {
    const issuedAt = Date.parse(binding.issuedAt);
    const expiresAt = Date.parse(binding.expiresAt);
    if (expiresAt <= issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Cantrip MCP bindings must expire after they are issued.",
      });
    }
    if (expiresAt - issuedAt > 24 * 60 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Cantrip MCP bindings cannot live longer than 24 hours.",
      });
    }
  });

export const cantripMcpConnectionDocumentSchema = z
  .object({
    protocolVersion: z.literal(1),
    endpoint: z.url(),
    bindingId: z.string().uuid(),
    credential: z.string().min(32).max(512),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const cantripMcpBrokerOperationRequestSchema = z
  .object({
    bindingId: z.string().uuid(),
    request: cantripAgentOperationRequestSchema,
  })
  .strict();

export const workerCantripMcpOperationCallSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    binding: cantripMcpBindingSchema,
    request: cantripAgentOperationRequestSchema,
  })
  .strict();

const compatibleCantripMcpBindingBaseFields = {
  ...cantripMcpBindingBaseFields,
  canonicalRoot: z.string().min(1).max(8_192).optional(),
  allowedOperations: z.array(z.string().min(1).max(100)).min(1).max(100),
};

const compatibleCantripMcpBindingSchema = z.union([
  z.object({
    ...compatibleCantripMcpBindingBaseFields,
    contextKind: z.literal("project").optional(),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema,
    scratchRootId: z.null().optional(),
  }),
  z.object({
    ...compatibleCantripMcpBindingBaseFields,
    contextKind: z.literal("standalone"),
    projectId: z.null(),
    worktreeId: z.null(),
    rootKind: z.null(),
    scratchRootId: z.string().min(1).max(200),
  }),
]);

/**
 * Accepts both the current binding and the legacy binding used during rolling
 * worker/server upgrades. Unknown binding claims never grant authority: they
 * are discarded, and only locally known operation names survive normalization.
 */
export const compatibleWorkerCantripMcpOperationCallSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    binding: compatibleCantripMcpBindingSchema,
    request: cantripAgentOperationRequestSchema,
  })
  .strict()
  .transform(({ binding, ...call }) => {
    const {
      canonicalRoot: _legacyCanonicalRoot,
      allowedOperations,
      ...currentBinding
    } = binding;
    return {
      ...call,
      binding: {
        ...currentBinding,
        contextKind: currentBinding.contextKind ?? "project",
        scratchRootId: currentBinding.scratchRootId ?? null,
        allowedOperations: allowedOperations.filter(
          (operation) =>
            cantripAgentOperationNameSchema.safeParse(operation).success,
        ),
      },
    };
  })
  .pipe(workerCantripMcpOperationCallSchema);

export const CANTRIP_MCP_BINDING_PROTOCOL_VERSIONS = [1, 2] as const;

export const workerCantripMcpCapabilitiesQuerySchema = z
  .object({
    workerId: z.string().min(1).max(200),
  })
  .strict();

export const workerCantripMcpServerCapabilitiesSchema = z
  .object({
    bindingProtocolVersions: z
      .array(z.number().int().min(1).max(100))
      .min(1)
      .max(10)
      .refine((versions) => new Set(versions).size === versions.length, {
        message: "Cantrip MCP binding protocol versions must be unique.",
      }),
    operations: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(100)
      .refine((operations) => new Set(operations).size === operations.length, {
        message: "Cantrip MCP server operations must be unique.",
      }),
  })
  .strict();

export const cantripAgentOperationResultSchema = z.object({
  summary: z.string().min(1).max(2_000),
  target: executionTargetSchema.nullable().default(null),
  worktreeId: z.string().min(1).nullable().default(null),
  continuationScheduled: z.boolean().default(false),
  mutated: z.boolean().default(false),
  data: z.unknown().optional(),
});

export type CantripAgentOperationName = z.infer<
  typeof cantripAgentOperationNameSchema
>;
export type CantripAgentOperationRequest = z.infer<
  typeof cantripAgentOperationRequestSchema
>;
export type CantripAgentOperationResult = z.infer<
  typeof cantripAgentOperationResultSchema
>;
export type CantripMcpBinding = z.infer<typeof cantripMcpBindingSchema>;
export type CantripMcpConnectionDocument = z.infer<
  typeof cantripMcpConnectionDocumentSchema
>;
export type CantripMcpBrokerOperationRequest = z.infer<
  typeof cantripMcpBrokerOperationRequestSchema
>;
export type WorkerCantripMcpOperationCall = z.infer<
  typeof workerCantripMcpOperationCallSchema
>;
