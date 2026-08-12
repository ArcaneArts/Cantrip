import type {
  TerminalServiceConfiguration,
  TerminalSummary,
} from "@cantrip/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw, ServerCog, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { restartTerminalService, updateTerminalService } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";

export function TerminalServicePanel({
  onClose,
  terminal,
}: {
  onClose(): void;
  terminal: TerminalSummary;
}) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(terminal.service.enabled);
  const [command, setCommand] = useState(terminal.service.command);

  useEffect(() => {
    setEnabled(terminal.service.enabled);
    setCommand(terminal.service.command);
  }, [terminal.id, terminal.service.command, terminal.service.enabled]);

  const updateCachedTerminal = (updated: TerminalSummary) => {
    queryClient.setQueryData<TerminalSummary[]>(
      ["terminals", updated.projectId],
      (current = []) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
    );
  };
  const save = useMutation({
    mutationFn: (service: TerminalServiceConfiguration) =>
      updateTerminalService(terminal.id, service),
    onSuccess: (updated) => {
      updateCachedTerminal(updated);
      setEnabled(updated.service.enabled);
      setCommand(updated.service.command);
    },
    onError: (_error, service) => {
      if (!service.enabled && terminal.service.enabled) setEnabled(true);
    },
  });
  const restart = useMutation({
    mutationFn: () => restartTerminalService(terminal.id),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ["terminals", terminal.projectId],
      }),
  });
  const pending = save.isPending || restart.isPending;
  const canSave = !enabled || command.trim().length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || save.isPending) return;
    save.mutate({ enabled, command });
  };
  const toggleEnabled = () => {
    if (pending) return;
    if (enabled) {
      setEnabled(false);
      save.mutate({ enabled: false, command });
    } else {
      setEnabled(true);
    }
  };
  const error = save.error ?? restart.error;

  return (
    <aside
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label="Terminal service"
      data-slot="terminal-service-panel"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <ServerCog className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">Terminal service</h2>
        </div>
        <Button
          aria-label="Close terminal service panel"
          className="size-7"
          onClick={onClose}
          size="icon"
          title="Close"
          variant="ghost"
        >
          <X className="size-4" />
        </Button>
      </header>

      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <div className="flex items-center justify-between gap-4 border-b py-4">
            <div>
              <p className="text-sm font-medium">Keep command running</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Starts with the worker and runs without an open terminal view.
              </p>
            </div>
            <button
              aria-checked={enabled}
              aria-label="Keep command running"
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                enabled ? "bg-primary" : "bg-muted-foreground/35",
              )}
              disabled={pending}
              onClick={toggleEnabled}
              role="switch"
              type="button"
            >
              <span
                className={cn(
                  "absolute top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform",
                  enabled ? "translate-x-[18px]" : "translate-x-0.5",
                )}
              />
            </button>
          </div>

          <label className="grid gap-2 border-b py-4 text-sm">
            <span className="font-medium">Command</span>
            <textarea
              className="min-h-32 resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none ring-ring placeholder:text-muted-foreground focus:ring-2"
              onChange={(event) => setCommand(event.target.value)}
              placeholder="pnpm dev"
              spellCheck={false}
              value={command}
            />
            <span className="text-xs leading-relaxed text-muted-foreground">
              Runs in this terminal&apos;s worktree. If it exits unexpectedly,
              Cantrip starts it again after a five-second cooldown.
            </span>
          </label>

          <div className="flex items-center justify-between gap-3 py-4">
            <div>
              <p className="text-sm font-medium">Process control</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Restart kills the current process and launches it again now.
              </p>
            </div>
            <Button
              disabled={!terminal.service.enabled || pending}
              onClick={() => restart.mutate()}
              size="sm"
              type="button"
              variant="outline"
            >
              {restart.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              Restart
            </Button>
          </div>

          {error ? (
            <p className="border-t py-3 text-xs text-destructive" role="alert">
              {errorMessage(error)}
            </p>
          ) : null}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
          <Button disabled={!canSave || pending} size="sm" type="submit">
            {save.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            Save
          </Button>
        </footer>
      </form>
    </aside>
  );
}
