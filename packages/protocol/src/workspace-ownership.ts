import { z } from "zod";
import { explorerFileModeSchema } from "./explorer-surfaces.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { projectPaneRegionSchema } from "./project-pane-identifiers.js";
import { projectSurfaceResourceRefSchema } from "./project-surfaces.js";
import {
  projectBuiltInSurfaceStateSchema,
  projectCenterLayoutNodeSchema,
  projectDockPresentationPreferenceSchema,
} from "./project-tabs.js";

const identity = z.string().min(1);

/** Stable import identity, retained after close to prevent legacy URL replay
 * from resurrecting a view. Document contents/paths never belong here. */
export const workspaceLegacyFileImportSchema = z
  .object({
    windowId: z.string().regex(/^cantrip-editor-.+/u),
    paneId: identity,
    views: z
      .array(
        z
          .object({
            tabId: identity,
            documentId: identity,
            mode: explorerFileModeSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

// Durable preparation only. Contents and runtime state must use protected
// surface handoff channels, never plaintext layout metadata.
const pendingTransferSchema = z
  .object({
    id: identity,
    sourceWindowId: identity,
    sourceGeneration: z.int().nonnegative(),
    sourcePaneId: identity,
    sourcePlacement: z
      .object({
        panePosition: z.int().nonnegative(),
        tabPosition: z.int().nonnegative(),
        viewKind: z.enum(["tab", "conversation"]).optional(),
        region: projectPaneRegionSchema,
        centerRoot: projectCenterLayoutNodeSchema.nullable(),
      })
      .strict(),
    tabIds: z.array(identity).min(1),
    wholePane: z.boolean(),
    destinationWindowId: identity,
    destinationGeneration: z.int().nonnegative(),
    destinationPaneId: identity,
    // Present only for a prepared return into the existing main window.
    returnSplitId: identity.optional(),
    phase: z.enum(["preparing", "destination-ready", "state-ready"]),
  })
  .strict();

/** A view identity is independent of the resource it displays. No plaintext content. */
export const workspaceTabSchema = z
  .object({
    id: identity,
    resource: projectSurfaceResourceRefSchema,
    preview: z.boolean(),
    // Non-content presentation preference, scoped to this view/device layout.
    fileMode: explorerFileModeSchema.optional(),
    titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
    builtInState: projectBuiltInSurfaceStateSchema.nullable(),
    dockPresentation: projectDockPresentationPreferenceSchema.nullable(),
  })
  .strict()
  .superRefine((tab, context) => {
    if (
      tab.fileMode !== undefined &&
      tab.resource.definitionId !== "project.file"
    ) {
      context.addIssue({
        code: "custom",
        path: ["fileMode"],
        message: "File mode requires a file view.",
      });
    }
    if (tab.resource.kind === "builtin") {
      if (tab.builtInState?.definitionId !== tab.resource.definitionId) {
        context.addIssue({
          code: "custom",
          path: ["builtInState"],
          message: "Built-in view state must match its resource.",
        });
      }
    } else if (tab.builtInState !== null) {
      context.addIssue({
        code: "custom",
        path: ["builtInState"],
        message: "Entity views cannot carry built-in state.",
      });
    }
  });

export const workspaceConversationViewSchema = workspaceTabSchema.refine(
  (view) =>
    view.resource.kind === "entity" &&
    view.resource.definitionId === "project.agent" &&
    !view.preview,
  "A conversation view must be a permanent Agent view.",
);

export const workspaceContentSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tab"), tabId: identity }).strict(),
  z.object({ kind: z.literal("conversation"), viewId: identity }).strict(),
]);

export const workspacePaneSchema = z
  .object({
    id: identity,
    region: projectPaneRegionSchema,
    titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
    tabs: z.array(workspaceTabSchema),
    // Last selected rail tab, retained while a direct conversation is selected.
    activeTabId: identity.nullable(),
    conversationView: workspaceConversationViewSchema.nullable().optional(),
    selection: workspaceContentSelectionSchema.optional(),
  })
  .strict();

export const workspaceWindowSchema = z
  .object({
    id: identity,
    // Incremented when ownership is attached to a new renderer, never inferred
    // from a timeout. Transfer commands must fence stale attachment generations.
    attachmentGeneration: z.int().nonnegative(),
    // Opaque identity of the context holding the exclusive lifetime lock.
    rendererId: identity.optional(),
    panes: z.array(workspacePaneSchema),
    centerRoot: projectCenterLayoutNodeSchema.nullable(),
    focusedPaneId: identity.nullable(),
    recentPaneIds: z.array(identity),
    // Optional for existing persisted layouts; absence means no observed history.
    recentTabIds: z.array(identity).optional(),
    returnPlacement: pendingTransferSchema
      .pick({
        sourceWindowId: true,
        sourcePaneId: true,
        sourcePlacement: true,
        wholePane: true,
      })
      .extend({ detachedPaneId: identity.optional() })
      .optional(),
  })
  .strict();

/**
 * Versioned ownership snapshot. Nesting is the only placement authority:
 * workspace -> window -> pane -> tab -> resource. IDs are scoped to this
 * workspace, which the server must additionally authorize against its owner
 * and project. Device identity must not depend on responsive viewport size.
 */
export const workspaceOwnershipSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    id: identity,
    projectId: identity,
    revision: z.int().nonnegative(),
    mainWindowId: identity,
    windows: z.array(workspaceWindowSchema).min(1),
    pendingTransfers: z.array(pendingTransferSchema).max(128).optional(),
    legacyFileImports: z.array(workspaceLegacyFileImportSchema).optional(),
    // Conversion receipts survive file-tab closure. Identity-only metadata;
    // drafts remain in protected per-view recovery records.
    legacyCodeImports: z
      .array(
        z
          .object({
            tabId: identity,
            codeId: identity,
            views: workspaceLegacyFileImportSchema.shape.views,
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((layout, context) => {
    const windowIds = new Set<string>();
    const paneIds = new Set<string>();
    const tabIds = new Set<string>();
    const splitIds = new Set<string>();
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const codeImports = new Set<string>();
    for (const [index, entry] of (layout.legacyCodeImports ?? []).entries()) {
      if (codeImports.has(entry.tabId))
        issue(
          ["legacyCodeImports", index],
          "Code conversion receipts must be unique.",
        );
      codeImports.add(entry.tabId);
      if (
        new Set(entry.views.map((view) => view.tabId)).size !==
          entry.views.length ||
        new Set(entry.views.map((view) => view.documentId)).size !==
          entry.views.length ||
        entry.views.some((view) => view.tabId === entry.tabId)
      )
        issue(
          ["legacyCodeImports", index],
          "Code conversion views must have distinct identities.",
        );
    }
    for (const [wi, window] of layout.windows.entries()) {
      const wp = ["windows", wi];
      if (windowIds.has(window.id))
        issue([...wp, "id"], "Window identities must be unique.");
      windowIds.add(window.id);
      const localPaneIds = new Set(window.panes.map((pane) => pane.id));
      if (
        window.focusedPaneId !== null &&
        !localPaneIds.has(window.focusedPaneId)
      ) {
        issue([...wp, "focusedPaneId"], "Focus must belong to this window.");
      }
      const recentIds = new Set<string>();
      const localTabIds = new Set(
        window.panes.flatMap((pane) =>
          [
            ...pane.tabs,
            ...(pane.conversationView ? [pane.conversationView] : []),
          ].map((view) => view.id),
        ),
      );
      const recentTabs = new Set<string>();
      for (const [ri, id] of (window.recentTabIds ?? []).entries()) {
        if (!localTabIds.has(id) || recentTabs.has(id))
          issue(
            [...wp, "recentTabIds", ri],
            "Recent tabs must be unique and belong to this window.",
          );
        recentTabs.add(id);
      }
      for (const [ri, id] of window.recentPaneIds.entries()) {
        if (!localPaneIds.has(id) || recentIds.has(id)) {
          issue(
            [...wp, "recentPaneIds", ri],
            "Recent panes must be unique and belong to this window.",
          );
        }
        recentIds.add(id);
      }
      for (const [pi, pane] of window.panes.entries()) {
        const pp = [...wp, "panes", pi];
        if (paneIds.has(pane.id))
          issue([...pp, "id"], "A pane must have exactly one window owner.");
        paneIds.add(pane.id);
        if (
          layout.version === 1 &&
          (pane.conversationView !== undefined || pane.selection !== undefined)
        )
          issue(pp, "Conversation content requires workspace version 2.");
        if (
          layout.version === 2 &&
          (pane.conversationView === undefined || pane.selection === undefined)
        )
          issue(
            pp,
            "Version 2 panes require conversation content and selection.",
          );
        if (!pane.tabs.length && !pane.conversationView)
          issue([...pp, "tabs"], "A pane must own at least one view.");
        if (
          pane.activeTabId === null
            ? pane.tabs.length > 0
            : !pane.tabs.some((tab) => tab.id === pane.activeTabId)
        )
          issue(
            [...pp, "activeTabId"],
            "The active tab must belong to this pane.",
          );
        if (pane.conversationView && pane.region !== "center")
          issue(
            [...pp, "conversationView"],
            "Direct conversations require a center pane.",
          );
        if (
          pane.selection?.kind === "tab" &&
          (pane.selection.tabId !== pane.activeTabId ||
            !pane.tabs.some((tab) => tab.id === pane.activeTabId))
        )
          issue([...pp, "selection"], "Selected tab must belong to this pane.");
        if (
          pane.selection?.kind === "conversation" &&
          pane.conversationView?.id !== pane.selection.viewId
        )
          issue(
            [...pp, "selection"],
            "Selected conversation must belong to this pane.",
          );
        if (pane.conversationView) {
          if (tabIds.has(pane.conversationView.id))
            issue(
              [...pp, "conversationView", "id"],
              "A view must have exactly one pane owner.",
            );
          tabIds.add(pane.conversationView.id);
        }
        for (const [ti, tab] of pane.tabs.entries()) {
          if (tabIds.has(tab.id))
            issue(
              [...pp, "tabs", ti, "id"],
              "A tab must have exactly one pane owner.",
            );
          tabIds.add(tab.id);
        }
      }
      const centerIds = new Set(
        window.panes
          .filter((pane) => pane.region === "center")
          .map((pane) => pane.id),
      );
      const leaves = new Set<string>();
      const pending = window.centerRoot
        ? [{ node: window.centerRoot, depth: 0 }]
        : [];
      let nodes = 0;
      while (pending.length) {
        const { node, depth } = pending.pop()!;
        if (++nodes > 255 || depth > 32) {
          issue(
            [...wp, "centerRoot"],
            "Window topology exceeds supported bounds.",
          );
          break;
        }
        if (node.kind === "pane") {
          if (!centerIds.has(node.paneId) || leaves.has(node.paneId)) {
            issue(
              [...wp, "centerRoot"],
              "Tree leaves must reference each local center pane exactly once.",
            );
          }
          leaves.add(node.paneId);
        } else {
          if (splitIds.has(node.id))
            issue([...wp, "centerRoot"], "Split identities must be unique.");
          splitIds.add(node.id);
          pending.push(
            { node: node.first, depth: depth + 1 },
            { node: node.second, depth: depth + 1 },
          );
        }
      }
      if ([...centerIds].some((id) => !leaves.has(id))) {
        issue(
          [...wp, "centerRoot"],
          "Every center pane must appear in its owning window's tree.",
        );
      }
    }
    if (!windowIds.has(layout.mainWindowId))
      issue(["mainWindowId"], "The main window must exist in this workspace.");
    const transfers = new Set<string>();
    const destinations = new Set<string>();
    const reservedTabs = new Set<string>();
    const reservedPanes = new Set<string>();
    for (const [index, transfer] of (layout.pendingTransfers ?? []).entries()) {
      const path = ["pendingTransfers", index];
      const source = layout.windows.find(
        ({ id }) => id === transfer.sourceWindowId,
      );
      const destination = layout.windows.find(
        ({ id }) => id === transfer.destinationWindowId,
      );
      if (
        transfers.has(transfer.id) ||
        (!transfer.returnSplitId &&
          destinations.has(transfer.destinationWindowId))
      )
        issue(path, "Transfer and destination identities must be unique.");
      transfers.add(transfer.id);
      if (!transfer.returnSplitId)
        destinations.add(transfer.destinationWindowId);
      if (
        reservedPanes.has(transfer.destinationPaneId) ||
        (transfer.wholePane
          ? transfer.destinationPaneId !== transfer.sourcePaneId
          : paneIds.has(transfer.destinationPaneId))
      )
        issue(path, "Destination pane identities must be uniquely reserved.");
      reservedPanes.add(transfer.destinationPaneId);
      if (
        !source ||
        !destination ||
        source === destination ||
        (transfer.returnSplitId
          ? destination.id !== layout.mainWindowId
          : destination.id === layout.mainWindowId ||
            destination.panes.length > 0)
      )
        issue(
          path,
          "A pending transfer requires a distinct empty destination window.",
        );
      if (
        source?.attachmentGeneration !== transfer.sourceGeneration ||
        destination?.attachmentGeneration !== transfer.destinationGeneration
      )
        issue(
          path,
          "Transfer generations must match their window attachments.",
        );
      for (const tabId of transfer.tabIds) {
        if (reservedTabs.has(tabId))
          issue(path, "A tab cannot participate in overlapping transfers.");
        reservedTabs.add(tabId);
      }
    }
  });

export type WorkspaceTab = z.infer<typeof workspaceTabSchema>;
export type WorkspacePane = z.infer<typeof workspacePaneSchema>;
export type WorkspaceWindow = z.infer<typeof workspaceWindowSchema>;
export type WorkspaceOwnership = z.infer<typeof workspaceOwnershipSchema>;
