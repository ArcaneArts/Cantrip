import { z } from "zod";
import { projectPaneRegionSchema } from "./project-pane-identifiers.js";
import {
  projectCenterSplitEdgeSchema,
  projectCenterSplitFractionSchema,
  projectDockPresentationPreferenceSchema,
} from "./project-tabs.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { workspaceTabSchema } from "./workspace-ownership.js";

const id = z.string().min(1);
export const workspaceActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("prepare-return"),
      transferId: id,
      paneId: id,
      splitId: id,
    })
    .strict(),
  z
    .object({ type: z.literal("transfer-state-ready"), transferId: id })
    .strict(),
  z.object({ type: z.literal("commit-transfer"), transferId: id }).strict(),
  z
    .object({
      type: z.literal("prepare-detach"),
      transferId: id,
      paneId: id,
      tabId: id.optional(),
      destinationWindowId: id,
      destinationPaneId: id,
    })
    .strict(),
  z.object({ type: z.literal("transfer-ready"), transferId: id }).strict(),
  z.object({ type: z.literal("cancel-transfer"), transferId: id }).strict(),
  z.object({ type: z.literal("select"), tabId: id }).strict(),
  z.object({ type: z.literal("home") }).strict(),
  z.object({ type: z.literal("close-tab"), tabId: id }).strict(),
  z.object({ type: z.literal("close-pane"), paneId: id }).strict(),
  z.object({ type: z.literal("pin"), tabId: id }).strict(),
  z
    .object({
      type: z.literal("rename-pane"),
      paneId: id,
      titleProtection: privateDisplayLabelOpaqueSchema
        .refine(
          (label) => label.classification.recordKind === "tab-group",
          "Pane titles require tab-group classification.",
        )
        .nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("dock-presentation"),
      tabId: id,
      presentation: projectDockPresentationPreferenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("reorder-panes"),
      region: projectPaneRegionSchema,
      paneIds: z.array(id),
    })
    .strict(),
  z
    .object({
      type: z.literal("move-new-pane"),
      tabId: id,
      paneId: id,
      region: projectPaneRegionSchema,
      position: z.int().nonnegative(),
      splitId: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("reorder"),
      paneId: id,
      tabIds: z.array(id).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      tabId: id,
      targetPaneId: id,
      position: z.int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("split"),
      tabId: id,
      targetPaneId: id,
      paneId: id,
      splitId: id,
      edge: projectCenterSplitEdgeSchema,
      fraction: projectCenterSplitFractionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("resize"),
      splitId: id,
      fraction: projectCenterSplitFractionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("open"),
      tab: workspaceTabSchema,
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("pane"), paneId: id }).strict(),
        z
          .object({
            kind: z.literal("new-pane"),
            paneId: id,
            region: projectPaneRegionSchema,
            splitId: id,
          })
          .strict(),
      ]),
    })
    .strict(),
]);

/** Transport and optimistic execution use the same explicit operation identity. */
export const workspaceCommandSchema = z
  .object({
    operationId: id,
    workspaceId: id,
    projectId: id,
    windowId: id,
    attachmentGeneration: z.int().nonnegative(),
    expectedRevision: z.int().nonnegative(),
    action: workspaceActionSchema,
  })
  .strict();

export type WorkspaceAction = z.infer<typeof workspaceActionSchema>;
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
