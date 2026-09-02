import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { WorkspaceRepositoryDiscoveryInvariantError } from "../src/db/workspace-repository-discovery-jobs.js";
import { SecretVault } from "../src/security/secret-vault.js";
import { protectedProjectFields } from "./private-label-fixture.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const workspaceId = "118e3c88-d173-4208-9a6c-c6d688f14e54";
const workerId = "workspace-discovery-worker";
const rootPathHandle = `ctrr_${"a".repeat(43)}`;

async function fixture() {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  const repository = new ServerRepository(
    database,
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
    }),
  );
  await repository.ensureLocalIdentity();
  await database.insert(schema.workers).values({
    id: workerId,
    ownerId: LOCAL_USER_ID,
    name: "Discovery worker",
    platform: "linux",
    architecture: "x64",
    startedAt: new Date(),
    lastSeenAt: new Date(),
  });
  await database.insert(schema.projectWorkspaces).values({
    id: workspaceId,
    ownerId: LOCAL_USER_ID,
    nameEnvelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: Buffer.alloc(12, 2).toString("base64url"),
      ciphertext: Buffer.alloc(16, 3).toString("base64url"),
    },
    nameBlindIndex: Buffer.alloc(32, 4).toString("base64url"),
    nameFormatVersion: 1,
    nameKeyRevision: 1,
    position: 1,
  });
  await database.insert(schema.projectWorkspaceStorageProfiles).values({
    workspaceId,
    kind: "attached",
    workerId,
    protectedRootPathHandle: rootPathHandle,
    protectedDisplayHandle: `ctrr_${"b".repeat(43)}`,
  });
  return { client, database, repository };
}

describe("workspace repository discovery jobs", () => {
  it("deletes only the empty attached workspace and its discovery metadata", async () => {
    const { client, database, repository } = await fixture();
    try {
      await repository.workspaceRepositoryDiscoveryJobs.queue(
        LOCAL_USER_ID,
        workspaceId,
      );
      const claimed =
        await repository.workspaceRepositoryDiscoveryJobs.claimNext();
      await repository.workspaceRepositoryDiscoveryJobs.complete(
        claimed!.job.id,
        claimed!.commandId,
        {
          attempt: claimed!.job.attempt,
          candidates: [
            {
              pathHandle: `ctrr_${"c".repeat(43)}`,
              displayHandle: `ctrr_${"d".repeat(43)}`,
              originUrlHandle: null,
              github: null,
              repositoryFingerprint: "e".repeat(64),
              classification: "local-git",
              diagnosticCode: null,
            },
          ],
          counts: {
            candidates: 1,
            collapsedRepositories: 0,
            rejectedRepositories: 0,
            scannedDirectories: 1,
            scannedEntries: 1,
            skippedSymlinks: 0,
            unreadableDirectories: 0,
          },
          truncated: false,
        },
      );

      await expect(
        repository.deleteProjectWorkspace(LOCAL_USER_ID, workspaceId),
      ).resolves.toBe(true);
      const workspaces =
        await repository.listProjectWorkspaceWire(LOCAL_USER_ID);
      expect(workspaces.workspaces.some(({ id }) => id === workspaceId)).toBe(
        false,
      );
      expect(
        await database
          .select()
          .from(schema.projectWorkspaceStorageProfiles)
          .where(
            eq(schema.projectWorkspaceStorageProfiles.workspaceId, workspaceId),
          ),
      ).toEqual([]);
      expect(
        await database
          .select()
          .from(schema.workspaceRepositoryDiscoveryJobs)
          .where(
            eq(
              schema.workspaceRepositoryDiscoveryJobs.workspaceId,
              workspaceId,
            ),
          ),
      ).toEqual([]);
      expect(
        await database
          .select()
          .from(schema.workspaceRepositoryCandidates)
          .where(
            eq(schema.workspaceRepositoryCandidates.workspaceId, workspaceId),
          ),
      ).toEqual([]);
      expect(
        await database
          .select({ id: schema.workers.id })
          .from(schema.workers)
          .where(eq(schema.workers.id, workerId)),
      ).toEqual([{ id: workerId }]);
    } finally {
      await client.close();
    }
  });

  it("recovers an interrupted scan and fences its stale completion", async () => {
    const { client, repository } = await fixture();
    try {
      await repository.workspaceRepositoryDiscoveryJobs.queue(
        LOCAL_USER_ID,
        workspaceId,
      );
      const interrupted =
        await repository.workspaceRepositoryDiscoveryJobs.claimNext();
      expect(interrupted?.job).toMatchObject({
        attempt: 1,
        state: "running",
        stateRevision: 2,
      });

      await expect(
        repository.workspaceRepositoryDiscoveryJobs.recoverInterrupted(true),
      ).resolves.toBe(1);
      expect(
        (
          await repository.workspaceRepositoryDiscoveryJobs.getSnapshot(
            LOCAL_USER_ID,
            workspaceId,
          )
        )?.job,
      ).toMatchObject({ state: "queued", stateRevision: 3 });

      const replacement =
        await repository.workspaceRepositoryDiscoveryJobs.claimNext();
      expect(replacement?.job).toMatchObject({
        attempt: 2,
        state: "running",
        stateRevision: 4,
      });
      await expect(
        repository.workspaceRepositoryDiscoveryJobs.complete(
          interrupted!.job.id,
          interrupted!.commandId,
          {
            attempt: interrupted!.job.attempt,
            candidates: [],
            counts: {
              candidates: 0,
              collapsedRepositories: 0,
              rejectedRepositories: 0,
              scannedDirectories: 0,
              scannedEntries: 0,
              skippedSymlinks: 0,
              unreadableDirectories: 0,
            },
            truncated: false,
          },
        ),
      ).rejects.toThrow(/no longer current/iu);
    } finally {
      await client.close();
    }
  });

  it("fences attempts and atomically replaces durable candidates", async () => {
    const { client, repository } = await fixture();
    try {
      const queued = await repository.workspaceRepositoryDiscoveryJobs.queue(
        LOCAL_USER_ID,
        workspaceId,
      );
      expect(queued).toMatchObject({
        workspaceId,
        workerId,
        state: "queued",
        stateRevision: 1,
        attempt: 0,
        depth: 3,
      });

      const claimed =
        await repository.workspaceRepositoryDiscoveryJobs.claimNext();
      expect(claimed).toMatchObject({
        ownerId: LOCAL_USER_ID,
        rootPathHandle,
        job: { state: "running", stateRevision: 2, attempt: 1 },
      });
      const completed =
        await repository.workspaceRepositoryDiscoveryJobs.complete(
          claimed!.job.id,
          claimed!.commandId,
          {
            attempt: claimed!.job.attempt,
            candidates: [
              {
                pathHandle: `ctrr_${"c".repeat(43)}`,
                displayHandle: `ctrr_${"d".repeat(43)}`,
                originUrlHandle: `ctrr_${"f".repeat(43)}`,
                github: {
                  repositoryId: `ctrr_${"g".repeat(43)}`,
                  nameWithOwner: `ctrr_${"h".repeat(43)}`,
                  url: `ctrr_${"i".repeat(43)}`,
                },
                repositoryFingerprint: "e".repeat(64),
                classification: "github-accessible",
                diagnosticCode: null,
              },
            ],
            counts: {
              candidates: 1,
              collapsedRepositories: 0,
              rejectedRepositories: 1,
              scannedDirectories: 4,
              scannedEntries: 12,
              skippedSymlinks: 2,
              unreadableDirectories: 0,
            },
            truncated: false,
          },
        );
      expect(completed.job).toMatchObject({
        state: "succeeded",
        stateRevision: 3,
        counts: { candidates: 1, scannedDirectories: 4 },
      });
      expect(completed.candidates).toEqual([
        expect.objectContaining({
          workspaceId,
          workerId,
          repositoryFingerprint: "e".repeat(64),
          classification: "github-accessible",
          originUrlHandle: `ctrr_${"f".repeat(43)}`,
          github: {
            repositoryId: `ctrr_${"g".repeat(43)}`,
            nameWithOwner: `ctrr_${"h".repeat(43)}`,
            url: `ctrr_${"i".repeat(43)}`,
          },
          importState: "pending",
        }),
      ]);

      await expect(
        repository.workspaceRepositoryDiscoveryJobs.complete(
          claimed!.job.id,
          claimed!.commandId,
          {
            attempt: claimed!.job.attempt,
            candidates: [],
            counts: {
              candidates: 0,
              collapsedRepositories: 0,
              rejectedRepositories: 0,
              scannedDirectories: 0,
              scannedEntries: 0,
              skippedSymlinks: 0,
              unreadableDirectories: 0,
            },
            truncated: false,
          },
        ),
      ).rejects.toThrow(/no longer current/iu);

      await expect(
        repository.workspaceRepositoryDiscoveryJobs.queue(
          LOCAL_USER_ID,
          workspaceId,
          { expectedStateRevision: 2 },
        ),
      ).resolves.toBeNull();
      const rescanned = await repository.workspaceRepositoryDiscoveryJobs.queue(
        LOCAL_USER_ID,
        workspaceId,
        { expectedStateRevision: completed.job.stateRevision },
      );
      expect(rescanned).toMatchObject({ state: "queued", stateRevision: 4 });
      expect(
        (
          await repository.workspaceRepositoryDiscoveryJobs.getSnapshot(
            LOCAL_USER_ID,
            workspaceId,
          )
        )?.candidates,
      ).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("persists unsupported checkouts for review but refuses to import them", async () => {
    const { client, repository } = await fixture();
    try {
      await repository.workspaceRepositoryDiscoveryJobs.queue(
        LOCAL_USER_ID,
        workspaceId,
      );
      const claimed =
        await repository.workspaceRepositoryDiscoveryJobs.claimNext();
      const completed =
        await repository.workspaceRepositoryDiscoveryJobs.complete(
          claimed!.job.id,
          claimed!.commandId,
          {
            attempt: claimed!.job.attempt,
            candidates: [
              {
                pathHandle: `ctrr_${"c".repeat(43)}`,
                displayHandle: `ctrr_${"d".repeat(43)}`,
                repositoryFingerprint: "e".repeat(64),
                classification: "unsupported",
                diagnosticCode: "bare-repository",
              },
            ],
            counts: {
              candidates: 1,
              collapsedRepositories: 0,
              rejectedRepositories: 1,
              scannedDirectories: 1,
              scannedEntries: 1,
              skippedSymlinks: 0,
              unreadableDirectories: 0,
            },
            truncated: false,
          },
        );
      expect(completed.candidates).toEqual([
        expect.objectContaining({
          classification: "unsupported",
          diagnosticCode: "bare-repository",
          importState: "pending",
        }),
      ]);

      const projectId = "09dd9169-04ca-41c1-a473-250b5716bf7c";
      await expect(
        repository.workspaceRepositoryDiscoveryJobs.queueImports(
          LOCAL_USER_ID,
          workspaceId,
          {
            expectedStateRevision: completed.job.stateRevision,
            candidates: [
              {
                candidateId: completed.candidates[0]!.id,
                projectId,
                nameProtection:
                  protectedProjectFields(projectId).nameProtection,
                repositoryBlindIndex: null,
              },
            ],
          },
        ),
      ).rejects.toBeInstanceOf(WorkspaceRepositoryDiscoveryInvariantError);
    } finally {
      await client.close();
    }
  });

  it("requeues retryable worker failures and rejects non-attached workspaces", async () => {
    const { client, database, repository } = await fixture();
    try {
      await repository.workspaceRepositoryDiscoveryJobs.queue(
        LOCAL_USER_ID,
        workspaceId,
      );
      const claimed =
        await repository.workspaceRepositoryDiscoveryJobs.claimNext();
      const blocked = await repository.workspaceRepositoryDiscoveryJobs.block(
        claimed!.job.id,
        claimed!.commandId,
        { code: "worker-offline", retryable: true },
      );
      expect(blocked.state).toBe("blocked");
      await expect(
        repository.workspaceRepositoryDiscoveryJobs.requeueRetryableForWorker(
          workerId,
        ),
      ).resolves.toBe(1);
      expect(
        (
          await repository.workspaceRepositoryDiscoveryJobs.getSnapshot(
            LOCAL_USER_ID,
            workspaceId,
          )
        )?.job.state,
      ).toBe("queued");

      const managedWorkspaceId = "ceabcb6c-afc1-48bf-bfba-c95e7a865d30";
      await database.insert(schema.projectWorkspaces).values({
        id: managedWorkspaceId,
        ownerId: LOCAL_USER_ID,
        nameEnvelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: Buffer.alloc(12, 5).toString("base64url"),
          ciphertext: Buffer.alloc(16, 6).toString("base64url"),
        },
        nameBlindIndex: Buffer.alloc(32, 7).toString("base64url"),
        nameFormatVersion: 1,
        nameKeyRevision: 1,
        position: 2,
      });
      await database.insert(schema.projectWorkspaceStorageProfiles).values({
        workspaceId: managedWorkspaceId,
        kind: "managed",
      });
      await expect(
        repository.workspaceRepositoryDiscoveryJobs.queue(
          LOCAL_USER_ID,
          managedWorkspaceId,
        ),
      ).rejects.toBeInstanceOf(WorkspaceRepositoryDiscoveryInvariantError);
    } finally {
      await client.close();
    }
  });

  it("imports candidates independently and records an existing checkout without cloning", async () => {
    const { client, database, repository } = await fixture();
    try {
      await repository.workspaceRepositoryDiscoveryJobs.queue(
        LOCAL_USER_ID,
        workspaceId,
      );
      const discovery =
        await repository.workspaceRepositoryDiscoveryJobs.claimNext();
      const completed =
        await repository.workspaceRepositoryDiscoveryJobs.complete(
          discovery!.job.id,
          discovery!.commandId,
          {
            attempt: discovery!.job.attempt,
            candidates: [
              {
                pathHandle: `ctrr_${"c".repeat(43)}`,
                displayHandle: `ctrr_${"d".repeat(43)}`,
                repositoryFingerprint: "1".repeat(64),
                classification: "local-git",
                diagnosticCode: null,
              },
              {
                pathHandle: `ctrr_${"e".repeat(43)}`,
                displayHandle: `ctrr_${"f".repeat(43)}`,
                repositoryFingerprint: "2".repeat(64),
                classification: "local-git",
                diagnosticCode: null,
              },
            ],
            counts: {
              candidates: 2,
              collapsedRepositories: 0,
              rejectedRepositories: 0,
              scannedDirectories: 2,
              scannedEntries: 2,
              skippedSymlinks: 0,
              unreadableDirectories: 0,
            },
            truncated: false,
          },
        );
      const firstProjectId = "09dd9169-04ca-41c1-a473-250b5716bf7c";
      const secondProjectId = "a6b5056a-dde0-4385-b948-5f084603520a";
      const queued =
        await repository.workspaceRepositoryDiscoveryJobs.queueImports(
          LOCAL_USER_ID,
          workspaceId,
          {
            expectedStateRevision: completed.job.stateRevision,
            candidates: [
              {
                candidateId: completed.candidates[0]!.id,
                projectId: firstProjectId,
                nameProtection:
                  protectedProjectFields(firstProjectId).nameProtection,
                repositoryBlindIndex: null,
              },
              {
                candidateId: completed.candidates[1]!.id,
                projectId: secondProjectId,
                nameProtection:
                  protectedProjectFields(secondProjectId).nameProtection,
                repositoryBlindIndex: null,
              },
            ],
          },
        );
      expect(queued?.candidates.map(({ importState }) => importState)).toEqual([
        "queued",
        "queued",
      ]);

      const first =
        await repository.workspaceRepositoryDiscoveryJobs.claimNextImport();
      expect(first).toMatchObject({
        projectId: firstProjectId,
        rootPathHandle,
        workerId,
      });
      await repository.workspaceRepositoryDiscoveryJobs.completeImport(first!, {
        candidateId: first!.candidateId,
        attempt: first!.attempt,
        path: `ctrr_${"c".repeat(43)}`,
        displayPath: `ctrr_${"d".repeat(43)}`,
        originUrl: null,
        github: null,
        repositoryFingerprint: "1".repeat(64),
        classification: "local-git",
        diagnosticCode: null,
        branch: `ctrr_${"g".repeat(43)}`,
        head: null,
      });

      const second =
        await repository.workspaceRepositoryDiscoveryJobs.claimNextImport();
      await repository.workspaceRepositoryDiscoveryJobs.failImport(second!, {
        code: "repository-unavailable",
        retryable: false,
      });
      const outcome =
        await repository.workspaceRepositoryDiscoveryJobs.getSnapshot(
          LOCAL_USER_ID,
          workspaceId,
        );
      expect(outcome?.candidates).toEqual([
        expect.objectContaining({
          importState: "imported",
          projectId: firstProjectId,
        }),
        expect.objectContaining({
          importState: "failed",
          projectId: secondProjectId,
          importError: {
            code: "repository-unavailable",
            retryable: false,
          },
        }),
      ]);
      expect(await database.select().from(schema.projects)).toEqual([
        expect.objectContaining({
          id: firstProjectId,
          originKind: "managed-folder",
          folderManagement: "external",
          gitCapability: true,
          githubCapability: false,
          preferredWorkerId: workerId,
        }),
      ]);
      expect(await database.select().from(schema.projectSources)).toEqual([
        expect.objectContaining({
          projectId: firstProjectId,
          workerId,
          placementMode: "direct",
          ownershipKind: "user",
          repositoryFingerprint: "1".repeat(64),
        }),
      ]);
      expect(
        await database.select().from(schema.projectWorkspaceMemberships),
      ).toContainEqual(
        expect.objectContaining({ projectId: firstProjectId, workspaceId }),
      );

      const replicaWorkerId = "workspace-discovery-replica-worker";
      const replicaSourceId = "24b62297-057d-4eaa-9270-6c969edc61ce";
      await database.insert(schema.workers).values({
        id: replicaWorkerId,
        ownerId: LOCAL_USER_ID,
        name: "Discovery replica worker",
        platform: "linux",
        architecture: "x64",
        startedAt: new Date(),
        lastSeenAt: new Date(),
      });
      await database.insert(schema.projectSources).values({
        id: replicaSourceId,
        projectId: firstProjectId,
        workerId: replicaWorkerId,
        sourceKind: "git",
        absolutePath: `ctrr_${"u".repeat(43)}`,
        displayPath: `ctrr_${"v".repeat(43)}`,
        placementMode: "direct",
        ownershipKind: "user",
        requestedPath: `ctrr_${"u".repeat(43)}`,
        repositoryFingerprint: "6".repeat(64),
      });
      await database.insert(schema.projectWorktrees).values({
        id: "f831374f-5606-4764-8114-53e02f366930",
        projectSourceId: replicaSourceId,
        workerId: replicaWorkerId,
        rootKind: "git-worktree",
        name: "Primary",
        absolutePath: `ctrr_${"u".repeat(43)}`,
        displayPath: `ctrr_${"v".repeat(43)}`,
        isPrimary: true,
        isDefault: true,
        origin: "external",
        lifecycleState: "ready",
      });
      expect(
        await repository.resolveProjectExecutionPlacement(
          LOCAL_USER_ID,
          firstProjectId,
          "terminal",
          undefined,
          () => true,
        ),
      ).toMatchObject({
        selection: "project-preference",
        placement: { workerId },
      });
      expect(
        await repository.resolveProjectExecutionPlacement(
          LOCAL_USER_ID,
          firstProjectId,
          "terminal",
          undefined,
          (candidateWorkerId) => candidateWorkerId === replicaWorkerId,
        ),
      ).toMatchObject({
        selection: "fallback",
        placement: {
          projectReplicaId: replicaSourceId,
          workerId: replicaWorkerId,
        },
      });

      const unattachedWorkerId = "workspace-discovery-unattached-worker";
      await database.insert(schema.workers).values({
        id: unattachedWorkerId,
        ownerId: LOCAL_USER_ID,
        name: "Unattached worker",
        platform: "linux",
        architecture: "x64",
        startedAt: new Date(),
        lastSeenAt: new Date(),
      });
      const executionTargets = await repository.listProjectExecutionTargets(
        LOCAL_USER_ID,
        firstProjectId,
        () => true,
      );
      expect(executionTargets?.targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resourceKind: "worker",
            placement: expect.objectContaining({ workerId }),
          }),
          expect.objectContaining({
            resourceKind: "worker",
            placement: expect.objectContaining({ workerId: replicaWorkerId }),
          }),
          expect.objectContaining({
            resourceKind: "replica",
            placement: expect.objectContaining({ workerId: replicaWorkerId }),
          }),
          expect.objectContaining({
            resourceKind: "worktree",
            placement: expect.objectContaining({ workerId: replicaWorkerId }),
          }),
        ]),
      );
      expect(
        executionTargets?.targets.some(
          ({ placement }) => placement.workerId === unattachedWorkerId,
        ),
      ).toBe(false);
      await expect(
        repository.resolveExecutionTarget(
          LOCAL_USER_ID,
          firstProjectId,
          {
            kind: "worker",
            projectId: firstProjectId,
            workerId: unattachedWorkerId,
          },
          () => true,
        ),
      ).rejects.toMatchObject({
        code: "target-mismatch",
        message:
          "This local Git project has no ready source on the selected worker.",
      });

      const duplicateWorkspaceId = "facb4083-8fef-4b31-9d60-0d64a6c1e77f";
      await database.insert(schema.projectWorkspaces).values({
        id: duplicateWorkspaceId,
        ownerId: LOCAL_USER_ID,
        nameEnvelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: Buffer.alloc(12, 8).toString("base64url"),
          ciphertext: Buffer.alloc(16, 9).toString("base64url"),
        },
        nameBlindIndex: Buffer.alloc(32, 10).toString("base64url"),
        nameFormatVersion: 1,
        nameKeyRevision: 1,
        position: 2,
      });
      await database.insert(schema.projectWorkspaceStorageProfiles).values({
        workspaceId: duplicateWorkspaceId,
        kind: "attached",
        workerId,
        protectedRootPathHandle: `ctrr_${"q".repeat(43)}`,
        protectedDisplayHandle: `ctrr_${"r".repeat(43)}`,
      });
      await repository.workspaceRepositoryDiscoveryJobs.queue(
        LOCAL_USER_ID,
        duplicateWorkspaceId,
      );
      const duplicateDiscovery =
        await repository.workspaceRepositoryDiscoveryJobs.claimNext();
      await repository.workspaceRepositoryDiscoveryJobs.complete(
        duplicateDiscovery!.job.id,
        duplicateDiscovery!.commandId,
        {
          attempt: duplicateDiscovery!.job.attempt,
          candidates: [
            {
              pathHandle: `ctrr_${"c".repeat(43)}`,
              displayHandle: `ctrr_${"s".repeat(43)}`,
              repositoryFingerprint: "1".repeat(64),
              classification: "local-git",
              diagnosticCode: null,
            },
          ],
          counts: {
            candidates: 1,
            collapsedRepositories: 0,
            rejectedRepositories: 0,
            scannedDirectories: 1,
            scannedEntries: 1,
            skippedSymlinks: 0,
            unreadableDirectories: 0,
          },
          truncated: false,
        },
      );
      const duplicateScan =
        await repository.workspaceRepositoryDiscoveryJobs.getSnapshot(
          LOCAL_USER_ID,
          duplicateWorkspaceId,
        );
      expect(duplicateScan?.candidates[0]?.conflict).toEqual({
        kind: "checkout",
        projectId: firstProjectId,
        workspaceId,
      });
      const duplicateProjectId = "f3d84519-25fb-462f-a9e4-1a11ace33b3f";
      await repository.workspaceRepositoryDiscoveryJobs.queueImports(
        LOCAL_USER_ID,
        duplicateWorkspaceId,
        {
          expectedStateRevision: duplicateScan!.job.stateRevision,
          candidates: [
            {
              candidateId: duplicateScan!.candidates[0]!.id,
              projectId: duplicateProjectId,
              nameProtection:
                protectedProjectFields(duplicateProjectId).nameProtection,
              repositoryBlindIndex: null,
            },
          ],
        },
      );
      const duplicateClaim =
        await repository.workspaceRepositoryDiscoveryJobs.claimNextImport();
      await repository.workspaceRepositoryDiscoveryJobs.completeImport(
        duplicateClaim!,
        {
          candidateId: duplicateClaim!.candidateId,
          attempt: duplicateClaim!.attempt,
          path: `ctrr_${"c".repeat(43)}`,
          displayPath: `ctrr_${"d".repeat(43)}`,
          originUrl: null,
          github: null,
          repositoryFingerprint: "1".repeat(64),
          classification: "local-git",
          diagnosticCode: null,
          branch: null,
          head: null,
        },
      );
      const duplicateOutcome =
        await repository.workspaceRepositoryDiscoveryJobs.getSnapshot(
          LOCAL_USER_ID,
          duplicateWorkspaceId,
        );
      expect(duplicateOutcome?.candidates[0]).toMatchObject({
        importState: "skipped",
        projectId: firstProjectId,
        conflict: { projectId: firstProjectId, workspaceId },
      });
      expect(await database.select().from(schema.projects)).toHaveLength(1);

      await expect(
        repository.unlinkWorker(LOCAL_USER_ID, workerId),
      ).resolves.toBe(true);
      await expect(
        repository.getWorker(LOCAL_USER_ID, workerId),
      ).resolves.toBeNull();
      expect(
        (
          await repository.listProjectWorkspaceWire(LOCAL_USER_ID)
        ).workspaces.find((workspace) => workspace.id === workspaceId)?.storage,
      ).toEqual({
        kind: "attached",
        workerId,
        rootPathHandle,
        displayHandle: `ctrr_${"b".repeat(43)}`,
      });
      expect(
        await repository.resolveProjectExecutionPlacement(
          LOCAL_USER_ID,
          firstProjectId,
          "terminal",
          undefined,
          (candidateWorkerId) => candidateWorkerId === replicaWorkerId,
        ),
      ).toMatchObject({
        selection: "fallback",
        placement: {
          projectReplicaId: replicaSourceId,
          workerId: replicaWorkerId,
        },
      });
      const targetsAfterUnlink = await repository.listProjectExecutionTargets(
        LOCAL_USER_ID,
        firstProjectId,
        () => true,
      );
      expect(
        targetsAfterUnlink?.targets.some(
          ({ placement }) => placement.workerId === workerId,
        ),
      ).toBe(false);
      expect(
        targetsAfterUnlink?.targets.some(
          ({ placement }) => placement.workerId === replicaWorkerId,
        ),
      ).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("recovers an interrupted import and fences its stale completion", async () => {
    const { client, repository } = await fixture();
    try {
      await repository.workspaceRepositoryDiscoveryJobs.queue(
        LOCAL_USER_ID,
        workspaceId,
      );
      const discovery =
        await repository.workspaceRepositoryDiscoveryJobs.claimNext();
      const completed =
        await repository.workspaceRepositoryDiscoveryJobs.complete(
          discovery!.job.id,
          discovery!.commandId,
          {
            attempt: discovery!.job.attempt,
            candidates: [
              {
                pathHandle: `ctrr_${"c".repeat(43)}`,
                displayHandle: `ctrr_${"d".repeat(43)}`,
                repositoryFingerprint: "1".repeat(64),
                classification: "local-git",
                diagnosticCode: null,
              },
            ],
            counts: {
              candidates: 1,
              collapsedRepositories: 0,
              rejectedRepositories: 0,
              scannedDirectories: 1,
              scannedEntries: 1,
              skippedSymlinks: 0,
              unreadableDirectories: 0,
            },
            truncated: false,
          },
        );
      const projectId = "09dd9169-04ca-41c1-a473-250b5716bf7c";
      await repository.workspaceRepositoryDiscoveryJobs.queueImports(
        LOCAL_USER_ID,
        workspaceId,
        {
          expectedStateRevision: completed.job.stateRevision,
          candidates: [
            {
              candidateId: completed.candidates[0]!.id,
              projectId,
              nameProtection: protectedProjectFields(projectId).nameProtection,
              repositoryBlindIndex: null,
            },
          ],
        },
      );
      const interrupted =
        await repository.workspaceRepositoryDiscoveryJobs.claimNextImport();
      expect(interrupted).toMatchObject({ attempt: 1, projectId });

      await expect(
        repository.workspaceRepositoryDiscoveryJobs.recoverInterruptedImports(
          true,
        ),
      ).resolves.toBe(1);
      expect(
        (
          await repository.workspaceRepositoryDiscoveryJobs.getSnapshot(
            LOCAL_USER_ID,
            workspaceId,
          )
        )?.candidates[0],
      ).toMatchObject({ importAttempt: 1, importState: "queued", projectId });

      const staleResult = {
        candidateId: interrupted!.candidateId,
        attempt: interrupted!.attempt,
        path: `ctrr_${"c".repeat(43)}`,
        displayPath: `ctrr_${"d".repeat(43)}`,
        originUrl: null,
        github: null,
        repositoryFingerprint: "1".repeat(64),
        classification: "local-git" as const,
        diagnosticCode: null,
        branch: null,
        head: null,
      };
      await expect(
        repository.workspaceRepositoryDiscoveryJobs.completeImport(
          interrupted!,
          staleResult,
        ),
      ).rejects.toThrow(/no longer current/iu);

      const replacement =
        await repository.workspaceRepositoryDiscoveryJobs.claimNextImport();
      expect(replacement).toMatchObject({ attempt: 2, projectId });
      await expect(
        repository.workspaceRepositoryDiscoveryJobs.completeImport(
          replacement!,
          { ...staleResult, attempt: replacement!.attempt },
        ),
      ).resolves.toMatchObject({ state: "succeeded" });
      expect(
        (
          await repository.workspaceRepositoryDiscoveryJobs.getSnapshot(
            LOCAL_USER_ID,
            workspaceId,
          )
        )?.candidates[0],
      ).toMatchObject({ importAttempt: 2, importState: "imported", projectId });
    } finally {
      await client.close();
    }
  });

  it("registers an accessible GitHub checkout with its direct attached source", async () => {
    const { client, database, repository } = await fixture();
    try {
      await repository.workspaceRepositoryDiscoveryJobs.queue(
        LOCAL_USER_ID,
        workspaceId,
      );
      const discovery =
        await repository.workspaceRepositoryDiscoveryJobs.claimNext();
      const github = {
        repositoryId: `ctrr_${"g".repeat(43)}`,
        nameWithOwner: `ctrr_${"h".repeat(43)}`,
        url: `ctrr_${"i".repeat(43)}`,
      };
      const completed =
        await repository.workspaceRepositoryDiscoveryJobs.complete(
          discovery!.job.id,
          discovery!.commandId,
          {
            attempt: discovery!.job.attempt,
            candidates: [
              {
                pathHandle: `ctrr_${"c".repeat(43)}`,
                displayHandle: `ctrr_${"d".repeat(43)}`,
                originUrlHandle: `ctrr_${"e".repeat(43)}`,
                github,
                repositoryFingerprint: "3".repeat(64),
                classification: "github-accessible",
                diagnosticCode: null,
              },
            ],
            counts: {
              candidates: 1,
              collapsedRepositories: 0,
              rejectedRepositories: 0,
              scannedDirectories: 1,
              scannedEntries: 1,
              skippedSymlinks: 0,
              unreadableDirectories: 0,
            },
            truncated: false,
          },
        );
      const projectId = "a2d806a2-f83b-4bfd-967f-0dc364ac5cd4";
      const repositoryBlindIndex = Buffer.alloc(32, 12).toString("base64url");
      await repository.workspaceRepositoryDiscoveryJobs.queueImports(
        LOCAL_USER_ID,
        workspaceId,
        {
          expectedStateRevision: completed.job.stateRevision,
          candidates: [
            {
              candidateId: completed.candidates[0]!.id,
              projectId,
              nameProtection: protectedProjectFields(projectId).nameProtection,
              repositoryBlindIndex,
            },
          ],
        },
      );
      const claimed =
        await repository.workspaceRepositoryDiscoveryJobs.claimNextImport();
      await repository.workspaceRepositoryDiscoveryJobs.completeImport(
        claimed!,
        {
          candidateId: claimed!.candidateId,
          attempt: claimed!.attempt,
          path: `ctrr_${"c".repeat(43)}`,
          displayPath: `ctrr_${"j".repeat(43)}`,
          originUrl: `ctrr_${"e".repeat(43)}`,
          github,
          repositoryFingerprint: "3".repeat(64),
          classification: "github-accessible",
          diagnosticCode: null,
          branch: `ctrr_${"k".repeat(43)}`,
          head: "4".repeat(40),
        },
      );

      expect(await database.select().from(schema.projects)).toEqual([
        expect.objectContaining({
          id: projectId,
          originKind: "github",
          worktreePolicy: "agent-managed",
          githubCapability: true,
          githubRepositoryBlindIndex: repositoryBlindIndex,
          githubRepositoryId: github.repositoryId,
        }),
      ]);
      expect(await database.select().from(schema.projectWorktrees)).toEqual([
        expect.objectContaining({
          workerId,
          origin: "external",
          lifecycleState: "ready",
          branch: `ctrr_${"k".repeat(43)}`,
          head: "4".repeat(40),
        }),
      ]);
    } finally {
      await client.close();
    }
  });

  it("downgrades a GitHub candidate to local Git when access disappears before import", async () => {
    const { client, database, repository } = await fixture();
    try {
      await repository.workspaceRepositoryDiscoveryJobs.queue(
        LOCAL_USER_ID,
        workspaceId,
      );
      const discovery =
        await repository.workspaceRepositoryDiscoveryJobs.claimNext();
      const completed =
        await repository.workspaceRepositoryDiscoveryJobs.complete(
          discovery!.job.id,
          discovery!.commandId,
          {
            attempt: discovery!.job.attempt,
            candidates: [
              {
                pathHandle: `ctrr_${"c".repeat(43)}`,
                displayHandle: `ctrr_${"d".repeat(43)}`,
                originUrlHandle: `ctrr_${"e".repeat(43)}`,
                github: {
                  repositoryId: `ctrr_${"g".repeat(43)}`,
                  nameWithOwner: `ctrr_${"h".repeat(43)}`,
                  url: `ctrr_${"i".repeat(43)}`,
                },
                repositoryFingerprint: "5".repeat(64),
                classification: "github-accessible",
                diagnosticCode: null,
              },
            ],
            counts: {
              candidates: 1,
              collapsedRepositories: 0,
              rejectedRepositories: 0,
              scannedDirectories: 1,
              scannedEntries: 1,
              skippedSymlinks: 0,
              unreadableDirectories: 0,
            },
            truncated: false,
          },
        );
      const projectId = "611cb653-ddfd-4d1d-9185-9661827b2a0c";
      await repository.workspaceRepositoryDiscoveryJobs.queueImports(
        LOCAL_USER_ID,
        workspaceId,
        {
          expectedStateRevision: completed.job.stateRevision,
          candidates: [
            {
              candidateId: completed.candidates[0]!.id,
              projectId,
              nameProtection: protectedProjectFields(projectId).nameProtection,
              repositoryBlindIndex: Buffer.alloc(32, 13).toString("base64url"),
            },
          ],
        },
      );
      const claimed =
        await repository.workspaceRepositoryDiscoveryJobs.claimNextImport();
      await repository.workspaceRepositoryDiscoveryJobs.completeImport(
        claimed!,
        {
          candidateId: claimed!.candidateId,
          attempt: claimed!.attempt,
          path: `ctrr_${"c".repeat(43)}`,
          displayPath: `ctrr_${"j".repeat(43)}`,
          originUrl: `ctrr_${"e".repeat(43)}`,
          github: null,
          repositoryFingerprint: "5".repeat(64),
          classification: "github-unavailable",
          diagnosticCode: "github-api-unavailable",
          branch: null,
          head: null,
        },
      );

      expect(await database.select().from(schema.projects)).toEqual([
        expect.objectContaining({
          id: projectId,
          originKind: "managed-folder",
          folderManagement: "external",
          worktreePolicy: "direct",
          gitCapability: true,
          githubCapability: false,
          githubRepositoryBlindIndex: null,
          githubRepositoryId: null,
        }),
      ]);
      expect(
        (
          await repository.workspaceRepositoryDiscoveryJobs.getSnapshot(
            LOCAL_USER_ID,
            workspaceId,
          )
        )?.candidates[0],
      ).toMatchObject({
        classification: "github-unavailable",
        diagnosticCode: "github-api-unavailable",
        importState: "imported",
        projectId,
      });
    } finally {
      await client.close();
    }
  });
});
