import type { ArchivedChatSummary, ChatSummary } from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveRestore,
  Clock3,
  ListTodo,
  Loader2,
  MessageSquare,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  getArchivedChats,
  permanentlyDeleteArchivedChat,
  restoreArchivedChat,
} from "@/lib/api";

const archiveDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

function archivedFor(chat: ArchivedChatSummary): string {
  const days = Math.max(
    0,
    Math.ceil((Date.now() - new Date(chat.archivedAt).getTime()) / 86_400_000),
  );
  return days === 0 ? "today" : `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function ProjectArchiveSettings({
  projectId,
  onRestoreChat,
}: {
  projectId: string;
  onRestoreChat?(chat: ChatSummary): void;
}) {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<ArchivedChatSummary | null>(
    null,
  );
  const archived = useQuery({
    queryKey: ["archived-chats", projectId],
    queryFn: () => getArchivedChats(projectId),
  });
  const restore = useMutation({
    mutationFn: (chatId: string) => restoreArchivedChat(chatId),
    onSuccess: (chat) => {
      if (chat.contextKind === "standalone") return;
      void queryClient.invalidateQueries({ queryKey: ["chats", projectId] });
      void queryClient.invalidateQueries({
        queryKey: ["archived-chats", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", projectId],
      });
      onRestoreChat?.(chat);
    },
  });
  const remove = useMutation({
    mutationFn: (chatId: string) => permanentlyDeleteArchivedChat(chatId),
    onSuccess: () => {
      setDeleteTarget(null);
      void queryClient.invalidateQueries({
        queryKey: ["archived-chats", projectId],
      });
    },
  });
  const error = archived.error ?? restore.error ?? remove.error;
  const chats = archived.data ?? [];

  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
      <section aria-labelledby="project-archive-title">
        <div className="mb-4">
          <h2 id="project-archive-title" className="font-semibold">
            Archived agents and tasks{" "}
            <span className="text-muted-foreground">{chats.length}</span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Agents and Tasks with conversation history remain recoverable for 90
            days. Empty items are removed immediately.
          </p>
        </div>

        {error ? (
          <p className="mb-3 text-sm text-destructive">
            {error instanceof Error
              ? error.message
              : "The archive could not be updated."}
          </p>
        ) : null}

        <div className="border-y">
          {archived.isLoading ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading archive…
            </div>
          ) : chats.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <ArchiveRestore className="mx-auto mb-3 size-5 text-muted-foreground" />
              <p className="text-sm font-medium">No archived agents or Tasks</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Removed agents and Tasks with messages will appear here.
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {chats.map((chat) => (
                <div
                  key={chat.id}
                  className="grid min-h-14 gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <p className="flex min-w-0 items-center gap-2 truncate text-sm font-medium">
                      {chat.experience === "task" ? (
                        <ListTodo className="size-3.5 shrink-0" />
                      ) : (
                        <MessageSquare className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate">{chat.title}</span>
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <MessageSquare className="size-3" />
                        {chat.messageCount}{" "}
                        {chat.messageCount === 1 ? "message" : "messages"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="size-3" /> Archived{" "}
                        {archivedFor(chat)}
                      </span>
                      <span>
                        Deletes {archiveDate.format(new Date(chat.expiresAt))}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={restore.isPending || remove.isPending}
                      onClick={() => restore.mutate(chat.id)}
                    >
                      <ArchiveRestore className="size-4" /> Restore
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label={`Permanently delete ${chat.title}`}
                      disabled={restore.isPending || remove.isPending}
                      onClick={() => setDeleteTarget(chat)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <ConfirmDialog
        confirmDisabled={!deleteTarget}
        confirmLabel={
          <>
            <Trash2 className="size-4" /> Delete permanently
          </>
        }
        confirmPendingLabel="Deleting…"
        description={`${deleteTarget?.title ?? "This item"} and its entire conversation history will be deleted. This cannot be undone.`}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        pending={remove.isPending}
        title={
          <>
            Permanently delete this{" "}
            {deleteTarget?.experience === "task" ? "Task" : "agent"}?
          </>
        }
      />
    </div>
  );
}
