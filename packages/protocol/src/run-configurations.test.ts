import { describe, expect, it } from "vitest";

import {
  CANTRIP_MCP_OPERATIONS,
  cantripAgentOperationNameSchema,
  cantripCliCommandNameSchema,
  workerCommandSchema,
  workerNotificationSchema,
} from "./index.js";
import {
  RUN_CONFIGURATION_CANONICAL_PATH,
  runConfigurationInspectionSchema,
  runInstanceSchema,
  workerRunLogSnapshotSchema,
} from "./run-configurations.js";

const runIdentity = {
  runId: "11111111-1111-4111-8111-111111111111",
  projectId: "project-1",
  worktreeId: "worktree-1",
  actionId: "b".repeat(64),
  configurationRevision: "a".repeat(64),
};

const workerSnapshot = {
  ...runIdentity,
  state: "running" as const,
  startedAt: "2026-08-21T12:00:00.000Z",
  endedAt: null,
  exitCode: null,
  signal: null,
};

describe("runConfigurationInspectionSchema", () => {
  it("bounds and normalizes the unconfigured state", () => {
    expect(
      runConfigurationInspectionSchema.parse({
        platform: "linux",
        canonical: {
          relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
          sourceControlState: "absent",
        },
        configured: false,
        valid: true,
        configurations: [],
        diagnostics: [],
      }),
    ).toMatchObject({ configured: false, valid: true });
  });

  it("rejects action commands containing NUL", () => {
    expect(() =>
      runConfigurationInspectionSchema.parse({
        platform: "linux",
        canonical: {
          relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
          sourceControlState: "untracked",
        },
        configured: true,
        valid: true,
        configurations: [
          {
            relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
            revision: "a".repeat(64),
            version: 1,
            name: "Example",
            sourceControlState: "untracked",
            setup: null,
            actions: [
              {
                id: "b".repeat(64),
                name: "Run",
                icon: "run",
                command: "echo before\0after",
                platform: null,
                configurationPath: RUN_CONFIGURATION_CANONICAL_PATH,
                sourceIndex: 0,
              },
            ],
            diagnostics: [],
          },
        ],
        diagnostics: [],
      }),
    ).toThrow();
  });

  it("registers the discovery operations without broad worker arguments", () => {
    expect(cantripAgentOperationNameSchema.parse("run-config.list")).toBe(
      "run-config.list",
    );
    expect(cantripAgentOperationNameSchema.parse("run-config.read")).toBe(
      "run-config.read",
    );
    expect(cantripCliCommandNameSchema.parse("run.config-path")).toBe(
      "run.config-path",
    );
    expect(
      workerCommandSchema.parse({
        type: "project.run-configurations.inspect",
        sourcePath: "/project/source",
      }),
    ).toEqual({
      type: "project.run-configurations.inspect",
      sourcePath: "/project/source",
    });
    expect(
      workerCommandSchema.safeParse({
        type: "project.run-configurations.inspect",
        sourcePath: "/project/source",
        worktreePath: "/untrusted/override",
      }).success,
    ).toBe(false);
  });
});

describe("Run runtime schemas", () => {
  it("stores durable metadata without commands, environment, or scrollback", () => {
    const run = {
      id: runIdentity.runId,
      projectId: runIdentity.projectId,
      worktreeId: runIdentity.worktreeId,
      workerId: "worker-1",
      actionId: runIdentity.actionId,
      configurationRevision: runIdentity.configurationRevision,
      state: "running",
      terminalId: null,
      exitCode: null,
      signal: null,
      createdAt: "2026-08-21T11:59:59.000Z",
      startedAt: workerSnapshot.startedAt,
      endedAt: null,
      updatedAt: "2026-08-21T12:00:00.000Z",
    };
    expect(runInstanceSchema.parse(run)).toEqual(run);
    for (const forbidden of ["command", "environment", "scrollback"]) {
      expect(
        runInstanceSchema.safeParse({ ...run, [forbidden]: "private" }).success,
      ).toBe(false);
    }
  });

  it("bounds volatile logs and worker observations", () => {
    expect(
      workerRunLogSnapshotSchema.parse({
        run: workerSnapshot,
        data: "ready\n",
        truncated: false,
      }),
    ).toMatchObject({ run: { state: "running" }, data: "ready\n" });
    expect(
      workerRunLogSnapshotSchema.safeParse({
        run: workerSnapshot,
        data: "x".repeat(100_001),
        truncated: true,
      }).success,
    ).toBe(false);
    expect(
      workerNotificationSchema.parse({
        type: "project.run.state.observed",
        run: workerSnapshot,
      }),
    ).toMatchObject({ type: "project.run.state.observed" });
  });

  it("registers exact CLI and worker operations without exposing MCP early", () => {
    for (const operation of [
      "run.start",
      "run.status",
      "run.read",
      "run.stop",
    ]) {
      expect(cantripAgentOperationNameSchema.parse(operation)).toBe(operation);
    }
    for (const command of ["run.start", "run.status", "run.logs", "run.stop"]) {
      expect(cantripCliCommandNameSchema.parse(command)).toBe(command);
    }
    expect(CANTRIP_MCP_OPERATIONS).not.toContain("run.start");
    expect(CANTRIP_MCP_OPERATIONS).not.toContain("run.status");

    const start = {
      type: "project.run.start" as const,
      requestId: "request-1",
      rootKind: "git-worktree" as const,
      sourcePath: "/project/source",
      worktreePath: "/project/worktree",
      ...runIdentity,
    };
    expect(workerCommandSchema.parse(start)).toEqual(start);
    expect(
      workerCommandSchema.safeParse({ ...start, command: "echo private" })
        .success,
    ).toBe(false);
    expect(
      workerCommandSchema.parse({
        type: "project.run.reconcile",
        runs: [runIdentity],
      }),
    ).toMatchObject({ type: "project.run.reconcile" });
  });
});
