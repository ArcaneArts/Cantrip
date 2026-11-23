import { z } from "zod";
import { projectSourceKindSchema } from "./project-foundation.js";
import { projectWorktreeSummarySchema } from "./worktrees.js";

const id = z.string().min(1).max(200);

/** Linux paths are explicitly guest addresses, never worker-local paths. */
export const cantripOsGuestPathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), {
    message: "Expected an absolute Linux guest path.",
  });

export const projectSourceLocationSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("worker-local"), workerPath: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("cantrip-os"),
      instanceId: id,
      workspaceId: id,
      guestPath: cantripOsGuestPathSchema,
    })
    .strict(),
]);

/** Credentials remain files on the owning worker, not files in CantripOS. */
export const cantripOsTransportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("docker"), container: id }).strict(),
  z
    .object({
      kind: z.literal("ssh"),
      host: z.string().min(1).max(1_000),
      port: z.number().int().min(1).max(65_535),
      user: id,
      identityFile: z.string().min(1),
      knownHostsFile: z.string().min(1),
    })
    .strict(),
]);

export const cantripOsDependencyOverlaySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4_000)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\0") &&
          path
            .split("/")
            .every((part) => part !== "" && part !== "." && part !== "..") &&
          path.split("/")[0] !== ".git",
        {
          message:
            "Expected a checkout-relative dependency directory outside .git.",
        },
      ),
  })
  .strict();

export const cantripOsDependencyOverlaysSchema = z
  .array(cantripOsDependencyOverlaySchema)
  .max(32)
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.path)).size === entries.length,
    { message: "A dependency directory may have only one overlay." },
  );

export const cantripOsAttachSchema = z
  .object({
    workerId: id,
    guestInstanceId: z.uuid(),
    name: z.string().min(1).max(200),
    transport: cantripOsTransportSchema,
    expectedAttachmentGeneration: id.nullable(),
  })
  .strict();

/** Worker receipts, never user-provided account creation parameters. */
export const cantripOsWorkspaceObservationSchema = z
  .object({
    guestWorkspaceId: id,
    uid: z.number().int().positive(),
    gid: z.number().int().positive(),
    homeGuestPath: cantripOsGuestPathSchema,
  })
  .strict();

export const cantripOsInstanceSummarySchema = z.object({
  id,
  ownerId: id,
  workerId: id,
  guestInstanceId: z.uuid(),
  attachmentGeneration: id,
  name: z.string().min(1).max(200),
  status: z.enum(["connected", "disconnected", "unknown"]),
  runtimeGeneration: id.nullable(),
  lastError: z.string().max(4_000).nullable(),
  lastObservedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const cantripOsWorkspaceSummarySchema = z.object({
  id,
  instanceId: id,
  workerId: id,
  guestWorkspaceId: id,
  uid: z.number().int().positive(),
  gid: z.number().int().positive(),
  homeGuestPath: cantripOsGuestPathSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** A Linux-owned checkout has its own source ID, independent of branch names. */
export const cantripOsProjectSourceSummarySchema = z
  .object({
    id,
    projectId: id,
    workerId: id,
    sourceKind: projectSourceKindSchema,
    instanceId: id,
    workspaceId: id,
    guestPath: cantripOsGuestPathSchema,
    ownershipKind: z.enum(["cantrip", "user"]),
    repositoryFingerprint: id.nullable(),
    primaryWorktreeId: id.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const cantripOsProjectWorktreeSummarySchema =
  projectWorktreeSummarySchema
    .omit({ path: true })
    .extend({
      instanceId: id,
      workspaceId: id,
      guestPath: cantripOsGuestPathSchema,
    })
    .strict();

/** Execution placement is separate from physical checkout ownership. A linked
 * checkout keeps its worker-owned Git/source identity and can also run on Linux. */
export const cantripOsSourceBindingSummarySchema = z
  .object({
    id,
    ownerId: id,
    projectId: id,
    workerId: id,
    projectSourceId: id,
    worktreeId: id,
    instanceId: id,
    workspaceId: id,
    mode: z.enum(["linked", "linux-owned"]),
    linkedWorkerPath: z.string().min(1).nullable(),
    guestPath: cantripOsGuestPathSchema,
    bindingGeneration: id,
    provisionedAttachmentGeneration: id.nullable(),
    provisionedRuntimeGeneration: id.nullable(),
    state: z.enum(["provisioning", "ready", "failed", "unknown", "retired"]),
    lastError: z.string().max(4_000).nullable(),
    dependencyOverlays: cantripOsDependencyOverlaysSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ProjectSourceLocation = z.infer<typeof projectSourceLocationSchema>;
export type CantripOsTransport = z.infer<typeof cantripOsTransportSchema>;
export type CantripOsDependencyOverlay = z.infer<
  typeof cantripOsDependencyOverlaySchema
>;
export type CantripOsInstanceSummary = z.infer<
  typeof cantripOsInstanceSummarySchema
>;
export type CantripOsWorkspaceSummary = z.infer<
  typeof cantripOsWorkspaceSummarySchema
>;
export type CantripOsProjectSourceSummary = z.infer<
  typeof cantripOsProjectSourceSummarySchema
>;
export type CantripOsProjectWorktreeSummary = z.infer<
  typeof cantripOsProjectWorktreeSummarySchema
>;
export type CantripOsSourceBindingSummary = z.infer<
  typeof cantripOsSourceBindingSummarySchema
>;
