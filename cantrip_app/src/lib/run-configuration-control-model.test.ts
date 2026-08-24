import type { ProjectWorktreeSummary, WorkerSummary } from "@cantrip/protocol";
import type { RunConfigurationRepositoryInventory } from "@cantrip/protocol/run-configuration-definitions";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";
import { describe, expect, it } from "vitest";

import {
  buildRunConfigurationControlModel,
  runConfigurationPrimaryOperation,
} from "./run-configuration-control-model";

const primary = {
  id: "primary",
  projectSourceId: "source",
  projectId: "project",
  rootKind: "git-worktree",
  workerId: "worker",
  name: "Primary",
  path: "/project",
  displayPath: "/project",
  isPrimary: true,
  isDefault: true,
  origin: "cantrip",
  lifecycleState: "ready",
  branch: "main",
  head: "abc",
  detached: false,
  locked: false,
  lockReason: null,
  lastScannedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies ProjectWorktreeSummary;
const alternate = {
  ...primary,
  id: "alternate",
  name: "Feature",
  branch: "feature/run",
  isPrimary: false,
  isDefault: false,
} satisfies ProjectWorktreeSummary;
const worker = {
  workerId: "worker",
  online: true,
} as WorkerSummary;

function entry(id: string, name: string, command: string) {
  return {
    relativePath: `.cantrip/run-configurations/${id}.json`,
    revision: "a".repeat(64),
    id,
    status: "ready" as const,
    diagnostics: [],
    document: {
      schema: "cantrip.run-configuration" as const,
      version: 1 as const,
      id,
      name,
      provider: "shell" as const,
      workingDirectory: ".",
      target: { kind: "command" as const, command },
      commandOverride: null,
      arguments: [],
      environment: {
        includeCodexEnvironment: true,
        files: [],
        variables: [],
        secrets: [],
      },
      beforeLaunch: [],
      platformOverrides: {},
      options: { shell: "automatic" as const, login: true },
      stop: { gracePeriodMs: 3_000 },
    },
  };
}

function runtime(
  configurationId: string,
  worktreeId: string,
  state = "running",
) {
  return {
    id: `${configurationId}-${worktreeId}`,
    configurationId,
    worktreeId,
    state,
  } as RunConfigurationRuntime;
}

describe("Run configuration control model", () => {
  it("sorts active configurations first and exposes alternate instances", () => {
    const inventory = {
      directory: ".cantrip/run-configurations",
      diagnostics: [],
      entries: [
        entry("00000000-0000-4000-8000-000000000001", "Alpha", "alpha"),
        entry("00000000-0000-4000-8000-000000000002", "Zulu", "zulu"),
      ],
    } satisfies RunConfigurationRepositoryInventory;
    const model = buildRunConfigurationControlModel({
      inventory,
      runtimes: [runtime("00000000-0000-4000-8000-000000000002", alternate.id)],
      workers: [worker],
      worktrees: [primary, alternate],
    });

    expect(model.configurations.map(({ name }) => name)).toEqual([
      "Zulu",
      "Alpha",
    ]);
    expect(model.configurations[0]?.activeAlternates[0]?.label).toBe(
      "feature/run",
    );
    expect(model.configurations[0]?.searchValue).toContain("feature/run");
  });

  it("maps an active Primary to restart and explains offline targets", () => {
    const id = "00000000-0000-4000-8000-000000000003";
    const model = buildRunConfigurationControlModel({
      inventory: {
        directory: ".cantrip/run-configurations",
        diagnostics: [],
        entries: [entry(id, "Serve", "pnpm dev")],
      },
      runtimes: [runtime(id, primary.id)],
      workers: [{ ...worker, online: false }],
      worktrees: [primary],
    });

    expect(runConfigurationPrimaryOperation(model.configurations[0]!)).toBe(
      "restart",
    );
    expect(model.configurations[0]?.primary).toMatchObject({
      available: false,
      reason: "Worker is offline.",
    });
  });

  it("indexes structured Node targets by their generated command", () => {
    const id = "00000000-0000-4000-8000-000000000004";
    const shell = entry(id, "Web", "unused");
    const inventory = {
      directory: ".cantrip/run-configurations",
      diagnostics: [],
      entries: [
        {
          ...shell,
          document: {
            ...shell.document,
            provider: "node" as const,
            target: { kind: "packageScript" as const, script: "dev" },
            options: {
              packageManager: "pnpm" as const,
              runtime: "node" as const,
              runtimeArguments: [],
            },
          },
        },
      ],
    } satisfies RunConfigurationRepositoryInventory;
    const model = buildRunConfigurationControlModel({
      inventory,
      runtimes: [],
      workers: [worker],
      worktrees: [primary],
    });
    expect(model.configurations[0]).toMatchObject({
      provider: "node",
      targetLabel: "pnpm run dev",
    });
    expect(model.configurations[0]?.searchValue).toContain("pnpm run dev");
  });
});
