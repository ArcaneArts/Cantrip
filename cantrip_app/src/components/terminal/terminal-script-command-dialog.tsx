import type { ScriptCommand } from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import { CornerDownLeft, Loader2, Palette, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { getTerminalScriptCommands } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";

import {
  ensureTerminalCommandSelectionVisible,
  filterTerminalScriptCommands,
  moveTerminalCommandSelection,
  type TerminalCommandSelectionSource,
} from "./terminal-command-palette";

function errorText(error: unknown): string {
  return errorMessage(error, String(error));
}

export function TerminalScriptCommandDialog({
  onOpenChange,
  onRun,
  open,
  terminalId,
}: {
  onOpenChange(open: boolean): void;
  onRun(command: ScriptCommand): string | null;
  open: boolean;
  terminalId: string;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectionSourceRef = useRef<TerminalCommandSelectionSource>("reset");
  const commands = useQuery({
    queryKey: ["terminal-script-commands", terminalId],
    queryFn: () => getTerminalScriptCommands(terminalId),
    enabled: open,
    refetchOnWindowFocus: false,
  });
  const filtered = useMemo(
    () => filterTerminalScriptCommands(query, commands.data ?? []),
    [commands.data, query],
  );

  useEffect(() => {
    if (!open) return;
    selectionSourceRef.current = "reset";
    setQuery("");
    setSelectedIndex(0);
    setRunError(null);
  }, [open, terminalId]);

  useEffect(() => {
    selectionSourceRef.current = "reset";
    setSelectedIndex(0);
  }, [query, commands.data]);

  useEffect(() => {
    ensureTerminalCommandSelectionVisible(
      listRef.current?.querySelector<HTMLElement>("[data-selected='true']") ??
        null,
      selectionSourceRef.current,
    );
    selectionSourceRef.current = "reset";
  }, [selectedIndex]);

  const run = (command: ScriptCommand | undefined) => {
    if (!command) return;
    const error = onRun(command);
    if (error) {
      setRunError(error);
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[15vh] flex max-h-[70vh] max-w-2xl -translate-y-0 flex-col gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Run a project command</DialogTitle>
        <DialogDescription className="sr-only">
          Filter commands discovered from project manifests and run one in the
          current terminal.
        </DialogDescription>
        <div className="flex h-16 shrink-0 items-center gap-3 border-b px-5 pr-12">
          <Search className="size-5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                selectionSourceRef.current = "keyboard";
                setSelectedIndex((index) =>
                  moveTerminalCommandSelection(
                    index,
                    event.key === "ArrowDown" ? 1 : -1,
                    filtered.length,
                  ),
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(filtered[selectedIndex]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onOpenChange(false);
              }
            }}
            placeholder="Type a script or task name…"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="terminal-script-command-list"
            aria-expanded={open}
            aria-activedescendant={
              filtered[selectedIndex]
                ? `terminal-script-command-${selectedIndex}`
                : undefined
            }
          />
        </div>
        <div
          id="terminal-script-command-list"
          ref={listRef}
          className="min-h-28 flex-1 overscroll-contain overflow-y-auto p-2"
          role="listbox"
        >
          {commands.isPending ? (
            <div className="grid min-h-28 place-items-center text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> Discovering project
                commands…
              </span>
            </div>
          ) : commands.isError ? (
            <div className="grid min-h-28 place-items-center px-6 text-center text-sm text-destructive">
              {errorText(commands.error)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="grid min-h-28 place-items-center px-6 text-center text-sm text-muted-foreground">
              {query
                ? "No project commands match your search."
                : "No script commands were found in this worktree."}
            </div>
          ) : (
            filtered.map((command, index) => (
              <button
                id={`terminal-script-command-${index}`}
                key={command.id}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                data-selected={index === selectedIndex}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition-colors",
                  index === selectedIndex
                    ? "bg-muted text-foreground"
                    : "hover:bg-muted/60",
                )}
                onClick={() => run(command)}
                onMouseMove={() => {
                  selectionSourceRef.current = "pointer";
                  setSelectedIndex(index);
                }}
              >
                <Palette className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {command.name}
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {command.source}
                    </span>
                  </span>
                  <code className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {command.command}
                  </code>
                  {command.description ? (
                    <span className="mt-1 block truncate text-xs text-muted-foreground/80">
                      {command.description}
                    </span>
                  ) : null}
                </span>
                {index === selectedIndex ? (
                  <CornerDownLeft className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                ) : null}
              </button>
            ))
          )}
        </div>
        <div className="flex min-h-9 shrink-0 items-center justify-between border-t px-4 text-[11px] text-muted-foreground">
          <span>{runError ?? `${filtered.length} commands`}</span>
          <span className="flex items-center gap-3">
            <span>↑↓ Navigate</span>
            <span>↵ Run</span>
            <span>esc Close</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
