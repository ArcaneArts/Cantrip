import { z } from "zod";
import {
  explorerEntrySchema,
  explorerFileSchema,
  explorerFileWriteSchema,
} from "./explorer.js";
import {
  runConfigurationDeleteResponseSchema,
  runConfigurationDetectResponseSchema,
  runConfigurationGetResponseSchema,
  runConfigurationListResponseSchema,
  runConfigurationWriteResponseSchema,
} from "./run-configuration-operations.js";
import {
  runConfigurationRuntimeOperationResultSchema,
  runConfigurationRuntimeOutputSchema,
  runConfigurationRuntimeStatusResultSchema,
} from "./run-configuration-runtime.js";
import {
  runConfigurationFileSchema,
  runConfigurationIdSchema,
  runConfigurationProviderKindSchema,
  runConfigurationRevisionSchema,
  runConfigurationSecretReferenceSchema,
} from "./run-configuration-definitions.js";
import {
  runConfigurationSecretSetResultSchema,
  runConfigurationSecretValueContentSchema,
} from "./run-configuration-secrets.js";
import { clientControlResultStatusSchema } from "./live.js";
import {
  policyCliListResultSchema,
  policyCliReadResultSchema,
  policyKeySchema,
} from "./policies.js";
import { projectRootKindSchema } from "./project-foundation.js";
import {
  executionTargetSchema,
  executionTargetResourceKindSchema,
  executionTargetResolutionSchema,
  executionTargetDescriptorSchema,
} from "./execution-targets.js";
import { projectWorktreeSummarySchema } from "./worktrees.js";
import { permissionProfileIdSchema } from "./permission-profiles.js";
import {
  browserHttpUrlSchema,
  browserServiceListSchema,
} from "./browser-surfaces.js";
import {
  chatExecutionLaneStateSchema,
  chatExecutionLaneSummarySchema,
} from "./chat-execution-lanes.js";
import { cantripMcpToolNameSchema } from "./cantrip-mcp.js";

export const cantripMcpReadResultBaseSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    target: executionTargetSchema.nullable().default(null),
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    continuationScheduled: z.literal(false).default(false),
    mutated: z.literal(false).default(false),
  })
  .strict();

export const cantripMcpContextGetInputSchema = z.object({}).strict();
export const cantripMcpToolHelpInputSchema = z
  .object({ tool: cantripMcpToolNameSchema })
  .strict();
export const cantripMcpBindingStaleClaimSchema = z.enum([
  "context-kind",
  "chat",
  "project",
  "scratch-root",
  "worker",
  "execution-lane",
  "worktree",
  "root-kind",
  "permission-profile",
  "chat-status",
]);
export const cantripMcpBindingReadinessSchema = z
  .object({
    status: z.enum(["ready", "read-only", "refresh-required"]),
    mutationReady: z.boolean(),
    staleClaims: z.array(cantripMcpBindingStaleClaimSchema).max(10),
    recoveryInstruction: z.string().min(1).max(500).nullable(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export const cantripMcpPolicyListInputSchema = z.object({}).strict();
export const cantripMcpPolicyReadInputSchema = z
  .object({ key: policyKeySchema })
  .strict();
export const cantripMcpTargetListInputSchema = z
  .object({
    kind: executionTargetResourceKindSchema.optional(),
    cursor: z.number().int().min(0).max(1_999).default(0),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export const cantripMcpTargetInspectInputSchema = z
  .object({ target: executionTargetSchema })
  .strict();
export const cantripMcpRunConfigurationListInputSchema = z.object({}).strict();
export const cantripMcpRunConfigurationGetInputSchema = z
  .object({ configurationId: runConfigurationIdSchema })
  .strict();
export const cantripMcpRunConfigurationDetectInputSchema = z
  .object({ provider: runConfigurationProviderKindSchema.optional() })
  .strict();
export const cantripMcpRunConfigurationCreateInputSchema = z
  .object({
    operationId: z.string().uuid(),
    document: runConfigurationFileSchema,
  })
  .strict();
export const cantripMcpRunConfigurationUpdateInputSchema = z
  .object({
    operationId: z.string().uuid(),
    configurationId: runConfigurationIdSchema,
    expectedRevision: runConfigurationRevisionSchema,
    document: runConfigurationFileSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.configurationId !== input.document.id) {
      context.addIssue({
        code: "custom",
        message: "The requested and document configuration IDs must match.",
        path: ["document", "id"],
      });
    }
  });
export const cantripMcpRunConfigurationDeleteInputSchema = z
  .object({
    operationId: z.string().uuid(),
    configurationId: runConfigurationIdSchema,
    expectedRevision: runConfigurationRevisionSchema,
  })
  .strict();
const cantripMcpRunConfigurationTargetInputFields = {
  operationId: z.string().uuid(),
  configurationId: runConfigurationIdSchema,
  worktreeId: z.string().min(1).max(200).nullable().default(null),
};
export const cantripMcpRunConfigurationStartInputSchema = z
  .object(cantripMcpRunConfigurationTargetInputFields)
  .strict();
export const cantripMcpRunConfigurationRestartInputSchema = z
  .object(cantripMcpRunConfigurationTargetInputFields)
  .strict();
export const cantripMcpRunConfigurationStopInputSchema = z
  .object(cantripMcpRunConfigurationTargetInputFields)
  .strict();
export const cantripMcpRunConfigurationStatusInputSchema = z
  .object({
    configurationId: runConfigurationIdSchema.nullable().default(null),
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    limit: z.number().int().positive().max(256).default(256),
  })
  .strict();
export const cantripMcpRunConfigurationReadOutputInputSchema = z
  .object({
    ...cantripMcpRunConfigurationTargetInputFields,
    tail: z.number().int().positive().max(100_000).default(10_000),
  })
  .strict();
export const cantripMcpRunConfigurationSecretSetInputSchema = z
  .object({
    operationId: z.string().uuid(),
    reference: runConfigurationSecretReferenceSchema,
    value: runConfigurationSecretValueContentSchema.shape.value,
  })
  .strict();
export const cantripMcpWorktreeListInputSchema = z
  .object({
    cursor: z.number().int().min(0).max(1_999).default(0),
    limit: z.number().int().min(1).max(200).default(100),
    includeLeaseHistory: z.boolean().default(false),
  })
  .strict();
export const cantripMcpWorktreeStatusInputSchema = z
  .object({
    target: z
      .object({
        kind: z.literal("worktree"),
        projectId: z.string().min(1).max(200),
        worktreeId: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
    fileLimit: z.number().int().min(1).max(2_000).default(500),
    branchLimit: z.number().int().min(1).max(500).default(200),
  })
  .strict();

const cantripMcpSurfaceTargetSchema = <
  Kind extends "browser" | "explorer" | "terminal",
>(
  kind: Kind,
) =>
  z
    .object({
      kind: z.literal("surface"),
      projectId: z.string().min(1).max(200),
      surfaceKind: z.literal(kind),
      surfaceId: z.string().min(1).max(200),
    })
    .strict();

export const cantripMcpExplorerListInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    path: z.string().max(8_192).default(""),
    cursor: z.number().int().min(0).max(999).default(0),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export const cantripMcpExplorerReadInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    path: z.string().min(1).max(8_192),
    maxChars: z.number().int().min(1).max(200_000).default(100_000),
  })
  .strict();
export const cantripMcpTerminalReadInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    maxChars: z.number().int().min(1).max(100_000).default(20_000),
  })
  .strict();
const cantripWebDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u,
    "Domains must be hostnames without a scheme or path.",
  )
  .overwrite((value) => value.toLowerCase());
export const cantripMcpWebSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    count: z.number().int().min(1).max(20).default(10),
    page: z.number().int().min(1).max(5).default(1),
    freshness: z.enum(["day", "month", "year"]).optional(),
    language: z
      .string()
      .trim()
      .min(2)
      .max(35)
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u)
      .optional(),
    category: z.enum(["general", "news", "science", "it"]).default("general"),
    safeSearch: z.enum(["off", "moderate", "strict"]).default("moderate"),
    includeDomains: z.array(cantripWebDomainSchema).max(10).default([]),
    excludeDomains: z.array(cantripWebDomainSchema).max(10).default([]),
  })
  .strict()
  .superRefine((input, context) => {
    const included = new Set(input.includeDomains);
    for (const [index, domain] of input.excludeDomains.entries()) {
      if (included.has(domain)) {
        context.addIssue({
          code: "custom",
          message: "A domain cannot be both included and excluded.",
          path: ["excludeDomains", index],
        });
      }
    }
  });
export const cantripMcpWebReadInputSchema = z
  .object({
    url: z.url().max(8_192).optional(),
    searchResultId: z
      .string()
      .regex(/^wsr_[A-Za-z0-9_-]{32}$/u)
      .optional(),
    cursor: z
      .string()
      .regex(/^wrc_[A-Za-z0-9_-]{32}$/u)
      .optional(),
    maxChars: z.number().int().min(1_000).max(100_000).default(20_000),
    render: z.enum(["never", "auto", "always"]).default("auto"),
  })
  .strict()
  .superRefine((input, context) => {
    const initialSources =
      Number(Boolean(input.url)) + Number(Boolean(input.searchResultId));
    if (input.cursor ? initialSources !== 0 : initialSources !== 1) {
      context.addIssue({
        code: "custom",
        message: input.cursor
          ? "A continuation cursor cannot be combined with a URL or search result ID."
          : "Provide exactly one of url or searchResultId.",
        path: input.cursor ? ["cursor"] : [],
      });
    }
  });
const cantripWebSessionIdSchema = z.string().regex(/^wss_[A-Za-z0-9_-]{32}$/u);
const cantripWebElementRefSchema = z.string().regex(/^wer_[A-Za-z0-9_-]{32}$/u);
export const cantripMcpWebSessionOpenInputSchema = z
  .object({
    url: z.url().max(8_192),
    sessionId: cantripWebSessionIdSchema.optional(),
    browserTarget: cantripMcpSurfaceTargetSchema("browser").optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.sessionId && input.browserTarget) {
      context.addIssue({
        code: "custom",
        message: "A resumed session already has a fixed profile target.",
        path: ["browserTarget"],
      });
    }
  });
export const cantripMcpWebSessionSnapshotInputSchema = z
  .object({
    sessionId: cantripWebSessionIdSchema,
    maxChars: z.number().int().min(1_000).max(50_000).default(20_000),
  })
  .strict();
export const cantripMcpWebSessionClickInputSchema = z
  .object({
    sessionId: cantripWebSessionIdSchema,
    elementRef: cantripWebElementRefSchema,
  })
  .strict();
export const cantripMcpWebSessionTypeInputSchema = z
  .object({
    sessionId: cantripWebSessionIdSchema,
    elementRef: cantripWebElementRefSchema,
    text: z.string().max(4_000),
    submit: z.boolean().default(false),
  })
  .strict();
export const cantripMcpWebSessionCloseInputSchema = z
  .object({ sessionId: cantripWebSessionIdSchema })
  .strict();
export const cantripMcpBrowserServicesInputSchema = z
  .object({ target: cantripMcpSurfaceTargetSchema("browser") })
  .strict();

const cantripMcpWorktreeTargetSchema = z
  .object({
    kind: z.literal("worktree"),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
  })
  .strict();

export const cantripMcpWorktreeCreateInputSchema = z.discriminatedUnion(
  "intent",
  [
    z
      .object({
        intent: z.literal("newBranch"),
        name: z.string().trim().min(1).max(200),
        branch: z.string().trim().min(1).max(255),
        baseRevision: z
          .string()
          .trim()
          .min(1)
          .max(1_024)
          .optional()
          .describe(
            "Optional starting revision; matches CLI --base-revision (legacy alias --from).",
          ),
      })
      .strict(),
    z
      .object({
        intent: z.literal("existingBranch"),
        name: z.string().trim().min(1).max(200),
        branch: z.string().trim().min(1).max(255),
      })
      .strict(),
    z
      .object({
        intent: z.literal("detached"),
        name: z.string().trim().min(1).max(200),
        baseRevision: z
          .string()
          .trim()
          .min(1)
          .max(1_024)
          .describe(
            "Required detached revision; CLI expresses this variant with --detach.",
          ),
      })
      .strict(),
  ],
);
export const cantripMcpWorktreeSwitchInputSchema = z
  .object({
    target: cantripMcpWorktreeTargetSchema,
    purpose: z.string().trim().min(1).max(500),
  })
  .strict();
export const cantripMcpWorktreeReleaseInputSchema = z
  .object({ purpose: z.string().trim().min(1).max(500) })
  .strict();
export const cantripMcpWorktreeRemoveInputSchema = z
  .object({ target: cantripMcpWorktreeTargetSchema })
  .strict();
export const cantripMcpExplorerWriteInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    path: explorerFileWriteSchema.shape.path,
    content: z.string().max(200_000),
    version: explorerFileWriteSchema.shape.version,
  })
  .strict();
export const cantripMcpTerminalSendInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    data: z.string().max(100_000),
  })
  .strict();
export const cantripMcpTerminalRestartInputSchema = z
  .object({ target: cantripMcpSurfaceTargetSchema("terminal") })
  .strict();
export const cantripMcpBrowserNavigateInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("browser"),
    url: browserHttpUrlSchema,
  })
  .strict();
export const cantripMcpClientNotifyInputSchema = z
  .object({
    level: z.enum(["info", "warning", "error"]).default("info"),
    title: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(2_000),
  })
  .strict();
export const cantripMcpClientFocusProjectInputSchema = z.object({}).strict();
export const cantripMcpClientSurfaceTargetSchema = z.discriminatedUnion(
  "surfaceKind",
  [
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("chat"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("terminal"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("explorer"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("code"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("browser"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
  ],
);
export const cantripMcpClientFocusSurfaceInputSchema = z
  .object({ target: cantripMcpClientSurfaceTargetSchema })
  .strict();
export const cantripMcpClientShowInteractionInputSchema = z
  .object({ interactionId: z.string().min(1).max(200) })
  .strict();

export const cantripMcpContextGetResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: z
      .object({
        worker: z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().min(1).max(200),
            online: z.boolean(),
          })
          .strict(),
        context: z
          .object({
            chatId: z.string().min(1).max(200).nullable(),
            executionLaneId: z.string().min(1).max(200).nullable(),
            permissionProfileId: permissionProfileIdSchema.nullable(),
            projectId: z.string().min(1).max(200),
            rootKind: projectRootKindSchema,
            terminalId: z.string().min(1).max(200).nullable(),
            workerId: z.string().min(1).max(200),
            worktreeId: z.string().min(1).max(200),
            worktreeMode: z.enum(["agent-managed", "pinned"]).nullable(),
          })
          .strict(),
        binding: cantripMcpBindingReadinessSchema,
      })
      .strict(),
  });
export const cantripMcpToolHelpResultSchema = cantripMcpReadResultBaseSchema
  .extend({
    target: z.null().default(null),
    data: z
      .object({
        tool: cantripMcpToolNameSchema,
        inputSchema: z.record(z.string(), z.unknown()),
        examples: z.array(z.record(z.string(), z.unknown())).max(3),
        notes: z.array(z.string().min(1).max(500)).max(8),
      })
      .strict(),
  })
  .strict();
export const cantripMcpPolicyListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: policyCliListResultSchema,
  });
export const cantripMcpPolicyReadResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: policyCliReadResultSchema,
  });
export const cantripMcpTargetListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: z
      .object({
        projectId: z.string().min(1).max(200),
        targets: z.array(executionTargetDescriptorSchema).max(200),
        cursor: z.number().int().min(0).max(1_999),
        nextCursor: z.number().int().positive().max(2_000).nullable(),
        total: z.number().int().nonnegative().max(2_000),
        truncated: z.boolean(),
      })
      .strict(),
  });
export const cantripMcpTargetInspectResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: executionTargetSchema,
    data: executionTargetResolutionSchema
      .extend({
        stateRevision: z.number().int().positive().nullable(),
      })
      .strict(),
  });
const cantripMcpRunConfigurationProjectTargetSchema = z
  .object({
    kind: z.literal("project"),
    projectId: z.string().min(1).max(200),
  })
  .strict();
const cantripMcpRunConfigurationResultBaseSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    target: cantripMcpRunConfigurationProjectTargetSchema,
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    continuationScheduled: z.literal(false).default(false),
    mutated: z.boolean(),
  })
  .strict();
const cantripMcpRunConfigurationReadResultBaseSchema =
  cantripMcpRunConfigurationResultBaseSchema.extend({
    mutated: z.literal(false).default(false),
  });
export const cantripMcpRunConfigurationListResultSchema =
  cantripMcpRunConfigurationReadResultBaseSchema.extend({
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationListResponseSchema
      .extend({
        runtimes: runConfigurationRuntimeStatusResultSchema.shape.runtimes,
      })
      .strict(),
  });
export const cantripMcpRunConfigurationGetResultSchema =
  cantripMcpRunConfigurationReadResultBaseSchema.extend({
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationGetResponseSchema,
  });
export const cantripMcpRunConfigurationDetectResultSchema =
  cantripMcpRunConfigurationReadResultBaseSchema.extend({
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationDetectResponseSchema,
  });
export const cantripMcpRunConfigurationStatusResultSchema =
  cantripMcpRunConfigurationReadResultBaseSchema.extend({
    data: runConfigurationRuntimeStatusResultSchema,
  });
export const cantripMcpRunConfigurationReadOutputResultSchema =
  cantripMcpRunConfigurationReadResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationRuntimeOutputSchema,
  });
export const cantripMcpRunConfigurationCreateResultSchema =
  cantripMcpRunConfigurationResultBaseSchema.extend({
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationWriteResponseSchema,
  });
export const cantripMcpRunConfigurationUpdateResultSchema =
  cantripMcpRunConfigurationCreateResultSchema;
export const cantripMcpRunConfigurationDeleteResultSchema =
  cantripMcpRunConfigurationResultBaseSchema.extend({
    worktreeId: z.string().min(1).max(200),
    mutated: z.literal(true),
    data: runConfigurationDeleteResponseSchema,
  });
const cantripMcpRunConfigurationLifecycleResultSchema =
  cantripMcpRunConfigurationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationRuntimeOperationResultSchema,
  });
export const cantripMcpRunConfigurationStartResultSchema =
  cantripMcpRunConfigurationLifecycleResultSchema;
export const cantripMcpRunConfigurationRestartResultSchema =
  cantripMcpRunConfigurationLifecycleResultSchema;
export const cantripMcpRunConfigurationStopResultSchema =
  cantripMcpRunConfigurationLifecycleResultSchema;
export const cantripMcpRunConfigurationSecretSetResultSchema =
  cantripMcpRunConfigurationResultBaseSchema.extend({
    worktreeId: z.null().default(null),
    data: runConfigurationSecretSetResultSchema,
  });

export const cantripMcpWorktreeSummarySchema = projectWorktreeSummarySchema
  .omit({ path: true, displayPath: true })
  .strict();
export const cantripMcpWorktreeListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: z
      .object({
        currentWorktreeId: z.string().min(1).max(200),
        worktrees: z.array(cantripMcpWorktreeSummarySchema).max(200),
        leases: z.array(chatExecutionLaneSummarySchema).max(1_000),
        cursor: z.number().int().min(0).max(1_999),
        nextCursor: z.number().int().positive().max(2_000).nullable(),
        total: z.number().int().nonnegative().max(2_000),
        truncated: z.boolean(),
      })
      .strict(),
  });
export const cantripMcpExplorerListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    data: z
      .object({
        path: z.string().max(8_192),
        entries: z.array(explorerEntrySchema).max(200),
        cursor: z.number().int().min(0).max(999),
        nextCursor: z.number().int().positive().max(1_000).nullable(),
        total: z.number().int().nonnegative().max(1_000),
        truncated: z.boolean(),
      })
      .strict(),
  });
export const cantripMcpExplorerReadResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    data: explorerFileSchema.extend({
      content: z.string().max(200_000),
      truncated: z.boolean(),
    }),
  });
export const cantripMcpTerminalReadResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    data: z
      .object({
        status: z.enum(["running", "restarting", "exited", "not-running"]),
        data: z.string().max(100_000),
        truncated: z.boolean(),
        exitCode: z.number().int().nullable(),
      })
      .strict(),
  });
const cantripWebSearchResultRowSchema = z
  .object({
    id: z.string().regex(/^wsr_[A-Za-z0-9_-]{32}$/u),
    title: z.string().max(1_000),
    url: z.url().max(8_192),
    snippet: z.string().max(4_000),
    engines: z.array(z.string().min(1).max(100)).max(10),
    publishedAt: z.iso.datetime().nullable(),
  })
  .strict();
export const cantripMcpWebSearchResultSchema = cantripMcpReadResultBaseSchema
  .extend({
    target: z.null().default(null),
    data: z
      .object({
        query: z.string().max(500),
        results: z.array(cantripWebSearchResultRowSchema).max(20),
        diagnostics: z
          .array(
            z
              .object({
                engine: z.string().min(1).max(100),
                category: z.enum([
                  "captcha",
                  "rate-limited",
                  "timeout",
                  "unavailable",
                  "unknown",
                ]),
                message: z.string().min(1).max(500),
              })
              .strict(),
          )
          .max(10),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const cantripMcpWebReadResultSchema = cantripMcpReadResultBaseSchema
  .extend({
    target: z.null().default(null),
    data: z
      .object({
        url: z.url().max(8_192),
        title: z.string().max(1_000),
        content: z.string().max(100_000),
        method: z.enum(["static", "plain-text", "rendered"]),
        retrievedAt: z.iso.datetime(),
        cursor: z
          .string()
          .regex(/^wrc_[A-Za-z0-9_-]{32}$/u)
          .nullable(),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();
const cantripWebSessionStateSchema = z
  .object({
    sessionId: cantripWebSessionIdSchema,
    url: z.url().max(8_192),
    title: z.string().max(1_000),
    generation: z.number().int().positive(),
    persistent: z.boolean(),
  })
  .strict();
const cantripMcpWebSessionMutationResultBaseSchema =
  cantripMcpReadResultBaseSchema
    .extend({
      target: z.null().default(null),
      mutated: z.literal(true),
    })
    .strict();
export const cantripMcpWebSessionOpenResultSchema =
  cantripMcpWebSessionMutationResultBaseSchema.extend({
    data: cantripWebSessionStateSchema,
  });
export const cantripMcpWebSessionSnapshotResultSchema =
  cantripMcpReadResultBaseSchema
    .extend({
      target: z.null().default(null),
      data: cantripWebSessionStateSchema
        .extend({
          snapshot: z.string().max(50_000),
          elements: z
            .array(
              z
                .object({
                  ref: cantripWebElementRefSchema,
                  description: z.string().min(1).max(1_000),
                })
                .strict(),
            )
            .max(100),
          truncated: z.boolean(),
        })
        .strict(),
    })
    .strict();
export const cantripMcpWebSessionActionResultSchema =
  cantripMcpWebSessionMutationResultBaseSchema.extend({
    data: cantripWebSessionStateSchema,
  });
export const cantripMcpWebSessionCloseResultSchema =
  cantripMcpWebSessionMutationResultBaseSchema.extend({
    data: z
      .object({ sessionId: cantripWebSessionIdSchema, closed: z.literal(true) })
      .strict(),
  });
export const cantripMcpBrowserServicesResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("browser"),
    data: browserServiceListSchema,
  });

const cantripMcpMutationResultBaseSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    target: executionTargetSchema,
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    continuationScheduled: z.literal(false).default(false),
    mutated: z.literal(true),
  })
  .strict();
const cantripMcpContinuationResultBaseSchema =
  cantripMcpMutationResultBaseSchema.extend({
    continuationScheduled: z.literal(true),
  });
const cantripMcpTransitionDataSchema = z
  .object({
    lane: z
      .object({
        id: z.string().min(1).max(200),
        state: chatExecutionLaneStateSchema,
        transitionKind: z.enum(["switch", "release"]),
      })
      .strict(),
    worktree: cantripMcpWorktreeSummarySchema,
  })
  .strict();

export const cantripMcpWorktreeCreateResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: z.object({ worktree: cantripMcpWorktreeSummarySchema }).strict(),
  });
export const cantripMcpWorktreeSwitchResultSchema =
  cantripMcpContinuationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: cantripMcpTransitionDataSchema,
  });
export const cantripMcpWorktreeReleaseResultSchema =
  cantripMcpContinuationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: cantripMcpTransitionDataSchema,
  });
export const cantripMcpWorktreeRemoveResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: z
      .object({
        removedWorktreeId: z.string().min(1).max(200),
        branchRetained: z.literal(true),
      })
      .strict(),
  });
export const cantripMcpExplorerWriteResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    data: explorerFileSchema.omit({ content: true }).strict(),
  });
export const cantripMcpTerminalSendResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    data: z.object({ accepted: z.literal(true) }).strict(),
  });
export const cantripMcpTerminalRestartResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    data: z.object({ status: z.literal("running") }).strict(),
  });
export const cantripMcpBrowserNavigateResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("browser"),
    data: z
      .object({
        url: browserHttpUrlSchema,
        stateRevision: z.number().int().positive().safe(),
      })
      .strict(),
  });

const cantripMcpClientControlDataSchema = z
  .object({
    correlationId: z.string().uuid(),
    status: clientControlResultStatusSchema,
  })
  .strict();
const cantripMcpClientControlResultBaseSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    target: executionTargetSchema,
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    continuationScheduled: z.literal(false).default(false),
    mutated: z.boolean(),
    data: cantripMcpClientControlDataSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.mutated === (result.data.status === "applied")) return;
    context.addIssue({
      code: "custom",
      path: ["mutated"],
      message: "Client-control mutation state must match its applied status.",
    });
  });
export const cantripMcpClientNotifyResultSchema =
  cantripMcpClientControlResultBaseSchema.safeExtend({
    target: z
      .object({
        kind: z.literal("project"),
        projectId: z.string().min(1).max(200),
      })
      .strict(),
  });
export const cantripMcpClientFocusProjectResultSchema =
  cantripMcpClientNotifyResultSchema;
export const cantripMcpClientFocusSurfaceResultSchema =
  cantripMcpClientControlResultBaseSchema.safeExtend({
    target: cantripMcpClientSurfaceTargetSchema,
  });
export const cantripMcpClientShowInteractionResultSchema =
  cantripMcpClientControlResultBaseSchema.safeExtend({
    target: z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("chat"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
  });

// The human CLI is a compatibility adapter over the same operation result
