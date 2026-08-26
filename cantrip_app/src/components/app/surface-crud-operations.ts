import type {
  BrowserSummary,
  ChatSummary,
  CodeTabSummary,
  ExplorerSummary,
  ProjectViewSummary,
  TerminalSummary,
} from "@cantrip/protocol";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";

import type { PendingTerminalInput } from "@/components/app/surface-creation-operations";
import {
  confirmExplorerDiscard,
  deleteExplorerAfterPreparation,
} from "@/components/explorer/explorer-lifecycle";
import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import {
  acknowledgeChatCompletion,
  deleteBrowser,
  deleteChat,
  deleteCodeTab,
  deleteExplorer,
  deleteProjectView,
  deleteTerminal,
  forkChat,
  renameChat,
  renameExplorer,
  renameProjectView,
  renameTerminal,
  updateBrowser,
  updateCodeTab,
} from "@/lib/api";
import { operateRunConfigurationRuntime } from "@/lib/run-configuration-api";

export function useChatRenameAndForkOperations({
  openCreatedTab,
  queryClient,
  selectedProjectId,
}: {
  openCreatedTab: (projectId: string, kind: "chat", tabId: string) => void;
  queryClient: QueryClient;
  selectedProjectId: string | null;
}) {
  const renameChatMutation = useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) =>
      renameChat(chatId, title),
    onSuccess: (renamed) => {
      if (renamed.contextKind === "standalone") return;
      queryClient.setQueryData<ChatSummary[]>(
        ["chats", renamed.projectId],
        (current = []) =>
          current.map((chat) => (chat.id === renamed.id ? renamed : chat)),
      );
    },
  });
  const { mutate: acknowledgeSelectedChatCompletion } = useMutation({
    mutationFn: ({ chatId }: { chatId: string; projectId: string }) =>
      acknowledgeChatCompletion(chatId),
    onSuccess: (acknowledged) => {
      if (acknowledged.contextKind === "standalone") return;
      queryClient.setQueryData<ChatSummary[]>(
        ["chats", acknowledged.projectId],
        (current = []) =>
          current.map((chat) =>
            chat.id === acknowledged.id ? acknowledged : chat,
          ),
      );
    },
    retry: 2,
  });
  const forkChatMutation = useMutation({
    mutationFn: (chatId: string) => {
      const source = queryClient
        .getQueryData<ChatSummary[]>(["chats", selectedProjectId])
        ?.find(({ id }) => id === chatId);
      if (!source) throw new Error("The source chat is unavailable.");
      return forkChat(chatId, source.title);
    },
    onSuccess: async (forked) => {
      if (forked.contextKind === "standalone") return;
      await queryClient.invalidateQueries({
        queryKey: ["chats", forked.projectId],
      });
      openCreatedTab(forked.projectId, "chat", forked.id);
    },
  });
  return {
    acknowledgeSelectedChatCompletion,
    forkChatMutation,
    renameChatMutation,
  } as const;
}

export function useChatDeleteOperation({
  queryClient,
  selectedProjectId,
  setChatConsoleOpen,
  setProjectTaskChatIds,
  setTaskChatViewIds,
}: {
  queryClient: QueryClient;
  selectedProjectId: string | null;
  setChatConsoleOpen: (chatId: string, open: boolean) => void;
  setProjectTaskChatIds: Dispatch<SetStateAction<ReadonlyMap<string, string>>>;
  setTaskChatViewIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
}) {
  return useMutation({
    mutationFn: deleteChat,
    onSuccess: async (_value, deletedId) => {
      setChatConsoleOpen(deletedId, false);
      setTaskChatViewIds((current) => {
        if (!current.has(deletedId)) return current;
        const next = new Set(current);
        next.delete(deletedId);
        return next;
      });
      setProjectTaskChatIds((current) => {
        const next = new Map(
          [...current].filter(([, chatId]) => chatId !== deletedId),
        );
        if (next.size === current.size) return current;
        return next;
      });
      await queryClient.invalidateQueries({
        queryKey: ["chats", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["archived-chats", selectedProjectId],
      });
    },
  });
}

export function useTerminalSurfaceOperations({
  queryClient,
  selectedProjectId,
  setPendingTerminalInputs,
  setTerminalServiceTerminalId,
  terminalServiceTerminalId,
}: {
  queryClient: QueryClient;
  selectedProjectId: string | null;
  setPendingTerminalInputs: Dispatch<SetStateAction<PendingTerminalInput[]>>;
  setTerminalServiceTerminalId: (terminalId: string | null) => void;
  terminalServiceTerminalId: string | null;
}) {
  const renameTerminalMutation = useMutation({
    mutationFn: ({
      terminalId,
      title,
    }: {
      terminalId: string;
      title: string;
    }) => renameTerminal(terminalId, title),
    onSuccess: (renamed) =>
      queryClient.setQueryData<TerminalSummary[]>(
        ["terminals", renamed.projectId],
        (current = []) =>
          current.map((terminal) =>
            terminal.id === renamed.id ? renamed : terminal,
          ),
      ),
  });
  const deleteTerminalMutation = useMutation({
    mutationFn: deleteTerminal,
    onSuccess: async (_value, deletedId) => {
      if (terminalServiceTerminalId === deletedId) {
        setTerminalServiceTerminalId(null);
      }
      setPendingTerminalInputs((current) =>
        current.filter(({ terminalId }) => terminalId !== deletedId),
      );
      await queryClient.invalidateQueries({
        queryKey: ["terminals", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  const stopAndDeleteRunTerminalMutation = useMutation({
    mutationFn: async (terminal: TerminalSummary) => {
      if (
        terminal.kind !== "run-configuration" ||
        !terminal.runConfigurationId
      ) {
        throw new Error("Only a bound Run terminal can be stopped and closed.");
      }
      await operateRunConfigurationRuntime({
        operation: "stop",
        projectId: terminal.projectId,
        configurationId: terminal.runConfigurationId,
        targetWorktreeId: terminal.worktreeId,
      });
      await deleteTerminal(terminal.id);
    },
    onSuccess: async (_value, terminal) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["terminals", terminal.projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", terminal.projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["run-configuration-runtimes", terminal.projectId],
        }),
      ]);
    },
  });
  return {
    deleteTerminalMutation,
    renameTerminalMutation,
    stopAndDeleteRunTerminalMutation,
  } as const;
}

export function useExplorerSurfaceOperations({
  explorerLifecycleRef,
  queryClient,
  selectedProjectId,
}: {
  explorerLifecycleRef: { current: Map<string, ExplorerLifecycleActions> };
  queryClient: QueryClient;
  selectedProjectId: string | null;
}) {
  const renameExplorerMutation = useMutation({
    mutationFn: ({
      explorerId,
      title,
    }: {
      explorerId: string;
      title: string;
    }) => renameExplorer(explorerId, title),
    onSuccess: (renamed) =>
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", renamed.projectId],
        (current = []) =>
          current.map((explorer) =>
            explorer.id === renamed.id ? renamed : explorer,
          ),
      ),
  });
  const deleteExplorerMutation = useMutation({
    mutationFn: (explorerId: string) =>
      deleteExplorerAfterPreparation(
        explorerLifecycleRef.current.get(explorerId),
        () => deleteExplorer(explorerId),
      ),
    onSuccess: async (_value, deletedId) => {
      explorerLifecycleRef.current.delete(deletedId);
      await queryClient.invalidateQueries({
        queryKey: ["explorers", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  const requestDeleteExplorer = (explorerId: string) => {
    const lifecycle = explorerLifecycleRef.current.get(explorerId);
    if (
      !confirmExplorerDiscard(lifecycle, () =>
        window.confirm(
          "Delete this Explorer and discard its unsaved file changes?",
        ),
      )
    ) {
      return;
    }
    deleteExplorerMutation.mutate(explorerId);
  };
  return {
    deleteExplorerMutation,
    renameExplorerMutation,
    requestDeleteExplorer,
  } as const;
}

export function useBrowserSurfaceOperations({
  queryClient,
  selectedProjectId,
}: {
  queryClient: QueryClient;
  selectedProjectId: string | null;
}) {
  const updateBrowserMutation = useMutation({
    mutationFn: ({
      browserId,
      input,
    }: {
      browserId: string;
      input: { title?: string; url?: string; stateRevision?: number };
    }) => updateBrowser(browserId, input),
    onSuccess: (updated) =>
      queryClient.setQueryData<BrowserSummary[]>(
        ["browsers", updated.projectId],
        (current = []) =>
          current.map((browser) =>
            browser.id === updated.id ? updated : browser,
          ),
      ),
  });
  const deleteBrowserMutation = useMutation({
    mutationFn: deleteBrowser,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["browsers", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  return { deleteBrowserMutation, updateBrowserMutation } as const;
}

export function useCodeSurfaceOperations({
  queryClient,
  selectedProjectId,
}: {
  queryClient: QueryClient;
  selectedProjectId: string | null;
}) {
  const updateCodeTabMutation = useMutation({
    mutationFn: ({ codeTabId, title }: { codeTabId: string; title: string }) =>
      updateCodeTab(codeTabId, { title }),
    onSuccess: (updated) =>
      queryClient.setQueryData<CodeTabSummary[]>(
        ["code-tabs", updated.projectId],
        (current = []) =>
          current.map((codeTab) =>
            codeTab.id === updated.id ? updated : codeTab,
          ),
      ),
  });
  const deleteCodeTabMutation = useMutation({
    mutationFn: deleteCodeTab,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["code-tabs", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  return { deleteCodeTabMutation, updateCodeTabMutation } as const;
}

export function useProjectViewSurfaceOperations({
  queryClient,
  selectedProjectId,
}: {
  queryClient: QueryClient;
  selectedProjectId: string | null;
}) {
  const renameProjectViewMutation = useMutation({
    mutationFn: ({ viewId, title }: { viewId: string; title: string }) =>
      renameProjectView(viewId, title),
    onSuccess: (renamed) =>
      queryClient.setQueryData<ProjectViewSummary[]>(
        ["project-views", renamed.projectId],
        (current = []) =>
          current.map((view) => (view.id === renamed.id ? renamed : view)),
      ),
  });
  const deleteProjectViewMutation = useMutation({
    mutationFn: deleteProjectView,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["project-views", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  return { deleteProjectViewMutation, renameProjectViewMutation } as const;
}
