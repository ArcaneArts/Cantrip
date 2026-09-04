import { z } from "zod";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import {
  remoteDesktopPrivateInventoryOpaqueSchema,
  remoteDesktopPrivateStateOpaqueSchema,
} from "./surface-private-state.js";
import { remoteSurfaceStatusSchema } from "./runtime-capabilities.js";
import { executionTargetSchema } from "./execution-targets.js";
import {
  hasUnambiguousProjectPaneDestination,
  projectPaneDestinationShape,
} from "./project-pane-identifiers.js";

export const remoteDesktopTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("monitor"),
    id: z.string().min(1).max(200).nullable().default(null),
    name: z.string().trim().min(1).max(500).nullable().default(null),
  }),
  z.object({
    kind: z.literal("window"),
    id: z.string().min(1).max(200).nullable().default(null),
    application: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(1_000).nullable().default(null),
  }),
]);

const remoteDesktopCreateBaseSchema = z.object({
  ...projectPaneDestinationShape,
  target: executionTargetSchema.optional(),
});

export const remoteDesktopCreateSchema = remoteDesktopCreateBaseSchema
  .strict()
  .refine(hasUnambiguousProjectPaneDestination, {
    message:
      "Specify only one of paneId, the deprecated tabGroupId, or targetRegion.",
    path: ["paneId"],
  });

export const encryptedRemoteDesktopCreateSchema = remoteDesktopCreateBaseSchema
  .extend({
    id: z.string().uuid(),
    stateProtection: remoteDesktopPrivateStateOpaqueSchema,
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine(hasUnambiguousProjectPaneDestination, {
    message:
      "Specify only one of paneId, the deprecated tabGroupId, or targetRegion.",
    path: ["paneId"],
  })
  .refine(
    (input) =>
      input.titleProtection.classification.recordKind === "project-view",
    {
      message: "Remote Desktop title classification must be project-view.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const remoteDesktopMonitorSchema = z.object({
  kind: z.literal("monitor"),
  id: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(500),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  primary: z.boolean(),
});

export const remoteDesktopApplicationIconKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9:_-]+$/u);

export const remoteDesktopWindowSchema = z.object({
  kind: z.literal("window"),
  id: z.string().min(1).max(200),
  application: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(1_000),
  iconKey: remoteDesktopApplicationIconKeySchema.nullable().default(null),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  minimized: z.boolean(),
  focused: z.boolean(),
});

export const remoteDesktopTargetInventorySchema = z.object({
  monitors: z.array(remoteDesktopMonitorSchema).max(64),
  windows: z.array(remoteDesktopWindowSchema).max(2_000),
});

export const encryptedRemoteDesktopUpdateSchema = z
  .object({
    expectedStateRevision: z.number().int().positive().safe(),
    stateProtection: remoteDesktopPrivateStateOpaqueSchema,
  })
  .strict();

const remoteDesktopSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  workerId: z.string().min(1),
  stateRevision: z.number().int().positive().safe(),
  status: remoteSurfaceStatusSchema,
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const remoteDesktopSummarySchema = remoteDesktopSummaryBaseSchema.extend(
  {
    title: z.string().min(1).max(200),
    target: remoteDesktopTargetSchema,
  },
);

export const remoteDesktopWireSummarySchema = remoteDesktopSummaryBaseSchema
  .extend({
    stateProtection: remoteDesktopPrivateStateOpaqueSchema,
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .superRefine((desktop, context) => {
    if (desktop.titleProtection.classification.recordKind !== "project-view") {
      context.addIssue({
        code: "custom",
        message: "Remote Desktop title classification must be project-view.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

export const remoteDesktopListSchema = z.array(remoteDesktopSummarySchema);
export const remoteDesktopWireListSchema = z.array(
  remoteDesktopWireSummarySchema,
);

export const remoteDesktopFleetWorkerStatusSchema = z.enum([
  "ok",
  "offline",
  "timed-out",
  "error",
]);

export const remoteDesktopFleetErrorSchema = z.object({
  code: z.enum(["worker-offline", "worker-timeout", "worker-error"]),
  message: z.string().min(1).max(1_000),
});

export const remoteDesktopFleetWorkerSchema = z.object({
  workerId: z.string().min(1).max(200),
  workerName: z.string().min(1).max(200),
  platform: z.string().min(1).max(100),
  architecture: z.string().min(1).max(100),
  status: remoteDesktopFleetWorkerStatusSchema,
  inventory: remoteDesktopTargetInventorySchema,
  desktops: z.array(remoteDesktopSummarySchema).max(64),
  error: remoteDesktopFleetErrorSchema.nullable(),
  truncated: z.boolean().default(false),
});

export const remoteDesktopProtectedInventorySchema = z
  .object({
    operationId: z.string().uuid(),
    stateProtection: remoteDesktopPrivateInventoryOpaqueSchema,
    monitorCount: z.number().int().nonnegative().max(64),
    windowCount: z.number().int().nonnegative().max(2_000),
    truncated: z.boolean().default(false),
  })
  .strict();

export const remoteDesktopFleetWireWorkerSchema = remoteDesktopFleetWorkerSchema
  .omit({ inventory: true })
  .extend({
    inventoryOperationId: z.string().uuid().nullable(),
    inventoryProtection: remoteDesktopPrivateInventoryOpaqueSchema.nullable(),
    monitorCount: z.number().int().nonnegative().max(64),
    windowCount: z.number().int().nonnegative().max(2_000),
    desktops: z.array(remoteDesktopWireSummarySchema).max(64),
  })
  .strict()
  .superRefine((worker, context) => {
    if (
      (worker.status === "ok") !==
      (worker.inventoryOperationId !== null &&
        worker.inventoryProtection !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Available Remote Desktop workers require protected inventory.",
        path: ["inventoryProtection"],
      });
    }
  });

export const remoteDesktopFleetSchema = z.object({
  projectId: z.string().min(1),
  observedAt: z.string().datetime(),
  partial: z.boolean(),
  truncated: z.boolean().default(false),
  workers: z.array(remoteDesktopFleetWorkerSchema).max(64),
});

export const remoteDesktopFleetWireSchema = remoteDesktopFleetSchema
  .extend({
    workers: z.array(remoteDesktopFleetWireWorkerSchema).max(64),
  })
  .strict();

export type RemoteDesktopCreate = z.infer<typeof remoteDesktopCreateSchema>;
export type EncryptedRemoteDesktopCreate = z.infer<
  typeof encryptedRemoteDesktopCreateSchema
>;
export type RemoteDesktopTarget = z.infer<typeof remoteDesktopTargetSchema>;
export type RemoteDesktopMonitor = z.infer<typeof remoteDesktopMonitorSchema>;
export type RemoteDesktopWindow = z.infer<typeof remoteDesktopWindowSchema>;
export type RemoteDesktopTargetInventory = z.infer<
  typeof remoteDesktopTargetInventorySchema
>;
export type EncryptedRemoteDesktopUpdate = z.infer<
  typeof encryptedRemoteDesktopUpdateSchema
>;
export type RemoteDesktopSummary = z.infer<typeof remoteDesktopSummarySchema>;
export type RemoteDesktopWireSummary = z.infer<
  typeof remoteDesktopWireSummarySchema
>;
export type RemoteDesktopFleetWorkerStatus = z.infer<
  typeof remoteDesktopFleetWorkerStatusSchema
>;
export type RemoteDesktopFleetWorker = z.infer<
  typeof remoteDesktopFleetWorkerSchema
>;
export type RemoteDesktopProtectedInventory = z.infer<
  typeof remoteDesktopProtectedInventorySchema
>;
export type RemoteDesktopFleetWireWorker = z.infer<
  typeof remoteDesktopFleetWireWorkerSchema
>;
export type RemoteDesktopFleet = z.infer<typeof remoteDesktopFleetSchema>;
export type RemoteDesktopFleetWire = z.infer<
  typeof remoteDesktopFleetWireSchema
>;
