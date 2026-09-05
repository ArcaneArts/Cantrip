import { z } from "zod";
import {
  encryptedInteractionResponseContentSchema,
  interactionProtectedClassificationSchema,
  interactionRequestOpaqueContentSchema,
  interactionResponseOpaqueContentSchema,
} from "./communication-content.js";

export const agentInteractionRequestKindSchema = z.enum([
  "commandExecution",
  "fileChange",
  "permissions",
  "userInput",
  "mcpElicitation",
]);

export const agentInteractionRequestStatusSchema = z.enum([
  "pending",
  "resolved",
  "expired",
  "interrupted",
]);

const codexInteractionProvenanceSchema = z
  .object({
    chatId: z.string().min(1).nullable(),
    threadId: z.string().min(1),
    turnId: z.string().min(1).nullable(),
    itemId: z.string().min(1).nullable(),
    executionLaneId: z.string().min(1).nullable(),
    workerId: z.string().min(1),
    // No default: adding owner to historical JSON changes request-key replay.
    owner: z.literal("codex").optional(),
  })
  .strict();
export const agentInteractionProvenanceSchema = z.discriminatedUnion("owner", [
  codexInteractionProvenanceSchema,
  codexInteractionProvenanceSchema.extend({
    owner: z.literal("computer-use"),
    chatId: z.string().min(1),
    threadId: z.string().min(1).nullable(),
  }),
]);

export const agentInteractionRequestPayloadSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("commandExecution"),
      startedAtMs: z.number().int().nonnegative(),
      approvalId: z.string().min(1).nullable(),
      environmentId: z.string().min(1).nullable(),
      reason: z.string().nullable(),
      command: z.string().nullable(),
      cwd: z.string().nullable(),
      commandActions: z.json().nullable().optional(),
      networkApprovalContext: z
        .object({
          host: z.string().min(1),
          protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"]),
        })
        .nullable(),
      additionalPermissions: z.json().nullable(),
      proposedExecpolicyAmendment: z.array(z.string()).nullable(),
      proposedNetworkPolicyAmendments: z
        .array(
          z.object({
            host: z.string().min(1),
            action: z.enum(["allow", "deny"]),
          }),
        )
        .nullable(),
      availableDecisions: z
        .array(
          z.enum([
            "accept",
            "acceptForSession",
            "acceptWithExecpolicyAmendment",
            "applyNetworkPolicyAmendment",
            "decline",
            "cancel",
          ]),
        )
        .nullable(),
    }),
    z.object({
      kind: z.literal("fileChange"),
      startedAtMs: z.number().int().nonnegative(),
      reason: z.string().nullable(),
      grantRoot: z.string().nullable(),
    }),
    z
      .object({
        kind: z.literal("permissions"),
        startedAtMs: z.number().int().nonnegative(),
        environmentId: z.string().min(1).nullable(),
        cwd: z.string().min(1).nullable(),
        reason: z.string().nullable(),
        requestedPermissions: z.json(),
        source: z.literal("native-computer-use").optional(),
      })
      .refine(
        (payload) =>
          payload.cwd !== null || payload.source === "native-computer-use",
        {
          message:
            "Only native computer-use permission requests may omit a working directory.",
          path: ["cwd"],
        },
      ),
    z.object({
      kind: z.literal("userInput"),
      questions: z
        .array(
          z.object({
            id: z.string().min(1),
            header: z.string().min(1),
            question: z.string().min(1),
            isOther: z.boolean(),
            isSecret: z.boolean(),
            options: z
              .array(
                z.object({
                  label: z.string().min(1),
                  description: z.string(),
                }),
              )
              .nullable(),
          }),
        )
        .min(1)
        .max(3),
      autoResolutionMs: z.number().int().nonnegative().nullable(),
    }),
    z.object({
      kind: z.literal("mcpElicitation"),
      serverName: z.string().min(1),
      mode: z.enum(["form", "openai/form", "url"]),
      message: z.string().min(1),
      requestedSchema: z.json().nullable(),
      url: z.url().nullable(),
      elicitationId: z.string().min(1).nullable(),
      metadata: z.json().nullable(),
    }),
  ],
);

export const agentInteractionResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commandExecution"),
    decision: z.enum([
      "accept",
      "acceptForSession",
      "acceptWithExecpolicyAmendment",
      "applyNetworkPolicyAmendment",
      "decline",
      "cancel",
    ]),
    execpolicyAmendment: z.array(z.string()).nullable().default(null),
    networkPolicyAmendment: z
      .object({
        host: z.string().min(1),
        action: z.enum(["allow", "deny"]),
      })
      .nullable()
      .default(null),
  }),
  z.object({
    kind: z.literal("fileChange"),
    decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  }),
  z.object({
    kind: z.literal("permissions"),
    permissions: z.json(),
    scope: z.enum(["turn", "session"]),
    strictAutoReview: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("userInput"),
    answers: z.record(
      z.string().min(1),
      z.object({ answers: z.array(z.string()).min(1) }),
    ),
  }),
  z.object({
    kind: z.literal("mcpElicitation"),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.json().nullable(),
    metadata: z.json().nullable().default(null),
  }),
]);

function fitsAgentInteractionStorageLimit(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= 1_000_000;
  } catch {
    return false;
  }
}

function validateInteractionPayloadOwner(
  request: {
    provenance: z.infer<typeof agentInteractionProvenanceSchema>;
    payload: z.infer<typeof agentInteractionRequestPayloadSchema>;
  },
  context: z.RefinementCtx,
) {
  validateComputerUseRequestId(request, context);
  const native =
    request.payload.kind === "permissions" &&
    request.payload.source === "native-computer-use";
  if ((request.provenance.owner === "computer-use") !== native) {
    context.addIssue({
      code: "custom",
      path: ["payload"],
      message:
        "Native computer-use permissions require computer-use provenance, and no other payload kind may use that owner.",
    });
  }
}

function validateProtectedInteractionOwner(
  request: {
    provenance: z.infer<typeof agentInteractionProvenanceSchema>;
    classification: { kind: string };
  },
  context: z.RefinementCtx,
) {
  validateComputerUseRequestId(request, context);
  if (
    request.provenance.owner === "computer-use" &&
    request.classification.kind !== "permissions"
  ) {
    context.addIssue({
      code: "custom",
      path: ["classification", "kind"],
      message: "Computer-use interactions require permissions classification.",
    });
  }
}

function validateComputerUseRequestId(
  request: { provenance: z.infer<typeof agentInteractionProvenanceSchema> },
  context: z.RefinementCtx,
) {
  if (
    request.provenance.owner === "computer-use" &&
    "id" in request &&
    !z.uuid().safeParse(request.id).success
  ) {
    context.addIssue({
      code: "custom",
      path: ["id"],
      message: "Computer-use interaction IDs must be genuine request UUIDs.",
    });
  }
}

export const agentInteractionRequestCreateSchema = z
  .object({
    requestKey: z.string().min(1).max(200),
    projectId: z.string().min(1).nullable(),
    provenance: agentInteractionProvenanceSchema,
    payload: agentInteractionRequestPayloadSchema,
    expiresAt: z.string().datetime().nullable(),
  })
  .superRefine(validateInteractionPayloadOwner)
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Agent interaction request exceeds the 1 MB storage limit.",
  });

export const agentInteractionResolutionCreateSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    response: agentInteractionResponseSchema,
  })
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Agent interaction response exceeds the 1 MB storage limit.",
  });

export const encryptedAgentInteractionRequestCreateSchema = z
  .object({
    requestKey: z.string().min(1).max(200),
    projectId: z.string().min(1).nullable(),
    provenance: agentInteractionProvenanceSchema,
    ...interactionRequestOpaqueContentSchema.shape,
    expiresAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine(validateProtectedInteractionOwner)
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Protected agent interaction request exceeds the storage limit.",
  });

export const encryptedAgentInteractionResolutionCreateSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    ...interactionResponseOpaqueContentSchema.shape,
  })
  .strict()
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Protected agent interaction response exceeds the storage limit.",
  });

export const agentInteractionRuntimeRequestSchema = z.object({
  requestKey: z.string().min(1).max(200),
  threadId: z.string().min(1),
  turnId: z.string().min(1).nullable(),
  itemId: z.string().min(1).nullable(),
  payload: agentInteractionRequestPayloadSchema,
  expiresAt: z.string().datetime(),
});

export const encryptedAgentInteractionRuntimeRequestSchema = z
  .object({
    requestKey: z.string().min(1).max(200),
    threadId: z.string().min(1),
    turnId: z.string().min(1).nullable(),
    itemId: z.string().min(1).nullable(),
    ...interactionRequestOpaqueContentSchema.shape,
    expiresAt: z.string().datetime(),
  })
  .strict();

export const agentInteractionAcceptedSchema = z.object({
  accepted: z.literal(true),
});

export const agentInteractionRequestSchema = z
  .object({
    id: z.string().min(1),
    requestKey: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    provenance: agentInteractionProvenanceSchema,
    payload: agentInteractionRequestPayloadSchema,
    status: agentInteractionRequestStatusSchema,
    response: agentInteractionResponseSchema.nullable(),
    resolvedByUserId: z.string().min(1).nullable(),
    expiresAt: z.string().datetime().nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((request, context) => {
    validateInteractionPayloadOwner(request, context);
    if (request.response && request.response.kind !== request.payload.kind) {
      context.addIssue({
        code: "custom",
        path: ["response", "kind"],
        message: "Response kind must match request kind.",
      });
    }
    const terminalWithoutResponse =
      request.status === "expired" || request.status === "interrupted";
    if (request.status === "pending") {
      if (request.response || request.resolvedByUserId || request.resolvedAt) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Pending requests cannot contain resolution data.",
        });
      }
    } else if (request.status === "resolved") {
      if (
        !request.response ||
        !request.resolvedByUserId ||
        !request.resolvedAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Resolved requests require response and resolution data.",
        });
      }
    } else if (
      terminalWithoutResponse &&
      (request.response || request.resolvedByUserId || !request.resolvedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Expired and interrupted requests require a terminal timestamp without a response.",
      });
    }
  });

export const agentInteractionRequestListSchema = z.array(
  agentInteractionRequestSchema,
);

export const encryptedAgentInteractionRequestSchema = z
  .object({
    id: z.string().min(1),
    requestKey: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    provenance: agentInteractionProvenanceSchema,
    classification: interactionProtectedClassificationSchema,
    protectedPayload:
      interactionRequestOpaqueContentSchema.shape.protectedPayload,
    status: agentInteractionRequestStatusSchema,
    protectedResponse: encryptedInteractionResponseContentSchema.nullable(),
    resolvedByUserId: z.string().min(1).nullable(),
    expiresAt: z.string().datetime().nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((request, context) => {
    validateProtectedInteractionOwner(request, context);
    if (request.status === "pending") {
      if (
        request.protectedResponse ||
        request.resolvedByUserId ||
        request.resolvedAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Pending requests cannot contain resolution data.",
        });
      }
      return;
    }
    if (request.status === "resolved") {
      if (
        !request.protectedResponse ||
        !request.resolvedByUserId ||
        !request.resolvedAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Resolved requests require protected resolution data.",
        });
      }
      return;
    }
    if (
      request.protectedResponse ||
      request.resolvedByUserId ||
      !request.resolvedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Expired and interrupted requests require a terminal timestamp without a response.",
      });
    }
  });

export const agentInteractionRequestWireSchema = z.union([
  agentInteractionRequestSchema,
  encryptedAgentInteractionRequestSchema,
]);

export const agentInteractionRequestWireListSchema = z.array(
  agentInteractionRequestWireSchema,
);

export const agentInteractionResolutionWireCreateSchema = z.union([
  agentInteractionResolutionCreateSchema,
  encryptedAgentInteractionResolutionCreateSchema,
]);

export const agentInteractionRequestQuerySchema = z
  .object({
    chatId: z.string().min(1).optional(),
    status: agentInteractionRequestStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

export type AgentInteractionRequestKind = z.infer<
  typeof agentInteractionRequestKindSchema
>;
export type AgentInteractionRequestStatus = z.infer<
  typeof agentInteractionRequestStatusSchema
>;
export type AgentInteractionProvenance = z.infer<
  typeof agentInteractionProvenanceSchema
>;
export type AgentInteractionRequestPayload = z.infer<
  typeof agentInteractionRequestPayloadSchema
>;
export type AgentInteractionResponse = z.infer<
  typeof agentInteractionResponseSchema
>;
export type AgentInteractionRequestCreate = z.infer<
  typeof agentInteractionRequestCreateSchema
>;
export type AgentInteractionResolutionCreate = z.infer<
  typeof agentInteractionResolutionCreateSchema
>;
export type EncryptedAgentInteractionRequestCreate = z.infer<
  typeof encryptedAgentInteractionRequestCreateSchema
>;
export type EncryptedAgentInteractionResolutionCreate = z.infer<
  typeof encryptedAgentInteractionResolutionCreateSchema
>;
export type AgentInteractionRuntimeRequest = z.infer<
  typeof agentInteractionRuntimeRequestSchema
>;
export type EncryptedAgentInteractionRuntimeRequest = z.infer<
  typeof encryptedAgentInteractionRuntimeRequestSchema
>;
export type AgentInteractionAccepted = z.infer<
  typeof agentInteractionAcceptedSchema
>;
export type AgentInteractionRequest = z.infer<
  typeof agentInteractionRequestSchema
>;
export type EncryptedAgentInteractionRequest = z.infer<
  typeof encryptedAgentInteractionRequestSchema
>;
export type AgentInteractionRequestWire = z.infer<
  typeof agentInteractionRequestWireSchema
>;
export type AgentInteractionResolutionWireCreate = z.infer<
  typeof agentInteractionResolutionWireCreateSchema
>;
export type AgentInteractionRequestQuery = z.infer<
  typeof agentInteractionRequestQuerySchema
>;
