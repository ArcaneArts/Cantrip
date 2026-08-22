import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type {
  RunConfigurationAction,
  RunEnvironmentSummary,
} from "@cantrip/protocol";
import {
  CircleAlert,
  CircleStop,
  GitCompareArrows,
  Loader2,
  Play,
  Settings2,
  SquareTerminal,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import { cn } from "@/lib/utils";

const activeRunStates = new Set(["queued", "starting", "running", "stopping"]);

function failureText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : "The Run operation failed.";
}

function stateTone(state: string): string {
  if (state === "running") return "bg-emerald-500";
  if (state === "failed" || state === "lost") return "bg-destructive";
  if (state === "starting" || state === "stopping" || state === "queued") {
    return "bg-amber-500";
  }
  return "bg-muted-foreground";
}

export function EnvironmentRunMenu({
  compact = false,
  environment,
  error,
  loading,
  mutationPending,
  onCompareBranch,
  onConfigure,
  onOpen,
  onStart,
  onStop,
}: {
  compact?: boolean;
  environment: RunEnvironmentSummary | null;
  error?: unknown;
  loading: boolean;
  mutationPending: boolean;
  onCompareBranch?: (() => void) | null;
  onConfigure(): void;
  onOpen(runId: string): void;
  onStart(action: RunConfigurationAction, configRevision: string): void;
  onStop(runId: string): void;
}) {
  const configurations = environment?.inspection.configurations ?? [];
  const actions = configurations.flatMap((configuration) =>
    configuration.actions.map((action) => ({
      action,
      configRevision: configuration.revision,
    })),
  );
  const run = environment?.run ?? null;
  const setup = environment?.setup ?? null;
  const actionName = run
    ? actions.find(({ action }) => action.id === run.actionId)?.action.name
    : null;
  const operationError = failureText(error);
  const errorDiagnostics = [
    ...(environment?.inspection.diagnostics ?? []),
    ...configurations.flatMap((configuration) => configuration.diagnostics),
  ].filter((diagnostic) => diagnostic.severity === "error");

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button
          aria-label="Environment and Run actions"
          className={cn(compact ? "size-8" : "h-8 gap-1.5 px-2")}
          size={compact ? "icon" : "sm"}
          title="Environment and Run actions"
          variant="ghost"
        >
          {loading || mutationPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          {compact ? (
            <span className="sr-only">Environment</span>
          ) : (
            <span>Environment</span>
          )}
          {run ? (
            <span
              aria-label={`Latest Run ${run.state}`}
              className={cn("size-1.5 rounded-full", stateTone(run.state))}
            />
          ) : null}
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <StyledDropdownMenuContent align="end" className="w-80">
          <DropdownMenuPrimitive.Label className="px-2 py-1.5">
            <span className="block truncate text-xs font-medium">
              {configurations[0]?.name ?? "Project environment"}
            </span>
            <span className="block text-[10px] text-muted-foreground">
              {environment
                ? `${environment.inspection.platform} · ${environment.inspection.canonical.sourceControlState}`
                : "Codex-compatible local environment"}
            </span>
          </DropdownMenuPrimitive.Label>
          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />

          {operationError ? (
            <div className="flex gap-2 px-2 py-2 text-xs text-destructive">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{operationError}</span>
            </div>
          ) : errorDiagnostics.length > 0 ? (
            <div className="flex gap-2 px-2 py-2 text-xs text-destructive">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {errorDiagnostics[0]?.message}
                {errorDiagnostics.length > 1
                  ? ` (+${errorDiagnostics.length - 1} more)`
                  : ""}
              </span>
            </div>
          ) : null}

          {setup ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
              {setup.state === "queued" ||
              setup.state === "running" ||
              setup.state === "blocked" ? (
                <Loader2 className="size-3.5 animate-spin text-amber-500" />
              ) : setup.state === "failed" || setup.state === "stale" ? (
                <CircleAlert className="size-3.5 text-destructive" />
              ) : (
                <span className="size-2 rounded-full bg-emerald-500" />
              )}
              <span>Worktree setup</span>
              <span className="ml-auto capitalize text-muted-foreground">
                {setup.state}
              </span>
            </div>
          ) : null}

          {run ? (
            <>
              <div className="px-2 py-1.5 text-xs">
                <span className="flex items-center gap-2 font-medium">
                  <span
                    className={cn("size-2 rounded-full", stateTone(run.state))}
                  />
                  <span className="truncate">{actionName ?? "Latest Run"}</span>
                  <span className="ml-auto capitalize text-muted-foreground">
                    {run.state}
                  </span>
                </span>
                <span className="ml-4 block font-mono text-[10px] text-muted-foreground">
                  {run.id.slice(0, 8)}
                </span>
              </div>
              <StyledDropdownMenuItem
                disabled={mutationPending}
                onSelect={() => onOpen(run.id)}
              >
                <SquareTerminal className="size-4" />
                {run.terminalId ? "Open Run terminal" : "Create Run terminal"}
              </StyledDropdownMenuItem>
              {activeRunStates.has(run.state) ? (
                <StyledDropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={mutationPending}
                  onSelect={() => onStop(run.id)}
                >
                  <CircleStop className="size-4" />
                  Stop Run
                </StyledDropdownMenuItem>
              ) : null}
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
            </>
          ) : null}

          {loading ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              Loading environment actions…
            </div>
          ) : actions.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              No platform-compatible actions are configured.
            </div>
          ) : (
            actions.map(({ action, configRevision }) => (
              <StyledDropdownMenuItem
                disabled={
                  mutationPending ||
                  environment?.inspection.valid === false ||
                  (setup !== null && setup.state !== "succeeded")
                }
                key={`${configRevision}:${action.id}`}
                onSelect={() => onStart(action, configRevision)}
              >
                <Play className="size-4" />
                <span className="min-w-0 flex-1 truncate">{action.name}</span>
                {action.platform ? (
                  <span className="text-[10px] text-muted-foreground">
                    {action.platform}
                  </span>
                ) : null}
              </StyledDropdownMenuItem>
            ))
          )}

          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
          <StyledDropdownMenuItem onSelect={onConfigure}>
            <Settings2 className="size-4" />
            Configure environment
          </StyledDropdownMenuItem>
          {onCompareBranch ? (
            <StyledDropdownMenuItem onSelect={onCompareBranch}>
              <GitCompareArrows className="size-4" />
              Compare branch
            </StyledDropdownMenuItem>
          ) : null}
        </StyledDropdownMenuContent>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
