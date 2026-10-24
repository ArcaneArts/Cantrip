import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { getFileDocuments, type FileDocument } from "@/lib/api/file-documents";
import type {
  TerminalSummary,
  ExplorerSummary,
  CodeTabSummary,
  BrowserSummary,
  ChatSummary,
} from "@cantrip/protocol";
import type { TerminalTransferStaging } from "@/components/terminal/terminal-view";
import type {
  ExplorerTransferState,
  ExplorerTransferStaging,
  IncomingEditorView,
} from "@/components/explorer/explorer-view";
import { stageWorkspaceViewTransferBatch } from "./workspace-view-transfer-batch";
import type { TerminalViewState } from "@/components/terminal/terminal-view-state";
import {
  getCodeTabs,
  getExplorers,
  getTerminals,
  getBrowsers,
  getChats,
} from "@/lib/api";
import type {
  BrowserViewState,
  BrowserTransferStaging,
} from "@/components/browser/browser-view-state";
import type { IncomingBrowserView } from "@/components/browser/persistent-browser-views";
import type {
  ChatViewState,
  ChatTransferStaging,
  IncomingChatView,
} from "@/components/chat/chat-view-state";
import {
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";
import type { DesktopPopoutPaneTarget } from "@/lib/desktop-popout";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import { startWorkspaceTransferDestination } from "@/lib/workspace-transfer-destination";

const sessionKey = () => JSON.stringify(getClientSessionIdentitySnapshot());
const subscribeSession = (listener: () => void) =>
  onClientSessionIdentityChanged(listener);
const noSubscription = () => () => {};
type StagedEditor =
  | {
      tabId: string;
      kind: "chat";
      state: ChatViewState;
      chat: ChatSummary;
      staging: ChatTransferStaging;
    }
  | {
      tabId: string;
      kind: "file";
      state: ExplorerTransferState;
      resource: FileDocument;
      staging: ExplorerTransferStaging;
    }
  | {
      tabId: string;
      kind: "browser";
      state: BrowserViewState;
      browser: BrowserSummary;
      staging: BrowserTransferStaging;
    }
  | {
      tabId: string;
      kind: "explorer";
      state: ExplorerTransferState;
      resource: ExplorerSummary;
      staging: ExplorerTransferStaging;
    }
  | {
      tabId: string;
      kind: "code";
      state: ExplorerTransferState;
      resource: CodeTabSummary;
      staging: ExplorerTransferStaging;
    }
  | {
      tabId: string;
      kind: "terminal";
      state: TerminalViewState;
      terminal: TerminalSummary;
      staging: TerminalTransferStaging;
    };

/** Destination staging is private renderer state, never persisted in the layout.
 * Incoming views mount passively and acknowledge restoration before commit. */
export function useWorkspaceEditorTransfer({
  connection,
  target: launchTarget,
  onError,
}: {
  connection?: { controller: WorkspaceCommandClient; windowId: string };
  target: DesktopPopoutPaneTarget | null;
  onError(error: unknown): void;
}) {
  const identityKey = useSyncExternalStore(
    subscribeSession,
    sessionKey,
    sessionKey,
  );
  const readIncoming = useCallback(() => {
    const layout = connection?.controller.getSnapshot().authoritative;
    const transfer = layout?.pendingTransfers?.find(
      (candidate) =>
        candidate.returnSplitId &&
        candidate.destinationWindowId === connection?.windowId,
    );
    return JSON.stringify(
      transfer
        ? {
            projectId: layout!.projectId,
            paneId: transfer.destinationPaneId,
            activeTabKey: transfer.tabIds[0]!,
            transfer: {
              id: transfer.id,
              workspaceId: layout!.id,
              windowId: transfer.destinationWindowId,
              generation: transfer.destinationGeneration,
            },
          }
        : null,
    );
  }, [connection?.controller, connection?.windowId]);
  const incoming = useSyncExternalStore(
    connection?.controller.subscribe ?? noSubscription,
    readIncoming,
    readIncoming,
  );
  const readRetainedTabs = useCallback(() => {
    const snapshot = connection?.controller.getSnapshot();
    if (!snapshot || snapshot.disposed) return "[]";
    const layout = snapshot.authoritative;
    return JSON.stringify(
      [
        ...new Set([
          ...(layout.windows
            .find(({ id }) => id === connection?.windowId)
            ?.panes.flatMap((pane) => pane.tabs.map(({ id }) => id)) ?? []),
          ...(layout.pendingTransfers ?? [])
            .filter(
              ({ destinationWindowId }) =>
                destinationWindowId === connection?.windowId,
            )
            .flatMap(({ tabIds }) => tabIds),
        ]),
      ].sort(),
    );
  }, [connection?.controller, connection?.windowId]);
  const retainedKey = useSyncExternalStore(
    connection?.controller.subscribe ?? noSubscription,
    readRetainedTabs,
    readRetainedTabs,
  );
  const retainedTabs = useMemo<ReadonlySet<string>>(
    () => new Set(JSON.parse(retainedKey)),
    [retainedKey],
  );
  const readPendingTabs = useCallback(
    () =>
      JSON.stringify(
        connection?.controller
          .getSnapshot()
          .authoritative.pendingTransfers?.filter(
            (transfer) => transfer.destinationWindowId === connection.windowId,
          )
          .flatMap((transfer) => transfer.tabIds) ?? [],
      ),
    [connection?.controller, connection?.windowId],
  );
  const pendingKey = useSyncExternalStore(
    connection?.controller.subscribe ?? noSubscription,
    readPendingTabs,
    readPendingTabs,
  );
  const pendingTabs = useMemo<ReadonlySet<string>>(
    () => new Set(JSON.parse(pendingKey)),
    [pendingKey],
  );
  const target = useMemo<DesktopPopoutPaneTarget | null>(
    () => JSON.parse(incoming) ?? launchTarget,
    [incoming, launchTarget],
  );
  const routeKey = JSON.stringify(target);
  const liveRoute = useRef(routeKey);
  liveRoute.current = routeKey;
  const context = useMemo(
    () => ({}),
    [connection?.controller, connection?.windowId, identityKey],
  );
  const liveContext = useRef(context);
  liveContext.current = context;
  const reportError = useRef(onError);
  reportError.current = onError;
  const [staged, setStaged] = useState<{
    context: object;
    editors: readonly StagedEditor[];
  } | null>(null);
  useEffect(() => {
    setStaged((current) => {
      if (!current || current.context !== context) return null;
      const editors = current.editors.filter(({ tabId }) =>
        retainedTabs.has(tabId),
      );
      return editors.length === current.editors.length
        ? current
        : { context, editors };
    });
  }, [context, retainedTabs, staged]);
  useEffect(() => {
    setStaged((current) => (current?.context === context ? current : null));
    if (!connection || !target?.transfer) return;
    const identity = getClientSessionIdentitySnapshot();
    if (!identity) return;
    const { controller, windowId } = connection;
    // A restored window may retain its launch URL after a completed transfer.
    // Never replay the old snapshot over its live editors.
    if (
      !controller
        .getSnapshot()
        .authoritative.pendingTransfers?.some(
          ({ id }) => id === target.transfer!.id,
        )
    )
      return;
    let disposed = false;
    const waiting = new Set<(error: unknown) => void>();
    const rejectWaiting = (error: unknown) => {
      for (const reject of waiting) reject(error);
      waiting.clear();
    };
    const assertCurrent = () => {
      if (
        disposed ||
        liveRoute.current !== routeKey ||
        liveContext.current !== context ||
        sessionKey() !== identityKey
      )
        throw new Error("Workspace editor transfer context changed.");
    };
    const fail = (error: unknown) => {
      if (!disposed && liveContext.current === context)
        reportError.current(error);
    };
    let receiver:
      ReturnType<typeof startWorkspaceTransferDestination> | undefined;
    let unsubscribe: (() => void) | undefined;
    let readyTimer: ReturnType<typeof setInterval> | undefined;
    try {
      receiver = startWorkspaceTransferDestination({
        controller,
        windowId,
        target,
        identity: { serverId: identity.serverId, ownerId: identity.userId },
        onError: fail,
        restore: async (bytes) => {
          assertCurrent();
          const layout = controller.getSnapshot().authoritative;
          const reservation = layout.pendingTransfers?.find(
            ({ id }) => id === target.transfer!.id,
          );
          const pane = layout.windows
            .find(({ id }) => id === reservation?.sourceWindowId)
            ?.panes.find(({ id }) => id === reservation?.sourcePaneId);
          if (!reservation || !pane)
            throw new Error("Workspace transfer source is unavailable.");
          const tabs = reservation.tabIds.map((id) => {
            const tab = pane.tabs.find((candidate) => candidate.id === id);
            if (!tab) throw new Error("Workspace transfer tab is unavailable.");
            return tab;
          });
          const editorTabs = tabs.filter(({ resource }) =>
            ["project.file", "project.explorer", "project.code"].includes(
              resource.definitionId,
            ),
          );
          const terminalTabs = tabs.filter(
            ({ resource }) => resource.definitionId === "project.terminal",
          );
          const browserTabs = tabs.filter(
            ({ resource }) => resource.definitionId === "project.browser",
          );
          const chatTabs = tabs.filter(
            ({ resource }) => resource.definitionId === "project.agent",
          );
          if (
            editorTabs.length +
              terminalTabs.length +
              browserTabs.length +
              chatTabs.length !==
            tabs.length
          )
            throw new Error(
              "This surface does not yet have a workspace transfer adapter.",
            );
          const [explorers, code, terminals, browsers, documents, chats] =
            await Promise.all([
              editorTabs.some(
                ({ resource }) => resource.definitionId !== "project.code",
              )
                ? getExplorers(layout.projectId)
                : [],
              editorTabs.some(
                ({ resource }) => resource.definitionId === "project.code",
              )
                ? getCodeTabs(layout.projectId)
                : [],
              terminalTabs.length ? getTerminals(layout.projectId) : [],
              browserTabs.length ? getBrowsers(layout.projectId) : [],
              editorTabs.some(
                ({ resource }) => resource.definitionId === "project.file",
              )
                ? getFileDocuments(layout.projectId)
                : [],
              chatTabs.length ? getChats(layout.projectId) : [],
            ]);
          assertCurrent();
          const expected = editorTabs.map((tab) => {
            const isCode = tab.resource.definitionId === "project.code";
            const resource = tab.resource;
            const document =
              resource.kind === "entity" &&
              resource.definitionId === "project.file"
                ? documents.find(({ id }) => id === resource.resourceId)
                : undefined;
            if (document) {
              if (document.projectId !== layout.projectId)
                throw new Error(
                  "Transferred document resource is unavailable.",
                );
              return {
                tabId: tab.id,
                scope: {
                  serverId: identity.serverId,
                  ownerId: identity.userId,
                  explorerId: tab.id,
                  documentId: document.id,
                  documentPath: document.path,
                  projectId: document.projectId,
                  worktreeId: document.worktreeId,
                  workerId: document.workerId,
                },
              };
            }
            const entity =
              resource.kind === "entity"
                ? (isCode ? code : explorers).find(
                    ({ id }) => id === resource.resourceId,
                  )
                : undefined;
            if (!entity || entity.projectId !== layout.projectId)
              throw new Error("Transferred editor resource is unavailable.");
            return {
              tabId: tab.id,
              scope: {
                serverId: identity.serverId,
                ownerId: identity.userId,
                explorerId: entity.id,
                projectId: entity.projectId,
                worktreeId: entity.worktreeId,
                workerId: entity.activeWorkerId,
              },
            };
          });
          const expectedTerminals = terminalTabs.map((tab) => {
            const resource = tab.resource;
            const entity =
              resource.kind === "entity"
                ? terminals.find(({ id }) => id === resource.resourceId)
                : undefined;
            if (!entity || entity.projectId !== layout.projectId)
              throw new Error("Transferred terminal resource is unavailable.");
            return {
              tabId: tab.id,
              terminalId: entity.id,
              workerId: entity.activeWorkerId,
            };
          });
          const expectedBrowsers = browserTabs.map((tab) => {
            const resource = tab.resource;
            const entity =
              resource.kind === "entity"
                ? browsers.find(({ id }) => id === resource.resourceId)
                : undefined;
            if (
              !entity ||
              entity.projectId !== layout.projectId ||
              !entity.workerId
            )
              throw new Error("Transferred browser resource is unavailable.");
            return {
              tabId: tab.id,
              browserId: entity.id,
              projectId: entity.projectId,
              workerId: entity.workerId,
            };
          });
          const expectedChats = chatTabs.map((tab) => {
            const resource = tab.resource;
            const chat =
              resource.kind === "entity"
                ? chats.find(({ id }) => id === resource.resourceId)
                : undefined;
            if (!chat || chat.projectId !== layout.projectId)
              throw new Error("Transferred chat resource is unavailable.");
            return {
              tabId: tab.id,
              chatId: chat.id,
              projectId: chat.projectId,
            };
          });
          const {
            editors: snapshots,
            terminals: terminalSnapshots,
            browsers: browserSnapshots,
            chats: chatSnapshots,
          } = stageWorkspaceViewTransferBatch(
            bytes,
            expected,
            expectedTerminals,
            expectedBrowsers,
            expectedChats,
          );
          const explorerStates = new Map<string, ExplorerTransferState>();
          const codeStates = new Map<string, ExplorerTransferState>();
          snapshots.forEach(({ state }, index) => {
            const destination =
              editorTabs[index]!.resource.definitionId === "project.code"
                ? codeStates
                : explorerStates;
            if (destination.has(state.explorerId))
              throw new Error("Duplicate editor owner in workspace transfer.");
            destination.set(state.explorerId, state);
          });
          assertCurrent();
          const completions: Promise<void>[] = [];
          const restoration = () => {
            let resolve!: () => void;
            let reject!: (error: unknown) => void;
            const promise = new Promise<void>((yes, no) => {
              resolve = yes;
              reject = no;
            });
            void promise.catch(() => {});
            waiting.add(reject);
            completions.push(promise.finally(() => waiting.delete(reject)));
            return { onRestored: resolve, onError: reject };
          };
          const stagedEditors = snapshots.map(
            ({ tabId, state }, index): StagedEditor => {
              const staging = restoration();
              if (state.documentId)
                return {
                  tabId,
                  state,
                  kind: "file",
                  resource: documents.find(
                    ({ id }) => id === state.documentId,
                  )!,
                  staging,
                };
              return editorTabs[index]!.resource.definitionId === "project.code"
                ? {
                    tabId,
                    state,
                    kind: "code",
                    resource: code.find(({ id }) => id === state.explorerId)!,
                    staging,
                  }
                : {
                    tabId,
                    state,
                    kind: "explorer",
                    resource: explorers.find(
                      ({ id }) => id === state.explorerId,
                    )!,
                    staging,
                  };
            },
          );
          const stagedTerminals = terminalSnapshots.map(
            ({ tabId, state }): StagedEditor => {
              return {
                tabId,
                state,
                kind: "terminal",
                terminal: terminals.find(({ id }) => id === state.terminalId)!,
                staging: restoration(),
              };
            },
          );
          const stagedBrowsers = browserSnapshots.map(
            ({ tabId, state }): StagedEditor => ({
              tabId,
              state,
              kind: "browser",
              browser: browsers.find(({ id }) => id === state.browserId)!,
              staging: restoration(),
            }),
          );
          const stagedChats = chatSnapshots.map(
            ({ tabId, state }): StagedEditor => ({
              tabId,
              state,
              kind: "chat",
              chat: chats.find(({ id }) => id === state.chatId)!,
              staging: restoration(),
            }),
          );
          // Complete React staging before the coordinator acknowledges readiness.
          flushSync(() =>
            setStaged((current) => ({
              context,
              editors: [
                ...(current?.context === context
                  ? current.editors.filter(
                      ({ tabId }) =>
                        !snapshots.some(
                          (snapshot) => snapshot.tabId === tabId,
                        ) &&
                        !terminalSnapshots.some(
                          (snapshot) => snapshot.tabId === tabId,
                        ) &&
                        !browserSnapshots.some(
                          (snapshot) => snapshot.tabId === tabId,
                        ) &&
                        !chatSnapshots.some(
                          (snapshot) => snapshot.tabId === tabId,
                        ),
                    )
                  : []),
                ...stagedEditors,
                ...stagedTerminals,
                ...stagedBrowsers,
                ...stagedChats,
              ],
            })),
          );
          await Promise.all(completions);
          assertCurrent();
        },
      });
      // Main may observe a return reservation before the source HTTP response
      // arrives and its channel opens. Reannounce the same authenticated ready
      // state; elapsed time never grants ownership or proves owner death.
      readyTimer = setInterval(() => {
        void receiver!.announceReady().catch(fail);
      }, 1_000);
      unsubscribe = controller.subscribe(() => {
        const state = controller.getSnapshot();
        if (
          state.disposed ||
          !state.authoritative.pendingTransfers?.some(
            ({ id }) => id === target.transfer!.id,
          )
        ) {
          clearInterval(readyTimer);
          rejectWaiting(
            new Error(
              "Workspace transfer reservation ended before restoration.",
            ),
          );
          receiver?.dispose();
        }
      });
      void receiver.ready.catch((error: unknown) => {
        clearInterval(readyTimer);
        fail(error);
      });
    } catch (error) {
      fail(error);
    }
    return () => {
      disposed = true;
      rejectWaiting(new Error("Workspace transfer destination was disposed."));
      clearInterval(readyTimer);
      unsubscribe?.();
      receiver?.dispose();
    };
  }, [
    connection?.controller,
    connection?.windowId,
    context,
    identityKey,
    routeKey,
  ]);
  return useMemo(() => {
    if (staged?.context !== context)
      return {
        stagedExplorerTransfers: undefined,
        stagedCodeTransfers: undefined,
        stagedTerminalTransfers: undefined,
        incomingTerminalViews: undefined,
        incomingExplorerViews: undefined,
        incomingFileDocumentViews: undefined,
        incomingCodeViews: undefined,
        incomingBrowserViews: undefined,
        incomingChatViews: undefined,
      };
    const explorers = new Map<string, ExplorerTransferState>();
    const code = new Map<string, ExplorerTransferState>();
    const terminals = new Map<string, TerminalViewState>();
    const incomingExplorerViews: IncomingEditorView<ExplorerSummary>[] = [];
    const incomingFileDocumentViews: IncomingEditorView<FileDocument>[] = [];
    const incomingCodeViews: IncomingEditorView<CodeTabSummary>[] = [];
    const incomingBrowserViews: IncomingBrowserView[] = [];
    const incomingChatViews: IncomingChatView[] = [];
    const incomingTerminalViews: {
      tabId: string;
      terminal: TerminalSummary;
      state: TerminalViewState;
      staging?: TerminalTransferStaging;
    }[] = [];
    for (const editor of staged.editors) {
      if (!retainedTabs.has(editor.tabId)) continue;
      if (editor.kind === "chat") {
        incomingChatViews.push({
          ...editor,
          staging: pendingTabs.has(editor.tabId) ? editor.staging : undefined,
        });
        continue;
      }
      if (editor.kind === "file") {
        incomingFileDocumentViews.push({
          ...editor,
          staging: pendingTabs.has(editor.tabId) ? editor.staging : undefined,
        });
        continue;
      }
      if (editor.kind === "browser") {
        incomingBrowserViews.push({
          ...editor,
          staging: pendingTabs.has(editor.tabId) ? editor.staging : undefined,
        });
        continue;
      }
      if (editor.kind === "terminal") {
        terminals.set(editor.tabId, editor.state);
        incomingTerminalViews.push({
          tabId: editor.tabId,
          terminal: editor.terminal,
          state: editor.state,
          staging: pendingTabs.has(editor.tabId) ? editor.staging : undefined,
        });
        continue;
      }
      (editor.kind === "code" ? code : explorers).set(
        editor.state.explorerId,
        editor.state,
      );
      const staging = pendingTabs.has(editor.tabId)
        ? editor.staging
        : undefined;
      if (editor.kind === "code")
        incomingCodeViews.push({ ...editor, staging });
      else incomingExplorerViews.push({ ...editor, staging });
    }
    return {
      stagedExplorerTransfers: explorers,
      stagedCodeTransfers: code,
      stagedTerminalTransfers: terminals,
      incomingTerminalViews,
      incomingExplorerViews,
      incomingFileDocumentViews,
      incomingCodeViews,
      incomingBrowserViews,
      incomingChatViews,
    };
  }, [context, staged, retainedTabs, pendingTabs]);
}
