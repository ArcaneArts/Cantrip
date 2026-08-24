import { describe, expect, it } from "vitest";

import {
  CANTRIP_MCP_OPERATIONS,
  CANTRIP_MCP_TOOL_NAMES,
  cantripAgentOperationNameSchema,
  cantripCliCommandNameSchema,
  workerCommandSchema,
  workerNotificationSchema,
} from "./index.js";
import {
  RUN_CONFIGURATION_CANONICAL_PATH,
  RUN_CONFIGURATION_AUTHORING_EXAMPLE,
  runConfigurationActionAddInputSchema,
  runConfigurationAuthoringDocumentSchema,
  runConfigurationInspectionSchema,
  runInstanceSchema,
  runSetupStatusResultSchema,
  workerRunLogSnapshotSchema,
  workerRunSetupStatusSchema,
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

  it("rejects raw scripts in transported configuration definitions", () => {
    const inspection = {
      platform: "linux" as const,
      canonical: {
        relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
        sourceControlState: "untracked" as const,
      },
      configured: true,
      valid: true,
      configurations: [
        {
          relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
          revision: "a".repeat(64),
          version: 1,
          name: "Example",
          sourceControlState: "untracked" as const,
          setup: { platform: null },
          actions: [
            {
              id: "b".repeat(64),
              name: "Run",
              icon: "run",
              platform: null,
              configurationPath: RUN_CONFIGURATION_CANONICAL_PATH,
              sourceIndex: 0,
            },
          ],
          diagnostics: [],
        },
      ],
      diagnostics: [],
    };
    expect(runConfigurationInspectionSchema.parse(inspection)).toEqual(
      inspection,
    );
    expect(
      runConfigurationInspectionSchema.safeParse({
        ...inspection,
        configurations: [
          {
            ...inspection.configurations[0],
            actions: [
              {
                ...inspection.configurations[0]!.actions[0],
                command: "echo private",
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      runConfigurationInspectionSchema.safeParse({
        ...inspection,
        configurations: [
          {
            ...inspection.configurations[0],
            setup: { platform: null, command: "pnpm install" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("registers the stable-ID MCP operations without legacy tools", () => {
    for (const operation of [
      "run-configuration.list",
      "run-configuration.get",
      "run-configuration.detect",
      "run-configuration.create",
      "run-configuration.update",
      "run-configuration.delete",
      "run-configuration.start",
      "run-configuration.restart",
      "run-configuration.stop",
      "run-configuration.status",
      "run-configuration.read-output",
      "run-configuration.secret-set",
    ]) {
      expect(cantripAgentOperationNameSchema.parse(operation)).toBe(operation);
      expect(CANTRIP_MCP_OPERATIONS).toContain(operation);
    }
    for (const command of [
      "run.list",
      "run.show",
      "run.detect",
      "run.create",
      "run.update",
      "run.delete",
      "run.secret-set",
    ]) {
      expect(cantripCliCommandNameSchema.parse(command)).toBe(command);
    }
    expect(
      workerCommandSchema.parse({
        type: "project.run-configurations.inspect",
        operationId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb330",
        projectId: "project-one",
        worktreeId: "worktree-one",
        serverId: "https://cantrip.test",
        sourcePath: "/project/source",
      }),
    ).toEqual({
      type: "project.run-configurations.inspect",
      operationId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb330",
      projectId: "project-one",
      worktreeId: "worktree-one",
      serverId: "https://cantrip.test",
      sourcePath: "/project/source",
    });
    expect(
      workerCommandSchema.safeParse({
        type: "project.run-configurations.inspect",
        operationId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb330",
        projectId: "project-one",
        worktreeId: "worktree-one",
        serverId: "https://cantrip.test",
        sourcePath: "/project/source",
        worktreePath: "/untrusted/override",
      }).success,
    ).toBe(false);
    expect(CANTRIP_MCP_OPERATIONS).not.toContain("run-config.authoring");
    expect(CANTRIP_MCP_OPERATIONS).not.toContain("run-config.write");
    expect(CANTRIP_MCP_OPERATIONS).not.toContain("run-config.list");
    expect(CANTRIP_MCP_OPERATIONS).not.toContain("run-config.action-add");
    expect(CANTRIP_MCP_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "run_configuration_list",
        "run_configuration_get",
        "run_configuration_detect",
        "run_configuration_create",
        "run_configuration_update",
        "run_configuration_delete",
        "run_configuration_start",
        "run_configuration_restart",
        "run_configuration_stop",
        "run_configuration_status",
        "run_configuration_read_output",
        "run_configuration_secret_set",
      ]),
    );
    for (const legacyTool of [
      "run_config_list",
      "run_config_read",
      "run_config_schema",
      "run_config_action_add",
      "run_start",
      "run_open",
      "run_setup_status",
      "run_setup_retry",
      "run_status",
      "run_read",
      "run_stop",
    ]) {
      expect(CANTRIP_MCP_TOOL_NAMES).not.toContain(legacyTool);
    }
  });

  it("bounds the complete cross-platform authoring document", () => {
    expect(
      runConfigurationAuthoringDocumentSchema.parse(
        RUN_CONFIGURATION_AUTHORING_EXAMPLE,
      ),
    ).toMatchObject({
      version: 1,
      actions: [{ name: "Run app", command: "pnpm run dev" }],
    });
    expect(
      runConfigurationActionAddInputSchema.parse({
        name: "Run app",
        command: "pnpm run dev",
      }),
    ).toEqual({
      name: "Run app",
      command: "pnpm run dev",
      icon: "run",
      platform: null,
    });
    expect(
      runConfigurationAuthoringDocumentSchema.parse({
        version: 1,
        name: "Spectral Lab",
        setup: {
          default: "dotnet restore",
          win32: "dotnet restore .\\SpectralLab.slnx",
          darwin: null,
          linux: null,
        },
        actions: [
          {
            name: "Run Spectral Lab",
            icon: "run",
            command: "dotnet run",
            platform: "win32",
          },
        ],
      }),
    ).toMatchObject({ version: 1, actions: [{ platform: "win32" }] });
    expect(
      runConfigurationAuthoringDocumentSchema.safeParse({
        version: 1,
        name: "Invalid",
        setup: { default: null, win32: null, darwin: null, linux: null },
        actions: [
          { name: "Run", icon: "run", command: "x\0y", platform: null },
        ],
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

  it("registers exact CLI and worker operations", () => {
    for (const command of [
      "run.start",
      "run.restart",
      "run.status",
      "run.logs",
      "run.stop",
    ]) {
      expect(cantripCliCommandNameSchema.parse(command)).toBe(command);
    }
    expect(CANTRIP_MCP_OPERATIONS).toEqual(
      expect.arrayContaining([
        "run-configuration.list",
        "run-configuration.get",
        "run-configuration.start",
        "run-configuration.restart",
        "run-configuration.status",
        "run-configuration.read-output",
        "run-configuration.stop",
      ]),
    );

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

  it("bounds setup observations and excludes worker-private environment", () => {
    const setup = {
      jobId: "11111111-1111-4111-8111-111111111112",
      projectId: runIdentity.projectId,
      worktreeId: runIdentity.worktreeId,
      configurationRevision: runIdentity.configurationRevision,
      attempt: 1,
      state: "succeeded" as const,
      output: "prepared\r\n",
      outputTruncated: false,
      exitCode: 0,
      signal: null,
      error: null,
      startedAt: "2026-08-21T12:00:00.000Z",
      completedAt: "2026-08-21T12:00:01.000Z",
      updatedAt: "2026-08-21T12:00:01.000Z",
    };
    expect(workerRunSetupStatusSchema.parse(setup)).toEqual(setup);
    expect(
      workerRunSetupStatusSchema.safeParse({
        ...setup,
        environmentDelta: { PRIVATE_TOKEN: "secret" },
      }).success,
    ).toBe(false);
    expect(
      runSetupStatusResultSchema.safeParse({
        worktreeId: runIdentity.worktreeId,
        setup: null,
        currentConfigurationRevision: runIdentity.configurationRevision,
        output: "x".repeat(100_001),
        outputTruncated: true,
        exitCode: null,
        signal: null,
        workerStatusAvailable: true,
      }).success,
    ).toBe(false);

    const start = {
      type: "project.run-setup.start" as const,
      operationId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb330",
      serverId: "https://cantrip.test",
      jobId: setup.jobId,
      attempt: 1,
      projectId: setup.projectId,
      worktreeId: setup.worktreeId,
      sourcePath: "/project/source",
      worktreePath: "/project/worktree",
      configurationRevision: setup.configurationRevision,
    };
    expect(workerCommandSchema.parse(start)).toEqual(start);
    expect(
      workerCommandSchema.safeParse({
        ...start,
        environmentDelta: { PRIVATE_TOKEN: "secret" },
      }).success,
    ).toBe(false);
  });
});
