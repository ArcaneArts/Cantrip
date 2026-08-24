import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalSummary } from "@cantrip/protocol";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Play, RotateCw, Square } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import {
  operateRunConfigurationRuntime,
  readRunConfigurationRuntimeOutput,
} from "@/lib/run-configuration-api";
import {
  runConfigurationRuntimeIsActive,
  runRuntimeLastResult,
} from "@/lib/run-terminal-model";
import { cn } from "@/lib/utils";

import { terminalBackground } from "./terminal-theme";

import "@xterm/xterm/css/xterm.css";

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: terminalBackground(
      styles.getPropertyValue("--background").trim(),
      document.documentElement.classList.contains("pro-mode"),
    ),
    foreground: styles.getPropertyValue("--foreground").trim(),
    selectionBackground: styles.getPropertyValue("--accent").trim(),
  };
}

export function RunTerminalOutput({ output }: { output: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef("");
  const outputWriteRef = useRef(Promise.resolve());
  const xtermRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const xterm = new Terminal({
      allowProposedApi: false,
      allowTransparency: true,
      convertEol: false,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(container);
    xtermRef.current = xterm;
    const resize = () => {
      try {
        fit.fit();
      } catch {
        // The surface may be between mount and layout during navigation.
      }
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const themeObserver = new MutationObserver(() => {
      xterm.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributeFilter: ["class", "style"],
      attributes: true,
    });
    requestAnimationFrame(resize);
    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      xtermRef.current = null;
      outputRef.current = "";
      xterm.dispose();
    };
  }, []);

  useEffect(() => {
    outputWriteRef.current = outputWriteRef.current.then(
      () =>
        new Promise<void>((resolve) => {
          const xterm = xtermRef.current;
          if (!xterm || output === outputRef.current) {
            resolve();
            return;
          }
          const complete = () => {
            if (xtermRef.current === xterm) {
              outputRef.current = output;
              xterm.scrollToBottom();
            }
            resolve();
          };
          if (output.startsWith(outputRef.current)) {
            xterm.write(output.slice(outputRef.current.length), complete);
          } else {
            xterm.reset();
            xterm.write(output, complete);
          }
        }),
    );
  }, [output]);

  return (
    <div
      aria-label="Read-only Run configuration output"
      className="min-h-0 flex-1 overflow-hidden px-3 pb-3"
      data-run-terminal-readonly="true"
      ref={containerRef}
      role="log"
    />
  );
}

export function RunTerminalView({
  definitionAvailable,
  definitionProblem,
  runtime,
  targetLabel,
  terminal,
  onEdit,
}: {
  definitionAvailable: boolean | null;
  definitionProblem?: string | null;
  runtime: RunConfigurationRuntime | null;
  targetLabel: string;
  terminal: TerminalSummary;
  onEdit?(): void;
}) {
  const queryClient = useQueryClient();
  const active = runConfigurationRuntimeIsActive(runtime);
  const configurationId = terminal.runConfigurationId;
  const lifecycle = useMutation({
    mutationFn: (operation: "start" | "restart" | "stop") => {
      if (!configurationId) {
        throw new Error("This Run terminal has no configuration binding.");
      }
      return operateRunConfigurationRuntime({
        operation,
        projectId: terminal.projectId,
        configurationId,
        targetWorktreeId: terminal.worktreeId,
      });
    },
    onSuccess: async (result) => {
      if (result.runtime) {
        queryClient.setQueryData<RunConfigurationRuntime[]>(
          ["run-configuration-runtimes", terminal.projectId],
          (current = []) => [
            ...current.filter(({ id }) => id !== result.runtime!.id),
            result.runtime!,
          ],
        );
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["run-configuration-runtimes", terminal.projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["terminals", terminal.projectId],
        }),
      ]);
    },
  });
  const output = useQuery({
    enabled: Boolean(active && configurationId),
    queryFn: () =>
      readRunConfigurationRuntimeOutput({
        projectId: terminal.projectId,
        configurationId: configurationId!,
        worktreeId: terminal.worktreeId,
      }),
    queryKey: [
      "run-configuration-runtime-output",
      terminal.projectId,
      configurationId,
      terminal.worktreeId,
      runtime?.generation,
    ],
    refetchInterval: active ? 500 : false,
    retry: false,
  });
  const definitionMissing = definitionAvailable === false;
  const status = runtime?.state ?? "idle";

  if (!active) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <span className="grid size-12 place-items-center rounded-full border bg-muted/40">
            <Play className="size-5" />
          </span>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{terminal.title}</h2>
            <p className="text-sm text-muted-foreground">{targetLabel}</p>
          </div>
          <div className="rounded-full border bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
            {runRuntimeLastResult(runtime)}
          </div>
          {definitionMissing ? (
            <InlineAlert tone="error">
              The shared Run configuration was deleted or is unavailable. It
              cannot be started again.
            </InlineAlert>
          ) : null}
          {definitionProblem ? (
            <InlineAlert tone="error">
              Could not load the shared Run configuration: {definitionProblem}
            </InlineAlert>
          ) : definitionAvailable === null ? (
            <p className="text-sm text-muted-foreground">
              Loading the shared Run configuration…
            </p>
          ) : null}
          {lifecycle.error ? (
            <InlineAlert tone="error">{lifecycle.error.message}</InlineAlert>
          ) : null}
          <div className="flex items-center gap-2">
            {onEdit ? (
              <Button onClick={onEdit} variant="outline">
                <Pencil className="size-4" /> Edit configuration
              </Button>
            ) : null}
            <Button
              disabled={definitionAvailable !== true}
              onClick={() => lifecycle.mutate("start")}
              pending={lifecycle.isPending}
              pendingLabel="Starting…"
            >
              <Play className="size-4 fill-current" /> Start
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex min-h-11 shrink-0 items-center gap-3 border-b px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{terminal.title}</div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            <span className="capitalize">{status}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{targetLabel}</span>
          </div>
        </div>
        <Button
          disabled={
            definitionAvailable !== true ||
            status === "stopping" ||
            lifecycle.isPending
          }
          onClick={() => lifecycle.mutate("restart")}
          size="sm"
          variant="outline"
        >
          <RotateCw
            className={cn("size-3.5", lifecycle.isPending && "animate-spin")}
          />
          Restart
        </Button>
        {onEdit ? (
          <Button onClick={onEdit} size="sm" variant="ghost">
            <Pencil className="size-3.5" /> Edit
          </Button>
        ) : null}
        <Button
          disabled={status === "stopping" || lifecycle.isPending}
          onClick={() => lifecycle.mutate("stop")}
          size="sm"
          variant="destructive"
        >
          {status === "stopping" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Square className="size-3.5 fill-current" />
          )}
          Stop
        </Button>
      </div>
      {definitionMissing ? (
        <InlineAlert className="m-3 mb-0" tone="error">
          The shared definition is unavailable. Restart is disabled, but this
          captured generation can finish or be stopped.
        </InlineAlert>
      ) : null}
      {lifecycle.error ? (
        <InlineAlert className="m-3 mb-0" tone="error">
          {lifecycle.error.message}
        </InlineAlert>
      ) : null}
      {output.error ? (
        <InlineAlert className="m-3 mb-0" tone="error">
          Live output is temporarily unavailable: {output.error.message}
        </InlineAlert>
      ) : null}
      {output.data ? (
        <RunTerminalOutput output={output.data.data} />
      ) : output.error ? null : (
        <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline size-4 animate-spin" /> Loading Run
          output…
        </div>
      )}
    </div>
  );
}
