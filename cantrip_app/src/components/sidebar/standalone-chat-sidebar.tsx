import type {
  ArchivedStandaloneChatSummary,
  StandaloneChatSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import {
  Archive,
  ArchiveRestore,
  Bot,
  Clock3,
  Code2,
  Loader2,
  MessageSquare,
  Plus,
  Settings,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { ChatContextMenu, ChatDropdownMenu } from "@/components/chat/chat-menu";
import { ChatActivityStatus } from "@/components/chat/chat-activity-status";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import { cn } from "@/lib/utils";

const archiveDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function recoveryLabel(expiresAt: string): string {
  const days = Math.max(
    0,
    Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000),
  );
  if (days === 0) return "Deletes today";
  return `Deletes in ${days} ${days === 1 ? "day" : "days"}`;
}

function workerAvailable(
  chat: StandaloneChatSummary,
  workers: readonly WorkerSummary[],
) {
  if (!chat.activeWorkerId) return false;
  return workers.some(
    (worker) => worker.workerId === chat.activeWorkerId && worker.online,
  );
}

export interface StandaloneChatSidebarProps {
  archived: readonly ArchivedStandaloneChatSummary[];
  archivedLoading: boolean;
  chats: readonly StandaloneChatSummary[];
  creationDisabled?: boolean;
  creationUnavailableReason?: string | null;
  creating: boolean;
  error?: unknown;
  selectedChatId: string | null;
  workers: readonly WorkerSummary[];
  onArchive(chat: StandaloneChatSummary): void;
  onFork(chat: StandaloneChatSummary): void;
  onNewChat(): void;
  onOpenSettings(): void;
  onPermanentlyDelete(chat: ArchivedStandaloneChatSummary): void;
  onRename(chat: StandaloneChatSummary, title: string): void;
  onRestore(chat: ArchivedStandaloneChatSummary): void;
  onSelect(chat: StandaloneChatSummary): void;
  onSwitchIde(): void;
}

export function StandaloneChatSidebar({
  archived,
  archivedLoading,
  chats,
  creationDisabled = false,
  creationUnavailableReason = null,
  creating,
  error,
  selectedChatId,
  workers,
  onArchive,
  onFork,
  onNewChat,
  onOpenSettings,
  onPermanentlyDelete,
  onRename,
  onRestore,
  onSelect,
  onSwitchIde,
}: StandaloneChatSidebarProps) {
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [renameTarget, setRenameTarget] =
    useState<StandaloneChatSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] =
    useState<ArchivedStandaloneChatSummary | null>(null);

  const beginRename = (chat: StandaloneChatSummary) => {
    setRenameTarget(chat);
    setRenameValue(chat.title);
  };
  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    const title = renameValue.trim();
    if (!renameTarget || !title) return;
    onRename(renameTarget, title);
    setRenameTarget(null);
  };

  return (
    <>
      <div className="space-y-2 px-3 pb-2 pt-4">
        <Button
          className="w-full justify-start"
          variant="ghost"
          onClick={onSwitchIde}
        >
          <Code2 className="size-4" /> IDE
        </Button>
        <Button
          className="w-full justify-start"
          disabled={creating || creationDisabled}
          title={creationUnavailableReason ?? undefined}
          onClick={onNewChat}
        >
          {creating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          New Chat
        </Button>
      </div>

      <nav
        aria-label="Standalone chats"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
      >
        <p className="px-2 pb-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Chats
        </p>
        {error ? (
          <InlineAlert
            className="mx-1 mb-2"
            error={error}
            size="sm"
            tone="error"
          />
        ) : null}
        {chats.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            <MessageSquare className="mx-auto mb-2 size-5" />
            {creationUnavailableReason ??
              "Your standalone conversations will appear here."}
          </div>
        ) : (
          <div className="space-y-0.5">
            {chats.map((chat) => {
              const available = workerAvailable(chat, workers);
              const actions = {
                deleteLabel: "Archive",
                deleteDisabled:
                  chat.status === "running" ||
                  chat.status === "waiting-for-approval",
                onDelete: () => onArchive(chat),
                onDuplicate: () => onFork(chat),
                onRename: () => beginRename(chat),
              };
              return (
                <ChatContextMenu actions={actions} key={chat.id}>
                  <div
                    className={cn(
                      "group flex min-h-9 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted/60",
                      selectedChatId === chat.id && "bg-muted",
                    )}
                  >
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
                      onClick={() => onSelect(chat)}
                      type="button"
                    >
                      <Bot className="size-3.5 shrink-0" />
                      <span className="truncate">{chat.title}</span>
                      {!available || chat.status === "offline" ? (
                        <WifiOff
                          aria-label="Chat worker is offline"
                          className="ml-auto size-3.5 shrink-0 text-amber-500"
                        />
                      ) : chat.status === "failed" ? (
                        <span
                          className="ml-auto size-2 shrink-0 rounded-full bg-destructive"
                          aria-label="Chat failed"
                        />
                      ) : (
                        <ChatActivityStatus chat={chat} />
                      )}
                    </button>
                    <ChatDropdownMenu actions={actions} title={chat.title} />
                  </div>
                </ChatContextMenu>
              );
            })}
          </div>
        )}
      </nav>

      <div className="space-y-1 border-t p-3">
        <Button
          className="w-full justify-start"
          variant="ghost"
          onClick={() => setArchiveOpen(true)}
        >
          <Archive className="size-4" /> Archived
          {archived.length > 0 ? (
            <span className="ml-auto text-xs text-muted-foreground">
              {archived.length}
            </span>
          ) : null}
        </Button>
        <Button
          className="w-full justify-start"
          variant="ghost"
          onClick={onOpenSettings}
        >
          <Settings className="size-4" /> Settings
        </Button>
      </div>

      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Archived chats</DialogTitle>
            <DialogDescription>
              Archived conversations and scratch files remain recoverable until
              their deletion date.
            </DialogDescription>
          </DialogHeader>
          {archivedLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading archive…
            </div>
          ) : archived.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <ArchiveRestore className="mx-auto mb-3 size-5" /> No archived
              chats
            </div>
          ) : (
            <div className="divide-y border-y">
              {archived.map((chat) => (
                <div className="flex items-center gap-3 py-3" key={chat.id}>
                  <MessageSquare className="size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{chat.title}</p>
                    <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      <span>{chat.messageCount} messages</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="size-3" />{" "}
                        {recoveryLabel(chat.expiresAt)}
                      </span>
                      <span>
                        {archiveDate.format(new Date(chat.expiresAt))}
                      </span>
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onRestore(chat)}
                  >
                    <ArchiveRestore className="size-4" /> Restore
                  </Button>
                  <Button
                    aria-label={`Permanently delete ${chat.title}`}
                    className="size-8"
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
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => !open && setRenameTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>
              Choose a name for this conversation.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submitRename}>
            <input
              autoFocus
              className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              maxLength={200}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameTarget(null)}
              >
                Cancel
              </Button>
              <Button disabled={!renameValue.trim()} type="submit">
                Rename
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

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
    </>
  );
}
