import {
  ArrowRightLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleAlert,
  ExternalLink,
  Loader2,
  MessageSquare,
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
        <Button
          size="icon"
          variant="ghost"
          disabled={explorer.isFetching}
          onClick={explorer.refresh}
          title="Refresh folder"
        >
          <RefreshCw
            className={cn("size-4", explorer.isFetching && "animate-spin")}
          />
          <span className="sr-only">Refresh folder</span>
        </Button>
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
                  ? "Chat move needs attention"
                  : chat.relocation.active
                    ? "View chat move progress"
                    : "Move chat to another worker"
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
                  ? "View chat move progress"
                  : "Move chat to another worker"}
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
            title={chat.consoleActive ? "Show chat" : "Show Codex console"}
          >
            {chat.consoleActive ? (
              <MessageSquare className="size-4" />
            ) : chat.consolePending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <SquareTerminal className="size-4" />
            )}
            <span className="sr-only">
              {chat.consoleActive ? "Show chat" : "Show Codex console"}
            </span>
          </Button>
        </>
      ) : null}
    </>
  );
}
