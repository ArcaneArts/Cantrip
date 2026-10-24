import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import type { ExplorerTransferEntry } from "@/components/explorer/explorer-transfer-batch";
import {
  prepareWorkspaceViewTransferBatch,
  type TerminalTransferEntry,
  type BrowserTransferEntry,
  type ChatTransferEntry,
  type RemoteDesktopTransferEntry,
} from "./workspace-view-transfer-batch";
import { getTerminalTransferLifecycle } from "@/components/terminal/terminal-transfer-lifecycle";
import { getBrowserTransferLifecycle } from "@/components/browser/browser-transfer-lifecycle";
import { getChatTransferLifecycle } from "@/components/chat/chat-transfer-lifecycle";
import { getRemoteDesktopTransferLifecycle } from "@/components/remote-desktop/remote-desktop-transfer-lifecycle";
import { getRemoteDesktop } from "@/lib/api";
import { getNativeCodeLifecycle } from "@/components/code/native-code-lifecycle";
import type { ProjectSurface } from "@/lib/project-surface";
import {
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";
import { focusWorkspaceNativeWindow } from "@/lib/desktop-popout";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import { detachWorkspaceViews } from "@/lib/workspace-transfer-source";

/** Source adapter for document-backed, terminal, and browser surfaces. Other live surfaces must
 * supply their own transfer adapters before they can use this path. */
export async function detachWorkspaceEditors(
  input: {
    controller: WorkspaceCommandClient;
    windowId: string;
    paneId: string;
    tabId?: string;
    returnToMain?: boolean;
    title: string;
    signal?: AbortSignal;
    surfaces: ReadonlyMap<string, ProjectSurface>;
    explorers: ReadonlyMap<string, ExplorerLifecycleActions>;
  },
  detach = detachWorkspaceViews,
) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity) throw new Error("Sign in before moving a workspace view.");
  const signal = new AbortController();
  const abort = () => signal.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  const unsubscribe = input.controller.subscribe(() => {
    if (
      input.controller.getSnapshot().disposed ||
      !clientSessionIdentityMatches(identity)
    )
      signal.abort(new Error("Workspace transfer source context changed."));
  });
  const unsubscribeSession = onClientSessionIdentityChanged(() => {
    if (!clientSessionIdentityMatches(identity))
      signal.abort(new Error("Workspace transfer account changed."));
  });
  try {
    return await detach({
      controller: input.controller,
      windowId: input.windowId,
      paneId: input.paneId,
      tabId: input.tabId,
      returnToMain: input.returnToMain,
      title: input.title,
      identity: { serverId: identity.serverId, ownerId: identity.userId },
      signal: signal.signal,
      activate: (windowId) =>
        focusWorkspaceNativeWindow(
          windowId === input.controller.getSnapshot().authoritative.mainWindowId
            ? "main"
            : windowId,
        ),
      prepare: async (tabIds) => {
        if (!clientSessionIdentityMatches(identity))
          throw new Error("Workspace transfer account changed.");
        const layout = input.controller.getSnapshot().authoritative;
        const pane = layout.windows
          .find(({ id }) => id === input.windowId)
          ?.panes.find(({ id }) => id === input.paneId);
        const entries: ExplorerTransferEntry[] = [];
        const terminalEntries: TerminalTransferEntry[] = [];
        const browserEntries: BrowserTransferEntry[] = [];
        const chatEntries: ChatTransferEntry[] = [];
        const desktopEntries: RemoteDesktopTransferEntry[] = [];
        for (const tabId of tabIds) {
          const tab = pane?.tabs.find(({ id }) => id === tabId);
          const surface = input.surfaces.get(tabId);
          if (
            !tab ||
            tab.resource.kind !== "entity" ||
            !surface ||
            (surface.kind !== "explorer" &&
              surface.kind !== "file" &&
              surface.kind !== "code" &&
              surface.kind !== "terminal" &&
              surface.kind !== "chat" &&
              surface.kind !== "remote-desktop" &&
              surface.kind !== "browser")
          )
            throw new Error(
              "This surface does not yet have a workspace transfer adapter.",
            );
          if (
            surface.entity.id !== tab.resource.resourceId ||
            surface.entity.projectId !== layout.projectId
          )
            throw new Error("Workspace transfer resource changed.");
          if (surface.kind === "chat") {
            const owner = {
              tabId,
              projectId: surface.entity.projectId,
              chatId: surface.entity.id,
            };
            const lifecycle = getChatTransferLifecycle(owner);
            if (!lifecycle)
              throw new Error("The chat view is not attached for transfer.");
            chatEntries.push({ ...owner, lifecycle });
            continue;
          }
          if (surface.kind === "remote-desktop") {
            const desktop = await getRemoteDesktop(surface.entity.id);
            if (
              desktop.id !== surface.entity.id ||
              desktop.projectId !== layout.projectId
            )
              throw new Error("Workspace transfer remote desktop changed.");
            if (!clientSessionIdentityMatches(identity))
              throw new Error("Workspace transfer account changed.");
            const owner = {
              tabId,
              desktopId: desktop.id,
              projectId: desktop.projectId,
              workerId: desktop.workerId,
            };
            const lifecycle = getRemoteDesktopTransferLifecycle(owner);
            if (!lifecycle)
              throw new Error(
                "The remote desktop view is not attached for transfer.",
              );
            desktopEntries.push({ ...owner, lifecycle });
            continue;
          }
          if (surface.kind === "browser") {
            const owner = {
              tabId,
              projectId: surface.entity.projectId,
              browserId: surface.entity.id,
              workerId: surface.entity.workerId ?? "",
            };
            const lifecycle = getBrowserTransferLifecycle(owner);
            if (!lifecycle)
              throw new Error("The browser is not attached for transfer.");
            browserEntries.push({ ...owner, lifecycle });
            continue;
          }
          if (surface.kind === "file") {
            const document = surface.entity;
            const lifecycle = input.explorers.get(tabId);
            if (!lifecycle)
              throw new Error(
                "The document view is not attached for transfer.",
              );
            entries.push({
              tabId,
              lifecycle,
              scope: {
                serverId: identity.serverId,
                ownerId: identity.userId,
                explorerId: tabId,
                documentId: document.id,
                documentPath: document.path,
                projectId: document.projectId,
                worktreeId: document.worktreeId,
                workerId: document.workerId,
              },
            });
            continue;
          }
          const entity = surface.entity;
          if (surface.kind === "terminal") {
            const owner = {
              tabId,
              projectId: entity.projectId,
              terminalId: entity.id,
              workerId: entity.activeWorkerId,
            };
            const lifecycle = getTerminalTransferLifecycle(owner);
            if (!lifecycle)
              throw new Error("The terminal is not attached for transfer.");
            terminalEntries.push({ ...owner, lifecycle });
            continue;
          }
          const lifecycle =
            surface.kind === "code"
              ? getNativeCodeLifecycle(entity.id)
              : input.explorers.get(entity.id);
          if (!lifecycle)
            throw new Error("The editor is not attached for transfer.");
          entries.push({
            tabId,
            lifecycle,
            scope: {
              serverId: identity.serverId,
              ownerId: identity.userId,
              explorerId: entity.id,
              projectId: entity.projectId,
              worktreeId: entity.worktreeId,
              workerId: entity.activeWorkerId,
            },
          });
        }
        const batch = prepareWorkspaceViewTransferBatch(
          entries,
          terminalEntries,
          browserEntries,
          chatEntries,
          desktopEntries,
        );
        return {
          capture: batch.captureBytes,
          retire: async () => batch.retire(),
          resume: async () => batch.resume(),
        };
      },
    });
  } finally {
    input.signal?.removeEventListener("abort", abort);
    unsubscribe();
    unsubscribeSession();
  }
}
