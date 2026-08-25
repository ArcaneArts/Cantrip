import type { ArchivedStandaloneChatSummary } from "@cantrip/protocol";
import {
  ArchiveRestore,
  Clock3,
  Loader2,
  MessageSquare,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { InlineAlert } from "@/components/ui/inline-alert";

const archiveDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function archivedChatRecoveryLabel(
  expiresAt: string,
  now = Date.now(),
): string {
  const days = Math.max(
    0,
    Math.ceil((Date.parse(expiresAt) - now) / 86_400_000),
  );
  if (days === 0) return "Deletes today";
  return `Deletes in ${days} ${days === 1 ? "day" : "days"}`;
}

export interface ArchivedStandaloneChatsPageProps {
  chats: readonly ArchivedStandaloneChatSummary[];
  deleting: boolean;
  error?: unknown;
  loading: boolean;
  restoring: boolean;
  onPermanentlyDelete(chat: ArchivedStandaloneChatSummary): void;
  onRestore(chat: ArchivedStandaloneChatSummary): void;
}

export function ArchivedStandaloneChatsPage({
  chats,
  deleting,
  error,
  loading,
  restoring,
  onPermanentlyDelete,
  onRestore,
}: ArchivedStandaloneChatsPageProps) {
  const [deleteTarget, setDeleteTarget] =
    useState<ArchivedStandaloneChatSummary | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">
            Archived chats
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Conversations and scratch files remain recoverable until their
            deletion date.
          </p>
        </div>

        {error ? (
          <InlineAlert className="mb-4" error={error} tone="error" />
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 border-y py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading archive…
          </div>
        ) : chats.length === 0 ? (
          <div className="border-y py-16 text-center text-sm text-muted-foreground">
            <ArchiveRestore className="mx-auto mb-3 size-6" />
            No archived chats
          </div>
        ) : (
          <div className="divide-y border-y">
            {chats.map((chat) => (
              <div
                className="flex flex-wrap items-center gap-3 px-1 py-4"
                key={chat.id}
              >
                <MessageSquare className="size-4 shrink-0" />
                <div className="min-w-48 flex-1">
                  <p className="truncate text-sm font-medium">{chat.title}</p>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{chat.messageCount} messages</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="size-3" />
                      {archivedChatRecoveryLabel(chat.expiresAt)}
                    </span>
                    <span>{archiveDate.format(new Date(chat.expiresAt))}</span>
                  </p>
                </div>
                <Button
                  disabled={restoring || deleting}
                  size="sm"
                  variant="outline"
                  onClick={() => onRestore(chat)}
                >
                  {restoring ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArchiveRestore className="size-4" />
                  )}
                  Restore
                </Button>
                <Button
                  aria-label={`Permanently delete ${chat.title}`}
                  className="size-8"
                  disabled={restoring || deleting}
                  size="icon"
                  variant="ghost"
                  onClick={() => setDeleteTarget(chat)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        confirmLabel={
          <>
            <Trash2 className="size-4" /> Delete permanently
          </>
        }
        description={`${deleteTarget?.title ?? "This chat"}, its messages, and its scratch files will be permanently deleted. This cannot be undone.`}
        onConfirm={() => {
          if (!deleteTarget) return;
          onPermanentlyDelete(deleteTarget);
          setDeleteTarget(null);
        }}
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Permanently delete this chat?"
      />
    </div>
  );
}
