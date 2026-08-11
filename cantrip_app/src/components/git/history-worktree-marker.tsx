import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type {
  ChatSummary,
  GitStatus,
  ProjectWorktreeSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import {
  Check,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  History,
  Lock,
  LockOpen,
  MessageSquare,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import {
  worktreeHasConflicts,
  worktreeTooltip,
} from "@/components/worktrees/worktree-control";
import { cn } from "@/lib/utils";

export function historyWorktreeState({
  online,
  status,
  worktree,
}: {
  online: boolean;
  status?: GitStatus;
  worktree: ProjectWorktreeSummary;
}) {
  const conflict = worktreeHasConflicts(status);
  return {
    conflict,
    dirty: Boolean(status?.files.length),
    unavailable: !online || worktree.lifecycleState !== "ready",
  };
}

export function HistoryWorktreeMarker({
  boundChats,
  onLockToggle,
  onOpenChat,
  onOpenExplorer,
  onOpenHistory,
  onOpenTerminal,
  onRemove,
  onSelect,
  selected,
  status,
  worker,
  worktree,
}: {
  boundChats: ChatSummary[];
  onLockToggle(): void;
  onOpenChat(chatId?: string): void;
  onOpenExplorer(): void;
  onOpenHistory(): void;
  onOpenTerminal(): void;
  onRemove(): void;
  onSelect(): void;
  selected: boolean;
  status?: GitStatus;
  worker?: WorkerSummary;
  worktree: ProjectWorktreeSummary;
}) {
  const state = historyWorktreeState({
    online: worker?.online ?? false,
    status,
    worktree,
  });
  const agentLeased = boundChats.some(
    ({ worktreeMode }) => worktreeMode === "agent-managed",
  );
  const leaseOwner = boundChats.map(({ title }) => title).join(", ") || null;
  const tooltip = [
    worktreeTooltip({
      leaseOwner,
      online: worker?.online ?? false,
      status,
      workerName: worker?.name ?? worktree.workerId,
      worktree,
    }),
    `Origin: ${worktree.origin}`,
    worktree.detached ? "Detached HEAD" : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          title={tooltip}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          className={cn(
            "inline-flex h-5 max-w-20 shrink-0 items-center gap-1 rounded px-1.5 text-[9px] font-medium",
            worktree.isPrimary
              ? "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300"
              : "bg-violet-500/15 text-violet-700 dark:text-violet-300",
            worktree.origin === "external" &&
              "bg-slate-500/15 text-slate-600 dark:text-slate-300",
            worktree.origin === "user" &&
              "bg-blue-500/15 text-blue-700 dark:text-blue-300",
            agentLeased &&
              "bg-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-300",
            state.dirty && "bg-amber-500/20 text-amber-700 dark:text-amber-300",
            state.conflict &&
              "bg-destructive/15 text-destructive ring-destructive",
            state.unavailable && "bg-muted text-muted-foreground",
            selected && "ring-1 ring-current",
          )}
        >
          {worktree.detached ? (
            <GitCommitHorizontal className="size-2.5" />
          ) : worktree.isPrimary ? (
            <GitBranch className="size-2.5" />
          ) : (
            <GitFork className="size-2.5" />
          )}
          <span className="truncate">{worktree.name}</span>
          {worktree.locked ? <Lock className="size-2.5" /> : null}
          {selected ? <Check className="size-2.5" /> : null}
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <StyledDropdownMenuContent
          align="start"
          sideOffset={4}
          className="min-w-72"
        >
          <div className="space-y-2 px-2 py-2 text-xs">
            <div className="flex items-center gap-2">
              <GitFork className="size-4 text-violet-500" />
              <span className="font-medium">{worktree.name}</span>
              <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">
                {worktree.origin}
              </span>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted-foreground">
              <dt>Branch</dt>
              <dd className="truncate text-foreground">
                {worktree.branch ??
                  `Detached ${worktree.head?.slice(0, 8) ?? "HEAD"}`}
              </dd>
              <dt>Worker</dt>
              <dd className="truncate text-foreground">
                {worker?.name ?? worktree.workerId}
                {!worker?.online ? " · offline" : ""}
              </dd>
              <dt>State</dt>
              <dd
                className={cn(
                  "truncate text-foreground",
                  state.dirty && "text-amber-500",
                  state.conflict && "text-destructive",
                )}
              >
                {state.conflict
                  ? "Conflicts"
                  : state.dirty
                    ? `${status!.files.length} changed`
                    : state.unavailable
                      ? worktree.lifecycleState === "ready"
                        ? "Worker offline"
                        : worktree.lifecycleState
                      : status
                        ? "Clean"
                        : "Status unavailable"}
              </dd>
              <dt>Path</dt>
              <dd className="truncate font-mono text-[10px] text-foreground">
                {worktree.displayPath}
              </dd>
              {boundChats.length ? (
                <>
                  <dt>Chats</dt>
                  <dd className="truncate text-foreground">
                    {boundChats.map(({ title }) => title).join(", ")}
                  </dd>
                </>
              ) : null}
            </dl>
          </div>
          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
          <StyledDropdownMenuItem onSelect={() => onOpenChat()}>
            <MessageSquare className="size-4" /> Open Chat here
          </StyledDropdownMenuItem>
          <StyledDropdownMenuItem onSelect={onOpenTerminal}>
            <SquareTerminal className="size-4" /> Open Terminal here
          </StyledDropdownMenuItem>
          <StyledDropdownMenuItem onSelect={onOpenExplorer}>
            <FolderTree className="size-4" /> Open Explorer here
          </StyledDropdownMenuItem>
          <StyledDropdownMenuItem onSelect={onOpenHistory}>
            <History className="size-4" /> Open another Git tab here
          </StyledDropdownMenuItem>
          {boundChats.map((chat) => (
            <StyledDropdownMenuItem
              key={chat.id}
              onSelect={() => onOpenChat(chat.id)}
            >
              <MessageSquare className="size-4" /> Open {chat.title}
            </StyledDropdownMenuItem>
          ))}
          {!worktree.isPrimary ? (
            <>
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <StyledDropdownMenuItem
                disabled={
                  !worker?.online || worktree.lifecycleState !== "ready"
                }
                onSelect={onLockToggle}
              >
                {worktree.locked ? (
                  <LockOpen className="size-4" />
                ) : (
                  <Lock className="size-4" />
                )}
                {worktree.locked ? "Unlock worktree" : "Lock worktree"}
              </StyledDropdownMenuItem>
              <StyledDropdownMenuItem
                className="text-destructive focus:bg-destructive/10"
                onSelect={onRemove}
              >
                <Trash2 className="size-4" /> Remove worktree…
              </StyledDropdownMenuItem>
            </>
          ) : null}
        </StyledDropdownMenuContent>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
