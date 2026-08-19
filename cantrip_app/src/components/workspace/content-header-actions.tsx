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
  Palette,
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
import { cn } from "@/lib/utils";

interface TerminalCommandPaletteAction {
  active: boolean;
  open(): void;
}

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
  terminalCommandPalette?: TerminalCommandPaletteAction | null;
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
        <span
          className="grid size-8 place-items-center text-destructive"
          role="status"
          title={runtimeIssue}
        >
          <CircleAlert className="size-4" />
          <span className="sr-only">{runtimeIssue}</span>
        </span>
      ) : header?.isBusy ? (
        <span
          className="grid size-8 place-items-center text-muted-foreground"
          role="status"
          title="Connecting to editor"
        >
          <Loader2 className="size-4 animate-spin" />
          <span className="sr-only">Connecting to editor</span>
        </span>
      ) : null}
      <Button
        size="icon"
        variant="ghost"
        className="size-8"
        disabled={!header || header.isBusy || !header.runtime}
        onClick={() => void header?.saveAll()}
        title="Save all editors"
      >
        <Save className="size-4" />
        <span className="sr-only">Save all editors</span>
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-8"
        disabled={!header || header.isBusy}
        onClick={header?.reload}
        title="Reload editor surface"
      >
        <RefreshCw className="size-4" />
        <span className="sr-only">Reload editor surface</span>
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-8"
        disabled={!header || header.isBusy}
        onClick={() => void header?.restart()}
        title="Restart editor"
      >
        <RotateCcw className="size-4" />
        <span className="sr-only">Restart editor</span>
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-8"
        disabled={!header || header.isBusy || !header.runtime}
        onClick={() => void header?.stop()}
        title="Stop editor"
      >
        <Power className="size-4" />
        <span className="sr-only">Stop editor</span>
      </Button>
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
              <DropdownMenuPrimitive.Trigger asChild>
                <Button
                  aria-label={`${mode.label} mode`}
                  className="size-8"
                  size="icon"
                  title={`${mode.label} mode`}
                  variant="ghost"
                >
                  <ModeIcon className="size-4" />
                </Button>
              </DropdownMenuPrimitive.Trigger>
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
            <span
              aria-label="View mode"
              className="grid size-8 place-items-center text-muted-foreground"
              title="View mode"
            >
              <Eye className="size-4" />
            </span>
          )}
          {!compact && header.dirty ? (
            <span className="px-1 text-[10px] font-medium text-amber-500">
              Unsaved
            </span>
          ) : null}
          {header.canEdit ? (
            <Button
              aria-keyshortcuts="Meta+S Control+S"
              className="relative size-8"
              disabled={!header.dirty || header.isSaving}
              onClick={() => void header.save()}
              size="icon"
              title={header.dirty ? "Save file" : "File is saved"}
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
            </Button>
          ) : null}
        </>
      ) : null}
      <Button
        className="size-8"
        disabled={header.isFetching}
        onClick={header.refresh}
        size="icon"
        title="Refresh Explorer"
        variant="ghost"
      >
        <RefreshCw
          className={cn("size-4", header.isFetching && "animate-spin")}
        />
        <span className="sr-only">Refresh Explorer</span>
      </Button>
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
    <Button
      className={compact ? "size-6 shrink-0" : "size-8 shrink-0"}
      onClick={header.back}
      size="icon"
      title={header.backLabel ?? "Close file"}
      variant="ghost"
    >
      <X className={compact ? "size-3" : "size-4"} />
      <span className="sr-only">{header.backLabel ?? "Close file"}</span>
    </Button>
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
  terminalCommandPalette,
  terminalService,
}: ContentHeaderActionsProps) {
  return (
    <>
      {git ? (
        <>
          <Button
            size={compact ? "icon" : "sm"}
            variant="ghost"
            disabled={git.isGitActionPending}
            onClick={git.pull}
            title="Fetch remotes and pull"
          >
            <ArrowDownToLine className="size-4" />
            {compact ? <span className="sr-only">Fetch and pull</span> : "Pull"}
          </Button>
          {git.canPush ? (
            <Button
              size={compact ? "icon" : "sm"}
              variant="ghost"
              disabled={git.isGitActionPending}
              onClick={git.push}
              title="Push local commits"
            >
              <ArrowUpFromLine className="size-4" />
              {compact ? <span className="sr-only">Push</span> : "Push"}
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            disabled={git.isFetching}
            onClick={git.refresh}
            title={
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
          </Button>
        </>
      ) : null}
      {explorer ? (
        <ExplorerHeaderActions compact={compact} header={explorer} />
      ) : null}
      {code ? <CodeHeaderActions header={code.header} /> : null}
      {terminalService ? (
        <Button
          size="icon"
          variant="ghost"
          aria-pressed={terminalService.active}
          onClick={terminalService.open}
          title="Configure terminal service"
        >
          <ServerCog className="size-4" />
          <span className="sr-only">Configure terminal service</span>
        </Button>
      ) : null}
      {terminalCommandPalette ? (
        <Button
          size="icon"
          variant="ghost"
          aria-pressed={terminalCommandPalette.active}
          onClick={terminalCommandPalette.open}
          title="Run a project command"
        >
          <Palette className="size-4" />
          <span className="sr-only">Run a project command</span>
        </Button>
      ) : null}
      {popout ? (
        <Button
          size="icon"
          variant="ghost"
          disabled={popout.pending}
          className={cn(popout.error && "text-destructive")}
          onClick={popout.open}
          title={popout.error ?? "Open this tab in a new window"}
        >
          {popout.pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ExternalLink className="size-4" />
          )}
          <span className="sr-only">Open this tab in a new window</span>
        </Button>
      ) : null}
      {task ? (
        <div
          aria-label="Task view"
          className="flex h-7 items-center rounded-md bg-muted/60 p-0.5"
          role="group"
        >
          <Button
            aria-pressed={task.view === "task"}
            className={cn(
              "h-6 gap-1 px-1.5 text-[10px]",
              task.view === "task" && "bg-background shadow-sm",
            )}
            onClick={() => task.change("task")}
            size="sm"
            title="Show Task"
            variant="ghost"
          >
            <ListTodo className="size-3" />
            {!compact ? "Task" : <span className="sr-only">Task</span>}
          </Button>
          <Button
            aria-pressed={task.view === "chat"}
            className={cn(
              "h-6 gap-1 px-1.5 text-[10px]",
              task.view === "chat" && "bg-background shadow-sm",
            )}
            onClick={() => task.change("chat")}
            size="sm"
            title="Show Task chat"
            variant="ghost"
          >
            <MessageSquare className="size-3" />
            {!compact ? "Chat" : <span className="sr-only">Chat</span>}
          </Button>
        </div>
      ) : null}
      {chat ? (
        <>
          {chat.relocation.available ? (
            <Button
              size="icon"
              variant="ghost"
              aria-pressed={chat.relocation.open}
              className={cn(chat.relocation.problem && "text-destructive")}
              onClick={chat.relocation.show}
              title={
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
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            onClick={chat.inspectCustomizations}
            title="Inspect Codex customizations"
          >
            <WandSparkles className="size-4" />
            <span className="sr-only">Inspect Codex customizations</span>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-pressed={chat.consoleActive}
            disabled={!chat.consoleActive && chat.consolePending}
            onClick={chat.toggleConsole}
            title={chat.consoleActive ? "Show agent" : "Show Codex console"}
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
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-pressed={chat.inspectActive}
            onClick={chat.toggleInspect}
            title={
              chat.inspectActive ? "Close agent Inspect" : "Open agent Inspect"
            }
          >
            <Info className="size-4" />
            <span className="sr-only">
              {chat.inspectActive
                ? "Close agent Inspect"
                : "Open agent Inspect"}
            </span>
          </Button>
        </>
      ) : null}
    </>
  );
}
