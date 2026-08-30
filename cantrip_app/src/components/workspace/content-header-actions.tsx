import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  Check,
  CircleAlert,
  Eye,
  ExternalLink,
  Info,
  Loader2,
  ListTodo,
  MessageSquare,
  Bot,
  Pencil,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  ServerCog,
  SquareTerminal,
  TableProperties,
  WandSparkles,
  X,
} from "lucide-react";

import type { CodeHeaderState } from "@/components/code/code-view";
import type { ExplorerHeaderState } from "@/components/explorer/explorer-view";
import type { GitHistoryHeaderState } from "@/components/git/git-history";
import { Button } from "@/components/ui/button";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import {
  Tooltip,
  TooltipButton,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface TerminalServiceAction {
  active: boolean;
  open(): void;
}

interface PopoutAction {
  error: string | null;
  pending: boolean;
  open(): void;
}

interface ChatHeaderActions {
  consoleActive: boolean;
  consolePending: boolean;
  inspectActive: boolean;
  inspectCustomizations(): void;
  relocation: {
    active: boolean;
    available: boolean;
    open: boolean;
    problem: boolean;
    show(): void;
  };
  toggleConsole(): void;
  toggleInspect(): void;
}

interface TaskViewAction {
  change(view: "task" | "chat"): void;
  view: "task" | "chat";
}

export interface ContentHeaderActionsProps {
  chat?: ChatHeaderActions | null;
  code?: { header: CodeHeaderState | null } | null;
  compact?: boolean;
  explorer?: ExplorerHeaderState | null;
  git?: GitHistoryHeaderState | null;
  popout?: PopoutAction | null;
  task?: TaskViewAction | null;
  terminalService?: TerminalServiceAction | null;
}

function CodeHeaderActions({ header }: { header: CodeHeaderState | null }) {
  const runtimeIssue =
    header?.error ??
    (header?.status === "failed" || header?.status === "offline"
      ? `Editor ${header.status}.`
      : null);

  return (
    <div className="flex items-center gap-1.5">
      {runtimeIssue ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="grid size-8 place-items-center text-destructive"
              role="status"
            >
              <CircleAlert className="size-4" />
              <span className="sr-only">{runtimeIssue}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{runtimeIssue}</TooltipContent>
        </Tooltip>
      ) : header?.isBusy ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="grid size-8 place-items-center text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" />
              <span className="sr-only">Connecting to editor</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Connecting to editor</TooltipContent>
        </Tooltip>
      ) : null}
      <TooltipButton
        size="icon"
        variant="ghost"
        className="size-8"
        disabled={!header || header.isBusy || !header.runtime}
        onClick={() => void header?.saveAll()}
        tooltip="Save all editors"
      >
        <Save className="size-4" />
        <span className="sr-only">Save all editors</span>
      </TooltipButton>
      <TooltipButton
        size="icon"
        variant="ghost"
        className="size-8"
        disabled={!header || header.isBusy}
        onClick={header?.reload}
        tooltip="Reload editor surface"
      >
        <RefreshCw className="size-4" />
        <span className="sr-only">Reload editor surface</span>
      </TooltipButton>
      <TooltipButton
        size="icon"
        variant="ghost"
        className="size-8"
        disabled={!header || header.isBusy}
        onClick={() => void header?.restart()}
        tooltip="Restart editor"
      >
        <RotateCcw className="size-4" />
        <span className="sr-only">Restart editor</span>
      </TooltipButton>
      <TooltipButton
        size="icon"
        variant="ghost"
        className="size-8"
        disabled={!header || header.isBusy || !header.runtime}
        onClick={() => void header?.stop()}
        tooltip="Stop editor"
      >
        <Power className="size-4" />
        <span className="sr-only">Stop editor</span>
      </TooltipButton>
    </div>
  );
}

function ExplorerHeaderActions({
  compact,
  header,
}: {
  compact: boolean;
  header: ExplorerHeaderState;
}) {
  const mode =
    header.fileMode === "preview"
      ? { icon: Eye, label: "View" }
      : header.fileMode === "visual"
        ? { icon: TableProperties, label: "Visual" }
        : { icon: Pencil, label: "Edit" };
  const ModeIcon = mode.icon;
  return (
    <div className="flex items-center gap-1">
      {header.selectedPath ? (
        <>
          {header.canEdit || header.canVisual ? (
            <DropdownMenuPrimitive.Root>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuPrimitive.Trigger asChild>
                    <Button
                      aria-label={`${mode.label} mode`}
                      className="size-8"
                      size="icon"
                      variant="ghost"
                    >
                      <ModeIcon className="size-4" />
                    </Button>
                  </DropdownMenuPrimitive.Trigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">{mode.label} mode</TooltipContent>
              </Tooltip>
              <DropdownMenuPrimitive.Portal>
                <StyledDropdownMenuContent align="end" className="min-w-36">
                  <StyledDropdownMenuItem
                    className="justify-between"
                    onSelect={() => header.setFileMode("preview")}
                  >
                    <span className="flex items-center gap-2">
                      <Eye className="size-3.5" />
                      View
                    </span>
                    {header.fileMode === "preview" ? (
                      <Check className="size-3.5" />
                    ) : null}
                  </StyledDropdownMenuItem>
                  <StyledDropdownMenuItem
                    className="justify-between"
                    disabled={!header.canVisual}
                    onSelect={() => header.setFileMode("visual")}
                  >
                    <span className="flex items-center gap-2">
                      <TableProperties className="size-3.5" />
                      Visual
                    </span>
                    {header.fileMode === "visual" ? (
                      <Check className="size-3.5" />
                    ) : null}
                  </StyledDropdownMenuItem>
                  <StyledDropdownMenuItem
                    className="justify-between"
                    disabled={!header.canEdit}
                    onSelect={() => header.setFileMode("edit")}
                  >
                    <span className="flex items-center gap-2">
                      <Pencil className="size-3.5" />
                      Edit
                    </span>
                    {header.fileMode === "edit" ? (
                      <Check className="size-3.5" />
                    ) : null}
                  </StyledDropdownMenuItem>
                </StyledDropdownMenuContent>
              </DropdownMenuPrimitive.Portal>
            </DropdownMenuPrimitive.Root>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-label="View mode"
                  className="grid size-8 place-items-center text-muted-foreground"
                >
                  <Eye className="size-4" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">View mode</TooltipContent>
            </Tooltip>
          )}
          {!compact && header.dirty ? (
            <span className="px-1 text-[10px] font-medium text-amber-500">
              Unsaved
            </span>
          ) : null}
          {header.canEdit ? (
            <TooltipButton
              aria-keyshortcuts="Meta+S Control+S"
              className="relative size-8"
              disabled={!header.dirty || header.isSaving}
              onClick={() => void header.save()}
              size="icon"
              tooltip={header.dirty ? "Save file" : "File is saved"}
              variant="ghost"
            >
              {header.isSaving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              {compact && header.dirty ? (
                <span className="absolute right-1 top-1 size-1.5 rounded-full bg-amber-400" />
              ) : null}
              <span className="sr-only">Save file</span>
            </TooltipButton>
          ) : null}
        </>
      ) : null}
      <TooltipButton
        className="size-8"
        disabled={header.isFetching}
        onClick={header.refresh}
        size="icon"
        tooltip="Refresh Explorer"
        variant="ghost"
      >
        <RefreshCw
          className={cn("size-4", header.isFetching && "animate-spin")}
        />
        <span className="sr-only">Refresh Explorer</span>
      </TooltipButton>
    </div>
  );
}

export function ExplorerFileCloseButton({
  compact = false,
  header,
}: {
  compact?: boolean;
  header: ExplorerHeaderState | null;
}) {
  if (!header || (!header.selectedPath && !header.canGoBack)) return null;
  return (
    <TooltipButton
      className={compact ? "size-6 shrink-0" : "size-8 shrink-0"}
      onClick={header.back}
      size="icon"
      tooltip={header.backLabel ?? "Close file"}
      variant="ghost"
    >
      <X className={compact ? "size-3" : "size-4"} />
      <span className="sr-only">{header.backLabel ?? "Close file"}</span>
    </TooltipButton>
  );
}

export function ContentHeaderActions({
  chat,
  code,
  compact = false,
  explorer,
  git,
  popout,
  task,
  terminalService,
}: ContentHeaderActionsProps) {
  return (
    <>
      {git ? (
        <>
          <TooltipButton
            size={compact ? "icon" : "sm"}
            variant="ghost"
            disabled={git.isGitActionPending}
            onClick={git.pull}
            tooltip="Fetch remotes and pull"
          >
            <ArrowDownToLine className="size-4" />
            {compact ? <span className="sr-only">Fetch and pull</span> : "Pull"}
          </TooltipButton>
          {git.canPush ? (
            <TooltipButton
              size={compact ? "icon" : "sm"}
              variant="ghost"
              disabled={git.isGitActionPending}
              onClick={git.push}
              tooltip="Push local commits"
            >
              <ArrowUpFromLine className="size-4" />
              {compact ? <span className="sr-only">Push</span> : "Push"}
            </TooltipButton>
          ) : null}
          <TooltipButton
            size="icon"
            variant="ghost"
            disabled={git.isFetching}
            onClick={git.refresh}
            tooltip={
              git.section === "graph"
                ? "Refresh repository graph"
                : "Refresh Git history"
            }
          >
            <RefreshCw
              className={cn("size-4", git.isFetching && "animate-spin")}
            />
            <span className="sr-only">
              {git.section === "graph"
                ? "Refresh repository graph"
                : "Refresh Git history"}
            </span>
          </TooltipButton>
        </>
      ) : null}
      {explorer ? (
        <ExplorerHeaderActions compact={compact} header={explorer} />
      ) : null}
      {code ? <CodeHeaderActions header={code.header} /> : null}
      {terminalService ? (
        <TooltipButton
          size="icon"
          variant="ghost"
          aria-pressed={terminalService.active}
          onClick={terminalService.open}
          tooltip="Configure terminal service"
        >
          <ServerCog className="size-4" />
          <span className="sr-only">Configure terminal service</span>
        </TooltipButton>
      ) : null}
      {popout ? (
        <TooltipButton
          size="icon"
          variant="ghost"
          disabled={popout.pending}
          className={cn(popout.error && "text-destructive")}
          onClick={popout.open}
          tooltip={popout.error ?? "Open this tab in a new window"}
        >
          {popout.pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ExternalLink className="size-4" />
          )}
          <span className="sr-only">Open this tab in a new window</span>
        </TooltipButton>
      ) : null}
      {task ? (
        <div
          aria-label="Task view"
          className="flex h-7 items-center rounded-md bg-muted/60 p-0.5"
          role="group"
        >
          <TooltipButton
            aria-pressed={task.view === "task"}
            className={cn(
              "h-6 gap-1 px-1.5 text-[10px]",
              task.view === "task" && "bg-background shadow-sm",
            )}
            onClick={() => task.change("task")}
            size="sm"
            tooltip="Show Task"
            variant="ghost"
          >
            <ListTodo className="size-3" />
            {!compact ? "Task" : <span className="sr-only">Task</span>}
          </TooltipButton>
          <TooltipButton
            aria-pressed={task.view === "chat"}
            className={cn(
              "h-6 gap-1 px-1.5 text-[10px]",
              task.view === "chat" && "bg-background shadow-sm",
            )}
            onClick={() => task.change("chat")}
            size="sm"
            tooltip="Show Task chat"
            variant="ghost"
          >
            <MessageSquare className="size-3" />
            {!compact ? "Chat" : <span className="sr-only">Chat</span>}
          </TooltipButton>
        </div>
      ) : null}
      {chat ? (
        <>
          {chat.relocation.available ? (
            <TooltipButton
              size="icon"
              variant="ghost"
              aria-pressed={chat.relocation.open}
              className={cn(chat.relocation.problem && "text-destructive")}
              onClick={chat.relocation.show}
              tooltip={
                chat.relocation.problem
                  ? "Agent move needs attention"
                  : chat.relocation.active
                    ? "View agent move progress"
                    : "Move agent to another worker"
              }
            >
              {chat.relocation.problem ? (
                <CircleAlert className="size-4" />
              ) : chat.relocation.active ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowRightLeft className="size-4" />
              )}
              <span className="sr-only">
                {chat.relocation.active
                  ? "View agent move progress"
                  : "Move agent to another worker"}
              </span>
            </TooltipButton>
          ) : null}
          <TooltipButton
            size="icon"
            variant="ghost"
            onClick={chat.inspectCustomizations}
            tooltip="Inspect Codex customizations"
          >
            <WandSparkles className="size-4" />
            <span className="sr-only">Inspect Codex customizations</span>
          </TooltipButton>
          <TooltipButton
            size="icon"
            variant="ghost"
            aria-pressed={chat.consoleActive}
            disabled={!chat.consoleActive && chat.consolePending}
            onClick={chat.toggleConsole}
            tooltip={chat.consoleActive ? "Show agent" : "Show Codex console"}
          >
            {chat.consoleActive ? (
              <Bot className="size-4" />
            ) : chat.consolePending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <SquareTerminal className="size-4" />
            )}
            <span className="sr-only">
              {chat.consoleActive ? "Show agent" : "Show Codex console"}
            </span>
          </TooltipButton>
          <TooltipButton
            size="icon"
            variant="ghost"
            aria-pressed={chat.inspectActive}
            onClick={chat.toggleInspect}
            tooltip={
              chat.inspectActive ? "Close agent Inspect" : "Open agent Inspect"
            }
          >
            <Info className="size-4" />
            <span className="sr-only">
              {chat.inspectActive
                ? "Close agent Inspect"
                : "Open agent Inspect"}
            </span>
          </TooltipButton>
        </>
      ) : null}
    </>
  );
}
