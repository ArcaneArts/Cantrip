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
  launchAvailable,
  launchProblem,
  runtime,
  stopAvailable,
  stopProblem,
  targetLabel,
  terminal,
  onEdit,
}: {
  definitionAvailable: boolean | null;
  definitionProblem?: string | null;
  launchAvailable: boolean | null;
  launchProblem?: string | null;
  runtime: RunConfigurationRuntime | null;
  stopAvailable: boolean | null;
  stopProblem?: string | null;
  targetLabel: string;
  terminal: TerminalSummary;
  onEdit?(): void;
}) {
  const queryClient = useQueryClient();
  const active = runConfigurationRuntimeIsActive(runtime);
  const configurationId = terminal.runConfigurationId;
  const canReadOutput = Boolean(configurationId && runtime);
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
    enabled: canReadOutput,
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
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const justStopped = wasActiveRef.current && !active;
    wasActiveRef.current = active;
    if (justStopped && canReadOutput) void output.refetch();
  }, [active, canReadOutput, output.refetch]);
  const definitionMissing = definitionAvailable === false;
  const status = runtime?.state ?? "idle";
  const hasOutput = Boolean(output.data?.data.length);
  const sharedTargetProblem =
    launchProblem && launchProblem === stopProblem ? launchProblem : null;

  if (!active && !hasOutput) {
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
          {definitionAvailable === true && launchProblem ? (
            <InlineAlert tone="error">
              Run is unavailable: {launchProblem}
            </InlineAlert>
          ) : definitionAvailable === true && launchAvailable === null ? (
            <p className="text-sm text-muted-foreground">
              Checking target availability…
            </p>
          ) : null}
          {lifecycle.error ? (
            <InlineAlert tone="error">{lifecycle.error.message}</InlineAlert>
          ) : null}
          {canReadOutput && output.error ? (
            <InlineAlert tone="info">
              Previous output is no longer available.
            </InlineAlert>
          ) : null}
          <div className="flex items-center gap-2">
            {onEdit ? (
              <Button onClick={onEdit} variant="outline">
                <Pencil className="size-4" /> Edit configuration
              </Button>
            ) : null}
            <Button
              disabled={
                definitionAvailable !== true || launchAvailable !== true
              }
              onClick={() => lifecycle.mutate("start")}
              pending={lifecycle.isPending}
              pendingLabel="Starting…"
              title={launchProblem ?? undefined}
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
            <span
              className={cn(
                "size-1.5 rounded-full",
                active ? "bg-emerald-500" : "bg-muted-foreground/50",
              )}
            />
            <span className={cn(active && "capitalize")}>
              {active ? status : runRuntimeLastResult(runtime)}
            </span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{targetLabel}</span>
          </div>
        </div>
        {active ? (
          <Button
            disabled={
              definitionAvailable !== true ||
              launchAvailable !== true ||
              status === "stopping" ||
              lifecycle.isPending
            }
            onClick={() => lifecycle.mutate("restart")}
            size="sm"
            title={
              launchProblem ??
              (launchAvailable === null
                ? "Checking target availability…"
                : undefined)
            }
            variant="outline"
          >
            <RotateCw
              className={cn("size-3.5", lifecycle.isPending && "animate-spin")}
            />
            Restart
          </Button>
        ) : (
          <Button
            disabled={definitionAvailable !== true || launchAvailable !== true}
            onClick={() => lifecycle.mutate("start")}
            pending={lifecycle.isPending}
            pendingLabel="Starting…"
            size="sm"
            title={launchProblem ?? undefined}
          >
            <Play className="size-3.5 fill-current" /> Start
          </Button>
        )}
        {onEdit ? (
          <Button onClick={onEdit} size="sm" variant="ghost">
            <Pencil className="size-3.5" /> Edit
          </Button>
        ) : null}
        {active ? (
          <Button
            disabled={
              stopAvailable !== true ||
              status === "stopping" ||
              lifecycle.isPending
            }
            onClick={() => lifecycle.mutate("stop")}
            size="sm"
            title={
              stopProblem ??
              (stopAvailable === null
                ? "Checking target availability…"
                : undefined)
            }
            variant="destructive"
          >
            {status === "stopping" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Square className="size-3.5 fill-current" />
            )}
            Stop
          </Button>
        ) : null}
      </div>
      {definitionMissing ? (
        <InlineAlert className="m-3 mb-0" tone="error">
          {active
            ? "The shared definition is unavailable. Restart is disabled, but this captured generation can finish or be stopped."
            : "The shared definition is unavailable. Start is disabled, but the retained output remains available."}
        </InlineAlert>
      ) : null}
      {active && sharedTargetProblem ? (
        <InlineAlert className="m-3 mb-0" tone="error">
          Restart and Stop are disabled: {sharedTargetProblem}
        </InlineAlert>
      ) : (
        <>
          {definitionAvailable === true && launchProblem ? (
            <InlineAlert className="m-3 mb-0" tone="error">
              {active ? "Restart" : "Start"} is disabled: {launchProblem}
            </InlineAlert>
          ) : null}
          {active && stopProblem ? (
            <InlineAlert className="m-3 mb-0" tone="error">
              Stop is disabled: {stopProblem}
            </InlineAlert>
          ) : null}
        </>
      )}
      {lifecycle.error ? (
        <InlineAlert className="m-3 mb-0" tone="error">
          {lifecycle.error.message}
        </InlineAlert>
      ) : null}
      {output.error ? (
        <InlineAlert className="m-3 mb-0" tone="error">
          {active
            ? "Live output is temporarily unavailable"
            : "Latest output refresh failed; showing retained output"}
          : {output.error.message}
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
