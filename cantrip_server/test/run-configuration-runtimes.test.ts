import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  runConfigurationRuntimeWorkerObservationSchema,
  type RunConfigurationRuntime,
} from "@cantrip/protocol/run-configuration-runtime";
import { getTableColumns } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import {
  runConfigurationRuntimeOperations,
  runConfigurationRuntimes,
} from "../src/db/schema.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-run-configuration-runtimes-"),
);
const config: ServerConfig = {
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  appOrigins: ["http://127.0.0.1:5173"],
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  dataDirectory,
  deploymentMode: "local",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  workerToken: "test-worker-token",
};

const workerId = "runtime-worker";
const definitionRevision = "a".repeat(64);
const codexEnvironmentRevision = "b".repeat(64);

let database: DatabaseConnection;
let projectId: string;
let worktreeId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId,
    name: "Runtime Worker",
    platform: "linux",
    architecture: "x64",
    codexVersion: null,
    codexRuntime: unprobedCodexRuntimeReport,
    managedFolders: {
      create: true,
      attachExisting: true,
      convertToGithub: true,
      remove: true,
    },
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const created = await database.repository.createManagedFolderProject(
    LOCAL_USER_ID,
    {
      workerId,
      ...protectedProjectFields(),
    },
  );
  projectId = created.project.id;
  const claimed = await database.repository.projectFolderSetupJobs.claimNext();
  if (!claimed) {
    throw new Error("Expected the folder setup job to be claimable.");
  }
  await database.repository.projectFolderSetupJobs.complete(
    claimed.job.id,
    claimed.commandId,
    {
      status: "ready",
      jobId: claimed.job.id,
      attempt: claimed.job.attempt,
      path: path.join(dataDirectory, "project"),
      displayPath: "project",
      reused: false,
    },
  );
  const [worktree] = await database.repository.listProjectWorktrees(
    LOCAL_USER_ID,
    projectId,
  );
  if (!worktree) throw new Error("Expected a primary worktree.");
  worktreeId = worktree.id;
});

afterAll(async () => {
  await database.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

function startRequest(configurationId: string, operationId = randomUUID()) {
  return {
    operation: "start" as const,
    operationId,
    projectId,
    configurationId,
    worktreeId,
    workerId,
    definitionRevision,
    codexEnvironmentRevision,
  };
}

function observation(
  runtime: RunConfigurationRuntime,
  state: RunConfigurationRuntime["state"],
  input: {
    operationId?: string;
    generation?: number;
    startedAt?: string | null;
    endedAt?: string | null;
    exitCode?: number | null;
  } = {},
) {
  const terminal = ["idle", "exited", "failed", "lost"].includes(state);
  return runConfigurationRuntimeWorkerObservationSchema.parse({
    runtimeId: runtime.id,
    projectId: runtime.projectId,
    configurationId: runtime.configurationId,
    worktreeId: runtime.worktreeId,
    workerId: runtime.workerId,
    definitionRevision: runtime.definitionRevision,
    codexEnvironmentRevision: runtime.codexEnvironmentRevision,
    generation: input.generation ?? runtime.generation,
    operationId: input.operationId ?? runtime.requestedOperationId,
    terminalId: runtime.terminalId,
    state,
    startedAt:
      input.startedAt === undefined ? runtime.startedAt : input.startedAt,
    endedAt:
      input.endedAt === undefined
        ? terminal
          ? "2026-08-24T01:01:00.000Z"
          : null
        : input.endedAt,
    exitCode: input.exitCode ?? null,
    signal: null,
    failure:
      state === "failed" || state === "lost"
        ? {
            phase: state === "lost" ? "reconcile" : "spawn",
            code: state === "lost" ? "process-missing" : "spawn-failed",
            message: "Bounded redacted failure.",
            retryable: true,
          }
        : null,
  });
}

describe("Run configuration runtime persistence", () => {
  it("durably binds an idempotent start to one configuration/worktree identity", async () => {
    const configurationId = randomUUID();
    const operationId = randomUUID();
    const request = startRequest(configurationId, operationId);
    const first =
      await database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        request,
      );
    const replay =
      await database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        request,
      );

    expect(first).toMatchObject({
      replayed: false,
      operation: {
        id: operationId,
        operation: "start",
        outcome: "accepted",
        generation: 1,
      },
      runtime: {
        projectId,
        configurationId,
        worktreeId,
        workerId,
        generation: 1,
        requestedOperationId: operationId,
        state: "starting",
      },
    });
    expect(replay).toMatchObject({
      replayed: true,
      operation: first.operation,
      runtime: { id: first.runtime?.id, generation: 1, state: "starting" },
    });
    expect(first.runtime).not.toHaveProperty("command");
    expect(first.runtime).not.toHaveProperty("environment");
    expect(first.runtime).not.toHaveProperty("output");

    await expect(
      database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        startRequest(randomUUID(), operationId),
      ),
    ).rejects.toThrow(/identity is already in use/iu);

    const duplicateStart =
      await database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        startRequest(configurationId),
      );
    expect(duplicateStart).toMatchObject({
      replayed: false,
      operation: { outcome: "already-active", generation: 1 },
      runtime: {
        requestedOperationId: operationId,
        generation: 1,
        state: "starting",
      },
    });
    expect(
      await database.repository.getRunConfigurationRuntime(
        LOCAL_USER_ID,
        projectId,
        configurationId,
        worktreeId,
      ),
    ).toEqual(duplicateStart.runtime);
  });

  it("increments generations and rejects stale exit and operation races", async () => {
    const configurationId = randomUUID();
    const start =
      await database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        startRequest(configurationId),
      );
    if (!start.runtime) throw new Error("Expected a started runtime.");
    const running =
      await database.repository.applyRunConfigurationRuntimeObservation(
        LOCAL_USER_ID,
        workerId,
        observation(start.runtime, "running", {
          startedAt: "2026-08-24T01:00:00.000Z",
        }),
      );
    expect(running).toMatchObject({
      applied: true,
      reason: "applied",
      runtime: { generation: 1, state: "running" },
    });
    if (!running) throw new Error("Expected a running runtime.");

    const restartOperationId = randomUUID();
    const restart =
      await database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        {
          operation: "restart",
          operationId: restartOperationId,
          projectId,
          configurationId,
          worktreeId,
          workerId,
          definitionRevision,
          codexEnvironmentRevision,
        },
      );
    expect(restart).toMatchObject({
      operation: { outcome: "accepted", generation: 2 },
      runtime: {
        generation: 2,
        requestedOperationId: restartOperationId,
        state: "restarting",
      },
    });
    if (!restart.runtime) throw new Error("Expected a restarted runtime.");
    expect(
      await database.repository.listActiveRunConfigurationRuntimeIdentitiesForWorker(
        LOCAL_USER_ID,
        workerId,
      ),
    ).toContainEqual({
      runtimeId: restart.runtime.id,
      projectId,
      configurationId,
      worktreeId,
      workerId,
      definitionRevision,
      codexEnvironmentRevision,
      generation: 2,
      operationId: restartOperationId,
      terminalId: null,
    });

    const staleExit =
      await database.repository.applyRunConfigurationRuntimeObservation(
        LOCAL_USER_ID,
        workerId,
        observation(restart.runtime, "exited", {
          generation: 1,
          operationId: start.operation.id,
          startedAt: "2026-08-24T01:00:00.000Z",
          exitCode: 0,
        }),
      );
    expect(staleExit).toMatchObject({
      applied: false,
      reason: "stale-generation",
      runtime: { generation: 2, state: "restarting" },
    });

    const restartedRunning =
      await database.repository.applyRunConfigurationRuntimeObservation(
        LOCAL_USER_ID,
        workerId,
        observation(restart.runtime, "running", {
          startedAt: "2026-08-24T01:02:00.000Z",
        }),
      );
    if (!restartedRunning) throw new Error("Expected a restarted runtime.");
    expect(restartedRunning.runtime.state).toBe("running");

    const stopOperationId = randomUUID();
    const stop =
      await database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        {
          operation: "stop",
          operationId: stopOperationId,
          projectId,
          configurationId,
          worktreeId,
          workerId,
          definitionRevision: null,
          codexEnvironmentRevision: null,
        },
      );
    expect(stop).toMatchObject({
      operation: { outcome: "accepted", generation: 2 },
      runtime: {
        generation: 2,
        requestedOperationId: stopOperationId,
        state: "stopping",
      },
    });
    if (!stop.runtime) throw new Error("Expected a stopping runtime.");

    const staleOperation =
      await database.repository.applyRunConfigurationRuntimeObservation(
        LOCAL_USER_ID,
        workerId,
        observation(stop.runtime, "exited", {
          operationId: restartOperationId,
          startedAt: "2026-08-24T01:02:00.000Z",
          exitCode: 0,
        }),
      );
    expect(staleOperation).toMatchObject({
      applied: false,
      reason: "stale-operation",
      runtime: { state: "stopping" },
    });

    const idle =
      await database.repository.applyRunConfigurationRuntimeObservation(
        LOCAL_USER_ID,
        workerId,
        observation(stop.runtime, "idle", {
          startedAt: "2026-08-24T01:02:00.000Z",
          exitCode: 0,
        }),
      );
    expect(idle).toMatchObject({
      applied: true,
      runtime: { generation: 2, state: "idle", exitCode: 0 },
    });
    expect(
      await database.repository.listActiveRunConfigurationRuntimeIdentitiesForWorker(
        LOCAL_USER_ID,
        workerId,
      ),
    ).not.toContainEqual(
      expect.objectContaining({ runtimeId: stop.runtime.id }),
    );

    const nextStart =
      await database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        startRequest(configurationId),
      );
    expect(nextStart).toMatchObject({
      operation: { outcome: "accepted", generation: 3 },
      runtime: { generation: 3, state: "starting", exitCode: null },
    });
  });

  it("keeps rejected operation retries inert after later lifecycle changes", async () => {
    const configurationId = randomUUID();
    const restartOperationId = randomUUID();
    const restartRequest = {
      operation: "restart" as const,
      operationId: restartOperationId,
      projectId,
      configurationId,
      worktreeId,
      workerId,
      definitionRevision,
      codexEnvironmentRevision,
    };
    const rejected =
      await database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        restartRequest,
      );
    expect(rejected).toMatchObject({
      replayed: false,
      operation: { outcome: "not-active", generation: 0 },
      runtime: null,
    });

    const start =
      await database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        startRequest(configurationId),
      );
    expect(start.runtime?.state).toBe("starting");

    const replay =
      await database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        restartRequest,
      );
    expect(replay).toMatchObject({
      replayed: true,
      operation: { outcome: "not-active", generation: 0 },
      runtime: null,
    });
    expect(
      await database.repository.getRunConfigurationRuntime(
        LOCAL_USER_ID,
        projectId,
        configurationId,
        worktreeId,
      ),
    ).toMatchObject({ generation: 1, state: "starting" });
  });

  it("persists only bounded runtime and operation metadata", () => {
    expect(
      Object.keys(getTableColumns(runConfigurationRuntimes)).sort(),
    ).toEqual(
      [
        "id",
        "ownerId",
        "projectId",
        "configurationId",
        "worktreeId",
        "workerId",
        "terminalId",
        "definitionRevision",
        "codexEnvironmentRevision",
        "generation",
        "requestedOperationId",
        "state",
        "startedAt",
        "endedAt",
        "exitCode",
        "signal",
        "failure",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    expect(
      Object.keys(getTableColumns(runConfigurationRuntimeOperations)).sort(),
    ).toEqual(
      [
        "id",
        "ownerId",
        "projectId",
        "configurationId",
        "worktreeId",
        "runtimeId",
        "workerId",
        "operation",
        "outcome",
        "generation",
        "definitionRevision",
        "codexEnvironmentRevision",
        "createdAt",
      ].sort(),
    );
  });
});
