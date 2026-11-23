import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { workspacePaneViews } from "@cantrip/protocol";
import { checkpointChatView } from "@/components/chat/chat-transfer-lifecycle";
import {
  archiveAgentConversation,
  restoreAgentConversation,
  permanentlyDeleteAgentConversation,
} from "@/lib/api/conversations";
import {
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
} from "@/lib/client-session";
import { forgetChatComposerDraftPersistence } from "@/lib/chat-composer-draft-persistence";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
export type ConversationLifecycleAction = "archive" | "restore" | "delete";

/** Per-resource mutations; an unrelated pending chat never blocks navigation. */
export function useConversationLifecycle(
  projectId: string,
  controller: WorkspaceCommandClient | null,
) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, unknown>>(new Map());
  const [completed, setCompleted] = useState<{
    chatId: string;
    action: ConversationLifecycleAction;
    sequence: number;
  } | null>(null);
  const busy = useRef(new Set<string>());
  const mounted = useRef(false);
  const scope = useRef({ projectId, controller });
  scope.current = { projectId, controller };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(
    chatId: string,
    action: ConversationLifecycleAction,
    stopRunning = false,
  ) {
    if (busy.current.has(chatId)) return false;
    const identity = getClientSessionIdentitySnapshot();
    const current = () =>
      mounted.current &&
      identity &&
      clientSessionIdentityMatches(identity) &&
      scope.current.projectId === projectId &&
      scope.current.controller === controller;
    const assertCurrent = () => {
      if (!current())
        throw new Error(
          "The conversation workspace changed. Try again in the current sidebar.",
        );
    };
    busy.current.add(chatId);
    setPending(new Set(busy.current));
    setErrors((previous) => {
      const next = new Map(previous);
      next.delete(chatId);
      return next;
    });
    const reconcile = () =>
      Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["chats", projectId] }),
        queryClient.invalidateQueries({
          queryKey: ["archived-chats", projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", projectId],
        }),
        ...(action === "restore"
          ? [
              "native-settings",
              "permission-profiles",
              "chat-runtime-selection",
            ].map((key) =>
              queryClient.invalidateQueries({ queryKey: [key, chatId] }),
            )
          : []),
        Promise.resolve().then(() => controller?.refresh()),
      ]);
    let mutationAttempted = false;
    const releases: Array<() => void> = [];
    try {
      assertCurrent();
      if (action === "archive") {
        for (const view of controller
          ?.getSnapshot()
          .projected.windows.flatMap((window) =>
            window.panes.flatMap(workspacePaneViews),
          ) ?? []) {
          if (
            view.resource.kind === "entity" &&
            view.resource.definitionId === "project.agent" &&
            view.resource.resourceId === chatId
          ) {
            releases.push(
              await checkpointChatView({ tabId: view.id, chatId, projectId }),
            );
            assertCurrent();
          }
        }
        mutationAttempted = true;
        await archiveAgentConversation(chatId, stopRunning, identity!);
      } else if (action === "restore") {
        mutationAttempted = true;
        await restoreAgentConversation(projectId, chatId, identity!);
      } else {
        mutationAttempted = true;
        await permanentlyDeleteAgentConversation(chatId, identity!);
      }
      assertCurrent();
      if (action === "delete") {
        forgetChatComposerDraftPersistence(queryClient, chatId);
        for (const key of [
          "chat-composer-draft",
          "messages",
          "chat-sync",
          "prompt-queue",
          "goal",
          "plan",
          "chat-runtime-selection",
          "native-settings",
        ])
          queryClient.removeQueries({ queryKey: [key, chatId] });
      }
      // A failed refresh cannot undo a committed archive/restore/delete. Live
      // and ordinary query retry keep reconciling the authoritative transition.
      await reconcile();
      assertCurrent();
      setCompleted((previous) => ({
        chatId,
        action,
        sequence: (previous?.sequence ?? 0) + 1,
      }));
      return true;
    } catch (error) {
      // A lost response can follow a committed mutation. Refresh without
      // guessing success or discarding drafts on an unconfirmed deletion.
      if (current() && mutationAttempted) await reconcile();
      if (current())
        setErrors((previous) => new Map(previous).set(chatId, error));
      return false;
    } finally {
      for (const release of releases.reverse()) release();
      busy.current.delete(chatId);
      if (mounted.current) setPending(new Set(busy.current));
    }
  }
  return {
    pending,
    errors,
    completed,
    archive: (chatId: string, stopRunning = false) =>
      run(chatId, "archive", stopRunning),
    restore: (chatId: string) => run(chatId, "restore"),
    remove: (chatId: string) => run(chatId, "delete"),
  };
}
