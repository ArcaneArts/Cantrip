import { z } from "zod";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { projectPaneRegionSchema } from "./project-pane-identifiers.js";
import { projectSurfaceResourceRefSchema } from "./project-surfaces.js";
import {
  projectBuiltInSurfaceStateSchema,
  projectCenterLayoutNodeSchema,
  projectDockPresentationPreferenceSchema,
} from "./project-tabs.js";

const identity = z.string().min(1);

/** A view identity is independent of the resource it displays. No plaintext content. */
export const workspaceTabSchema = z
  .object({
    id: identity,
    resource: projectSurfaceResourceRefSchema,
    preview: z.boolean(),
    titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
    builtInState: projectBuiltInSurfaceStateSchema.nullable(),
    dockPresentation: projectDockPresentationPreferenceSchema.nullable(),
  })
  .strict()
  .superRefine((tab, context) => {
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

export const workspacePaneSchema = z
  .object({
    id: identity,
    region: projectPaneRegionSchema,
    titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
    tabs: z.array(workspaceTabSchema).min(1),
    activeTabId: identity,
  })
  .strict();

export const workspaceWindowSchema = z
  .object({
    id: identity,
    // Incremented when ownership is attached to a new renderer, never inferred
    // from a timeout. Transfer commands must fence stale attachment generations.
    attachmentGeneration: z.int().nonnegative(),
    panes: z.array(workspacePaneSchema),
    centerRoot: projectCenterLayoutNodeSchema.nullable(),
    focusedPaneId: identity.nullable(),
    recentPaneIds: z.array(identity),
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
    version: z.literal(1),
    id: identity,
    projectId: identity,
    revision: z.int().nonnegative(),
    mainWindowId: identity,
    windows: z.array(workspaceWindowSchema).min(1),
  })
  .strict()
  .superRefine((layout, context) => {
    const windowIds = new Set<string>();
    const paneIds = new Set<string>();
    const tabIds = new Set<string>();
    const splitIds = new Set<string>();
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
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
        if (!pane.tabs.some((tab) => tab.id === pane.activeTabId)) {
          issue(
            [...pp, "activeTabId"],
            "The active tab must belong to this pane.",
          );
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
  });

export type WorkspaceTab = z.infer<typeof workspaceTabSchema>;
export type WorkspacePane = z.infer<typeof workspacePaneSchema>;
export type WorkspaceWindow = z.infer<typeof workspaceWindowSchema>;
export type WorkspaceOwnership = z.infer<typeof workspaceOwnershipSchema>;
