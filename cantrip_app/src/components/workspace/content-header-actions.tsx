import {
  ArrowLeft,
  ArrowRightLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleAlert,
  Code2,
  Eye,
  ExternalLink,
  Loader2,
  Bot,
  Palette,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  ServerCog,
  SquareTerminal,
  WandSparkles,
} from "lucide-react";

import type { CodeHeaderState } from "@/components/code/code-view";
import type { ExplorerHeaderState } from "@/components/explorer/explorer-view";
import type { GitHistoryHeaderState } from "@/components/git/git-history";
import { Button } from "@/components/ui/button";
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
  inspectCustomizations(): void;
  relocation: {
    active: boolean;
    available: boolean;
    open: boolean;
    problem: boolean;
    show(): void;
  };
  toggleConsole(): void;
}

export interface ContentHeaderActionsProps {
  chat?: ChatHeaderActions | null;
  code?: { header: CodeHeaderState | null } | null;
  compact?: boolean;
  explorer?: ExplorerHeaderState | null;
  git?: GitHistoryHeaderState | null;
  popout?: PopoutAction | null;
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
  const alternateMode = header.fileMode === "preview" ? "edit" : "preview";
  return (
    <div className="flex items-center gap-1">
      {header.selectedPath ? (
        <>
          <Button
            className="size-8"
            onClick={header.back}
            size="icon"
            title="Back to files"
            variant="ghost"
          >
            <ArrowLeft className="size-4" />
            <span className="sr-only">Back to files</span>
          </Button>
          {compact ? (
            <Button
              aria-pressed={header.fileMode === "edit"}
              className="size-8"
              disabled={alternateMode === "edit" && !header.canEdit}
              onClick={() => header.setFileMode(alternateMode)}
              size="icon"
              title={`Show ${alternateMode}`}
              variant="ghost"
            >
              {header.fileMode === "preview" ? (
                <Code2 className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
              <span className="sr-only">Show {alternateMode}</span>
            </Button>
          ) : (
            <div className="flex rounded-md border bg-muted/20 p-0.5">
              <Button
                aria-pressed={header.fileMode === "preview"}
                className="h-6 gap-1 rounded px-2 text-[10px]"
                onClick={() => header.setFileMode("preview")}
                size="sm"
                variant={header.fileMode === "preview" ? "outline" : "ghost"}
              >
                <Eye className="size-3" />
                Preview
              </Button>
              <Button
                aria-pressed={header.fileMode === "edit"}
                className="h-6 gap-1 rounded px-2 text-[10px]"
                disabled={!header.canEdit}
                onClick={() => header.setFileMode("edit")}
                size="sm"
                variant={header.fileMode === "edit" ? "outline" : "ghost"}
              >
                <Code2 className="size-3" />
                Edit
              </Button>
            </div>
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

export function ContentHeaderActions({
  chat,
  code,
  compact = false,
  explorer,
  git,
  popout,
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
            title="Refresh Git history"
          >
            <RefreshCw
              className={cn("size-4", git.isFetching && "animate-spin")}
            />
            <span className="sr-only">Refresh Git history</span>
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
        </>
      ) : null}
    </>
  );
}
