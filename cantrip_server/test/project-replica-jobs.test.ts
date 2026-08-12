import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { afterAll, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import {
  PROJECT_REPLICA_JOB_LEASE_MS,
  ProjectReplicaJobConflictError,
  ProjectReplicaJobStaleAttemptError,
} from "../src/db/project-replica-jobs.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-project-replica-jobs-"),
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

describe("durable project replica jobs", () => {
  it("recovers attempts across restart and rejects stale completions", async () => {
    const first = await connectDatabase(config);
    await first.repository.recordWorker(LOCAL_USER_ID, {
      workerId: "replica-worker",
      name: "Replica Worker",
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
      projectReplicas: {
        provision: true,
        synchronize: false,
        remove: false,
        exactRevision: true,
      },
      startedAt: "2026-08-11T12:00:00.000Z",
    });
    const project = await first.repository.createGithubProject(LOCAL_USER_ID, {
      workerId: "replica-worker",
      repositoryId: "repository-one",
      nameWithOwner: "ArcaneArts/Cantrip",
      url: "https://github.com/ArcaneArts/Cantrip",
    });
    const request = {
      workerId: "replica-worker",
      expectedRevision: "a".repeat(40),
      idempotencyKey: "provision:repository-one:replica-worker",
    };
    const created = await first.repository.projectReplicaJobs.createProvision(
      LOCAL_USER_ID,
      project.id,
      request,
    );
    const replayed = await first.repository.projectReplicaJobs.createProvision(
      LOCAL_USER_ID,
      project.id,
      request,
    );
    expect(replayed.id).toBe(created.id);
    await expect(
      first.repository.projectReplicaJobs.createProvision(
        LOCAL_USER_ID,
        project.id,
        { ...request, expectedRevision: "b".repeat(40) },
      ),
    ).rejects.toBeInstanceOf(ProjectReplicaJobConflictError);

    const firstAttempt = await first.repository.projectReplicaJobs.claimNext();
    expect(firstAttempt?.job).toMatchObject({
      id: created.id,
      state: "running",
      attempt: 1,
      expectedRevision: "a".repeat(40),
    });
    expect(
      await first.repository.projectReplicaJobs.updateProgress(
        created.id,
        firstAttempt!.commandId,
        1,
        {
          stage: "fetching",
          percent: 35,
          message: "Fetching repository references.",
        },
      ),
    ).toMatchObject({
      state: "running",
      stateRevision: 3,
      progress: { stage: "fetching", percent: 35 },
    });
    await first.close();

    const second = await connectDatabase(config);
    expect(
      await second.repository.projectReplicaJobs.recoverInterrupted(),
    ).toBe(1);
    expect(
      await second.repository.projectReplicaJobs.get(LOCAL_USER_ID, created.id),
    ).toMatchObject({ state: "queued", attempt: 1 });
    const secondAttempt =
      await second.repository.projectReplicaJobs.claimNext();
    expect(secondAttempt?.job).toMatchObject({ state: "running", attempt: 2 });
    await expect(
      second.repository.projectReplicaJobs.completeProvision(
        created.id,
        firstAttempt!.commandId,
        {
          status: "ready",
          jobId: created.id,
          attempt: 1,
          path: "/worker/repositories/ArcaneArts/Cantrip",
          displayPath: "ArcaneArts/Cantrip",
          repositoryFingerprint: "f".repeat(64),
          resolvedRevision: "a".repeat(40),
          branch: "main",
          reused: false,
          worktreePolicy: null,
        },
      ),
    ).rejects.toBeInstanceOf(ProjectReplicaJobStaleAttemptError);

    const completed =
      await second.repository.projectReplicaJobs.completeProvision(
        created.id,
        secondAttempt!.commandId,
        {
          status: "ready",
          jobId: created.id,
          attempt: 2,
          path: "/worker/repositories/ArcaneArts/Cantrip",
          displayPath: "ArcaneArts/Cantrip",
          repositoryFingerprint: "f".repeat(64),
          resolvedRevision: "a".repeat(40),
          branch: "main",
          reused: false,
          worktreePolicy: null,
        },
      );
    expect(completed).toMatchObject({
      state: "succeeded",
      attempt: 2,
      resolvedRevision: "a".repeat(40),
      projectReplicaId: expect.any(String),
    });
    expect(
      await second.repository.listProjectReplicas(LOCAL_USER_ID, project.id),
    ).toEqual([
      expect.objectContaining({
        workerId: "replica-worker",
        head: "a".repeat(40),
        ready: true,
      }),
    ]);
    await expect(
      second.repository.projectReplicaJobs.createRemove(
        LOCAL_USER_ID,
        project.id,
        completed.projectReplicaId!,
        {
          deleteLocalFiles: true,
          idempotencyKey: "remove:last-replica",
        },
      ),
    ).rejects.toBeInstanceOf(ProjectReplicaJobConflictError);

    await second.repository.recordWorker(LOCAL_USER_ID, {
      workerId: "replica-worker-two",
      name: "Replica Worker Two",
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
      projectReplicas: {
        provision: true,
        synchronize: true,
        remove: true,
        exactRevision: true,
      },
      startedAt: "2026-08-11T12:00:00.000Z",
    });
    const secondReplicaJob =
      await second.repository.projectReplicaJobs.createProvision(
        LOCAL_USER_ID,
        project.id,
        {
          workerId: "replica-worker-two",
          expectedRevision: "b".repeat(40),
          idempotencyKey: "provision:repository-one:replica-worker-two",
        },
      );
    const secondReplicaAttempt =
      await second.repository.projectReplicaJobs.claimNext();
    const secondReplica =
      await second.repository.projectReplicaJobs.completeProvision(
        secondReplicaJob.id,
        secondReplicaAttempt!.commandId,
        {
          status: "ready",
          jobId: secondReplicaJob.id,
          attempt: 1,
          path: "/worker-two/repositories/ArcaneArts/Cantrip",
          displayPath: "ArcaneArts/Cantrip",
          repositoryFingerprint: "e".repeat(64),
          resolvedRevision: "b".repeat(40),
          branch: "main",
          reused: false,
          worktreePolicy: null,
        },
      );
    const synchronization =
      await second.repository.projectReplicaJobs.createSynchronize(
        LOCAL_USER_ID,
        project.id,
        secondReplica.projectReplicaId!,
        {
          expectedRevision: "c".repeat(40),
          policy: "fast-forward-primary",
          idempotencyKey: "sync:repository-one:replica-worker-two:c",
        },
      );
    expect(synchronization).toMatchObject({
      kind: "synchronize",
      expectedRevision: "c".repeat(40),
      synchronizationPolicy: "fast-forward-primary",
    });
    const synchronizationAttempt =
      await second.repository.projectReplicaJobs.claimNext();
    await second.repository.projectReplicaJobs.completeSynchronize(
      synchronization.id,
      synchronizationAttempt!.commandId,
      {
        status: "ready",
        jobId: synchronization.id,
        attempt: 1,
        path: "/worker-two/repositories/ArcaneArts/Cantrip",
        previousRevision: "b".repeat(40),
        resolvedRevision: "c".repeat(40),
        branch: "main",
        changed: true,
      },
    );
    expect(
      await second.repository.getProjectReplica(
        LOCAL_USER_ID,
        project.id,
        secondReplica.projectReplicaId!,
      ),
    ).toMatchObject({ head: "c".repeat(40), branch: "main" });
    const removal = await second.repository.projectReplicaJobs.createRemove(
      LOCAL_USER_ID,
      project.id,
      secondReplica.projectReplicaId!,
      {
        deleteLocalFiles: true,
        idempotencyKey: "remove:repository-one:replica-worker-two",
      },
    );
    const removalAttempt =
      await second.repository.projectReplicaJobs.claimNext();
    expect(
      await second.repository.projectReplicaJobs.removalBlocker(
        secondReplica.projectReplicaId!,
        removal.id,
      ),
    ).toBeNull();
    expect(
      await second.repository.projectReplicaJobs.markRemovalStarted(
        secondReplica.projectReplicaId!,
      ),
    ).toBe(true);
    const replicaBeforeRemoval = await second.repository.getProjectReplica(
      LOCAL_USER_ID,
      project.id,
      secondReplica.projectReplicaId!,
    );
    expect(
      await second.repository.getProjectWorktreeContext(
        LOCAL_USER_ID,
        project.id,
        replicaBeforeRemoval!.primaryWorktreeId!,
      ),
    ).toBeNull();
    await second.repository.projectReplicaJobs.completeRemove(
      removal.id,
      removalAttempt!.commandId,
      {
        status: "removed",
        jobId: removal.id,
        attempt: 1,
        path: "/worker-two/repositories/ArcaneArts/Cantrip",
        localFilesDeleted: true,
      },
    );
    expect(
      await second.repository.listProjectReplicas(LOCAL_USER_ID, project.id),
    ).toEqual([expect.objectContaining({ workerId: "replica-worker" })]);
    expect(
      await second.repository.projectReplicaJobs.get(LOCAL_USER_ID, removal.id),
    ).toMatchObject({
      state: "succeeded",
      projectReplicaId: secondReplica.projectReplicaId,
    });
    const reprovision =
      await second.repository.projectReplicaJobs.createProvision(
        LOCAL_USER_ID,
        project.id,
        {
          workerId: "replica-worker-two",
          expectedRevision: null,
          idempotencyKey: "reprovision:repository-one:replica-worker-two",
        },
      );
    expect(reprovision).toMatchObject({ kind: "provision", state: "queued" });
    await second.repository.projectReplicaJobs.cancel(
      LOCAL_USER_ID,
      reprovision.id,
      reprovision.stateRevision,
    );

    const offlineProject = await second.repository.createGithubProject(
      LOCAL_USER_ID,
      {
        workerId: "replica-worker",
        repositoryId: "repository-two",
        nameWithOwner: "ArcaneArts/Offline",
        url: "https://github.com/ArcaneArts/Offline",
      },
    );
    const offline = await second.repository.projectReplicaJobs.createProvision(
      LOCAL_USER_ID,
      offlineProject.id,
      {
        workerId: "replica-worker",
        expectedRevision: null,
        idempotencyKey: "provision:repository-two:replica-worker",
      },
    );
    const offlineAttempt =
      await second.repository.projectReplicaJobs.claimNext();
    expect(offlineAttempt?.job.id).toBe(offline.id);
    await second.repository.projectReplicaJobs.block(
      offline.id,
      offlineAttempt!.commandId,
      {
        code: "worker-offline",
        message: "Worker is offline.",
        retryable: true,
      },
    );
    expect(
      await second.repository.projectReplicaJobs.requeueRetryableForWorker(
        "replica-worker",
      ),
    ).toBe(1);
    const recoveredOfflineAttempt =
      await second.repository.projectReplicaJobs.claimNext();
    expect(recoveredOfflineAttempt).toMatchObject({
      job: { id: offline.id, attempt: 2, state: "running" },
    });
    expect(
      await second.repository.projectReplicaJobs.recoverInterrupted(false),
    ).toBe(0);
    expect(
      await second.repository.projectReplicaJobs.renewLease(
        offline.id,
        recoveredOfflineAttempt!.commandId,
        2,
      ),
    ).toBe(true);
    expect(
      await second.repository.projectReplicaJobs.recoverInterrupted(
        false,
        new Date(Date.now() + PROJECT_REPLICA_JOB_LEASE_MS + 1),
      ),
    ).toBe(1);
    expect(
      await second.repository.projectReplicaJobs.get(LOCAL_USER_ID, offline.id),
    ).toMatchObject({ state: "queued", attempt: 2 });
    await second.close();
  });
});
