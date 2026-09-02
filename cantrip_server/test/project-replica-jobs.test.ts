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

import { protectedProjectFields } from "./private-label-fixture.js";

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
const repositoryHandle = `ctrr_${"A".repeat(43)}`;

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
      ...protectedProjectFields(),
      repositoryBlindIndex: "A".repeat(43),
      repositoryId: "repository-one",
      nameWithOwner: "ArcaneArts/Cantrip",
      url: "https://github.com/ArcaneArts/Cantrip",
    });
    const request = {
      workerId: "replica-worker",
      repository: repositoryHandle,
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
    expect(created).toMatchObject({
      placementMode: "managed",
      placementPath: null,
      resolvedMaterialization: null,
      resolvedOwnership: null,
    });
    await expect(
      first.repository.projectReplicaJobs.createProvision(
        LOCAL_USER_ID,
        project.id,
        { ...request, expectedRevision: "b".repeat(40) },
      ),
    ).rejects.toBeInstanceOf(ProjectReplicaJobConflictError);
    await expect(
      first.repository.projectReplicaJobs.createProvision(
        LOCAL_USER_ID,
        project.id,
        {
          ...request,
          placement: { mode: "direct", path: `ctrr_${"P".repeat(43)}` },
        },
      ),
    ).rejects.toBeInstanceOf(ProjectReplicaJobConflictError);
    await expect(
      first.repository.projectReplicaJobs.createProvision(
        LOCAL_USER_ID,
        project.id,
        {
          ...request,
          idempotencyKey: "unsupported-direct-placement",
          placement: { mode: "direct", path: `ctrr_${"P".repeat(43)}` },
        },
      ),
    ).rejects.toThrow(
      "The selected worker does not support this repository placement mode.",
    );

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
          repository: repositoryHandle,
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
        directPlacement: true,
        attachExisting: true,
        recursiveParentCreation: true,
      },
      startedAt: "2026-08-11T12:00:00.000Z",
    });
    const secondReplicaJob =
      await second.repository.projectReplicaJobs.createProvision(
        LOCAL_USER_ID,
        project.id,
        {
          workerId: "replica-worker-two",
          repository: repositoryHandle,
          expectedRevision: "b".repeat(40),
          idempotencyKey: "provision:repository-one:replica-worker-two",
          placement: { mode: "direct", path: `ctrr_${"P".repeat(43)}` },
        },
      );
    expect(secondReplicaJob).toMatchObject({
      placementMode: "direct",
      placementPath: `ctrr_${"P".repeat(43)}`,
    });
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
          path: `ctrr_${"T".repeat(43)}`,
          displayPath: "ArcaneArts/Cantrip",
          repositoryFingerprint: "e".repeat(64),
          resolvedRevision: "b".repeat(40),
          branch: "main",
          reused: true,
          worktreePolicy: null,
          placement: {
            mode: "direct",
            materialization: "attached",
            ownership: "user",
            canonicalPath: `ctrr_${"C".repeat(43)}`,
            requestedPath: `ctrr_${"R".repeat(43)}`,
            linkPath: null,
          },
        },
      );
    expect(secondReplica).toMatchObject({
      resolvedMaterialization: "attached",
      resolvedOwnership: "user",
    });
    const provisionedReplica = await second.repository.getProjectReplica(
      LOCAL_USER_ID,
      project.id,
      secondReplica.projectReplicaId!,
    );
    expect(provisionedReplica).toMatchObject({
      path: `ctrr_${"T".repeat(43)}`,
      placementMode: "direct",
      ownershipKind: "user",
      requestedPath: `ctrr_${"R".repeat(43)}`,
      linkPath: null,
    });
    await expect(
      second.repository.reconcileWorkerProjectObservationPaths(
        LOCAL_USER_ID,
        "replica-worker-two",
        [
          {
            expectedSourcePath: `ctrr_${"T".repeat(43)}`,
            expectedWorktreePath: `ctrr_${"T".repeat(43)}`,
            projectId: project.id,
            sourcePath: `ctrr_${"V".repeat(43)}`,
            worktreeId: provisionedReplica!.primaryWorktreeId!,
            worktreePath: `ctrr_${"V".repeat(43)}`,
          },
        ],
      ),
    ).resolves.toBe(2);
    const synchronization =
      await second.repository.projectReplicaJobs.createSynchronize(
        LOCAL_USER_ID,
        project.id,
        secondReplica.projectReplicaId!,
        {
          repository: repositoryHandle,
          expectedRevision: "c".repeat(40),
          policy: "fast-forward-primary",
          idempotencyKey: "sync:repository-one:replica-worker-two:c",
        },
      );
    expect(synchronization).toMatchObject({
      kind: "synchronize",
      expectedRevision: "c".repeat(40),
      synchronizationPolicy: "fast-forward-primary",
      placementMode: "direct",
      placementPath: `ctrr_${"R".repeat(43)}`,
    });
    const synchronizationAttempt =
      await second.repository.projectReplicaJobs.claimNext();
    expect(
      await second.repository.projectReplicaJobs.operationContext(
        synchronization.id,
        synchronizationAttempt!.commandId,
      ),
    ).toMatchObject({
      sourcePath: `ctrr_${"V".repeat(43)}`,
      placementMode: "direct",
      ownershipKind: "user",
      requestedPath: `ctrr_${"R".repeat(43)}`,
      linkPath: null,
      repositoryFingerprint: "e".repeat(64),
    });
    await second.repository.projectReplicaJobs.completeSynchronize(
      synchronization.id,
      synchronizationAttempt!.commandId,
      {
        status: "ready",
        jobId: synchronization.id,
        attempt: 1,
        path: `ctrr_${"U".repeat(43)}`,
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
    ).toMatchObject({
      path: `ctrr_${"U".repeat(43)}`,
      head: "c".repeat(40),
      branch: "main",
    });
    await expect(
      second.repository.projectReplicaJobs.createRemove(
        LOCAL_USER_ID,
        project.id,
        secondReplica.projectReplicaId!,
        {
          repository: repositoryHandle,
          deleteLocalFiles: true,
          idempotencyKey: "remove:repository-one:replica-worker-two:delete",
        },
      ),
    ).rejects.toThrow(
      "This checkout existed before Cantrip and cannot be deleted.",
    );
    const removal = await second.repository.projectReplicaJobs.createRemove(
      LOCAL_USER_ID,
      project.id,
      secondReplica.projectReplicaId!,
      {
        repository: repositoryHandle,
        deleteLocalFiles: false,
        idempotencyKey: "remove:repository-one:replica-worker-two",
      },
    );
    const removalAttempt =
      await second.repository.projectReplicaJobs.claimNext();
    expect(removal).toMatchObject({
      placementMode: "direct",
      placementPath: `ctrr_${"R".repeat(43)}`,
    });
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
        path: `ctrr_${"U".repeat(43)}`,
        localFilesDeleted: false,
        warning: "The retained checkout was left untouched.",
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
      progress: { stage: "succeeded", percent: 100 },
    });
    const reprovision =
      await second.repository.projectReplicaJobs.createProvision(
        LOCAL_USER_ID,
        project.id,
        {
          workerId: "replica-worker-two",
          repository: repositoryHandle,
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
        ...protectedProjectFields(),
        repositoryBlindIndex: "B".repeat(43),
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
        repository: repositoryHandle,
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

  it("attaches local Git sources and limits preferred workers to ready sources", async () => {
    const localGitDataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-local-git-replica-jobs-"),
    );
    const connection = await connectDatabase({
      ...config,
      dataDirectory: localGitDataDirectory,
    });
    try {
      const homeWorkerId = "local-git-home";
      const secondaryWorkerId = "local-git-secondary";
      for (const workerId of [homeWorkerId, secondaryWorkerId]) {
        await connection.repository.recordWorker(LOCAL_USER_ID, {
          workerId,
          name: workerId,
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
            directPlacement: true,
            attachExisting: true,
            recursiveParentCreation: false,
          },
          startedAt: "2026-08-11T12:00:00.000Z",
        });
      }
      const created = await connection.repository.createManagedFolderProject(
        LOCAL_USER_ID,
        {
          workerId: homeWorkerId,
          ...protectedProjectFields(),
          existingPath: `ctrr_${"H".repeat(43)}`,
        },
      );
      const setup =
        await connection.repository.projectFolderSetupJobs.claimNext();
      if (!setup) throw new Error("Expected local Git setup job.");
      await connection.repository.projectFolderSetupJobs.complete(
        setup.job.id,
        setup.commandId,
        {
          status: "ready",
          jobId: setup.job.id,
          attempt: setup.job.attempt,
          path: `ctrr_${"I".repeat(43)}`,
          displayPath: `ctrr_${"J".repeat(43)}`,
          reused: true,
          repositoryFingerprint: "c".repeat(64),
          github: null,
        },
      );
      expect(
        await connection.repository.getProject(
          LOCAL_USER_ID,
          created.project.id,
        ),
      ).toMatchObject({
        capabilities: {
          git: true,
          github: false,
          worktrees: false,
          replicas: true,
          relocation: true,
        },
      });
      await expect(
        connection.repository.updateProjectPreferredWorker(
          LOCAL_USER_ID,
          created.project.id,
          secondaryWorkerId,
        ),
      ).rejects.toThrow(
        "Attach a ready local Git source on this worker before selecting it as preferred.",
      );

      const revision = "d".repeat(40);
      const attachment =
        await connection.repository.projectReplicaJobs.createProvision(
          LOCAL_USER_ID,
          created.project.id,
          {
            workerId: secondaryWorkerId,
            repository: null,
            expectedRevision: revision,
            idempotencyKey: "attach:local-git-secondary",
            placement: {
              mode: "direct",
              path: `ctrr_${"K".repeat(43)}`,
            },
          },
        );
      const attachmentAttempt =
        await connection.repository.projectReplicaJobs.claimNext();
      expect(attachmentAttempt?.job.id).toBe(attachment.id);
      const attached =
        await connection.repository.projectReplicaJobs.completeProvision(
          attachment.id,
          attachmentAttempt!.commandId,
          {
            status: "ready",
            jobId: attachment.id,
            attempt: attachmentAttempt!.job.attempt,
            path: `ctrr_${"L".repeat(43)}`,
            displayPath: `ctrr_${"M".repeat(43)}`,
            repositoryFingerprint: "e".repeat(64),
            resolvedRevision: revision,
            branch: "main",
            reused: true,
            worktreePolicy: null,
            placement: {
              mode: "direct",
              materialization: "attached",
              ownership: "user",
              canonicalPath: `ctrr_${"L".repeat(43)}`,
              requestedPath: `ctrr_${"K".repeat(43)}`,
              linkPath: null,
            },
          },
        );
      expect(
        await connection.repository.updateProjectPreferredWorker(
          LOCAL_USER_ID,
          created.project.id,
          secondaryWorkerId,
        ),
      ).toMatchObject({ preferredWorkerId: secondaryWorkerId });

      await expect(
        connection.repository.projectReplicaJobs.createSynchronize(
          LOCAL_USER_ID,
          created.project.id,
          attached.projectReplicaId!,
          {
            repository: null,
            expectedRevision: revision,
            policy: "verify-only",
            idempotencyKey: "sync:local-git-secondary",
          },
        ),
      ).rejects.toThrow(
        "Local Git sources do not support remote synchronization.",
      );
      await expect(
        connection.repository.projectReplicaJobs.createRemove(
          LOCAL_USER_ID,
          created.project.id,
          attached.projectReplicaId!,
          {
            repository: null,
            deleteLocalFiles: true,
            idempotencyKey: "delete:local-git-secondary",
          },
        ),
      ).rejects.toThrow(
        "Detaching a local Git source never deletes its checkout.",
      );
      const removal =
        await connection.repository.projectReplicaJobs.createRemove(
          LOCAL_USER_ID,
          created.project.id,
          attached.projectReplicaId!,
          {
            repository: null,
            deleteLocalFiles: false,
            idempotencyKey: "detach:local-git-secondary",
          },
        );
      const removalAttempt =
        await connection.repository.projectReplicaJobs.claimNext();
      await connection.repository.projectReplicaJobs.markRemovalStarted(
        attached.projectReplicaId!,
      );
      await connection.repository.projectReplicaJobs.completeRemove(
        removal.id,
        removalAttempt!.commandId,
        {
          status: "removed",
          jobId: removal.id,
          attempt: removalAttempt!.job.attempt,
          path: `ctrr_${"L".repeat(43)}`,
          localFilesDeleted: false,
          ownershipReleased: true,
        },
      );
      expect(
        await connection.repository.getProject(
          LOCAL_USER_ID,
          created.project.id,
        ),
      ).toMatchObject({ preferredWorkerId: homeWorkerId });
    } finally {
      await connection.close();
      await rm(localGitDataDirectory, { recursive: true, force: true });
    }
  });
});
