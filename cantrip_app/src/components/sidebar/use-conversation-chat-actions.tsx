import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatSummary } from "@cantrip/protocol";
import { renameChat } from "@/lib/api/chats";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import { prepareConversationFork } from "@/lib/api/conversations";
import { errorMessage } from "@/lib/error-message";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";

/** Reuses the encrypted chat actions; sidebar forks are resources, not tabs. */
export function useConversationChatActions(projectId: string) {
  const queryClient = useQueryClient();
  const renderedIdentity = getClientSessionIdentitySnapshot();
  const scope = useRef(projectId);
  scope.current = projectId;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const forks = useRef(
    new Map<
      string,
      {
        projectId: string;
        identity: NonNullable<
          ReturnType<typeof getClientSessionIdentitySnapshot>
        >;
        run: Awaited<ReturnType<typeof prepareConversationFork>>;
      }
    >(),
  );
  const busy = useRef(new Set<string>());
  const [pending, setPending] = useState(new Set<string>());
  const [errors, setErrors] = useState(new Map<string, unknown>());
  const [target, setTarget] = useState<ChatSummary | null>(null);
  const [title, setTitle] = useState("");
  useEffect(() => {
    setTarget(null);
    setErrors(new Map());
  }, [projectId]);
  async function run(chat: ChatSummary, action: "rename" | "fork") {
    if (busy.current.has(chat.id)) return;
    const identity = renderedIdentity;
    const current = () =>
      mounted.current &&
      scope.current === projectId &&
      chat.projectId === projectId &&
      identity &&
      clientSessionIdentityMatches(identity);
    if (!current()) return;
    busy.current.add(chat.id);
    setPending(new Set(busy.current));
    setErrors((previous) => {
      const next = new Map(previous);
      next.delete(chat.id);
      return next;
    });
    try {
      let changed;
      if (action === "rename")
        changed = await renameChat(chat.id, title.trim());
      else {
        let operation = forks.current.get(chat.id);
        if (
          operation &&
          (operation.projectId !== projectId ||
            !clientSessionIdentityMatches(operation.identity))
        ) {
          forks.current.delete(chat.id);
          operation = undefined;
        }
        if (!operation) {
          const run = await prepareConversationFork(
            projectId,
            chat.id,
            chat.title,
          );
          if (!current()) return;
          operation = { projectId, identity: identity!, run };
          forks.current.set(chat.id, operation);
        }
        changed = await operation.run();
      }
      if (!current()) return;
      if (
        changed.contextKind === "standalone" ||
        changed.projectId !== projectId
      )
        throw new Error("Chat action returned another project.");
      if (action === "fork") forks.current.delete(chat.id);
      await queryClient.invalidateQueries({ queryKey: ["chats", projectId] });
      if (current() && action === "rename") setTarget(null);
    } catch (error) {
      if (current())
        setErrors((previous) => new Map(previous).set(chat.id, error));
    } finally {
      busy.current.delete(chat.id);
      if (mounted.current) setPending(new Set(busy.current));
    }
  }
  return {
    pending,
    errors,
    rename: (chat: ChatSummary) => {
      setTarget(chat);
      setTitle(chat.title);
    },
    fork: (chat: ChatSummary) => {
      void run(chat, "fork");
    },
    dialog: (
      <ConfirmDialog
        open={Boolean(target)}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title="Rename chat"
        description={
          <label className="block">
            Chat name
            <Input
              aria-label="Chat name"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        }
        confirmLabel="Rename"
        confirmPendingLabel="Renaming…"
        confirmVariant="default"
        confirmDisabled={!title.trim()}
        pending={Boolean(target && pending.has(target.id))}
        error={
          target && errors.has(target.id)
            ? errorMessage(errors.get(target.id))
            : undefined
        }
        onConfirm={() => {
          if (target) void run(target, "rename");
        }}
      />
    ),
  };
}
