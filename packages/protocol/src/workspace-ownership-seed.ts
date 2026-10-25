import { z } from "zod";
import { projectTabLayoutWireSummarySchema } from "./project-tabs.js";
import type { ProjectSurfaceResourceRef } from "./project-surfaces.js";
import { removeWorkspacePaneLeaf } from "./workspace-command-tree.js";
import { WorkspaceCommandError } from "./workspace-command-apply.js";
import {
  workspaceOwnershipSchema,
  type WorkspaceOwnership,
} from "./workspace-ownership.js";

type LegacyLayout = z.infer<typeof projectTabLayoutWireSummarySchema>;
type LegacyMember = LegacyLayout["panes"][number]["members"][number];

export const workspaceSeedRequestSchema = z
  .object({
    mainWindowId: z.string().min(1),
    activeTabByPane: z.record(z.string().min(1), z.string().min(1)).optional(),
    focusedPaneId: z.string().min(1).nullable().optional(),
    detachedPanes: z
      .array(
        z
          .object({
            paneId: z.string().min(1),
            windowId: z.string().min(1),
          })
          .strict(),
      )
      .max(128)
      .optional(),
  })
  .strict();

export type WorkspaceSeedRequest = z.infer<typeof workspaceSeedRequestSchema>;

const definitions = {
  chat: "project.agent",
  terminal: "project.terminal",
  explorer: "project.explorer",
  browser: "project.browser",
  code: "project.code",
  history: "project.git-history",
  graph: "project.git-graph",
  issues: "project.github-issues",
  prs: "project.github-pull-requests",
  actions: "project.github-actions",
  "remote-desktop": "project.remote-desktop",
} as const;

function resource(member: LegacyMember): ProjectSurfaceResourceRef {
  if (member.tabKind === "builtin") {
    // Validated by the legacy wire schema before conversion.
    return { kind: "builtin", definitionId: member.builtInState!.definitionId };
  }
  return {
    kind: "entity",
    definitionId: definitions[member.tabKind],
    resourceId: member.tabId,
  };
}

/** Seed once; never replay a project-global layout over an existing workspace. */
export function seedWorkspaceOwnership(input: {
  workspaceId: string;
  mainWindowId: string;
  legacy: LegacyLayout;
  existing?: WorkspaceOwnership;
  activeTabByPane?: Readonly<Record<string, string>>;
  focusedPaneId?: string | null;
  /** Actual legacy native window observations, not timeout-based ownership guesses. */
  detachedPanes?: readonly { paneId: string; windowId: string }[];
}): WorkspaceOwnership {
  if (input.existing) {
    const existing = workspaceOwnershipSchema.parse(input.existing);
    if (
      existing.id !== input.workspaceId ||
      existing.projectId !== input.legacy.projectId ||
      existing.mainWindowId !== input.mainWindowId
    ) {
      throw new Error(
        "Cannot seed a different workspace, project, or main window over existing ownership.",
      );
    }
    return existing;
  }
  const legacy = projectTabLayoutWireSummarySchema.parse(input.legacy);
  // Encoding each component separately avoids delimiter collisions. Tab identity
  // no longer equals resource identity; future opens allocate new opaque IDs.
  const tabId = (key: string) =>
    `tab:${encodeURIComponent(input.workspaceId)}:${encodeURIComponent(key)}`;
  const panes = legacy.panes.map((pane) => {
    const preferred = input.activeTabByPane?.[pane.id];
    return {
      id: pane.id,
      region: pane.region,
      titleProtection: pane.titleProtection,
      tabs: pane.members.map((member) => ({
        id: tabId(member.tabKey),
        resource: resource(member),
        preview: false,
        titleProtection: member.titleProtection,
        builtInState: member.builtInState ?? null,
        dockPresentation: member.dockPresentation ?? null,
      })),
      activeTabId: tabId(
        pane.members.some((member) => member.tabKey === preferred)
          ? preferred!
          : pane.anchorTabKey,
      ),
    };
  });
  const focusedPaneId = panes.some((pane) => pane.id === input.focusedPaneId)
    ? input.focusedPaneId!
    : null;
  const claimedPanes = new Set<string>();
  const claimedWindows = new Set([input.mainWindowId]);
  let centerRoot = legacy.centerRoot ?? null;
  const detachedWindows = (input.detachedPanes ?? []).map((claim) => {
    const pane = panes.find(({ id }) => id === claim.paneId);
    if (
      !pane ||
      claimedPanes.has(claim.paneId) ||
      !claim.windowId ||
      claimedWindows.has(claim.windowId)
    ) {
      throw new WorkspaceCommandError(
        "invalid",
        "Invalid or duplicate legacy detached pane ownership.",
      );
    }
    claimedPanes.add(claim.paneId);
    claimedWindows.add(claim.windowId);
    centerRoot = removeWorkspacePaneLeaf(centerRoot, claim.paneId);
    return {
      id: claim.windowId,
      attachmentGeneration: 0,
      panes: [pane],
      centerRoot:
        pane.region === "center"
          ? { kind: "pane" as const, paneId: pane.id }
          : null,
      focusedPaneId: pane.id,
      recentPaneIds: [pane.id],
    };
  });
  const mainFocus =
    focusedPaneId && !claimedPanes.has(focusedPaneId) ? focusedPaneId : null;
  return workspaceOwnershipSchema.parse({
    version: 1,
    id: input.workspaceId,
    projectId: legacy.projectId,
    revision: 0,
    mainWindowId: input.mainWindowId,
    windows: [
      {
        id: input.mainWindowId,
        attachmentGeneration: 0,
        panes: panes.filter(({ id }) => !claimedPanes.has(id)),
        centerRoot,
        focusedPaneId: mainFocus,
        recentPaneIds: mainFocus ? [mainFocus] : [],
      },
      ...detachedWindows,
    ],
  });
}
