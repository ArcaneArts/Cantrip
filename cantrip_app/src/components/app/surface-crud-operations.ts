import type {
  BrowserSummary,
  ChatSummary,
  CodeTabSummary,
  ExplorerSummary,
  ProjectViewSummary,
  TerminalSummary,
} from "@cantrip/protocol";
import {
  useMutation,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRef, type Dispatch, type SetStateAction } from "react";

import type { PendingTerminalInput } from "@/components/app/surface-creation-operations";
import type {
  ProjectSurfaceCloseCoordinator,
  ProjectSurfaceCloseInput,
  StoredProjectSurfaceKind,
} from "@/components/app/project-surface-close";
import { confirmExplorerDiscard } from "@/components/explorer/explorer-lifecycle";
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

function withImmediateClose<TData, TError, TVariables, TContext>(
  mutation: UseMutationResult<TData, TError, TVariables, TContext>,
  begin: (variables: TVariables) => void,
): UseMutationResult<TData, TError, TVariables, TContext> {
  return {
    ...mutation,
    mutate: (variables, options) => {
      begin(variables);
      mutation.mutate(variables, options);
    },
    mutateAsync: (variables, options) => {
      begin(variables);
      return mutation.mutateAsync(variables, options);
    },
  };
}

function useImmediateProjectSurfaceDelete<TData, TVariables>({
  getProjectId,
  getTabId,
  kind,
  mutationFn,
  onBegin,
  onError,
  onSuccess,
  selectedProjectId,
  surfaceClose,
}: {
  getProjectId?: (variables: TVariables) => string | null;
  getTabId: (variables: TVariables) => string;
  kind: StoredProjectSurfaceKind;
  mutationFn: (variables: TVariables) => Promise<TData>;
  onBegin?: (variables: TVariables) => void;
  onError?: (error: Error, variables: TVariables) => void;
  onSuccess?: (
    data: TData,
    variables: TVariables,
    projectId: string | null,
  ) => Promise<void> | void;
  selectedProjectId: string | null;
  surfaceClose: ProjectSurfaceCloseCoordinator;
}): UseMutationResult<TData, Error, TVariables> {
  const pending = useRef(new Map<string, ProjectSurfaceCloseInput>());
  const mutation = useMutation<TData, Error, TVariables>({
    mutationFn,
    onError: (error, variables) => {
      const tabId = getTabId(variables);
      const input = pending.current.get(tabId);
      pending.current.delete(tabId);
      if (input) surfaceClose.rollback(input);
      onError?.(error, variables);
    },
    onSuccess: async (data, variables) => {
      const tabId = getTabId(variables);
      const input = pending.current.get(tabId);
      pending.current.delete(tabId);
      if (input) surfaceClose.commit(input);
      await onSuccess?.(data, variables, input?.projectId ?? selectedProjectId);
    },
  });
  return withImmediateClose(mutation, (variables) => {
    onBegin?.(variables);
    const projectId = getProjectId?.(variables) ?? selectedProjectId;
    if (!projectId) return;
    const tabId = getTabId(variables);
    const input = {
      kind,
      projectId,
      tabId,
    } satisfies ProjectSurfaceCloseInput;
    pending.current.set(tabId, input);
    surfaceClose.begin(input);
  });
}

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
  surfaceClose,
}: {
  queryClient: QueryClient;
  selectedProjectId: string | null;
  setChatConsoleOpen: (chatId: string, open: boolean) => void;
  setProjectTaskChatIds: Dispatch<SetStateAction<ReadonlyMap<string, string>>>;
  setTaskChatViewIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  surfaceClose: ProjectSurfaceCloseCoordinator;
}) {
  return useImmediateProjectSurfaceDelete({
    getTabId: (tabId: string) => tabId,
    kind: "chat",
    mutationFn: deleteChat,
    onSuccess: async (_value, deletedId, projectId) => {
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
      await queryClient.invalidateQueries({ queryKey: ["chats", projectId] });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", projectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["archived-chats", projectId],
      });
    },
    selectedProjectId,
    surfaceClose,
  });
}

export function useTerminalSurfaceOperations({
  queryClient,
  selectedProjectId,
  setPendingTerminalInputs,
  setTerminalServiceTerminalId,
  surfaceClose,
  terminalServiceTerminalId,
}: {
  queryClient: QueryClient;
  selectedProjectId: string | null;
  setPendingTerminalInputs: Dispatch<SetStateAction<PendingTerminalInput[]>>;
  setTerminalServiceTerminalId: (terminalId: string | null) => void;
  surfaceClose: ProjectSurfaceCloseCoordinator;
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
  const deleteTerminalMutation = useImmediateProjectSurfaceDelete({
    getTabId: (tabId: string) => tabId,
    kind: "terminal",
    mutationFn: deleteTerminal,
    onSuccess: async (_value, deletedId, projectId) => {
      if (terminalServiceTerminalId === deletedId) {
        setTerminalServiceTerminalId(null);
      }
      setPendingTerminalInputs((current) =>
        current.filter(({ terminalId }) => terminalId !== deletedId),
      );
      await queryClient.invalidateQueries({
        queryKey: ["terminals", projectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", projectId],
      });
    },
    selectedProjectId,
    surfaceClose,
  });
  const stopAndDeleteRunTerminalMutation = useImmediateProjectSurfaceDelete({
    getProjectId: (terminal: TerminalSummary) => terminal.projectId,
    getTabId: (terminal: TerminalSummary) => terminal.id,
    kind: "terminal",
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
    selectedProjectId,
    surfaceClose,
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
  surfaceClose,
}: {
  explorerLifecycleRef: { current: Map<string, ExplorerLifecycleActions> };
  queryClient: QueryClient;
  selectedProjectId: string | null;
  surfaceClose: ProjectSurfaceCloseCoordinator;
}) {
  const preparedCloseActions = useRef(
    new Map<
      string,
      {
        actions: ExplorerLifecycleActions | undefined;
        preparation: Promise<void>;
      }
    >(),
  );
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
  const deleteExplorerMutation = useImmediateProjectSurfaceDelete({
    getTabId: (explorerId: string) => explorerId,
    kind: "explorer",
    mutationFn: async (explorerId: string) => {
      const prepared = preparedCloseActions.current.get(explorerId);
      await prepared?.preparation;
      return deleteExplorer(explorerId);
    },
    onBegin: (explorerId) => {
      const actions = explorerLifecycleRef.current.get(explorerId);
      preparedCloseActions.current.set(explorerId, {
        actions,
        preparation: actions?.prepareClose() ?? Promise.resolve(),
      });
    },
    onError: (_error, deletedId) => {
      preparedCloseActions.current.get(deletedId)?.actions?.cancelClose();
      preparedCloseActions.current.delete(deletedId);
    },
    onSuccess: async (_value, deletedId, projectId) => {
      preparedCloseActions.current.delete(deletedId);
      explorerLifecycleRef.current.delete(deletedId);
      await queryClient.invalidateQueries({
        queryKey: ["explorers", projectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", projectId],
      });
    },
    selectedProjectId,
    surfaceClose,
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
  surfaceClose,
}: {
  queryClient: QueryClient;
  selectedProjectId: string | null;
  surfaceClose: ProjectSurfaceCloseCoordinator;
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
  const deleteBrowserMutation = useImmediateProjectSurfaceDelete({
    getTabId: (browserId: string) => browserId,
    kind: "browser",
    mutationFn: deleteBrowser,
    onSuccess: async (_value, _deletedId, projectId) => {
      await queryClient.invalidateQueries({
        queryKey: ["browsers", projectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", projectId],
      });
    },
    selectedProjectId,
    surfaceClose,
  });
  return { deleteBrowserMutation, updateBrowserMutation } as const;
}

export function useCodeSurfaceOperations({
  queryClient,
  selectedProjectId,
  surfaceClose,
}: {
  queryClient: QueryClient;
  selectedProjectId: string | null;
  surfaceClose: ProjectSurfaceCloseCoordinator;
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
  const deleteCodeTabMutation = useImmediateProjectSurfaceDelete({
    getTabId: (codeTabId: string) => codeTabId,
    kind: "code",
    mutationFn: deleteCodeTab,
    onSuccess: async (_value, _deletedId, projectId) => {
      await queryClient.invalidateQueries({
        queryKey: ["code-tabs", projectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", projectId],
      });
    },
    selectedProjectId,
    surfaceClose,
  });
  return { deleteCodeTabMutation, updateCodeTabMutation } as const;
}

export function useProjectViewSurfaceOperations({
  queryClient,
  selectedProjectId,
  surfaceClose,
}: {
  queryClient: QueryClient;
  selectedProjectId: string | null;
  surfaceClose: ProjectSurfaceCloseCoordinator;
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
  const deleteProjectViewMutation = useImmediateProjectSurfaceDelete({
    getTabId: (viewId: string) => viewId,
    kind: "view",
    mutationFn: deleteProjectView,
    onSuccess: async (_value, _deletedId, projectId) => {
      await queryClient.invalidateQueries({
        queryKey: ["project-views", projectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", projectId],
      });
    },
    selectedProjectId,
    surfaceClose,
  });
  return { deleteProjectViewMutation, renameProjectViewMutation } as const;
}
