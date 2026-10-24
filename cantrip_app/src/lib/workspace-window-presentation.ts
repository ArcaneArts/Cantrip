import type {
  ProjectTabKind,
  ProjectTabLayoutWireSummary,
  WorkspaceOwnership,
  WorkspaceTab,
} from "@cantrip/protocol";
import { chatTitleEncryption } from "./chat-title-encryption";
import type { WorkspaceSelection } from "./workspace-selection";
import { workspaceWindowSelection } from "./workspace-selection-command";

const entityKinds = {
  "project.agent": "chat",
  "project.terminal": "terminal",
  "project.explorer": "explorer",
  "project.file": "explorer",
  "project.browser": "browser",
  "project.code": "code",
  "project.remote-desktop": "remote-desktop",
  "project.git-history": "history",
  "project.git-graph": "graph",
  "project.github-issues": "issues",
  "project.github-pull-requests": "prs",
  "project.github-actions": "actions",
} satisfies Partial<
  Record<WorkspaceTab["resource"]["definitionId"], ProjectTabKind>
>;

function tabKind(tab: WorkspaceTab): ProjectTabKind {
  if (tab.resource.kind === "builtin") return "builtin";
  const kind =
    entityKinds[tab.resource.definitionId as keyof typeof entityKinds];
  if (!kind)
    throw new Error(`Unsupported entity surface ${tab.resource.definitionId}.`);
  return kind;
}

// Rendering compatibility only: ownership does not have creation timestamps.
// Never persist this projection or use these fields for recent-use ordering.
const presentationTimestamp = "1970-01-01T00:00:00.000Z";

/** Read-only projection for existing pane components. It is not a second layout
 * store: only the named owner's panes are visible and tab keys remain opaque. */
export function workspaceWindowPresentation(
  layout: WorkspaceOwnership,
  windowId: string,
): {
  wire: ProjectTabLayoutWireSummary;
  selection: WorkspaceSelection;
} {
  const window = layout.windows.find(({ id }) => id === windowId);
  if (!window) throw new Error("The window does not belong to this workspace.");
  return {
    wire: {
      projectId: layout.projectId,
      revision: layout.revision,
      centerRoot: structuredClone(window.centerRoot),
      panes: window.panes.map((pane, position) => ({
        id: pane.id,
        projectId: layout.projectId,
        region: pane.region,
        position,
        anchorTabKey: pane.activeTabId,
        titleProtection: structuredClone(pane.titleProtection),
        createdAt: presentationTimestamp,
        updatedAt: presentationTimestamp,
        members: pane.tabs.map((tab, position) => ({
          tabKey: tab.id,
          tabId:
            tab.resource.kind === "entity"
              ? tab.resource.resourceId
              : tab.resource.definitionId,
          tabKind: tabKind(tab),
          paneId: pane.id,
          projectId: layout.projectId,
          position,
          titleProtection: structuredClone(tab.titleProtection),
          builtInState: structuredClone(tab.builtInState),
          dockPresentation:
            pane.region === "right" || pane.region === "bottom"
              ? structuredClone(tab.dockPresentation)
              : null,
          createdAt: presentationTimestamp,
          updatedAt: presentationTimestamp,
        })),
      })),
    },
    selection: workspaceWindowSelection(layout.projectId, window),
  };
}

/** Decrypt through the existing resource-bound label path; ownership and its
 * public transport never acquire the resulting plaintext labels. */
export async function openWorkspaceWindowPresentation(
  layout: WorkspaceOwnership,
  windowId: string,
) {
  const { wire, selection } = workspaceWindowPresentation(layout, windowId);
  return { layout: await chatTitleEncryption.openTabLayout(wire), selection };
}
