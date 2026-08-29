import { z } from "zod";

export const projectReplicaCapabilitiesSchema = z.object({
  provision: z.boolean(),
  synchronize: z.boolean(),
  remove: z.boolean(),
  exactRevision: z.boolean(),
  directPlacement: z.boolean().default(false),
  managedLinkPlacement: z.boolean().default(false),
  attachExisting: z.boolean().default(false),
  recursiveParentCreation: z.boolean().default(false),
});

export const unavailableProjectReplicaCapabilities =
  projectReplicaCapabilitiesSchema.parse({
    provision: false,
    synchronize: false,
    remove: false,
    exactRevision: false,
    directPlacement: false,
    managedLinkPlacement: false,
    attachExisting: false,
    recursiveParentCreation: false,
  });

export const managedFolderCapabilitiesSchema = z.object({
  create: z.boolean(),
  attachExisting: z.boolean().default(false),
  convertToGithub: z.boolean().default(false),
  remove: z.boolean(),
});

export const unavailableManagedFolderCapabilities =
  managedFolderCapabilitiesSchema.parse({
    create: false,
    attachExisting: false,
    convertToGithub: false,
    remove: false,
  });

export const standaloneChatScratchCapabilitiesSchema = z
  .object({
    provision: z.boolean(),
    resolve: z.boolean(),
    archive: z.boolean(),
    restore: z.boolean(),
    remove: z.boolean(),
    reconcile: z.boolean(),
    routingHandles: z.boolean(),
  })
  .strict();

export const standaloneChatFileCapabilitiesSchema = z
  .object({
    list: z.boolean(),
    read: z.boolean(),
    write: z.boolean(),
    remove: z.boolean(),
    download: z.boolean(),
    archive: z.boolean(),
    networkShare: z.boolean().default(false),
  })
  .strict();

export const standaloneChatCapabilitiesSchema = z
  .object({
    protocolVersion: z.number().int().positive(),
    scratch: standaloneChatScratchCapabilitiesSchema,
    files: standaloneChatFileCapabilitiesSchema,
  })
  .strict();

export const unavailableStandaloneChatCapabilities =
  standaloneChatCapabilitiesSchema.parse({
    protocolVersion: 1,
    scratch: {
      provision: false,
      resolve: false,
      archive: false,
      restore: false,
      remove: false,
      reconcile: false,
      routingHandles: false,
    },
    files: {
      list: false,
      read: false,
      write: false,
      remove: false,
      download: false,
      archive: false,
      networkShare: false,
    },
  });

export const codeGraphRuntimeStateSchema = z.enum([
  "checking",
  "degraded",
  "installing",
  "ready",
  "unavailable",
]);

export const codeGraphProjectStateSchema = z.enum([
  "degraded",
  "indexing",
  "queued",
  "ready",
  "syncing",
  "unavailable",
]);

export const codeGraphProjectCountsSchema = z.object({
  ready: z.number().int().nonnegative().max(128),
  indexing: z.number().int().nonnegative().max(128),
  queued: z.number().int().nonnegative().max(128),
  degraded: z.number().int().nonnegative().max(128),
});

export const codeGraphWorkerStatusSchema = z.object({
  supported: z.boolean(),
  available: z.boolean(),
  runtimeState: codeGraphRuntimeStateSchema,
  installedVersion: z.string().trim().min(1).max(100).nullable(),
  latestVersion: z.string().trim().min(1).max(100).nullable(),
  previousVersion: z.string().trim().min(1).max(100).nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  telemetryDisabled: z.boolean(),
  healthy: z.boolean(),
  statusMessage: z.string().max(1_000).nullable(),
  projectCounts: codeGraphProjectCountsSchema,
  cliAvailable: z.boolean(),
  mcpInjectionAvailable: z.boolean(),
});

export const unavailableCodeGraphWorkerStatus =
  codeGraphWorkerStatusSchema.parse({
    supported: false,
    available: false,
    runtimeState: "unavailable",
    installedVersion: null,
    latestVersion: null,
    previousVersion: null,
    lastCheckedAt: null,
    telemetryDisabled: false,
    healthy: false,
    statusMessage: "This worker has not reported CodeGraph capabilities.",
    projectCounts: { ready: 0, indexing: 0, queued: 0, degraded: 0 },
    cliAvailable: false,
    mcpInjectionAvailable: false,
  });

export const managedWebRuntimeComponentSchema = z.enum([
  "searxng",
  "playwright",
]);

export const managedWebRuntimePlatformSchema = z.enum([
  "darwin",
  "win32",
  "linux",
]);

export const managedWebRuntimeArchitectureSchema = z.enum(["arm64", "x64"]);

export const managedWebRuntimeArchiveFormatSchema = z.enum(["tar.gz", "zip"]);

const managedWebRuntimeRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/u.test(value) &&
      value
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    { message: "Managed runtime inventory paths must be safe relative paths." },
  );

export const managedWebRuntimeArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    component: managedWebRuntimeComponentSchema,
    version: z.string().trim().min(1).max(100),
    platform: managedWebRuntimePlatformSchema,
    architecture: managedWebRuntimeArchitectureSchema,
    archiveFormat: managedWebRuntimeArchiveFormatSchema,
    downloadUrl: z
      .url()
      .max(8_192)
      .refine((value) => value.startsWith("https://"), {
        message: "Managed web runtime artifacts must use HTTPS.",
      }),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u, {
      message: "Managed runtime signatures must be Ed25519 base64 values.",
    }),
    signingKeyId: z.string().trim().min(1).max(200),
    compressedBytes: z.number().int().positive().max(4_000_000_000),
    extractedBytes: z.number().int().positive().max(12_000_000_000),
    licenseManifest: managedWebRuntimeRelativePathSchema,
    sourceManifest: managedWebRuntimeRelativePathSchema,
    minimumOs: z.string().trim().min(1).max(200).optional(),
    minimumKernel: z.string().trim().min(1).max(200).optional(),
    minimumLibc: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const managedWebRuntimeReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.string().trim().min(1).max(100),
    publishedAt: z.iso.datetime(),
    artifacts: z.array(managedWebRuntimeArtifactSchema).min(1).max(12),
  })
  .strict()
  .superRefine((manifest, context) => {
    const targets = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      const target = `${artifact.component}:${artifact.platform}:${artifact.architecture}`;
      if (targets.has(target)) {
        context.addIssue({
          code: "custom",
          message: `Managed web runtime manifest contains duplicate target ${target}.`,
          path: ["artifacts", index],
        });
      }
      targets.add(target);
    }
  });

export const managedWebRuntimeStateSchema = z.enum([
  "checking",
  "installing",
  "updating",
  "ready",
  "degraded",
  "failed",
  "unsupported",
]);

export const managedWebRuntimeProgressPhaseSchema = z.enum([
  "manifest",
  "download",
  "verify",
  "extract",
  "inventory",
  "probe",
  "promote",
  "cleanup",
]);

export const managedWebRuntimeProgressSchema = z
  .object({
    phase: managedWebRuntimeProgressPhaseSchema,
    completedBytes: z.number().int().nonnegative().max(12_000_000_000),
    totalBytes: z.number().int().nonnegative().max(12_000_000_000),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (progress) =>
      progress.totalBytes === 0 ||
      progress.completedBytes <= progress.totalBytes,
    { message: "Managed web runtime progress cannot exceed its total." },
  );

export const managedWebRuntimeFailureCategorySchema = z.enum([
  "download",
  "integrity",
  "signature",
  "archive",
  "inventory",
  "health-check",
  "compatibility",
  "disk",
  "process",
  "unknown",
]);

export const managedWebRuntimeFailureSchema = z
  .object({
    category: managedWebRuntimeFailureCategorySchema,
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
    failedAt: z.iso.datetime(),
  })
  .strict();

export const managedWebRuntimeStatusSchema = z
  .object({
    component: managedWebRuntimeComponentSchema,
    supported: z.boolean(),
    state: managedWebRuntimeStateSchema,
    installedVersion: z.string().trim().min(1).max(100).nullable(),
    previousVersion: z.string().trim().min(1).max(100).nullable(),
    latestVersion: z.string().trim().min(1).max(100).nullable(),
    lastCheckedAt: z.iso.datetime().nullable(),
    progress: managedWebRuntimeProgressSchema.nullable(),
    failure: managedWebRuntimeFailureSchema.nullable(),
  })
  .strict();

export const managedWebRuntimeCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal(1),
    search: managedWebRuntimeStatusSchema,
    browser: managedWebRuntimeStatusSchema,
    staticReading: z.boolean(),
  })
  .strict()
  .superRefine((capabilities, context) => {
    if (capabilities.search.component !== "searxng") {
      context.addIssue({
        code: "custom",
        message: "Search runtime status must describe SearXNG.",
        path: ["search", "component"],
      });
    }
    if (capabilities.browser.component !== "playwright") {
      context.addIssue({
        code: "custom",
        message: "Browser runtime status must describe Playwright.",
        path: ["browser", "component"],
      });
    }
  });

export const managedWebRuntimeActionSchema = z.enum([
  "check-update",
  "retry",
  "reinstall",
  "clear-cache",
  "clear-profiles",
]);

export const managedWebRuntimeActionRequestSchema = z
  .object({
    component: managedWebRuntimeComponentSchema,
    action: managedWebRuntimeActionSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action === "clear-profiles" && input.component !== "playwright") {
      context.addIssue({
        code: "custom",
        message: "Only the managed browser runtime has persistent profiles.",
        path: ["component"],
      });
    }
  });

export const managedWebRuntimeActionResultSchema = z
  .object({
    accepted: z.literal(true),
    action: managedWebRuntimeActionSchema,
    component: managedWebRuntimeComponentSchema,
    status: managedWebRuntimeStatusSchema,
  })
  .strict();

export const unavailableManagedWebRuntimeCapabilities =
  managedWebRuntimeCapabilitiesSchema.parse({
    schemaVersion: 1,
    search: {
      component: "searxng",
      supported: false,
      state: "unsupported",
      installedVersion: null,
      previousVersion: null,
      latestVersion: null,
      lastCheckedAt: null,
      progress: null,
      failure: null,
    },
    browser: {
      component: "playwright",
      supported: false,
      state: "unsupported",
      installedVersion: null,
      previousVersion: null,
      latestVersion: null,
      lastCheckedAt: null,
      progress: null,
      failure: null,
    },
    staticReading: false,
  });

export const codeGraphJobSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["sync", "rebuild"]),
  state: z.enum(["queued", "running", "completed", "failed"]),
  requestedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const codeGraphProjectStatusSchema = z
  .object({
    projectId: z.string().uuid(),
    worktreeId: z.string().min(1).max(200),
    state: codeGraphProjectStateSchema,
    lastIndexedAt: z.iso.datetime().nullable(),
    lastSuccessfulSyncAt: z.iso.datetime().nullable(),
    fileCount: z.number().int().nonnegative().nullable(),
    nodeCount: z.number().int().nonnegative().nullable(),
    edgeCount: z.number().int().nonnegative().nullable(),
    pendingChanges: z.number().int().nonnegative().nullable(),
    statusMessage: z.string().max(1_000).nullable(),
    job: codeGraphJobSchema.nullable(),
  })
  .strict();

export const codeGraphActionAcknowledgementSchema = z.object({
  jobId: z.string().uuid(),
  action: z.enum(["sync", "rebuild", "update-check"]),
  acceptedAt: z.iso.datetime(),
  status: z.literal("queued"),
});

export type ProjectReplicaCapabilities = z.infer<
  typeof projectReplicaCapabilitiesSchema
>;

export type ManagedFolderCapabilities = z.infer<
  typeof managedFolderCapabilitiesSchema
>;

export type StandaloneChatScratchCapabilities = z.infer<
  typeof standaloneChatScratchCapabilitiesSchema
>;

export type StandaloneChatFileCapabilities = z.infer<
  typeof standaloneChatFileCapabilitiesSchema
>;

export type StandaloneChatCapabilities = z.infer<
  typeof standaloneChatCapabilitiesSchema
>;

export type CodeGraphWorkerStatus = z.infer<typeof codeGraphWorkerStatusSchema>;

export type ManagedWebRuntimeComponent = z.infer<
  typeof managedWebRuntimeComponentSchema
>;

export type ManagedWebRuntimeArtifact = z.infer<
  typeof managedWebRuntimeArtifactSchema
>;

export type ManagedWebRuntimeReleaseManifest = z.infer<
  typeof managedWebRuntimeReleaseManifestSchema
>;

export type ManagedWebRuntimeProgress = z.infer<
  typeof managedWebRuntimeProgressSchema
>;

export type ManagedWebRuntimeFailure = z.infer<
  typeof managedWebRuntimeFailureSchema
>;

export type ManagedWebRuntimeStatus = z.infer<
  typeof managedWebRuntimeStatusSchema
>;

export type ManagedWebRuntimeCapabilities = z.infer<
  typeof managedWebRuntimeCapabilitiesSchema
>;

export type ManagedWebRuntimeAction = z.infer<
  typeof managedWebRuntimeActionSchema
>;

export type ManagedWebRuntimeActionRequest = z.infer<
  typeof managedWebRuntimeActionRequestSchema
>;

export type ManagedWebRuntimeActionResult = z.infer<
  typeof managedWebRuntimeActionResultSchema
>;

export type CodeGraphProjectStatus = z.infer<
  typeof codeGraphProjectStatusSchema
>;

export type CodeGraphActionAcknowledgement = z.infer<
  typeof codeGraphActionAcknowledgementSchema
>;
