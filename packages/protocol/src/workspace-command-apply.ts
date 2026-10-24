import {
  workspaceCommandSchema,
  type WorkspaceCommand,
} from "./workspace-command.js";
import {
  workspaceOwnershipSchema,
  type WorkspaceOwnership,
  type WorkspaceWindow,
  type WorkspacePane,
  type WorkspaceTab,
} from "./workspace-ownership.js";
import {
  removeWorkspacePaneLeaf,
  replaceWorkspacePaneLeaf,
  resizeWorkspaceSplit,
} from "./workspace-command-tree.js";

export class WorkspaceCommandError extends Error {
  constructor(
    public readonly code:
      "scope" | "revision" | "attachment" | "missing" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceCommandError";
  }
}

function required<T>(value: T | undefined | null, message: string): T {
  if (value == null) throw new WorkspaceCommandError("missing", message);
  return value;
}

function focus(window: WorkspaceWindow, pane: WorkspacePane, tabId: string) {
  pane.activeTabId = tabId;
  window.focusedPaneId = pane.id;
  window.recentPaneIds = [
    pane.id,
    ...window.recentPaneIds.filter((id) => id !== pane.id),
  ];
}

function removePane(window: WorkspaceWindow, pane: WorkspacePane) {
  window.panes = window.panes.filter((candidate) => candidate.id !== pane.id);
  window.centerRoot = removeWorkspacePaneLeaf(window.centerRoot, pane.id);
  window.recentPaneIds = window.recentPaneIds.filter((id) => id !== pane.id);
  if (window.focusedPaneId === pane.id) {
    // Prefer actual focus history. Never jump into another window. A newly
    // seeded, never-focused pane is a deterministic local fallback.
    window.focusedPaneId =
      window.recentPaneIds[0] ??
      window.panes.find((p) => p.region === "center")?.id ??
      window.panes[0]?.id ??
      null;
    if (window.focusedPaneId)
      window.recentPaneIds = [
        window.focusedPaneId,
        ...window.recentPaneIds.filter((id) => id !== window.focusedPaneId),
      ];
  }
}

function takeTab(
  window: WorkspaceWindow,
  pane: WorkspacePane,
  tab: WorkspaceTab,
) {
  const index = pane.tabs.findIndex((candidate) => candidate.id === tab.id);
  pane.tabs.splice(index, 1);
  if (!pane.tabs.length) removePane(window, pane);
  else if (pane.activeTabId === tab.id)
    pane.activeTabId = (pane.tabs[index] ?? pane.tabs[index - 1])!.id;
}

function sameResource(a: WorkspaceTab, b: WorkspaceTab) {
  return (
    a.resource.kind === b.resource.kind &&
    a.resource.definitionId === b.resource.definitionId &&
    (a.resource.kind === "builtin" ||
      (b.resource.kind === "entity" &&
        a.resource.resourceId === b.resource.resourceId))
  );
}

export interface WorkspaceCommandResult {
  layout: WorkspaceOwnership;
  operationId: string;
  focusWindowId: string | null;
  emptyWindowIds: string[];
}

/**
 * Pure atomic transition shared by the future server command executor and UI
 * optimistic controller. It never performs native handoff, resource deletion,
 * saves, or authorization. Those lifecycle/authorization decisions precede it.
 * Durable operation-ID deduplication belongs in the executor's transaction.
 */
export function applyWorkspaceCommand(
  snapshot: WorkspaceOwnership,
  input: WorkspaceCommand,
): WorkspaceCommandResult {
  const command = workspaceCommandSchema.parse(input);
  const layout = workspaceOwnershipSchema.parse(snapshot);
  if (
    command.workspaceId !== layout.id ||
    command.projectId !== layout.projectId
  )
    throw new WorkspaceCommandError(
      "scope",
      "Command belongs to a different workspace or project.",
    );
  if (command.expectedRevision !== layout.revision)
    throw new WorkspaceCommandError(
      "revision",
      "Workspace revision changed; rebase the pending operation.",
    );
  const window = required(
    layout.windows.find((candidate) => candidate.id === command.windowId),
    "Command window no longer exists.",
  );
  const hadPanes = window.panes.length > 0;
  if (command.attachmentGeneration !== window.attachmentGeneration)
    throw new WorkspaceCommandError(
      "attachment",
      "The command's renderer no longer owns this window.",
    );
  const paneById = (id: string) =>
    required(
      window.panes.find((pane) => pane.id === id),
      "Pane does not belong to this window.",
    );
  const tabById = (id: string) => {
    const pane = required(
      window.panes.find((pane) => pane.tabs.some((tab) => tab.id === id)),
      "Tab does not belong to this window.",
    );
    return { pane, tab: pane.tabs.find((tab) => tab.id === id)! };
  };
  let focusWindowId: string | null = null;
  const action = command.action;
  switch (action.type) {
    case "home":
      window.focusedPaneId = null;
      break;
    case "select": {
      const { pane, tab } = tabById(action.tabId);
      focus(window, pane, tab.id);
      break;
    }
    case "close-tab": {
      const { pane, tab } = tabById(action.tabId);
      takeTab(window, pane, tab);
      break;
    }
    case "close-pane":
      removePane(window, paneById(action.paneId));
      break;
    case "pin":
      tabById(action.tabId).tab.preview = false;
      break;
    case "reorder": {
      const pane = paneById(action.paneId);
      const tabs = new Map(pane.tabs.map((tab) => [tab.id, tab]));
      if (
        new Set(action.tabIds).size !== tabs.size ||
        action.tabIds.length !== tabs.size ||
        action.tabIds.some((id) => !tabs.has(id))
      )
        throw new WorkspaceCommandError(
          "invalid",
          "Tab order must contain each pane member exactly once.",
        );
      pane.tabs = action.tabIds.map((id) => tabs.get(id)!);
      break;
    }
    case "move": {
      const { pane, tab } = tabById(action.tabId);
      const target = paneById(action.targetPaneId);
      const maximum = target.tabs.length - (target === pane ? 1 : 0);
      if (action.position > maximum)
        throw new WorkspaceCommandError(
          "invalid",
          "Target tab position is outside the pane.",
        );
      if (target === pane) {
        pane.tabs.splice(pane.tabs.indexOf(tab), 1);
      } else takeTab(window, pane, tab);
      target.tabs.splice(action.position, 0, tab);
      focus(window, target, tab.id);
      break;
    }
    case "split": {
      const { pane, tab } = tabById(action.tabId);
      const target = paneById(action.targetPaneId);
      if (
        target.region !== "center" ||
        (pane === target && pane.tabs.length === 1)
      )
        throw new WorkspaceCommandError(
          "invalid",
          "A split requires a surviving center target pane.",
        );
      takeTab(window, pane, tab);
      const newPane: WorkspacePane = {
        id: action.paneId,
        region: "center",
        titleProtection: null,
        tabs: [tab],
        activeTabId: tab.id,
      };
      const newFirst = action.edge === "left" || action.edge === "top";
      const first = {
        kind: "pane" as const,
        paneId: newFirst ? newPane.id : target.id,
      };
      const second = {
        kind: "pane" as const,
        paneId: newFirst ? target.id : newPane.id,
      };
      window.centerRoot = replaceWorkspacePaneLeaf(
        required(window.centerRoot, "Center tree is missing."),
        target.id,
        {
          kind: "split",
          id: action.splitId,
          direction:
            action.edge === "left" || action.edge === "right"
              ? "horizontal"
              : "vertical",
          fraction: action.fraction,
          first,
          second,
        },
      );
      window.panes.splice(
        window.panes.indexOf(target) + (newFirst ? 0 : 1),
        0,
        newPane,
      );
      focus(window, newPane, tab.id);
      break;
    }
    case "resize": {
      if (
        !resizeWorkspaceSplit(
          window.centerRoot,
          action.splitId,
          action.fraction,
        )
      )
        throw new WorkspaceCommandError(
          "missing",
          "Split does not belong to this window.",
        );
      break;
    }
    case "open": {
      const existing = layout.windows.flatMap((owner) =>
        owner.panes.flatMap((pane) =>
          pane.tabs
            .filter((tab) => sameResource(tab, action.tab))
            .map((tab) => ({ owner, pane, tab })),
        ),
      )[0];
      if (existing) {
        focus(existing.owner, existing.pane, existing.tab.id);
        if (existing.owner.id !== window.id) focusWindowId = existing.owner.id;
        break;
      }
      if (action.target.kind === "pane") {
        const target = paneById(action.target.paneId);
        target.tabs.push(action.tab);
        focus(window, target, action.tab.id);
      } else {
        const target: WorkspacePane = {
          id: action.target.paneId,
          region: action.target.region,
          titleProtection: null,
          tabs: [action.tab],
          activeTabId: action.tab.id,
        };
        window.panes.push(target);
        if (target.region === "center")
          window.centerRoot = window.centerRoot
            ? {
                kind: "split",
                id: action.target.splitId,
                direction: "horizontal",
                fraction: 0.5,
                first: window.centerRoot,
                second: { kind: "pane", paneId: target.id },
              }
            : { kind: "pane", paneId: target.id };
        focus(window, target, action.tab.id);
      }
      break;
    }
  }
  layout.revision++;
  const validated = workspaceOwnershipSchema.safeParse(layout);
  if (!validated.success) {
    throw new WorkspaceCommandError(
      "invalid",
      "The command would create invalid workspace ownership.",
    );
  }
  return {
    layout: validated.data,
    operationId: command.operationId,
    focusWindowId,
    // The native coordinator must close these only after the durable receipt.
    emptyWindowIds:
      hadPanes && window.id !== layout.mainWindowId && window.panes.length === 0
        ? [window.id]
        : [],
  };
}
