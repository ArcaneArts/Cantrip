import type { StandaloneChatSummary, WorkerSummary } from "@cantrip/protocol";
import {
  Archive,
  Bot,
  Code2,
  Loader2,
  MessageSquare,
  Plus,
  Settings,
  WifiOff,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { ChatContextMenu, ChatDropdownMenu } from "@/components/chat/chat-menu";
import { ChatActivityStatus } from "@/components/chat/chat-activity-status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import {
  closeTabOnMiddleClick,
  preventMiddleMouseDefault,
} from "@/lib/tab-middle-click";
import { cn } from "@/lib/utils";

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
  archivedCount: number;
  archivedSelected: boolean;
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
  onOpenArchived(): void;
  onOpenSettings(): void;
  onRename(chat: StandaloneChatSummary, title: string): void;
  onSelect(chat: StandaloneChatSummary): void;
  onSwitchIde(): void;
}

export function StandaloneChatSidebar({
  archivedCount,
  archivedSelected,
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
  onOpenArchived,
  onOpenSettings,
  onRename,
  onSelect,
  onSwitchIde,
}: StandaloneChatSidebarProps) {
  const [renameTarget, setRenameTarget] =
    useState<StandaloneChatSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");

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
      <div className="px-3 pb-2 pt-4">
        <Button
          className="w-full justify-start"
          variant="ghost"
          onClick={onSwitchIde}
        >
          <Code2 className="size-4" /> IDE
        </Button>
      </div>

      <nav
        aria-label="Standalone chats"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
      >
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Chats
          </p>
          <Button
            aria-busy={creating || undefined}
            aria-label="New chat"
            className="size-7"
            disabled={creating || creationDisabled}
            size="icon"
            title={creationUnavailableReason ?? "New chat"}
            variant="ghost"
            onClick={onNewChat}
          >
            {creating ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Plus aria-hidden="true" className="size-4" />
            )}
          </Button>
        </div>
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
              const archiveDisabled =
                chat.status === "running" ||
                chat.status === "waiting-for-approval";
              const actions = {
                deleteLabel: "Archive",
                deleteDisabled: archiveDisabled,
                onDelete: () => onArchive(chat),
                onDuplicate: () => onFork(chat),
                onRename: () => beginRename(chat),
              };
              return (
                <ChatContextMenu actions={actions} key={chat.id}>
                  <div
                    data-standalone-chat-id={chat.id}
                    className={cn(
                      "group flex min-h-9 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted/60",
                      selectedChatId === chat.id && "bg-muted",
                    )}
                    onAuxClick={
                      archiveDisabled
                        ? undefined
                        : (event) =>
                            closeTabOnMiddleClick(event, () => onArchive(chat))
                    }
                    onMouseDown={
                      archiveDisabled ? undefined : preventMiddleMouseDefault
                    }
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
          className={cn("w-full justify-start", archivedSelected && "bg-muted")}
          variant="ghost"
          onClick={onOpenArchived}
        >
          <Archive className="size-4" /> Archived
          {archivedCount > 0 ? (
            <span className="ml-auto text-xs text-muted-foreground">
              {archivedCount}
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
    </>
  );
}
