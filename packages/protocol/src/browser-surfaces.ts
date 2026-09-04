import { z } from "zod";
import { protectedTunnelContentRecordSchema } from "./tunnel-content.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { browserPrivateStateOpaqueSchema } from "./surface-private-state.js";
import {
  executionPlacementSchema,
  executionTargetSchema,
} from "./execution-targets.js";
import {
  hasUnambiguousProjectPaneDestination,
  projectPaneDestinationShape,
} from "./project-pane-identifiers.js";

export const browserHttpUrlSchema = z
  .string()
  .url()
  .max(4_096)
  .refine((value) => /^https?:\/\//u.test(value), {
    message: "Browser URLs must use HTTP or HTTPS.",
  });

const browserCreateBaseSchema = z.object({
  ...projectPaneDestinationShape,
  target: executionTargetSchema.optional(),
});

export const browserCreateSchema = browserCreateBaseSchema
  .extend({
    title: z.string().trim().min(1).max(200).default("Browser"),
    url: browserHttpUrlSchema.optional(),
  })
  .strict()
  .refine(hasUnambiguousProjectPaneDestination, {
    message:
      "Specify only one of paneId, the deprecated tabGroupId, or targetRegion.",
    path: ["paneId"],
  });

export const encryptedBrowserCreateSchema = browserCreateBaseSchema
  .extend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: browserPrivateStateOpaqueSchema,
  })
  .strict()
  .refine(hasUnambiguousProjectPaneDestination, {
    message:
      "Specify only one of paneId, the deprecated tabGroupId, or targetRegion.",
    path: ["paneId"],
  })
  .refine(
    (input) => input.titleProtection.classification.recordKind === "browser",
    {
      message: "Browser title classification must be browser.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const browserUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    url: browserHttpUrlSchema.optional(),
  })
  .refine((input) => input.title !== undefined || input.url !== undefined, {
    message: "At least one browser field is required.",
  });

export const encryptedBrowserUpdateSchema = z
  .object({
    titleProtection: privateDisplayLabelOpaqueSchema.optional(),
    expectedStateRevision: z.number().int().positive().safe().optional(),
    stateProtection: browserPrivateStateOpaqueSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.titleProtection === undefined &&
      input.stateProtection === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "At least one browser field is required.",
      });
    }
    if (
      (input.stateProtection === undefined) !==
      (input.expectedStateRevision === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Browser state updates require an expected revision.",
        path: ["expectedStateRevision"],
      });
    }
    if (
      input.titleProtection &&
      input.titleProtection.classification.recordKind !== "browser"
    ) {
      context.addIssue({
        code: "custom",
        message: "Browser title classification must be browser.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

const browserSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  stateRevision: z.number().int().positive().safe(),
  workerId: z.string().min(1).nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const browserSummarySchema = browserSummaryBaseSchema.extend({
  title: z.string().min(1).max(200),
  url: browserHttpUrlSchema,
});

export const browserWireSummarySchema = browserSummaryBaseSchema
  .extend({
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: browserPrivateStateOpaqueSchema,
  })
  .refine(
    (browser) =>
      browser.titleProtection.classification.recordKind === "browser",
    {
      message: "Browser title classification must be browser.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const browserListSchema = z.array(browserSummarySchema);
export const browserWireListSchema = z.array(browserWireSummarySchema);

export const browserServiceProtocolSchema = z.enum(["http", "https"]);

export const browserServiceSchema = z.object({
  workerId: z.string().min(1).max(200),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  protocol: browserServiceProtocolSchema,
  url: z
    .string()
    .url()
    .max(4_096)
    .refine((value) => /^https?:\/\//u.test(value), {
      message: "Browser service URLs must use HTTP or HTTPS.",
    }),
  title: z.string().trim().min(1).max(200).nullable(),
  processName: z.string().trim().min(1).max(200).nullable(),
  statusCode: z.number().int().min(100).max(599),
});

export const browserServiceListSchema = z.array(browserServiceSchema).max(128);

export const browserFleetServiceSchema = browserServiceSchema.extend({
  workerName: z.string().min(1).max(200),
  placement: executionPlacementSchema,
});

export const browserServiceDiscoveryWorkerStatusSchema = z.enum([
  "ok",
  "offline",
  "timed-out",
  "error",
]);

export const browserServiceDiscoveryErrorSchema = z.object({
  code: z.enum(["worker-offline", "worker-timeout", "worker-error"]),
  message: z.string().min(1).max(1_000),
});

export const browserServiceDiscoveryWorkerResultSchema = z.object({
  workerId: z.string().min(1).max(200),
  workerName: z.string().min(1).max(200),
  status: browserServiceDiscoveryWorkerStatusSchema,
  services: z.array(browserFleetServiceSchema).max(128),
  error: browserServiceDiscoveryErrorSchema.nullable(),
  truncated: z.boolean().default(false),
});

export const browserServiceFleetDiscoverySchema = z.object({
  projectId: z.string().min(1),
  observedAt: z.string().datetime(),
  partial: z.boolean(),
  truncated: z.boolean().default(false),
  workers: z.array(browserServiceDiscoveryWorkerResultSchema).max(64),
});

export const browserTunnelRequestSchema = z
  .object({
    protocol: z.enum(["http", "https"]),
    host: z.enum(["127.0.0.1", "localhost", "::1"]),
    port: z.number().int().min(1).max(65_535),
    workerId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const browserTunnelWireRequestSchema = z
  .object({
    tunnelId: z.string().uuid(),
    protocolHint: z.enum(["http-websocket", "https-websocket"]),
    workerId: z.string().min(1).max(200),
    resetAttachments: z.boolean().default(false),
    protectedRecord: protectedTunnelContentRecordSchema,
  })
  .strict();

export type BrowserCreate = z.infer<typeof browserCreateSchema>;
export type EncryptedBrowserCreate = z.infer<
  typeof encryptedBrowserCreateSchema
>;
export type BrowserUpdate = z.infer<typeof browserUpdateSchema>;
export type EncryptedBrowserUpdate = z.infer<
  typeof encryptedBrowserUpdateSchema
>;
export type BrowserSummary = z.infer<typeof browserSummarySchema>;
export type BrowserWireSummary = z.infer<typeof browserWireSummarySchema>;
export type BrowserServiceProtocol = z.infer<
  typeof browserServiceProtocolSchema
>;
export type BrowserService = z.infer<typeof browserServiceSchema>;
export type BrowserFleetService = z.infer<typeof browserFleetServiceSchema>;
export type BrowserServiceDiscoveryWorkerStatus = z.infer<
  typeof browserServiceDiscoveryWorkerStatusSchema
>;
export type BrowserServiceDiscoveryWorkerResult = z.infer<
  typeof browserServiceDiscoveryWorkerResultSchema
>;
export type BrowserServiceFleetDiscovery = z.infer<
  typeof browserServiceFleetDiscoverySchema
>;
export type BrowserTunnelRequest = z.infer<typeof browserTunnelRequestSchema>;
export type BrowserTunnelWireRequest = z.infer<
  typeof browserTunnelWireRequestSchema
>;
