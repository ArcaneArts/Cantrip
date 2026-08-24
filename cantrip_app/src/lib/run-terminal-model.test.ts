import type {
  ProjectWorktreeSummary,
  TerminalSummary,
} from "@cantrip/protocol";
import type { RunConfigurationRepositoryInventory } from "@cantrip/protocol/run-configuration-definitions";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";
import { describe, expect, it } from "vitest";

import {
  decorateRunConfigurationTerminals,
  runtimeForRunTerminal,
  runConfigurationRuntimeIsActive,
  runRuntimeLastResult,
  runTerminalTargetLabel,
} from "./run-terminal-model";

const timestamp = "2026-08-24T12:00:00.000Z";
const projectId = "a6c572b6-08d2-4e8d-9520-b8e8511b99d2";
const configurationId = "a6457251-6fe3-4aa8-8970-ed6c36f99c1d";
const runtimeId = "07c21baa-12a5-435a-8ac3-c71f925184d8";
const primaryId = "18a53d6c-a0e9-474d-a6d0-2a8e16756979";
const alternateId = "d52068af-36bb-489a-91ab-d9bea42cc14b";

function terminal(worktreeId = primaryId): TerminalSummary {
  return {
    id: runtimeId,
    projectId,
    kind: "run-configuration",
    title: "Run configuration",
    position: 0,
    status: "running",
    activeWorkerId: "worker-one",
    worktreeId,
    linkedChatId: null,
    runConfigurationId: configurationId,
    runConfigurationRuntimeId: runtimeId,
    directoryPath: null,
    service: { enabled: false, command: "" },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function worktree(
  id: string,
  isPrimary: boolean,
  branch: string,
): ProjectWorktreeSummary {
  return {
    id,
    projectSourceId: "source-one",
    projectId,
    rootKind: "git-worktree",
    workerId: "worker-one",
    name: isPrimary ? "Primary" : "feature",
    path: `/project/${branch}`,
    displayPath: branch,
    isPrimary,
    isDefault: isPrimary,
    origin: isPrimary ? "user" : "cantrip",
    lifecycleState: "ready",
    branch,
    head: "abc123",
    detached: false,
    locked: false,
    lockReason: null,
    lastScannedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function runtime(
  state: RunConfigurationRuntime["state"],
): RunConfigurationRuntime {
  return {
    id: runtimeId,
    projectId,
    configurationId,
    worktreeId: primaryId,
    workerId: "worker-one",
    terminalId: runtimeId,
    definitionRevision: "a".repeat(64),
    codexEnvironmentRevision: null,
    generation: 2,
    requestedOperationId: "e58e4b84-1939-434f-a71c-c95144b04fe9",
    state,
    startedAt: timestamp,
    endedAt: state === "running" ? null : timestamp,
    exitCode: state === "exited" ? 7 : null,
    signal: null,
    failure: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const inventory: RunConfigurationRepositoryInventory = {
  directory: ".cantrip/run-configurations",
  diagnostics: [],
  entries: [
    {
      relativePath: `.cantrip/run-configurations/${configurationId}.json`,
      revision: "a".repeat(64),
      id: configurationId,
      status: "ready",
      document: {
        schema: "cantrip.run-configuration",
        version: 1,
        id: configurationId,
        name: "Development server",
        provider: "shell",
        workingDirectory: ".",
        target: { kind: "command", command: "pnpm dev" },
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
        options: { shell: "automatic", login: true },
        stop: { gracePeriodMs: 3_000 },
      },
      diagnostics: [],
    },
  ],
};

describe("Run terminal model", () => {
  it("uses the configuration name on Primary and a concise alternate suffix", () => {
    const worktrees = [
      worktree(primaryId, true, "main"),
      worktree(alternateId, false, "codex/run-ui"),
    ];
    expect(
      decorateRunConfigurationTerminals(
        [terminal(primaryId), terminal(alternateId)],
        inventory,
        worktrees,
      ).map(({ title }) => title),
    ).toEqual(["Development server", "Development server · codex/run-ui"]);
    expect(runTerminalTargetLabel(terminal(primaryId), worktrees)).toBe(
      "Primary",
    );
    expect(runTerminalTargetLabel(terminal(alternateId), worktrees)).toBe(
      "codex/run-ui",
    );
  });

  it("matches the durable runtime binding and reports lifecycle results", () => {
    const running = runtime("running");
    expect(runtimeForRunTerminal(terminal(), [running])).toEqual(running);
    expect(runConfigurationRuntimeIsActive(running)).toBe(true);
    expect(runConfigurationRuntimeIsActive(runtime("exited"))).toBe(false);
    expect(runRuntimeLastResult(runtime("exited"))).toBe("Exited with code 7");
  });

  it("keeps a deleted definition identifiable without inventing editable state", () => {
    expect(
      decorateRunConfigurationTerminals(
        [terminal()],
        { ...inventory, entries: [] },
        [],
      ).at(0)?.title,
    ).toBe("Deleted Run configuration");
  });
});
