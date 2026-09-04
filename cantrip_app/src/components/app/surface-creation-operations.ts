import type {
  ArchivedStandaloneChatSummary,
  BrowserSummary,
  ChatComposerDraft,
  ChatSummary,
  CodeTabSummary,
  ExecutionTarget,
  GithubAgentWorkflowContext,
  ExplorerEntry,
  ExplorerSummary,
  ProjectViewSummary,
  RemoteDesktopTarget,
  StandaloneChatSummary,
  TerminalSummary,
} from "@cantrip/protocol";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";

import type {
  ApplicationInventory,
  ProjectInventory,
} from "@/components/app/project-inventory";
import type { ProjectWorkspaceResources } from "@/components/app/project-workspace-resources";
import { newAgentChatTitle } from "@/components/chat/agent-chat-name";
import { explorerGraphRootForEntry } from "@/components/explorer/explorer-graph-routing";
import type { ExplorerGraphRequest } from "@/components/explorer/explorer-view";
import {
  acknowledgeChatCompletion,
  createBrowser,
  createChat,
  createChatConsole,
  createCodeTab,
  createExplorer,
  createRemoteDesktop,
  createStandaloneChat,
  createTask,
  createTerminal,
  deleteChat,
  forkChat,
  permanentlyDeleteArchivedChat,
  renameChat,
  restoreArchivedChat,
  saveChatComposerDraft,
  startTurn,
} from "@/lib/api";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import { errorMessage as errorText } from "@/lib/error-message";

export interface PendingTerminalInput {
  data: string;
  id: string;
  terminalId: string;
}

type OpenCreatedTab = (
  projectId: string,
  kind: "browser" | "chat" | "code" | "explorer" | "terminal" | "view",
  tabId: string,
) => void;

export function useProjectChatCreationOperation({
  openCreatedTab,
  queryClient,
  randomAgentNames,
  resources,
}: {
  openCreatedTab: OpenCreatedTab;
  queryClient: QueryClient;
  randomAgentNames: boolean;
  resources: Pick<
    ProjectWorkspaceResources,
    | "browsers"
    | "chats"
    | "codeTabs"
    | "explorers"
    | "projectViews"
    | "terminals"
  >;
}) {
  return useMutation({
    mutationFn: ({
      projectId,
      paneId,
      title,
      worktreeId,
      worktreeMode,
      target,
      initialDraft,
      githubAgentContext,
      startInitialDraft,
    }: {
      githubAgentContext?: GithubAgentWorkflowContext;
      initialDraft?: ChatComposerDraft;
      startInitialDraft?: boolean;
      open?: boolean;
      projectId: string;
      paneId?: string;
      title?: string;
      worktreeId?: string;
      worktreeMode?: "agent-managed" | "pinned";
      target?: ExecutionTarget;
    }) => {
      const existingTitles = [
        ...(resources.chats.data ?? []),
        ...(resources.terminals.data ?? []),
        ...(resources.explorers.data ?? []),
        ...(resources.browsers.data ?? []),
        ...(resources.codeTabs.data ?? []),
        ...(resources.projectViews.data ?? []),
      ]
        .filter((surface) => surface.projectId === projectId)
        .map((surface) => surface.title);
      return createChat(
        projectId,
        title ?? newAgentChatTitle(existingTitles, randomAgentNames),
        worktreeId,
        worktreeMode,
        paneId,
        target,
        githubAgentContext,
      ).then(async (chat) => {
        if (initialDraft) {
          await saveChatComposerDraft(chat.id, initialDraft);
          queryClient.setQueryData(
            ["chat-composer-draft", chat.id],
            initialDraft,
          );
          if (startInitialDraft && chat.modelId) {
            try {
              await startTurn(
                chat.id,
                initialDraft.text,
                {
                  modelId: chat.modelId,
                  reasoningEffort:
                    initialDraft.reasoningEffort ?? chat.reasoningEffort,
                  customSubagentModel: chat.customSubagentModel ?? false,
                  subagentModelId: chat.subagentModelId ?? null,
                  subagentReasoningEffort: chat.subagentReasoningEffort ?? null,
                },
                [],
                initialDraft.mode,
              );
              await saveChatComposerDraft(chat.id, null);
              queryClient.setQueryData(["chat-composer-draft", chat.id], null);
            } catch {
              // Keep the complete draft visible when starting is unavailable.
            }
          }
        }
        return chat;
      });
    },
    onSuccess: (chat, { open }) => {
      queryClient.setQueryData<ChatSummary[]>(
        ["chats", chat.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== chat.id), chat].sort(
            (left, right) => left.position - right.position,
          ),
      );
      if (open !== false) {
        openCreatedTab(chat.projectId, "chat", chat.id);
      } else {
        void queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", chat.projectId],
        });
      }
      void queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
    },
  });
}

export function useStandaloneChatOperations({
  bootstrap,
  persistAppDestination,
  queryClient,
  randomAgentNames,
  selectedStandaloneChatId,
  setSelectedStandaloneChatId,
  setShowArchivedStandaloneChats,
  standaloneChats,
  standaloneChatWorkerAvailable,
}: {
  bootstrap: ApplicationInventory["bootstrap"];
  persistAppDestination: (patch: {
    lastAppMode?: "chat" | "ide";
    lastStandaloneChatId?: string | null;
  }) => Promise<void>;
  queryClient: QueryClient;
  randomAgentNames: boolean;
  selectedStandaloneChatId: string | null;
  setSelectedStandaloneChatId: (chatId: string | null) => void;
  setShowArchivedStandaloneChats: (show: boolean) => void;
  standaloneChats: ProjectInventory["standaloneChats"];
  standaloneChatWorkerAvailable: boolean;
}) {
  const newStandaloneChat = useMutation({
    mutationFn: () => {
      if (bootstrap.data?.capabilities.standaloneChat.available === false) {
        throw new Error(
          bootstrap.data.capabilities.standaloneChat.reason ??
            "Standalone Chat is unavailable on this server.",
        );
      }
      if (!standaloneChatWorkerAvailable) {
        throw new Error(
          "Connect an online worker with standalone Chat scratch support first.",
        );
      }
      return createStandaloneChat(
        newAgentChatTitle(
          (standaloneChats.data ?? []).map(({ title }) => title),
          randomAgentNames,
        ),
      );
    },
    onSuccess: (chat) => {
      queryClient.setQueryData<StandaloneChatSummary[]>(
        ["standalone-chats"],
        (current = []) =>
          [...current.filter(({ id }) => id !== chat.id), chat].sort(
            (left, right) => left.position - right.position,
          ),
      );
      setSelectedStandaloneChatId(chat.id);
      setShowArchivedStandaloneChats(false);
      void persistAppDestination({
        lastAppMode: "chat",
        lastStandaloneChatId: chat.id,
      });
    },
  });
  const renameStandaloneChat = useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) =>
      renameChat(chatId, title),
    onSuccess: (renamed) => {
      if (renamed.contextKind !== "standalone") return;
      queryClient.setQueryData<StandaloneChatSummary[]>(
        ["standalone-chats"],
        (current = []) =>
          current.map((chat) => (chat.id === renamed.id ? renamed : chat)),
      );
    },
  });
  const forkStandaloneChat = useMutation({
    mutationFn: (chat: StandaloneChatSummary) => forkChat(chat.id, chat.title),
    onSuccess: (forked) => {
      if (forked.contextKind !== "standalone") return;
      void queryClient.invalidateQueries({ queryKey: ["standalone-chats"] });
      setSelectedStandaloneChatId(forked.id);
      void persistAppDestination({
        lastAppMode: "chat",
        lastStandaloneChatId: forked.id,
      });
    },
  });
  const archiveStandaloneChat = useMutation({
    mutationFn: (chat: StandaloneChatSummary) => deleteChat(chat.id),
    onSuccess: async (_result, chat) => {
      if (selectedStandaloneChatId === chat.id) {
        setSelectedStandaloneChatId(null);
        void persistAppDestination({ lastStandaloneChatId: null });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["standalone-chats"] }),
        queryClient.invalidateQueries({
          queryKey: ["archived-standalone-chats"],
        }),
      ]);
    },
  });
  const restoreStandaloneChat = useMutation({
    mutationFn: (chat: ArchivedStandaloneChatSummary) =>
      restoreArchivedChat(chat.id),
    onSuccess: (restored) => {
      if (restored.contextKind !== "standalone") return;
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["standalone-chats"] }),
        queryClient.invalidateQueries({
          queryKey: ["archived-standalone-chats"],
        }),
      ]);
      setSelectedStandaloneChatId(restored.id);
      setShowArchivedStandaloneChats(false);
      void persistAppDestination({
        lastAppMode: "chat",
        lastStandaloneChatId: restored.id,
      });
    },
  });
  const permanentlyDeleteStandaloneChat = useMutation({
    mutationFn: (chat: ArchivedStandaloneChatSummary) =>
      permanentlyDeleteArchivedChat(chat.id),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["archived-standalone-chats"],
      }),
  });
  return {
    archiveStandaloneChat,
    forkStandaloneChat,
    newStandaloneChat,
    permanentlyDeleteStandaloneChat,
    renameStandaloneChat,
    restoreStandaloneChat,
  } as const;
}

export function useStandaloneChatCompletionOperation(queryClient: QueryClient) {
  const { mutate: acknowledgeSelectedStandaloneChatCompletion } = useMutation({
    mutationFn: (chatId: string) => acknowledgeChatCompletion(chatId),
    onSuccess: (acknowledged) => {
      if (acknowledged.contextKind !== "standalone") return;
      queryClient.setQueryData<StandaloneChatSummary[]>(
        ["standalone-chats"],
        (current = []) =>
          current.map((chat) =>
            chat.id === acknowledged.id ? acknowledged : chat,
          ),
      );
    },
    retry: 2,
  });
  return acknowledgeSelectedStandaloneChatCompletion;
}

export function useProjectTaskCreationOperation({
  openProjectTask,
  queryClient,
}: {
  openProjectTask: (projectId: string, chatId: string) => void;
  queryClient: QueryClient;
}) {
  return useMutation({
    mutationFn: ({
      projectId,
      paneId,
      worktreeId,
      worktreeMode,
      target,
    }: {
      projectId: string;
      paneId?: string;
      worktreeId?: string;
      worktreeMode?: "agent-managed" | "pinned";
      target?: ExecutionTarget;
    }) =>
      createTask(
        projectId,
        "New task",
        worktreeId,
        worktreeMode,
        paneId,
        target,
      ),
    onSuccess: ({ chat, task }) => {
      queryClient.setQueryData<ChatSummary[]>(
        ["chats", chat.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== chat.id), chat].sort(
            (left, right) => left.position - right.position,
          ),
      );
      queryClient.setQueryData(["task", chat.id], task);
      openProjectTask(chat.projectId, chat.id);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
        queryClient.invalidateQueries({
          queryKey: ["project-task-workload", chat.projectId],
        }),
      ]);
    },
  });
}

export function useTerminalCreationOperation({
  openCreatedTab,
  queryClient,
  setPendingTerminalInputs,
}: {
  openCreatedTab: OpenCreatedTab;
  queryClient: QueryClient;
  setPendingTerminalInputs: Dispatch<SetStateAction<PendingTerminalInput[]>>;
}) {
  return useMutation({
    mutationFn: ({
      projectId,
      directoryPath,
      paneId,
      title,
      worktreeId,
      target,
      initialInput: _initialInput,
    }: {
      initialInput?: string;
      projectId: string;
      directoryPath?: string;
      paneId?: string;
      title?: string;
      worktreeId?: string;
      target?: ExecutionTarget;
    }) =>
      createTerminal(
        projectId,
        title ?? "Terminal",
        worktreeId,
        paneId,
        target,
        directoryPath,
      ),
    onSuccess: (terminal, { initialInput }) => {
      queryClient.setQueryData<TerminalSummary[]>(
        ["terminals", terminal.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== terminal.id), terminal].sort(
            (left, right) => left.position - right.position,
          ),
      );
      if (initialInput) {
        setPendingTerminalInputs((current) => [
          ...current,
          {
            data: initialInput,
            id: crypto.randomUUID(),
            terminalId: terminal.id,
          },
        ]);
      }
      openCreatedTab(terminal.projectId, "terminal", terminal.id);
      void queryClient.invalidateQueries({
        queryKey: ["terminals", terminal.projectId],
      });
    },
  });
}

export function useChatConsoleOperation({
  queryClient,
  setChatConsoleOpen,
}: {
  queryClient: QueryClient;
  setChatConsoleOpen: (chatId: string, open: boolean) => void;
}) {
  return useMutation({
    mutationFn: (chatId: string) => createChatConsole(chatId),
    onError: (error, chatId) => {
      clientLogger.error("Codex console failed to open", {
        chatId,
        ...operationalErrorMetadata(error),
        event: "surface.codex-console.open.failed",
        operation: "open-console",
        reasonCode: "request-failed",
        status: "failed",
        subsystem: "codex-console",
      });
    },
    onSuccess: (terminal, chatId) => {
      queryClient.setQueryData<TerminalSummary[]>(
        ["terminals", terminal.projectId],
        (current = []) => [
          ...current.filter((item) => item.id !== terminal.id),
          terminal,
        ],
      );
      setChatConsoleOpen(chatId, true);
    },
  });
}

export function useExplorerCreationOperations({
  openCreatedTab,
  queryClient,
  setExplorerGraphRequest,
  setPopoutError,
}: {
  openCreatedTab: OpenCreatedTab;
  queryClient: QueryClient;
  setExplorerGraphRequest: Dispatch<
    SetStateAction<ExplorerGraphRequest | null>
  >;
  setPopoutError: (error: string | null) => void;
}) {
  const newExplorer = useMutation({
    mutationFn: ({
      projectId,
      paneId,
      worktreeId,
      target,
    }: {
      projectId: string;
      paneId?: string;
      worktreeId?: string;
      target?: ExecutionTarget;
    }) => createExplorer(projectId, "Explorer", worktreeId, paneId, target),
    onSuccess: (explorer) => {
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", explorer.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== explorer.id), explorer].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(explorer.projectId, "explorer", explorer.id);
      void queryClient.invalidateQueries({
        queryKey: ["explorers", explorer.projectId],
      });
    },
  });
  const newGraphExplorer = useMutation({
    mutationFn: ({
      explorer,
      entry,
      paneId,
    }: {
      explorer: ExplorerSummary;
      entry: ExplorerEntry;
      paneId?: string;
    }) =>
      createExplorer(
        explorer.projectId,
        `Graph · ${entry.name}`,
        explorer.worktreeId,
        paneId,
        {
          kind: "worktree",
          projectId: explorer.projectId,
          worktreeId: explorer.worktreeId,
        },
      ),
    onError: (error) => setPopoutError(errorText(error)),
    onSuccess: (createdExplorer, { entry }) => {
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", createdExplorer.projectId],
        (current = []) =>
          [
            ...current.filter((item) => item.id !== createdExplorer.id),
            createdExplorer,
          ].sort((left, right) => left.position - right.position),
      );
      setExplorerGraphRequest({
        explorerId: createdExplorer.id,
        requestId: crypto.randomUUID(),
        rootPath: explorerGraphRootForEntry(entry),
      });
      openCreatedTab(createdExplorer.projectId, "explorer", createdExplorer.id);
      void queryClient.invalidateQueries({
        queryKey: ["explorers", createdExplorer.projectId],
      });
    },
  });
  return { newExplorer, newGraphExplorer } as const;
}

export function useBrowserCodeViewCreationOperations({
  openCreatedTab,
  queryClient,
}: {
  openCreatedTab: OpenCreatedTab;
  queryClient: QueryClient;
}) {
  const newBrowser = useMutation({
    mutationFn: ({
      projectId,
      paneId,
      target,
      title,
      url,
    }: {
      projectId: string;
      paneId?: string;
      target?: ExecutionTarget;
      title?: string;
      url?: string;
    }) => createBrowser(projectId, title ?? "Browser", paneId, target, url),
    onSuccess: (browser) => {
      queryClient.setQueryData<BrowserSummary[]>(
        ["browsers", browser.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== browser.id), browser].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(browser.projectId, "browser", browser.id);
      void queryClient.invalidateQueries({
        queryKey: ["browsers", browser.projectId],
      });
    },
  });
  const newCodeTab = useMutation({
    mutationFn: ({
      projectId,
      paneId,
      worktreeId,
      target,
    }: {
      projectId: string;
      paneId?: string;
      worktreeId?: string;
      target?: ExecutionTarget;
    }) => createCodeTab(projectId, "Code", worktreeId, paneId, target),
    onSuccess: (codeTab) => {
      queryClient.setQueryData<CodeTabSummary[]>(
        ["code-tabs", codeTab.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== codeTab.id), codeTab].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(codeTab.projectId, "code", codeTab.id);
      void queryClient.invalidateQueries({
        queryKey: ["code-tabs", codeTab.projectId],
      });
    },
  });
  return { newBrowser, newCodeTab } as const;
}

export function useRemoteDesktopCreationOperation({
  openCreatedTab,
  queryClient,
}: {
  openCreatedTab: OpenCreatedTab;
  queryClient: QueryClient;
}) {
  return useMutation({
    mutationFn: ({
      projectId,
      paneId,
      target,
      desktopTarget,
    }: {
      projectId: string;
      paneId?: string;
      target?: ExecutionTarget;
      desktopTarget?: RemoteDesktopTarget;
    }) => createRemoteDesktop(projectId, paneId, target, desktopTarget),
    onSuccess: (desktop) => {
      queryClient.setQueryData<ProjectViewSummary[]>(
        ["project-views", desktop.projectId],
        (current = []) =>
          [
            ...current.filter((item) => item.id !== desktop.id),
            {
              id: desktop.id,
              projectId: desktop.projectId,
              title: desktop.title,
              kind: "remote-desktop" as const,
              worktreeId: null,
              position: desktop.position,
              createdAt: desktop.createdAt,
              updatedAt: desktop.updatedAt,
            },
          ].sort((left, right) => left.position - right.position),
      );
      queryClient.setQueryData(["remote-desktop", desktop.id], desktop);
      void queryClient.invalidateQueries({
        queryKey: ["remote-desktop-fleet", desktop.projectId],
      });
      openCreatedTab(desktop.projectId, "view", desktop.id);
      void queryClient.invalidateQueries({
        queryKey: ["project-views", desktop.projectId],
      });
    },
  });
}
