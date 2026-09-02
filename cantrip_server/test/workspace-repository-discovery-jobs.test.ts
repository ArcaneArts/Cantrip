import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { WorkspaceRepositoryDiscoveryInvariantError } from "../src/db/workspace-repository-discovery-jobs.js";
import { SecretVault } from "../src/security/secret-vault.js";

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
                repositoryFingerprint: "e".repeat(64),
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
          classification: "unclassified",
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
});
