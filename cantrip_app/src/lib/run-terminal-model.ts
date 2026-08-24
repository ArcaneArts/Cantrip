import type {
  ProjectWorktreeSummary,
  TerminalSummary,
} from "@cantrip/protocol";
import type { RunConfigurationRepositoryInventory } from "@cantrip/protocol/run-configuration-definitions";
import type {
  RunConfigurationRuntime,
  RunConfigurationRuntimeState,
} from "@cantrip/protocol/run-configuration-runtime";

const ACTIVE_RUNTIME_STATES = new Set<RunConfigurationRuntimeState>([
  "starting",
  "running",
  "restarting",
  "stopping",
]);

export function runConfigurationRuntimeIsActive(
  runtime: RunConfigurationRuntime | null | undefined,
): boolean {
  return Boolean(runtime && ACTIVE_RUNTIME_STATES.has(runtime.state));
}

export function runTerminalIsActive(terminal: TerminalSummary): boolean {
  return terminal.kind === "run-configuration" && terminal.status === "running";
}

export function runtimeForRunTerminal(
  terminal: TerminalSummary,
  runtimes: readonly RunConfigurationRuntime[],
): RunConfigurationRuntime | null {
  if (terminal.kind !== "run-configuration") return null;
  return (
    runtimes.find(
      (runtime) => runtime.id === terminal.runConfigurationRuntimeId,
    ) ??
    runtimes.find(
      (runtime) =>
        runtime.configurationId === terminal.runConfigurationId &&
        runtime.worktreeId === terminal.worktreeId,
    ) ??
    null
  );
}

export function runTerminalTargetLabel(
  terminal: TerminalSummary,
  worktrees: readonly ProjectWorktreeSummary[],
): string {
  const worktree = worktrees.find(({ id }) => id === terminal.worktreeId);
  if (!worktree) return "Unavailable worktree";
  if (worktree.isPrimary) return "Primary";
  return worktree.branch ?? worktree.name;
}

export function decorateRunConfigurationTerminals(
  terminals: readonly TerminalSummary[],
  inventory: RunConfigurationRepositoryInventory | null | undefined,
  worktrees: readonly ProjectWorktreeSummary[],
): TerminalSummary[] {
  const names = new Map(
    (inventory?.entries ?? []).flatMap((entry) =>
      entry.id && entry.document ? [[entry.id, entry.document.name]] : [],
    ),
  );
  const worktreeById = new Map(
    worktrees.map((worktree) => [worktree.id, worktree]),
  );
  return terminals.map((terminal) => {
    if (terminal.kind !== "run-configuration" || !terminal.runConfigurationId) {
      return terminal;
    }
    const name =
      names.get(terminal.runConfigurationId) ??
      (inventory ? "Deleted Run configuration" : terminal.title);
    const worktree = worktreeById.get(terminal.worktreeId);
    return {
      ...terminal,
      title:
        worktree && !worktree.isPrimary
          ? `${name} · ${worktree.branch ?? worktree.name}`
          : name,
    };
  });
}

export function runRuntimeLastResult(
  runtime: RunConfigurationRuntime | null | undefined,
): string {
  if (!runtime || runtime.generation === 0) return "Not started yet";
  if (runtime.state === "failed" || runtime.state === "lost") {
    return (
      runtime.failure?.message ??
      (runtime.state === "lost"
        ? "The worker lost this process."
        : "The process failed.")
    );
  }
  if (runtime.state === "exited") {
    if (runtime.signal) return `Exited after signal ${runtime.signal}`;
    return runtime.exitCode === null
      ? "Exited"
      : `Exited with code ${runtime.exitCode}`;
  }
  if (runtime.state === "idle") {
    if (runtime.signal) return `Stopped after signal ${runtime.signal}`;
    return runtime.startedAt ? "Stopped" : "Not started yet";
  }
  return `${runtime.state.slice(0, 1).toUpperCase()}${runtime.state.slice(1)}`;
}
