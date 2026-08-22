import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { afterAll, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { WorktreeSetupJobStaleAttemptError } from "../src/db/worktree-setup-jobs.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-worktree-setup-jobs-"),
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

afterAll(async () => {
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("durable worktree setup jobs", () => {
  it("gates readiness, retries revision drift, and cleans up missing worktrees", async () => {
    const database = await connectDatabase(config);
    try {
      const workerId = "setup-worker";
      const primaryPath = path.join(dataDirectory, "repository");
      const worktreePath = path.join(dataDirectory, "worktrees", "feature");
      await database.repository.recordWorker(LOCAL_USER_ID, {
        workerId,
        name: "Setup Worker",
        platform: "linux",
        architecture: "x64",
        codexVersion: null,
        codexRuntime: unprobedCodexRuntimeReport,
        remoteSurfaces: {
          browser: false,
          desktop: false,
          transports: ["websocket"],
          maxSessions: 1,
        },
        startedAt: "2026-08-21T12:00:00.000Z",
      });
      const project = await database.repository.createGithubProject(
        LOCAL_USER_ID,
        {
          workerId,
          ...protectedProjectFields(),
          repositoryBlindIndex: "C".repeat(43),
          repositoryId: "setup-repository",
          nameWithOwner: "ArcaneArts/Cantrip",
          url: "https://github.com/ArcaneArts/Cantrip",
        },
      );
      await database.repository.completeGithubProjectSetup(
        LOCAL_USER_ID,
        project.id,
        workerId,
        {
          path: primaryPath,
          displayPath: "ArcaneArts/Cantrip",
          reused: false,
          updated: false,
          warning: null,
        },
      );
      const worktreeId = randomUUID();
      const inventory = {
        sourcePath: primaryPath,
        primaryPath,
        gitCommonDir: path.join(primaryPath, ".git"),
        managedRoot: path.join(dataDirectory, "worktrees"),
        repositoryFingerprint: "d".repeat(64),
        worktrees: [
          {
            path: primaryPath,
            head: "1".repeat(40),
            branch: "main",
            detached: false,
            isPrimary: true,
            managed: true,
            locked: false,
            lockReason: null,
            prunable: false,
            pruneReason: null,
            missing: false,
          },
          {
            path: worktreePath,
            head: "2".repeat(40),
            branch: "feature/setup",
            detached: false,
            isPrimary: false,
            managed: true,
            locked: false,
            lockReason: null,
            prunable: false,
            pruneReason: null,
            missing: false,
          },
        ],
      };
      await database.repository.reconcileProjectWorktrees(
        LOCAL_USER_ID,
        project.id,
        workerId,
        inventory,
        {
          id: worktreeId,
          lifecycleState: "preparing",
          name: "Setup feature",
          origin: "user",
          path: worktreePath,
        },
      );

      const firstRevision = "a".repeat(64);
      const initialized =
        await database.repository.worktreeSetupJobs.initialize({
          configurationRevision: firstRevision,
          ownerId: LOCAL_USER_ID,
          projectId: project.id,
          queued: true,
          workerId,
          worktreeId,
        });
      expect(initialized).toMatchObject({
        created: true,
        job: { state: "queued", attempt: 0 },
      });
      expect(
        (
          await database.repository.listProjectWorktrees(
            LOCAL_USER_ID,
            project.id,
          )
        ).find(({ id }) => id === worktreeId),
      ).toMatchObject({ lifecycleState: "preparing" });

      const claimed = await database.repository.worktreeSetupJobs.claimNext();
      expect(claimed).toMatchObject({
        sourcePath: primaryPath,
        worktreePath,
        job: { id: initialized.job.id, state: "running", attempt: 1 },
      });
      const completedAt = "2026-08-21T12:00:02.000Z";
      const succeeded = await database.repository.worktreeSetupJobs.complete(
        initialized.job.id,
        claimed!.commandId,
        {
          jobId: initialized.job.id,
          projectId: project.id,
          worktreeId,
          configurationRevision: firstRevision,
          attempt: 1,
          state: "succeeded",
          output: "prepared\r\n",
          outputTruncated: false,
          exitCode: 0,
          signal: null,
          error: null,
          startedAt: "2026-08-21T12:00:01.000Z",
          completedAt,
          updatedAt: completedAt,
        },
      );
      expect(succeeded).toMatchObject({ state: "succeeded", attempt: 1 });
      expect(
        (
          await database.repository.listProjectWorktrees(
            LOCAL_USER_ID,
            project.id,
          )
        ).find(({ id }) => id === worktreeId),
      ).toMatchObject({ lifecycleState: "ready" });

      const stale = await database.repository.worktreeSetupJobs.markStale(
        LOCAL_USER_ID,
        project.id,
        worktreeId,
        succeeded.stateRevision,
      );
      expect(stale).toMatchObject({
        state: "stale",
        error: { code: "configuration-stale" },
      });
      const secondRevision = "b".repeat(64);
      const retried = await database.repository.worktreeSetupJobs.retry(
        LOCAL_USER_ID,
        project.id,
        worktreeId,
        stale!.stateRevision,
        secondRevision,
        null,
      );
      expect(retried).toMatchObject({
        state: "queued",
        configurationRevision: secondRevision,
      });
      const secondAttempt =
        await database.repository.worktreeSetupJobs.claimNext();
      expect(secondAttempt?.job).toMatchObject({
        state: "running",
        attempt: 2,
      });
      await expect(
        database.repository.worktreeSetupJobs.complete(
          initialized.job.id,
          claimed!.commandId,
          {
            jobId: initialized.job.id,
            projectId: project.id,
            worktreeId,
            configurationRevision: firstRevision,
            attempt: 1,
            state: "succeeded",
            output: "late",
            outputTruncated: false,
            exitCode: 0,
            signal: null,
            error: null,
            startedAt: completedAt,
            completedAt,
            updatedAt: completedAt,
          },
        ),
      ).rejects.toBeInstanceOf(WorktreeSetupJobStaleAttemptError);
      const failed = await database.repository.worktreeSetupJobs.fail(
        initialized.job.id,
        secondAttempt!.commandId,
        null,
        {
          code: "setup-failed",
          message: "Restore failed.",
          retryable: true,
        },
      );
      expect(failed).toMatchObject({
        state: "failed",
        attempt: 2,
        error: { code: "setup-failed" },
      });
      expect(
        (
          await database.repository.listProjectWorktrees(
            LOCAL_USER_ID,
            project.id,
          )
        ).find(({ id }) => id === worktreeId),
      ).toMatchObject({ lifecycleState: "setup-failed" });

      await database.repository.reconcileProjectWorktrees(
        LOCAL_USER_ID,
        project.id,
        workerId,
        { ...inventory, worktrees: inventory.worktrees.slice(0, 1) },
      );
      await expect(
        database.repository.worktreeSetupJobs.get(
          LOCAL_USER_ID,
          project.id,
          worktreeId,
        ),
      ).resolves.toBeNull();
    } finally {
      await database.close();
    }
  });
});
