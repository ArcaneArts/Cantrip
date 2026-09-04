import { z } from "zod";
import { codeSettingsWorkerStatusSchema } from "./code-settings.js";
import { protectedTunnelContentRecordSchema } from "./tunnel-content.js";
import { encryptionKeyBytesSchema } from "./encryption.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { codeCapabilitiesSchema } from "./runtime-capabilities.js";
import {
  executionResourceIdSchema,
  executionTargetSchema,
} from "./execution-targets.js";
import { tunnelResourceIdSchema } from "./tunnels.js";
import { repositoryRelativePathSchema } from "./repository-paths.js";
import {
  hasUnambiguousProjectPaneDestination,
  projectPaneDestinationShape,
} from "./project-pane-identifiers.js";

export const codeThemeModeSchema = z.enum(["follow-cantrip", "independent"]);
export const codePresentationSchema = z.enum([
  "workbench",
  "editor",
  "extensions",
]);
export const codeAppearanceSchema = z.enum([
  "light",
  "dark",
  "high-contrast-light",
  "high-contrast-dark",
  "pro-light",
  "pro-dark",
  "pro-high-contrast-light",
  "pro-high-contrast-dark",
]);
export const codeTabStatusSchema = z.enum([
  "idle",
  "starting",
  "running",
  "stopped",
  "offline",
  "failed",
]);
export const codeSessionStatusSchema = z.enum([
  "starting",
  "running",
  "idle",
  "stopping",
  "stopped",
  "offline",
  "failed",
]);

const codeTabCreateBaseSchema = z
  .object({
    worktreeId: z.string().min(1).optional(),
    profileId: z.string().trim().min(1).max(200).default("default"),
    themeMode: codeThemeModeSchema.default("follow-cantrip"),
    ...projectPaneDestinationShape,
    target: executionTargetSchema.optional(),
  })
  .superRefine((input, context) => {
    if (input.worktreeId && input.target) {
      context.addIssue({
        code: "custom",
        message: "Choose either a legacy worktreeId or an execution target.",
      });
    }
    if (!hasUnambiguousProjectPaneDestination(input)) {
      context.addIssue({
        code: "custom",
        message:
          "Specify only one of paneId, the deprecated tabGroupId, or targetRegion.",
        path: ["paneId"],
      });
    }
  });

export const codeTabCreateSchema = codeTabCreateBaseSchema.safeExtend({
  title: z.string().trim().min(1).max(200).default("Code"),
});

export const encryptedCodeTabCreateSchema = codeTabCreateBaseSchema
  .safeExtend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .refine(
    (input) => input.titleProtection.classification.recordKind === "code-tab",
    {
      message: "Code-tab title classification must be code-tab.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const codeTabUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    themeMode: codeThemeModeSchema.optional(),
  })
  .refine(
    (input) => input.title !== undefined || input.themeMode !== undefined,
    { message: "At least one Code tab field is required." },
  );

export const encryptedCodeTabUpdateSchema = z
  .object({
    titleProtection: privateDisplayLabelOpaqueSchema.optional(),
    themeMode: codeThemeModeSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.titleProtection === undefined && input.themeMode === undefined) {
      context.addIssue({
        code: "custom",
        message: "At least one Code tab field is required.",
      });
    }
    if (
      input.titleProtection &&
      input.titleProtection.classification.recordKind !== "code-tab"
    ) {
      context.addIssue({
        code: "custom",
        message: "Code-tab title classification must be code-tab.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

const codeTabSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  activeWorkerId: z.string().min(1),
  worktreeId: z.string().min(1),
  profileId: z.string().min(1),
  themeMode: codeThemeModeSchema,
  status: codeTabStatusSchema,
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const codeTabSummarySchema = codeTabSummaryBaseSchema.extend({
  title: z.string().min(1).max(200),
});

export const codeTabWireSummarySchema = codeTabSummaryBaseSchema
  .extend({ titleProtection: privateDisplayLabelOpaqueSchema })
  .refine(
    (codeTab) =>
      codeTab.titleProtection.classification.recordKind === "code-tab",
    {
      message: "Code-tab title classification must be code-tab.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const codeTabListSchema = z.array(codeTabSummarySchema);
export const codeTabWireListSchema = z.array(codeTabWireSummarySchema);

export const codeEditorBuildSchema = z.object({
  version: z.string().min(1),
  upstreamRevision: z.string().regex(/^[0-9a-f]{40}$/u),
  patchset: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const codeProbeResultSchema = z.object({
  capabilities: codeCapabilitiesSchema,
  editorBuild: codeEditorBuildSchema.nullable(),
  serverControlPlaneGeneration: z.string().uuid().optional(),
  workerProcessGeneration: z.string().uuid().optional(),
});

export const codeSessionSummarySchema = z.object({
  id: z.string().min(1),
  codeTabId: z.string().min(1),
  projectId: z.string().min(1),
  workerId: z.string().min(1),
  worktreeId: z.string().min(1),
  profileId: z.string().min(1),
  editorBuild: codeEditorBuildSchema.nullable(),
  status: codeSessionStatusSchema,
  processInstanceId: z.string().min(1).nullable(),
  lastAttachmentAt: z.string().datetime().nullable(),
  lastStartedAt: z.string().datetime().nullable(),
  stoppedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const codeSessionListSchema = z.array(codeSessionSummarySchema);

export const codeDirtyEditorSchema = z.object({
  uri: z.string().min(1).max(16_384),
  relativePath: z.string().max(8_192).nullable(),
  untitled: z.boolean(),
  dirty: z.literal(true),
});

export const codeSaveBeforeAgentTurnSchema = z.enum(["always", "ask", "never"]);

export const codeWorkbenchAgentStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "failed",
]);

export const codeWorkbenchActiveEditorSchema = z.object({
  uri: z.string().min(1).max(16_384),
  relativePath: z.string().max(8_192).nullable(),
  topologyReconciled: z.boolean().optional(),
  selection: z.object({
    startLine: z.number().int().nonnegative(),
    startCharacter: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    endCharacter: z.number().int().nonnegative(),
  }),
});

export const codeWorkbenchGitStateSchema = z.object({
  branch: z.string().max(1_000).nullable(),
  head: z.string().max(200).nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  staged: z.number().int().nonnegative(),
  unstaged: z.number().int().nonnegative(),
  untracked: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
});

export const codeWorkbenchStateSchema = z.object({
  activeEditor: codeWorkbenchActiveEditorSchema.nullable(),
  git: codeWorkbenchGitStateSchema.nullable(),
  conflicts: z.array(codeDirtyEditorSchema).max(1_000),
  savePolicy: codeSaveBeforeAgentTurnSchema,
  agentStatus: codeWorkbenchAgentStatusSchema,
});

export const codeRuntimeStatusSchema = z.object({
  sessionId: z.string().min(1),
  sessionIncarnationId: z.string().uuid().nullable().optional(),
  initialFileUri: z.string().min(1).max(16_384).nullable().optional(),
  workspaceUri: z.string().min(1).max(16_384).optional(),
  status: codeSessionStatusSchema,
  editorBuild: codeEditorBuildSchema,
  processInstanceId: z.string().min(1).nullable(),
  bridgeConnected: z.boolean(),
  dirtyEditors: z.array(codeDirtyEditorSchema).max(1_000),
  workbench: codeWorkbenchStateSchema,
  startedAt: z.string().datetime().nullable(),
  lastActivityAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
});

export const codeSettingsWorkbenchOpenResultSchema = z
  .object({
    synchronization: codeSettingsWorkerStatusSchema,
    runtime: codeRuntimeStatusSchema,
  })
  .strict();

export const codeSaveAllResultSchema = z.object({
  saved: z.array(z.string().max(16_384)).max(1_000),
  failed: z
    .array(
      z.object({
        uri: z.string().min(1).max(16_384),
        message: z.string().min(1).max(4_000),
      }),
    )
    .max(1_000),
});

export const codeAgentTurnPreparationSessionSchema = z.object({
  sessionId: z.string().min(1),
  bridgeConnected: z.boolean(),
  allowed: z.boolean(),
  policy: codeSaveBeforeAgentTurnSchema.nullable(),
  dirtyEditors: z.array(codeDirtyEditorSchema).max(1_000),
  saved: z.array(z.string().max(16_384)).max(1_000),
  failed: codeSaveAllResultSchema.shape.failed,
  reason: z.string().max(4_000).nullable(),
});

export const codeAgentTurnPreparationResultSchema = z.object({
  prepared: z.boolean(),
  sessions: z.array(codeAgentTurnPreparationSessionSchema).max(128),
});

export const codeAgentTurnNotificationResultSchema = z.object({
  notifiedSessions: z.number().int().nonnegative(),
  refreshed: z.array(z.string().max(8_192)).max(5_000),
  conflicts: z.array(codeDirtyEditorSchema).max(1_000),
});

export const codeAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  sessionId: z.string().min(1),
  url: z.url(),
  expiresAt: z.string().datetime(),
  runtime: codeRuntimeStatusSchema,
});

export const codeProtectedAttachmentWireSchema = z
  .object({
    attachmentId: tunnelResourceIdSchema,
    tunnelId: tunnelResourceIdSchema,
    sessionId: tunnelResourceIdSchema,
    expiresAt: z.string().datetime(),
    runtime: codeRuntimeStatusSchema,
  })
  .strict()
  .refine(({ attachmentId, tunnelId }) => attachmentId === tunnelId, {
    message: "A protected Code attachment must reuse its tunnel identity.",
    path: ["attachmentId"],
  });

export const codeProtectedAttachmentIntentSchema = z
  .object({
    sessionId: tunnelResourceIdSchema,
    runtime: codeRuntimeStatusSchema,
  })
  .strict()
  .refine(({ sessionId, runtime }) => sessionId === runtime.sessionId, {
    message: "A Code attachment intent must bind its runtime session.",
    path: ["runtime", "sessionId"],
  });

export const codeSessionRouteGrantSchema = encryptionKeyBytesSchema;

export function codeSessionRouteBasePath(routeGrant: string): string {
  return `/sessions/${codeSessionRouteGrantSchema.parse(routeGrant)}/code`;
}

export function parseCodeSessionRoutePath(
  rawPath: string,
): { basePath: string; routeGrant: string } | null {
  const queryIndex = rawPath.indexOf("?");
  const pathname = queryIndex < 0 ? rawPath : rawPath.slice(0, queryIndex);
  if (
    pathname.includes("\\") ||
    pathname.includes("//") ||
    /%(?:2f|5c)/iu.test(pathname)
  ) {
    return null;
  }
  const match = /^\/sessions\/([A-Za-z0-9_-]{43})\/code(?=$|\/)/u.exec(
    pathname,
  );
  const routeGrant = match?.[1];
  if (
    !routeGrant ||
    !codeSessionRouteGrantSchema.safeParse(routeGrant).success
  ) {
    return null;
  }
  const basePath = codeSessionRouteBasePath(routeGrant);
  const suffix = pathname.slice(basePath.length);
  if (
    suffix !== "" &&
    (!suffix.startsWith("/") ||
      suffix
        .slice(1)
        .split("/")
        .some((segment) => {
          try {
            const decoded = decodeURIComponent(segment);
            return (
              decoded === "." ||
              decoded === ".." ||
              decoded.includes("/") ||
              decoded.includes("\\")
            );
          } catch {
            return true;
          }
        }))
  ) {
    return null;
  }
  return { basePath, routeGrant };
}

export const codeTransportCandidateSchema = z
  .object({
    formatVersion: z.literal(2),
    transportId: z.string().uuid(),
    protectedRecord: protectedTunnelContentRecordSchema,
  })
  .strict()
  .refine(
    ({ protectedRecord, transportId }) =>
      protectedRecord.operationId === transportId &&
      protectedRecord.revision === 1,
    {
      message:
        "A shared Code transport must begin with its transport-bound record.",
      path: ["protectedRecord"],
    },
  );

export const codeTransportWireSchema = z
  .object({
    formatVersion: z.literal(2),
    transportId: tunnelResourceIdSchema,
    tunnelId: tunnelResourceIdSchema,
    workerId: executionResourceIdSchema,
    securityScopeId: z.string().uuid(),
    serverId: executionResourceIdSchema,
    serverControlPlaneGeneration: z.string().uuid(),
    protectedKeyRevision: z.number().int().positive().safe(),
    workerProcessGeneration: z.string().uuid(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .refine(({ transportId, tunnelId }) => transportId === tunnelId, {
    message: "A shared Code transport must reuse its tunnel identity.",
    path: ["tunnelId"],
  });

export const codeSessionAttachmentWireSchema = z
  .object({
    formatVersion: z.literal(2),
    attachmentId: tunnelResourceIdSchema,
    transportId: tunnelResourceIdSchema,
    sessionId: tunnelResourceIdSchema,
    routeGrant: codeSessionRouteGrantSchema,
    expiresAt: z.string().datetime(),
    runtime: codeRuntimeStatusSchema,
  })
  .strict()
  .refine(({ runtime, sessionId }) => runtime.sessionId === sessionId, {
    message: "A shared Code attachment must bind its runtime session.",
    path: ["runtime", "sessionId"],
  });

export const codeSharedAttachmentWireSchema = z
  .object({
    formatVersion: z.literal(2),
    transport: codeTransportWireSchema,
    session: codeSessionAttachmentWireSchema,
  })
  .strict()
  .refine(
    ({ session, transport }) => session.transportId === transport.transportId,
    {
      message: "A shared Code attachment must reference its transport.",
      path: ["session", "transportId"],
    },
  );

const codeTransportLifecycleIdentitySchema = z
  .object({
    ownerId: z.string().min(1).max(2_000),
    authSessionId: z.string().min(1).max(2_000),
    serverId: z.string().min(1).max(2_000),
    serverControlPlaneGeneration: z.string().uuid(),
    protectedKeyRevision: z.number().int().positive().safe(),
    workerProcessGeneration: z.string().uuid(),
  })
  .strict();

export const codeTransportRouteAuthorizeCommandSchema = z
  .object({
    type: z.literal("code.transport.route.authorize"),
    ...codeTransportLifecycleIdentitySchema.shape,
    transportId: z.string().uuid(),
    attachmentId: z.string().uuid(),
    sessionId: z.string().uuid(),
    expectedSessionIncarnationId: z.string().uuid(),
    routeGrant: codeSessionRouteGrantSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export const codeTransportRouteRevokeCommandSchema = z
  .object({
    type: z.literal("code.transport.route.revoke"),
    ...codeTransportLifecycleIdentitySchema.shape,
    transportId: z.string().uuid(),
    attachmentId: z.string().uuid(),
  })
  .strict();

export const codeTransportRevokeCommandSchema = z
  .object({
    type: z.literal("code.transport.revoke"),
    ...codeTransportLifecycleIdentitySchema.shape,
    transportId: z.string().uuid(),
  })
  .strict();

export const codeTransportRouteAuthorizeResultSchema = z
  .object({
    ...codeTransportLifecycleIdentitySchema.shape,
    transportId: z.string().uuid(),
    attachmentId: z.string().uuid(),
    sessionId: z.string().uuid(),
    sessionIncarnationId: z.string().uuid(),
    authorized: z.literal(true),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const codeTransportRouteRevokeResultSchema = z
  .object({
    ...codeTransportLifecycleIdentitySchema.shape,
    transportId: z.string().uuid(),
    attachmentId: z.string().uuid(),
    revoked: z.literal(true),
  })
  .strict();

export const codeTransportRevokeResultSchema = z
  .object({
    ...codeTransportLifecycleIdentitySchema.shape,
    transportId: z.string().uuid(),
    revoked: z.literal(true),
  })
  .strict();

export const projectShareAttachmentSchema = z.object({
  attachmentId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  protocol: z.literal("webdav"),
  url: z.url(),
  username: z.string().min(1).max(128),
  password: z.string().min(24).max(256),
  realm: z.string().min(1).max(200),
  expiresAt: z.string().datetime(),
  mountLeaseMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60_000),
});

export const PROJECT_SHARE_STATE_STALE_CODE = "project-share-state-stale";

export const projectShareTunnelCreateSchema = z
  .object({
    tunnelId: z.string().uuid(),
    workerId: tunnelResourceIdSchema,
    worktreeId: z.string().min(1).optional(),
    protectedRecord: protectedTunnelContentRecordSchema,
  })
  .strict()
  .refine(
    ({ tunnelId, protectedRecord }) =>
      tunnelId === protectedRecord.operationId || protectedRecord.revision > 1,
    {
      message:
        "A new project share must bind its tunnel identity to its protected record.",
      path: ["protectedRecord", "operationId"],
    },
  );

export const projectShareDirectCreateSchema = z
  .object({
    clientId: tunnelResourceIdSchema,
  })
  .strict();

export const projectShareAttachmentWireSchema = z
  .object({
    attachmentId: tunnelResourceIdSchema,
    projectId: tunnelResourceIdSchema,
    protocol: z.literal("webdav"),
    tunnelId: tunnelResourceIdSchema,
    expiresAt: z.string().datetime(),
    mountLeaseMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60_000),
  })
  .strict();

export const standaloneChatShareAttachmentSchema = z.object({
  attachmentId: z.string().min(1).max(200),
  chatId: z.string().uuid(),
  protocol: z.literal("webdav"),
  url: z.url(),
  username: z.string().min(1).max(128),
  password: z.string().min(24).max(256),
  realm: z.string().min(1).max(200),
  expiresAt: z.string().datetime(),
  mountLeaseMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60_000),
});

export const standaloneChatShareAttachmentWireSchema = z
  .object({
    attachmentId: tunnelResourceIdSchema,
    chatId: z.string().uuid(),
    protocol: z.literal("webdav"),
    tunnelId: tunnelResourceIdSchema,
    expiresAt: z.string().datetime(),
    mountLeaseMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60_000),
  })
  .strict();

export const projectSharePublicBasePathSchema = z
  .string()
  .regex(/^\/project-shares\/[A-Za-z0-9_-]{43}$/u);

export const projectSharePublicOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === value
  );
});

export const codeAttachmentCreateSchema = z.object({
  appearance: codeAppearanceSchema.default("dark"),
  expectedWorkerId: executionResourceIdSchema,
  expectedWorktreeId: executionResourceIdSchema,
});

export const codeProtectedAttachmentCreateSchema = codeAttachmentCreateSchema
  .extend({
    tunnelId: z.string().uuid(),
    sessionId: z.string().uuid(),
    protectedRecord: protectedTunnelContentRecordSchema,
  })
  .strict()
  .refine(
    ({ tunnelId, protectedRecord }) =>
      tunnelId === protectedRecord.operationId &&
      protectedRecord.revision === 1,
    {
      message:
        "A protected Code attachment must begin with its tunnel-bound record.",
      path: ["protectedRecord"],
    },
  );

export const codeSessionAttachmentCreateSchema = codeAttachmentCreateSchema
  .extend({
    formatVersion: z.literal(2),
    attachmentId: z.string().uuid(),
    sessionId: z.string().uuid(),
    transport: codeTransportCandidateSchema,
  })
  .strict();

export const explorerCodeSessionAttachmentCreateSchema =
  codeSessionAttachmentCreateSchema.extend({
    path: repositoryRelativePathSchema.optional(),
  });

export const codeSettingsWorkbenchSessionAttachmentCreateSchema =
  codeSessionAttachmentCreateSchema.omit({ expectedWorktreeId: true });

export const codeSettingsWorkbenchSharedAttachmentWireSchema = z
  .object({
    workerId: executionResourceIdSchema,
    synchronization: codeSettingsWorkerStatusSchema,
    attachment: codeSharedAttachmentWireSchema,
  })
  .strict();

export const explorerCodeProtectedAttachmentCreateSchema =
  codeProtectedAttachmentCreateSchema.extend({
    path: repositoryRelativePathSchema.optional(),
  });

export const codeSettingsWorkbenchAttachmentCreateSchema =
  codeAttachmentCreateSchema
    .omit({ expectedWorktreeId: true })
    .extend({
      tunnelId: z.string().uuid(),
      sessionId: z.string().uuid(),
      protectedRecord: protectedTunnelContentRecordSchema,
    })
    .strict()
    .refine(
      ({ tunnelId, protectedRecord }) =>
        tunnelId === protectedRecord.operationId &&
        protectedRecord.revision === 1,
      {
        message:
          "A protected Code settings attachment must begin with its tunnel-bound record.",
        path: ["protectedRecord"],
      },
    );

export const codeSettingsWorkbenchAttachmentWireSchema = z
  .object({
    workerId: executionResourceIdSchema,
    synchronization: codeSettingsWorkerStatusSchema,
    attachment: codeProtectedAttachmentWireSchema,
  })
  .strict();

export const explorerCodeAttachmentCreateSchema = codeAttachmentCreateSchema
  .extend({
    path: repositoryRelativePathSchema,
  })
  .strict();

export const codeOpenFileResultSchema = z
  .object({
    relativePath: repositoryRelativePathSchema,
  })
  .strict();

export const codeOpenFileRequestSchema = codeOpenFileResultSchema;

export const codeOpenSettingsRequestSchema = z.object({}).strict();

export const codeOpenSettingsResultSchema = z
  .object({ opened: z.literal(true) })
  .strict();

export const codeOpenExtensionsRequestSchema = z.object({}).strict();

export const codeOpenExtensionsResultSchema = z
  .object({ opened: z.literal(true) })
  .strict();

export const codeInstallVsixResultSchema = z
  .object({ installed: z.literal(true) })
  .strict();

export const codePresentationUpdateSchema = z
  .object({
    presentation: codePresentationSchema,
  })
  .strict();

export const codeThemeUpdateSchema = z.object({
  themeMode: codeThemeModeSchema,
  appearance: codeAppearanceSchema,
});

export function isForwardableCodeWebSocketCloseCode(code: number): boolean {
  return (
    (code >= 1_000 &&
      code <= 1_014 &&
      code !== 1_004 &&
      code !== 1_005 &&
      code !== 1_006) ||
    (code >= 3_000 && code <= 4_999)
  );
}

export const CODE_MAX_WEBSOCKET_MESSAGE_BYTES = 4 * 1_024 * 1_024;

export type CodeThemeMode = z.infer<typeof codeThemeModeSchema>;
export type CodePresentation = z.infer<typeof codePresentationSchema>;
export type CodeAppearance = z.infer<typeof codeAppearanceSchema>;
export type CodeTabStatus = z.infer<typeof codeTabStatusSchema>;
export type CodeSessionStatus = z.infer<typeof codeSessionStatusSchema>;
export type CodeTabCreate = z.infer<typeof codeTabCreateSchema>;
export type EncryptedCodeTabCreate = z.infer<
  typeof encryptedCodeTabCreateSchema
>;
export type CodeTabUpdate = z.infer<typeof codeTabUpdateSchema>;
export type EncryptedCodeTabUpdate = z.infer<
  typeof encryptedCodeTabUpdateSchema
>;
export type CodeTabSummary = z.infer<typeof codeTabSummarySchema>;
export type CodeTabWireSummary = z.infer<typeof codeTabWireSummarySchema>;
export type CodeEditorBuild = z.infer<typeof codeEditorBuildSchema>;
export type CodeProbeResult = z.infer<typeof codeProbeResultSchema>;
export type CodeSessionSummary = z.infer<typeof codeSessionSummarySchema>;
export type CodeDirtyEditor = z.infer<typeof codeDirtyEditorSchema>;
export type CodeSaveBeforeAgentTurn = z.infer<
  typeof codeSaveBeforeAgentTurnSchema
>;
export type CodeWorkbenchState = z.infer<typeof codeWorkbenchStateSchema>;
export type CodeRuntimeStatus = z.infer<typeof codeRuntimeStatusSchema>;
export type CodeSaveAllResult = z.infer<typeof codeSaveAllResultSchema>;
export type CodeAgentTurnPreparationResult = z.infer<
  typeof codeAgentTurnPreparationResultSchema
>;
export type CodeAgentTurnNotificationResult = z.infer<
  typeof codeAgentTurnNotificationResultSchema
>;
export type CodeAttachment = z.infer<typeof codeAttachmentSchema>;
export type CodeAttachmentCreate = z.infer<typeof codeAttachmentCreateSchema>;
export type CodeProtectedAttachmentWire = z.infer<
  typeof codeProtectedAttachmentWireSchema
>;
export type CodeProtectedAttachmentIntent = z.infer<
  typeof codeProtectedAttachmentIntentSchema
>;
export type CodeProtectedAttachmentCreate = z.infer<
  typeof codeProtectedAttachmentCreateSchema
>;
export type CodeTransportCandidate = z.infer<
  typeof codeTransportCandidateSchema
>;
export type CodeTransportWire = z.infer<typeof codeTransportWireSchema>;
export type CodeSessionAttachmentCreate = z.infer<
  typeof codeSessionAttachmentCreateSchema
>;
export type ExplorerCodeSessionAttachmentCreate = z.infer<
  typeof explorerCodeSessionAttachmentCreateSchema
>;
export type CodeSettingsWorkbenchSessionAttachmentCreate = z.infer<
  typeof codeSettingsWorkbenchSessionAttachmentCreateSchema
>;
export type CodeSessionAttachmentWire = z.infer<
  typeof codeSessionAttachmentWireSchema
>;
export type CodeSharedAttachmentWire = z.infer<
  typeof codeSharedAttachmentWireSchema
>;
export type CodeSettingsWorkbenchSharedAttachmentWire = z.infer<
  typeof codeSettingsWorkbenchSharedAttachmentWireSchema
>;
export type CodeTransportRouteAuthorizeCommand = z.infer<
  typeof codeTransportRouteAuthorizeCommandSchema
>;
export type CodeTransportRouteRevokeCommand = z.infer<
  typeof codeTransportRouteRevokeCommandSchema
>;
export type CodeTransportRevokeCommand = z.infer<
  typeof codeTransportRevokeCommandSchema
>;
export type CodeTransportRouteAuthorizeResult = z.infer<
  typeof codeTransportRouteAuthorizeResultSchema
>;
export type CodeTransportRouteRevokeResult = z.infer<
  typeof codeTransportRouteRevokeResultSchema
>;
export type CodeTransportRevokeResult = z.infer<
  typeof codeTransportRevokeResultSchema
>;
export type CodeSettingsWorkbenchAttachmentCreate = z.infer<
  typeof codeSettingsWorkbenchAttachmentCreateSchema
>;
export type CodeSettingsWorkbenchAttachmentWire = z.infer<
  typeof codeSettingsWorkbenchAttachmentWireSchema
>;
export type ExplorerCodeAttachmentCreate = z.infer<
  typeof explorerCodeAttachmentCreateSchema
>;
export type ExplorerCodeProtectedAttachmentCreate = z.infer<
  typeof explorerCodeProtectedAttachmentCreateSchema
>;
export type CodeOpenFileResult = z.infer<typeof codeOpenFileResultSchema>;
export type CodeOpenFileRequest = z.infer<typeof codeOpenFileRequestSchema>;
export type CodeOpenSettingsResult = z.infer<
  typeof codeOpenSettingsResultSchema
>;
export type CodeOpenExtensionsResult = z.infer<
  typeof codeOpenExtensionsResultSchema
>;
export type CodeInstallVsixResult = z.infer<typeof codeInstallVsixResultSchema>;
export type CodeSettingsWorkbenchOpenResult = z.infer<
  typeof codeSettingsWorkbenchOpenResultSchema
>;
export type CodePresentationUpdate = z.infer<
  typeof codePresentationUpdateSchema
>;
export type CodeThemeUpdate = z.infer<typeof codeThemeUpdateSchema>;
export type ProjectShareAttachment = z.infer<
  typeof projectShareAttachmentSchema
>;
export type ProjectShareAttachmentWire = z.infer<
  typeof projectShareAttachmentWireSchema
>;
export type StandaloneChatShareAttachment = z.infer<
  typeof standaloneChatShareAttachmentSchema
>;
export type StandaloneChatShareAttachmentWire = z.infer<
  typeof standaloneChatShareAttachmentWireSchema
>;
