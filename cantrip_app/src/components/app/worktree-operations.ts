import type {
  ChatSummary,
  CodeTabSummary,
  ExplorerSummary,
  ProjectViewSummary,
  ProjectWorktreeCreate,
  ProjectWorktreeSummary,
  TerminalSummary,
} from "@cantrip/protocol";
import { useMutation, type QueryClient } from "@tanstack/react-query";

import type { WorktreeBindingTarget } from "@/components/app/application-shell-model";
import type { CodeHeaderState } from "@/components/code/code-view";
import { runCodeWorktreeChange } from "@/components/code/code-worktree-change";
import { prepareExplorerRebind as prepareExplorerRebindLifecycle } from "@/components/explorer/explorer-lifecycle";
import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import {
  createProjectWorktree,
  updateChatWorktree,
  updateBuiltInSurfaceWorktree,
  updateCodeTabWorktree,
  updateExplorerWorktree,
  updateProjectViewWorktree,
  updateTerminalWorktree,
} from "@/lib/api";
import { errorMessage as errorText } from "@/lib/error-message";

export function useWorktreeOperations({
  codeHeader,
  explorerLifecycleRef,
  queryClient,
  setWorktreeActionError,
}: {
  codeHeader: CodeHeaderState | null;
  explorerLifecycleRef: { current: Map<string, ExplorerLifecycleActions> };
  queryClient: QueryClient;
  setWorktreeActionError: (error: string | null) => void;
}) {
  const bindWorktreeMutation = useMutation({
    mutationFn: async ({
      target,
      worktreeId,
      mode,
    }: {
      target: WorktreeBindingTarget;
      worktreeId: string;
      mode?: "agent-managed" | "pinned";
    }) => {
      if (target.kind === "chat") {
        return {
          kind: "chat" as const,
          value: await updateChatWorktree(target.tabId, {
            worktreeId,
            mode: mode ?? target.mode,
          }),
        };
      }
      if (target.kind === "terminal") {
        return {
          kind: "terminal" as const,
          value: await updateTerminalWorktree(target.tabId, worktreeId),
        };
      }
      if (target.kind === "explorer") {
        return {
          kind: "explorer" as const,
          value: await updateExplorerWorktree(target.tabId, worktreeId),
        };
      }
      if (target.kind === "code") {
        return {
          kind: "code" as const,
          value: await updateCodeTabWorktree(target.tabId, worktreeId),
        };
      }
      if (target.kind === "builtin") {
        return {
          kind: "builtin" as const,
          value: await updateBuiltInSurfaceWorktree(
            target.projectId,
            target.definitionId,
            worktreeId,
          ),
        };
      }
      return {
        kind: "history" as const,
        value: await updateProjectViewWorktree(target.tabId, worktreeId),
      };
    },
    onMutate: async ({ target, worktreeId, mode }) => {
      setWorktreeActionError(null);
      if (target.kind !== "chat") return {};
      const queryKey = ["chats", target.projectId] as const;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ChatSummary[]>(queryKey);
      queryClient.setQueryData<ChatSummary[]>(queryKey, (current = []) =>
        current.map((chat) =>
          chat.id === target.tabId
            ? {
                ...chat,
                activeWorktreeId: worktreeId,
                worktreeMode: mode ?? target.mode,
              }
            : chat,
        ),
      );
      return { previous, queryKey };
    },
    onSuccess: ({ kind, value }) => {
      if (kind === "chat") {
        queryClient.setQueryData<ChatSummary[]>(
          ["chats", value.projectId],
          (current = []) =>
            current.map((chat) => (chat.id === value.id ? value : chat)),
        );
        void queryClient.invalidateQueries({
          queryKey: ["terminals", value.projectId],
        });
      } else if (kind === "terminal") {
        queryClient.setQueryData<TerminalSummary[]>(
          ["terminals", value.projectId],
          (current = []) =>
            current.map((terminal) =>
              terminal.id === value.id ? value : terminal,
            ),
        );
      } else if (kind === "explorer") {
        queryClient.setQueryData<ExplorerSummary[]>(
          ["explorers", value.projectId],
          (current = []) =>
            current.map((explorer) =>
              explorer.id === value.id ? value : explorer,
            ),
        );
        void Promise.all([
          queryClient.invalidateQueries({
            queryKey: [
              "explorer-directory",
              value.projectId,
              value.worktreeId,
              value.id,
            ],
          }),
          queryClient.invalidateQueries({
            queryKey: ["explorer-file", value.id],
          }),
        ]);
      } else if (kind === "code") {
        queryClient.setQueryData<CodeTabSummary[]>(
          ["code-tabs", value.projectId],
          (current = []) =>
            current.map((codeTab) =>
              codeTab.id === value.id ? value : codeTab,
            ),
        );
      } else if (kind === "history") {
        queryClient.setQueryData<ProjectViewSummary[]>(
          ["project-views", value.projectId],
          (current = []) =>
            current.map((view) => (view.id === value.id ? value : view)),
        );
      } else {
        queryClient.setQueryData(
          ["project-tab-layout", value.projectId],
          value,
        );
      }
    },
    onError: (error, input, context) => {
      if (context?.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      if (input.target.kind === "history") {
        void queryClient.invalidateQueries({
          queryKey: ["project-views", input.target.projectId],
        });
      }
      if (input.target.kind === "builtin") {
        void queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", input.target.projectId],
        });
      }
      if (input.target.kind === "code") {
        void queryClient.invalidateQueries({
          queryKey: ["code-tabs", input.target.projectId],
        });
      }
      setWorktreeActionError(errorText(error));
    },
  });
  const prepareExplorerRebind = async (target: WorktreeBindingTarget) => {
    if (target.kind !== "explorer") return true;
    const lifecycle = explorerLifecycleRef.current.get(target.tabId);
    const result = await prepareExplorerRebindLifecycle(lifecycle, () =>
      window.confirm(
        "Switch this Explorer to another worktree and discard its unsaved changes?",
      ),
    );
    if (result === "state-failed") {
      setWorktreeActionError(
        "Explorer view state could not be saved before switching worktrees.",
      );
    }
    return result === "ready";
  };
  const requestBindWorktree = async (input: {
    target: WorktreeBindingTarget;
    worktreeId: string;
    mode?: "agent-managed" | "pinned";
  }) => {
    if (!(await prepareExplorerRebind(input.target))) return false;
    const codeNeedsPause =
      input.target.kind === "code" &&
      Boolean(
        codeHeader?.runtime ||
        codeHeader?.status === "starting" ||
        codeHeader?.status === "running",
      );
    return runCodeWorktreeChange({
      active: codeNeedsPause,
      header: codeHeader,
      rebind: async () => {
        try {
          await bindWorktreeMutation.mutateAsync(input);
          return true;
        } catch {
          return false;
        }
      },
    });
  };
  const createWorktreeMutation = useMutation({
    mutationFn: ({
      projectId,
      input,
    }: {
      projectId: string;
      input: ProjectWorktreeCreate;
    }) => createProjectWorktree(projectId, input),
    onSuccess: (created) => {
      queryClient.setQueryData<ProjectWorktreeSummary[]>(
        ["worktrees", created.projectId],
        (current = []) => [
          ...current.filter((worktree) => worktree.id !== created.id),
          created,
        ],
      );
    },
  });
  return {
    bindWorktreeMutation,
    createWorktreeMutation,
    prepareExplorerRebind,
    requestBindWorktree,
  } as const;
}
