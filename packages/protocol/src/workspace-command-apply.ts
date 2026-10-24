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
  window.recentTabIds = [
    tabId,
    ...(window.recentTabIds ?? []).filter((id) => id !== tabId),
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
  const retiredDestinationIds: string[] = [];
  const action = command.action;
  if (
    (layout.pendingTransfers ?? []).some(
      (transfer) =>
        transfer.destinationWindowId === window.id && !transfer.returnSplitId,
    ) &&
    action.type !== "transfer-ready" &&
    action.type !== "transfer-state-ready"
  )
    throw new WorkspaceCommandError(
      "invalid",
      "The destination is reserved for a pending transfer.",
    );
  switch (action.type) {
    case "prepare-return": {
      if (window.id === layout.mainWindowId)
        throw new WorkspaceCommandError(
          "invalid",
          "The main window cannot return to itself.",
        );
      const pane = paneById(action.paneId);
      const destination = required(
        layout.windows.find(({ id }) => id === layout.mainWindowId),
        "Main window is unavailable.",
      );
      const pending = layout.pendingTransfers ?? [];
      if (
        pending.some(
          (transfer) =>
            transfer.id === action.transferId ||
            transfer.tabIds.some((id) =>
              pane.tabs.some((tab) => tab.id === id),
            ),
        )
      )
        throw new WorkspaceCommandError(
          "invalid",
          "Transfer identity or views are already in use.",
        );
      layout.pendingTransfers = [
        ...pending,
        {
          id: action.transferId,
          sourceWindowId: window.id,
          sourceGeneration: window.attachmentGeneration,
          sourcePaneId: pane.id,
          sourcePlacement: {
            panePosition: window.panes.indexOf(pane),
            tabPosition: 0,
            region: pane.region,
            centerRoot: structuredClone(window.centerRoot),
          },
          tabIds: pane.tabs.map(({ id }) => id),
          wholePane: true,
          destinationWindowId: destination.id,
          destinationGeneration: destination.attachmentGeneration,
          destinationPaneId: pane.id,
          returnSplitId: action.splitId,
          phase: "preparing",
        },
      ];
      break;
    }
    case "prepare-detach": {
      const pane = paneById(action.paneId);
      const tabs = action.tabId
        ? [
            required(
              pane.tabs.find(({ id }) => id === action.tabId),
              "Tab does not belong to the source pane.",
            ),
          ]
        : pane.tabs;
      const pending = layout.pendingTransfers ?? [];
      if (
        layout.windows.some(({ id }) => id === action.destinationWindowId) ||
        pending.some(
          (transfer) =>
            transfer.id === action.transferId ||
            transfer.tabIds.some((id) => tabs.some((tab) => tab.id === id)),
        )
      )
        throw new WorkspaceCommandError(
          "invalid",
          "Transfer identity, destination, or views are already in use.",
        );
      if (
        action.tabId
          ? layout.windows.some((owner) =>
              owner.panes.some(({ id }) => id === action.destinationPaneId),
            )
          : action.destinationPaneId !== pane.id
      )
        throw new WorkspaceCommandError(
          "invalid",
          "A pane transfer preserves its identity; a tab transfer requires a new pane identity.",
        );
      layout.windows.push({
        id: action.destinationWindowId,
        attachmentGeneration: 0,
        panes: [],
        centerRoot: null,
        focusedPaneId: null,
        recentPaneIds: [],
      });
      layout.pendingTransfers = [
        ...pending,
        {
          id: action.transferId,
          sourceWindowId: window.id,
          sourceGeneration: window.attachmentGeneration,
          sourcePaneId: pane.id,
          sourcePlacement: {
            panePosition: window.panes.indexOf(pane),
            tabPosition: pane.tabs.indexOf(tabs[0]!),
            region: pane.region,
            centerRoot: structuredClone(window.centerRoot),
          },
          tabIds: tabs.map(({ id }) => id),
          wholePane: !action.tabId,
          destinationWindowId: action.destinationWindowId,
          destinationGeneration: 0,
          destinationPaneId: action.destinationPaneId,
          phase: "preparing",
        },
      ];
      break;
    }
    case "transfer-ready": {
      const transfer = required(
        layout.pendingTransfers?.find(({ id }) => id === action.transferId),
        "Transfer no longer exists.",
      );
      if (transfer.destinationWindowId !== window.id)
        throw new WorkspaceCommandError(
          "scope",
          "Only the destination can acknowledge readiness.",
        );
      if (transfer.phase === "preparing") transfer.phase = "destination-ready";
      break;
    }
    case "transfer-state-ready": {
      const transfer = required(
        layout.pendingTransfers?.find(({ id }) => id === action.transferId),
        "Transfer no longer exists.",
      );
      if (transfer.destinationWindowId !== window.id)
        throw new WorkspaceCommandError(
          "scope",
          "Only the destination can acknowledge restored state.",
        );
      if (transfer.phase === "preparing")
        throw new WorkspaceCommandError(
          "invalid",
          "Destination application readiness has not been acknowledged.",
        );
      transfer.phase = "state-ready";
      break;
    }
    case "commit-transfer": {
      const transfer = required(
        layout.pendingTransfers?.find(({ id }) => id === action.transferId),
        "Transfer no longer exists.",
      );
      if (transfer.sourceWindowId !== window.id)
        throw new WorkspaceCommandError(
          "scope",
          "Only the source can commit transfer ownership after retiring its renderers.",
        );
      if (transfer.phase !== "state-ready")
        throw new WorkspaceCommandError(
          "invalid",
          "Destination state restoration has not been acknowledged.",
        );
      const source = paneById(transfer.sourcePaneId);
      const destination = required(
        layout.windows.find(({ id }) => id === transfer.destinationWindowId),
        "Destination window no longer exists.",
      );
      const tabs = transfer.tabIds.map((id) =>
        required(
          source.tabs.find((tab) => tab.id === id),
          "Transferred tab no longer belongs to the prepared source pane.",
        ),
      );
      if (
        transfer.wholePane &&
        (source.tabs.length !== tabs.length ||
          source.tabs.some((tab, index) => tab.id !== transfer.tabIds[index]))
      )
        throw new WorkspaceCommandError(
          "invalid",
          "Source pane membership changed during transfer preparation.",
        );
      let moved: WorkspacePane;
      if (transfer.wholePane) {
        moved = source;
        removePane(window, source);
        moved.region = "center";
      } else {
        if (tabs.length !== 1)
          throw new WorkspaceCommandError(
            "invalid",
            "Single-tab transfer contains multiple tabs.",
          );
        takeTab(window, source, tabs[0]!);
        moved = {
          id: transfer.destinationPaneId,
          region: "center",
          titleProtection: source.titleProtection,
          tabs,
          activeTabId: tabs[0]!.id,
        };
      }
      if (transfer.returnSplitId) {
        const previous = window.returnPlacement;
        const original =
          previous?.sourceWindowId === destination.id &&
          (previous.detachedPaneId === moved.id ||
            (previous.wholePane && previous.sourcePaneId === moved.id))
            ? previous
            : undefined;
        const originalPane =
          original && !original.wholePane
            ? destination.panes.find(({ id }) => id === original.sourcePaneId)
            : undefined;
        if (originalPane) {
          originalPane.tabs.splice(
            Math.min(
              original!.sourcePlacement.tabPosition,
              originalPane.tabs.length,
            ),
            0,
            ...moved.tabs,
          );
          focus(destination, originalPane, moved.activeTabId);
        } else {
          moved.region = original?.sourcePlacement.region ?? "center";
          destination.panes.splice(
            Math.min(
              original?.sourcePlacement.panePosition ??
                destination.panes.length,
              destination.panes.length,
            ),
            0,
            moved,
          );
          if (moved.region === "center") {
            const originalTree = original?.wholePane
              ? original.sourcePlacement.centerRoot
              : null;
            const canRestoreTree =
              originalTree &&
              JSON.stringify(
                removeWorkspacePaneLeaf(originalTree, moved.id),
              ) === JSON.stringify(destination.centerRoot);
            destination.centerRoot = canRestoreTree
              ? structuredClone(originalTree)
              : destination.centerRoot
                ? {
                    kind: "split",
                    id: transfer.returnSplitId,
                    direction: "horizontal",
                    fraction: 0.5,
                    first: destination.centerRoot,
                    second: { kind: "pane", paneId: moved.id },
                  }
                : { kind: "pane", paneId: moved.id };
          }
          focus(destination, moved, moved.activeTabId);
        }
        focusWindowId = destination.id;
        layout.pendingTransfers = layout.pendingTransfers!.filter(
          ({ id }) => id !== transfer.id,
        );
        break;
      }
      destination.panes = [moved];
      destination.centerRoot = { kind: "pane", paneId: moved.id };
      destination.returnPlacement = {
        detachedPaneId: moved.id,
        sourceWindowId: transfer.sourceWindowId,
        sourcePaneId: transfer.sourcePaneId,
        sourcePlacement: transfer.sourcePlacement,
        wholePane: transfer.wholePane,
      };
      focus(destination, moved, moved.activeTabId);
      focusWindowId = destination.id;
      layout.pendingTransfers = layout.pendingTransfers!.filter(
        ({ id }) => id !== transfer.id,
      );
      break;
    }
    case "cancel-transfer": {
      const transfer = required(
        layout.pendingTransfers?.find(({ id }) => id === action.transferId),
        "Transfer no longer exists.",
      );
      if (transfer.sourceWindowId !== window.id)
        throw new WorkspaceCommandError(
          "scope",
          "Only the source can cancel this transfer.",
        );
      if (!transfer.returnSplitId) {
        layout.windows = layout.windows.filter(
          ({ id }) => id !== transfer.destinationWindowId,
        );
        retiredDestinationIds.push(transfer.destinationWindowId);
      }
      layout.pendingTransfers = layout.pendingTransfers!.filter(
        ({ id }) => id !== transfer.id,
      );
      break;
    }
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
      const wasFocused =
        window.focusedPaneId === pane.id && pane.activeTabId === tab.id;
      takeTab(window, pane, tab);
      const next = window.panes.find(
        (candidate) => candidate.id === window.focusedPaneId,
      );
      if (wasFocused && next) focus(window, next, next.activeTabId);
      break;
    }
    case "close-pane": {
      const pane = paneById(action.paneId);
      const wasFocused = window.focusedPaneId === pane.id;
      removePane(window, pane);
      const next = window.panes.find(
        (candidate) => candidate.id === window.focusedPaneId,
      );
      if (wasFocused && next) focus(window, next, next.activeTabId);
      break;
    }
    case "pin":
      tabById(action.tabId).tab.preview = false;
      break;
    case "file-mode": {
      const { tab } = tabById(action.tabId);
      if (tab.resource.definitionId !== "project.file")
        throw new WorkspaceCommandError(
          "invalid",
          "File mode requires a file view.",
        );
      tab.fileMode = action.mode;
      break;
    }
    case "rename-pane":
      paneById(action.paneId).titleProtection = action.titleProtection;
      break;
    case "dock-presentation": {
      const { pane, tab } = tabById(action.tabId);
      if (pane.region !== "right" && pane.region !== "bottom")
        throw new WorkspaceCommandError(
          "invalid",
          "Dock presentation requires a right or bottom pane.",
        );
      tab.dockPresentation = action.presentation;
      break;
    }
    case "reorder-panes": {
      const panes = new Map(
        window.panes
          .filter((pane) => pane.region === action.region)
          .map((pane) => [pane.id, pane]),
      );
      if (
        action.paneIds.length !== panes.size ||
        new Set(action.paneIds).size !== panes.size ||
        action.paneIds.some((id) => !panes.has(id))
      )
        throw new WorkspaceCommandError(
          "invalid",
          "Pane order must contain every local region member exactly once.",
        );
      let index = 0;
      window.panes = window.panes.map((pane) =>
        pane.region === action.region
          ? panes.get(action.paneIds[index++]!)!
          : pane,
      );
      if (action.region === "center") {
        // Reassign leaf occupants, not split nodes: retain split identities,
        // orientation and fractions while changing visual pane order.
        let leaf = 0;
        const reorderLeaves = (
          node: NonNullable<WorkspaceWindow["centerRoot"]>,
        ): void => {
          if (node.kind === "pane") node.paneId = action.paneIds[leaf++]!;
          else {
            reorderLeaves(node.first);
            reorderLeaves(node.second);
          }
        };
        if (window.centerRoot) reorderLeaves(window.centerRoot);
      }
      break;
    }
    case "move-new-pane": {
      const { pane, tab } = tabById(action.tabId);
      // Evaluate the insertion position after removing an emptied source pane.
      const count = window.panes.filter(
        (p) =>
          p.region === action.region && !(p === pane && pane.tabs.length === 1),
      ).length;
      if (action.position > count)
        throw new WorkspaceCommandError(
          "invalid",
          "Target pane position is outside the region.",
        );
      takeTab(window, pane, tab);
      const target: WorkspacePane = {
        id: action.paneId,
        region: action.region,
        titleProtection: null,
        tabs: [tab],
        activeTabId: tab.id,
      };
      const regionPanes = window.panes.filter(
        (p) => p.region === action.region,
      );
      const neighbor = regionPanes[action.position];
      const previous = regionPanes[action.position - 1];
      const insertion = neighbor
        ? window.panes.indexOf(neighbor)
        : previous
          ? window.panes.indexOf(previous) + 1
          : window.panes.length;
      window.panes.splice(insertion, 0, target);
      if (target.region === "center") {
        if (!window.centerRoot)
          window.centerRoot = { kind: "pane", paneId: target.id };
        else {
          const anchor = neighbor ?? previous!;
          const targetLeaf = { kind: "pane" as const, paneId: target.id };
          const anchorLeaf = { kind: "pane" as const, paneId: anchor.id };
          window.centerRoot = replaceWorkspacePaneLeaf(
            window.centerRoot,
            anchor.id,
            {
              kind: "split",
              id: action.splitId,
              direction: "horizontal",
              fraction: 0.5,
              first: neighbor ? targetLeaf : anchorLeaf,
              second: neighbor ? anchorLeaf : targetLeaf,
            },
          );
        }
      }
      focus(window, target, tab.id);
      break;
    }
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
        // A permanent open promotes the existing preview in place. A preview
        // open never demotes an already pinned view, including in another window.
        if (!action.tab.preview) existing.tab.preview = false;
        focus(existing.owner, existing.pane, existing.tab.id);
        if (existing.owner.id !== window.id) focusWindowId = existing.owner.id;
        break;
      }
      if (action.target.kind === "pane") {
        const target = paneById(action.target.paneId);
        const replacing = action.replacePreviewTabId
          ? tabById(action.replacePreviewTabId)
          : null;
        if (
          replacing &&
          (replacing.pane.id !== target.id ||
            replacing.tab.resource.definitionId !== "project.file" ||
            action.tab.resource.definitionId !== "project.file" ||
            !action.tab.preview)
        )
          throw new WorkspaceCommandError(
            "invalid",
            "Preview replacement requires file views in the same pane.",
          );
        // A pin that wins a revision race preserves the old view. Opening the
        // new file still succeeds, but it must no longer replace that tab.
        if (replacing?.tab.preview) {
          if (
            (layout.pendingTransfers ?? []).some((transfer) =>
              transfer.tabIds.includes(replacing.tab.id),
            )
          )
            throw new WorkspaceCommandError(
              "invalid",
              "Preview is reserved for a pending transfer.",
            );
          target.tabs.splice(target.tabs.indexOf(replacing.tab), 1, action.tab);
        } else target.tabs.push(action.tab);
        focus(window, target, action.tab.id);
      } else {
        if (action.replacePreviewTabId)
          throw new WorkspaceCommandError(
            "invalid",
            "Preview replacement requires an existing pane.",
          );
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
  // Ownership is authoritative. Closed/moved views cannot survive in another
  // window's recent list, and layout-only changes must not invent activations.
  for (const owner of layout.windows) {
    if (!owner.recentTabIds) continue;
    const owned = new Set(
      owner.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id)),
    );
    owner.recentTabIds = owner.recentTabIds.filter((id) => owned.has(id));
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
    emptyWindowIds: [
      ...retiredDestinationIds,
      ...(hadPanes &&
      window.id !== layout.mainWindowId &&
      window.panes.length === 0
        ? [window.id]
        : []),
    ],
  };
}
