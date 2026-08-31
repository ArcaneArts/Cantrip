import { z } from "zod";
import { surfaceStreamWireRequestSchema } from "./surface-stream.js";
import { modelProviderKindSchema } from "./providers.js";
import { projectRootKindSchema } from "./project-foundation.js";
import { repositoryRelativePathSchema } from "./repository-paths.js";
import {
  codeThemeModeSchema,
  codePresentationSchema,
  codeAppearanceSchema,
  codeTransportRouteAuthorizeCommandSchema,
  codeTransportRouteRevokeCommandSchema,
  codeTransportRevokeCommandSchema,
} from "./code-surfaces.js";
import {
  worktreeCreateModeSchema,
  worktreeObservationTargetsSchema,
  codeGraphObservationTargetsSchema,
} from "./worker-worktrees.js";
import {
  workerRuntimeModelSchema,
  workerRuntimeProviderSchema,
} from "./worker-runtime-support.js";
import {
  customizationWorkerContentFields,
  protectedCustomizationWorkerRequestFields,
} from "./worker-command-shared.js";

export const workerWorktreeCodeCommandSchemas = [
  z.object({
    type: z.literal("worktree.list"),
    sourcePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.reconcile"),
    sourcePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.create"),
    sourcePath: z.string().min(1),
    worktreeId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    mode: worktreeCreateModeSchema,
  }),
  z.object({
    type: z.literal("worktree.remove"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
    force: z.boolean().default(false),
    allowExternal: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("worktree.lock"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
    reason: z.string().trim().min(1).max(1_000).nullable().default(null),
  }),
  z.object({
    type: z.literal("worktree.unlock"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.prune"),
    sourcePath: z.string().min(1),
    allowExternal: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("worktree.status"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.observation.configure"),
    targets: worktreeObservationTargetsSchema,
    codegraphTargets: codeGraphObservationTargetsSchema.optional(),
  }),
  z.object({
    type: z.literal("codegraph.status"),
    projectId: z.string().uuid(),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema.optional(),
    sourcePath: z.string().min(1).max(8_192).optional(),
    worktreePath: z.string().min(1).max(8_192).optional(),
  }),
  z.object({
    type: z.literal("codegraph.sync"),
    projectId: z.string().uuid(),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema.optional(),
    sourcePath: z.string().min(1).max(8_192).optional(),
    worktreePath: z.string().min(1).max(8_192).optional(),
  }),
  z.object({
    type: z.literal("codegraph.rebuild"),
    projectId: z.string().uuid(),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema.optional(),
    sourcePath: z.string().min(1).max(8_192).optional(),
    worktreePath: z.string().min(1).max(8_192).optional(),
  }),
  z.object({ type: z.literal("codegraph.update.check") }),
  z
    .object({
      type: z.literal("explorer.operation"),
      explorerId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(2_000),
      root: z.string().min(1),
    })
    .extend(surfaceStreamWireRequestSchema.shape)
    .strict(),
  z.object({ type: z.literal("code.probe") }),
  codeTransportRouteAuthorizeCommandSchema,
  codeTransportRouteRevokeCommandSchema,
  codeTransportRevokeCommandSchema,
  z.object({
    type: z.literal("code.settings.workbench.open"),
    sessionId: z.string().uuid(),
    profileId: z.string().min(1).max(200),
    appearance: codeAppearanceSchema,
  }),
  z.object({
    type: z.literal("code.open"),
    sessionId: z.string().min(1),
    codeTabId: z.string().min(1),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    worktreeName: z.string().trim().min(1).max(200).optional(),
    cwd: z.string().min(1),
    profileId: z.string().min(1).max(200),
    initialFile: repositoryRelativePathSchema.optional(),
    themeMode: codeThemeModeSchema,
    appearance: codeAppearanceSchema,
    presentation: codePresentationSchema.default("workbench"),
  }),
  z.object({
    type: z.literal("code.status"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.stop"),
    sessionId: z.string().min(1),
    expectedSessionIncarnationId: z.string().uuid().optional(),
  }),
  z.object({
    type: z.literal("code.endpoint.revoke"),
    tunnelId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("code.saveAll"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.openFile"),
    sessionId: z.string().min(1),
    path: repositoryRelativePathSchema,
  }),
  z.object({
    type: z.literal("code.getDirtyEditors"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.setTheme"),
    sessionId: z.string().min(1),
    themeMode: codeThemeModeSchema,
    appearance: codeAppearanceSchema,
  }),
  z.object({
    type: z.literal("code.prepareAgentTurn"),
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.agentTurnState"),
    cwd: z.string().min(1),
    phase: z.enum(["started", "completed", "failed"]),
    paths: z.array(z.string().min(1).max(8_192)).max(5_000).default([]),
  }),
  z.object({
    type: z.literal("skills.list"),
    ...customizationWorkerContentFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("skills.settings.list"),
    ...customizationWorkerContentFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
    model: workerRuntimeModelSchema.optional(),
    provider: workerRuntimeProviderSchema.optional(),
  }),
  z.object({
    type: z.literal("skills.settings.read"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
  }),
  z.object({
    type: z.literal("skills.settings.write"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
  }),
  z.object({
    type: z.literal("skills.settings.delete"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
  }),
  z.object({
    type: z.literal("skills.settings.configure"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.inventory.read"),
    ...customizationWorkerContentFields,
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    forceReload: z.boolean().default(false),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.external.preview"),
    ...customizationWorkerContentFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.resource.read"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.skill.configure"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.skill-roots.set"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.oauth.start"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.oauth.status"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.reload"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.external.apply"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.external.status"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
] as const;
