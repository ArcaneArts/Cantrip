import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { getTableColumns } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import { runInstances } from "../src/db/schema.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-run-instances-"),
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

let database: DatabaseConnection;
let projectId: string;
let worktreeId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "run-worker",
    name: "Run Worker",
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
      workerId: "run-worker",
      ...protectedProjectFields(),
    },
  );
  projectId = created.project.id;
  const claimed = await database.repository.projectFolderSetupJobs.claimNext();
  if (!claimed)
    throw new Error("Expected the folder setup job to be claimable.");
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

describe("Run instance persistence", () => {
  it("persists bounded metadata and idempotently reuses a request identity", async () => {
    const request = {
      projectId,
      worktreeId,
      workerId: "run-worker",
      idempotencyKey: randomUUID(),
      actionId: "a".repeat(64),
      configurationRevision: "b".repeat(64),
    };
    const first = await database.repository.createOrGetRunInstance(
      LOCAL_USER_ID,
      request,
    );
    const retry = await database.repository.createOrGetRunInstance(
      LOCAL_USER_ID,
      request,
    );

    expect(first.created).toBe(true);
    expect(retry).toEqual({ created: false, run: first.run });
    expect(first.run).toMatchObject({
      state: "queued",
      terminalId: null,
      exitCode: null,
      signal: null,
    });
    expect(first.run).not.toHaveProperty("command");
    expect(first.run).not.toHaveProperty("environment");
    expect(first.run).not.toHaveProperty("scrollback");
    expect(
      await database.repository.desktopUpdateActiveWork(LOCAL_USER_ID),
    ).toMatchObject({ backgroundJobs: 1 });

    await expect(
      database.repository.createOrGetRunInstance(LOCAL_USER_ID, {
        ...request,
        actionId: "c".repeat(64),
      }),
    ).rejects.toThrow(/another action/iu);
  });

  it("applies monotonic worker observations and reconciles active identities", async () => {
    const created = await database.repository.createOrGetRunInstance(
      LOCAL_USER_ID,
      {
        projectId,
        worktreeId,
        workerId: "run-worker",
        idempotencyKey: randomUUID(),
        actionId: "d".repeat(64),
        configurationRevision: "e".repeat(64),
      },
    );
    await database.repository.transitionRunInstance(
      LOCAL_USER_ID,
      projectId,
      worktreeId,
      created.run.id,
      "starting",
    );
    const running = await database.repository.applyRunInstanceObservation(
      LOCAL_USER_ID,
      "run-worker",
      {
        runId: created.run.id,
        projectId,
        worktreeId,
        actionId: created.run.actionId,
        configurationRevision: created.run.configurationRevision,
        state: "running",
        startedAt: "2026-08-21T12:00:00.000Z",
        endedAt: null,
        exitCode: null,
        signal: null,
      },
    );
    expect(running?.state).toBe("running");
    expect(
      await database.repository.listActiveRunIdentitiesForWorker(
        LOCAL_USER_ID,
        "run-worker",
      ),
    ).toContainEqual(
      expect.objectContaining({
        runId: created.run.id,
        actionId: created.run.actionId,
      }),
    );

    const exited = await database.repository.applyRunInstanceObservation(
      LOCAL_USER_ID,
      "run-worker",
      {
        runId: created.run.id,
        projectId,
        worktreeId,
        actionId: created.run.actionId,
        configurationRevision: created.run.configurationRevision,
        state: "exited",
        startedAt: "2026-08-21T12:00:00.000Z",
        endedAt: "2026-08-21T12:00:01.000Z",
        exitCode: 7,
        signal: null,
      },
    );
    expect(exited).toMatchObject({ state: "exited", exitCode: 7 });

    const late = await database.repository.applyRunInstanceObservation(
      LOCAL_USER_ID,
      "run-worker",
      {
        runId: created.run.id,
        projectId,
        worktreeId,
        actionId: created.run.actionId,
        configurationRevision: created.run.configurationRevision,
        state: "running",
        startedAt: "2026-08-21T12:00:00.000Z",
        endedAt: null,
        exitCode: null,
        signal: null,
      },
    );
    expect(late).toMatchObject({ state: "exited", exitCode: 7 });
    expect(
      await database.repository.listActiveRunIdentitiesForWorker(
        LOCAL_USER_ID,
        "run-worker",
      ),
    ).not.toContainEqual(expect.objectContaining({ runId: created.run.id }));
  });

  it("defines no durable command, environment, or output columns", () => {
    expect(Object.keys(getTableColumns(runInstances)).sort()).toEqual(
      [
        "actionId",
        "configurationRevision",
        "createdAt",
        "endedAt",
        "exitCode",
        "id",
        "idempotencyKey",
        "ownerId",
        "projectId",
        "signal",
        "startedAt",
        "state",
        "terminalId",
        "updatedAt",
        "workerId",
        "worktreeId",
      ].sort(),
    );
  });
});
