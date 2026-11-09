import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-worktree-lifecycle-recovery-"),
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

let database: DatabaseConnection;
let projectId: string;
let worktreeId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureLocalIdentity();
  await database.repository.ensureAccountConfiguration(LOCAL_USER_ID);
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

it("restores a removing worktree while retaining owner and active-source boundaries", async () => {
  const repository = database.repository;
  expect(
    await repository.setProjectWorktreeLifecycle(
      LOCAL_USER_ID,
      projectId,
      worktreeId,
      "removing",
    ),
  ).toMatchObject({ id: worktreeId, lifecycleState: "removing" });
  expect(
    await repository.getProjectWorktreeContext(
      LOCAL_USER_ID,
      projectId,
      worktreeId,
    ),
  ).toBeNull();
  for (const [owner, project, worktree] of [
    ["foreign-owner", projectId, worktreeId],
    [LOCAL_USER_ID, "foreign-project", worktreeId],
    [LOCAL_USER_ID, projectId, "unknown-worktree"],
  ]) {
    expect(
      await repository.setProjectWorktreeLifecycle(
        owner!,
        project!,
        worktree!,
        "ready",
      ),
    ).toBeNull();
  }
  expect(
    (await repository.listProjectWorktrees(LOCAL_USER_ID, projectId))[0],
  ).toMatchObject({ lifecycleState: "removing" });
  expect(
    await repository.setProjectWorktreeLifecycle(
      LOCAL_USER_ID,
      projectId,
      worktreeId,
      "ready",
    ),
  ).toMatchObject({ id: worktreeId, lifecycleState: "ready" });
  expect(
    await repository.getProjectWorktreeContext(
      LOCAL_USER_ID,
      projectId,
      worktreeId,
    ),
  ).not.toBeNull();
  await repository.setProjectWorktreeLifecycle(
    LOCAL_USER_ID,
    projectId,
    worktreeId,
    "removing",
  );
  await repository.projects.database.execute(
    sql`UPDATE project_sources SET removed_at=now() WHERE project_id=${projectId}`,
  );
  expect(
    await repository.setProjectWorktreeLifecycle(
      LOCAL_USER_ID,
      projectId,
      worktreeId,
      "ready",
    ),
  ).toBeNull();
  await repository.projects.database.execute(
    sql`UPDATE project_sources SET removed_at=NULL WHERE project_id=${projectId}`,
  );
  expect(
    (await repository.listProjectWorktrees(LOCAL_USER_ID, projectId))[0],
  ).toMatchObject({ lifecycleState: "removing" });
});
