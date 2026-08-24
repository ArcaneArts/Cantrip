import type { ProjectWorktreeSummary, WorkerSummary } from "@cantrip/protocol";
import type {
  RunConfigurationProviderKind,
  RunConfigurationRepositoryEntry,
  RunConfigurationRepositoryInventory,
} from "@cantrip/protocol/run-configuration-definitions";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";

import { runConfigurationRuntimeIsActive } from "@/lib/run-terminal-model";

export interface RunConfigurationTargetControl {
  available: boolean;
  label: string;
  reason: string | null;
  runtime: RunConfigurationRuntime | null;
  worktree: ProjectWorktreeSummary;
}

export interface RunConfigurationControlItem {
  activeAlternates: RunConfigurationTargetControl[];
  anyActive: boolean;
  document: NonNullable<RunConfigurationRepositoryEntry["document"]>;
  entry: RunConfigurationRepositoryEntry;
  id: string;
  name: string;
  primary: RunConfigurationTargetControl | null;
  provider: RunConfigurationProviderKind;
  revision: string;
  searchValue: string;
  targets: RunConfigurationTargetControl[];
  targetLabel: string;
}

export interface InvalidRunConfigurationControlItem {
  diagnostic: string;
  label: string;
  relativePath: string;
  searchValue: string;
}

export interface RunConfigurationControlModel {
  configurations: RunConfigurationControlItem[];
  invalidConfigurations: InvalidRunConfigurationControlItem[];
  primaryWorktree: ProjectWorktreeSummary | null;
  worktrees: ProjectWorktreeSummary[];
}

export function runConfigurationTargetLabel(
  document: NonNullable<RunConfigurationRepositoryEntry["document"]>,
): string {
  if (document.commandOverride) return document.commandOverride;
  return document.target.kind === "command"
    ? document.target.command
    : `${document.target.interpreter ? `${document.target.interpreter} ` : ""}${document.target.path}`;
}

function targetControl(
  worktree: ProjectWorktreeSummary,
  runtime: RunConfigurationRuntime | undefined,
  workers: readonly WorkerSummary[],
): RunConfigurationTargetControl {
  const worker = workers.find(({ workerId }) => workerId === worktree.workerId);
  const reason =
    worktree.lifecycleState !== "ready"
      ? `Worktree is ${worktree.lifecycleState}.`
      : !worker?.online
        ? "Worker is offline."
        : null;
  return {
    available: reason === null,
    label: worktree.isPrimary ? "Primary" : (worktree.branch ?? worktree.name),
    reason,
    runtime: runtime ?? null,
    worktree,
  };
}

export function buildRunConfigurationControlModel(input: {
  inventory: RunConfigurationRepositoryInventory | null | undefined;
  runtimes: readonly RunConfigurationRuntime[];
  workers: readonly WorkerSummary[];
  worktrees: readonly ProjectWorktreeSummary[];
}): RunConfigurationControlModel {
  const primaryWorktree =
    input.worktrees.find(({ isPrimary }) => isPrimary) ??
    input.worktrees.find(({ isDefault }) => isDefault) ??
    input.worktrees[0] ??
    null;
  const runtimeByTarget = new Map(
    input.runtimes.map((runtime) => [
      `${runtime.configurationId}:${runtime.worktreeId}`,
      runtime,
    ]),
  );
  const ready = (input.inventory?.entries ?? []).flatMap((entry) => {
    if (
      entry.status !== "ready" ||
      !entry.id ||
      !entry.revision ||
      !entry.document
    ) {
      return [];
    }
    const controls = input.worktrees.map((worktree) =>
      targetControl(
        worktree,
        runtimeByTarget.get(`${entry.id}:${worktree.id}`),
        input.workers,
      ),
    );
    const primary = primaryWorktree
      ? (controls.find(({ worktree }) => worktree.id === primaryWorktree.id) ??
        null)
      : null;
    const activeAlternates = controls.filter(
      ({ runtime, worktree }) =>
        !worktree.isPrimary && runConfigurationRuntimeIsActive(runtime),
    );
    const targetLabel = runConfigurationTargetLabel(entry.document);
    const worktreeSearch = activeAlternates
      .map(({ label, worktree }) => `${label} ${worktree.name}`)
      .join(" ");
    return [
      {
        activeAlternates,
        anyActive:
          runConfigurationRuntimeIsActive(primary?.runtime) ||
          activeAlternates.length > 0,
        document: entry.document,
        entry,
        id: entry.id,
        name: entry.document.name,
        primary,
        provider: entry.document.provider,
        revision: entry.revision,
        searchValue:
          `${entry.document.name} ${entry.document.provider} ${targetLabel} ${worktreeSearch}`.toLocaleLowerCase(),
        targets: controls,
        targetLabel,
      } satisfies RunConfigurationControlItem,
    ];
  });
  ready.sort(
    (left, right) =>
      Number(right.anyActive) - Number(left.anyActive) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  const invalidConfigurations = (input.inventory?.entries ?? []).flatMap(
    (entry) =>
      entry.status === "ready"
        ? []
        : [
            {
              diagnostic:
                entry.diagnostics[0]?.message ??
                "This Run configuration cannot be loaded.",
              label:
                entry.id ??
                entry.relativePath.split("/").at(-1) ??
                "Invalid configuration",
              relativePath: entry.relativePath,
              searchValue:
                `${entry.id ?? ""} ${entry.relativePath} ${entry.diagnostics.map(({ message }) => message).join(" ")}`.toLocaleLowerCase(),
            },
          ],
  );
  return {
    configurations: ready,
    invalidConfigurations,
    primaryWorktree,
    worktrees: [...input.worktrees],
  };
}

export function runConfigurationPrimaryOperation(
  item: RunConfigurationControlItem,
): "start" | "restart" {
  return runConfigurationRuntimeIsActive(item.primary?.runtime)
    ? "restart"
    : "start";
}
