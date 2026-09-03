import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq, getTableName, is } from "drizzle-orm";
import { PgTable, type AnyPgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { STORAGE_ACCOUNTING_MANIFEST } from "../src/account-usage/storage-manifest.js";
import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";
import { protectedAttachmentMetadataFixture } from "./protected-attachment-fixture.js";
import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

function schemaTables(): AnyPgTable[] {
  return Object.values(schema).filter((value): value is AnyPgTable =>
    is(value, PgTable),
  );
}

describe("account resource usage storage accounting", () => {
  it("requires an explicit accounting classification for every durable table", () => {
    const schemaNames = schemaTables().map(getTableName).sort();
    const manifestNames = STORAGE_ACCOUNTING_MANIFEST.map(({ table }) =>
      getTableName(table),
    ).sort();

    expect(new Set(manifestNames).size).toBe(manifestNames.length);
    expect(manifestNames).toEqual(schemaNames);
    for (const entry of STORAGE_ACCOUNTING_MANIFEST) {
      if (entry.classification.endsWith("excluded")) {
        expect(entry.excludeReason).toBeTruthy();
      } else {
        expect(entry.category).toBeTruthy();
        expect(entry.ownerResolution).toBeTruthy();
      }
    }
    const categoryFor = (table: AnyPgTable) =>
      STORAGE_ACCOUNTING_MANIFEST.find((entry) => entry.table === table)
        ?.category;
    expect(categoryFor(schema.taskDispatchCycles)).toBe("conversations");
    expect(categoryFor(schema.projectAutomations)).toBe("projects");
    expect(categoryFor(schema.projectAutomationRuns)).toBe("projects");
  });

  it("reconciles a precise current projection and one snapshot per hour", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder });
    const repository = new ServerRepository(
      database,
      new SecretVault({
        activeKeyId: "test",
        keys: [{ id: "test", key: Buffer.alloc(32, 37) }],
      }),
    );

    try {
      await repository.ensureLocalIdentity();

      const first = await repository.accountResourceUsage.reconcileStorage(
        "usage-test-instance",
        new Date("2026-08-23T10:15:00.000Z"),
      );
      expect(first).toMatchObject({
        acquired: true,
        accountCount: 1,
        ownerIds: [LOCAL_USER_ID],
      });
      expect(first.logicalBytes).toBeGreaterThan(0n);
      expect(first.rowCount).toBeGreaterThan(0n);

      const current = await database
        .select()
        .from(schema.accountStorageUsageCurrent);
      expect(current.length).toBeGreaterThan(0);
      expect(current.every((row) => row.ownerId === LOCAL_USER_ID)).toBe(true);
      expect(current.every((row) => row.logicalBytes > 0n)).toBe(true);

      const initialSnapshots = await database
        .select()
        .from(schema.accountStorageUsageSnapshots);
      expect(initialSnapshots.length).toBe(current.length);
      expect(
        initialSnapshots.every(
          (row) => row.bucketStart.toISOString() === "2026-08-23T10:00:00.000Z",
        ),
      ).toBe(true);

      await repository.accountResourceUsage.reconcileStorage(
        "usage-test-instance",
        new Date("2026-08-23T10:55:00.000Z"),
      );
      const sameHourSnapshots = await database
        .select()
        .from(schema.accountStorageUsageSnapshots);
      expect(sameHourSnapshots).toHaveLength(initialSnapshots.length);

      const hourly = await repository.accountResourceUsage.listStorageHistory(
        LOCAL_USER_ID,
        new Date("2026-08-23T10:00:00.000Z"),
        new Date("2026-08-23T11:00:00.000Z"),
        "hour",
      );
      expect(hourly).toHaveLength(initialSnapshots.length);
      const daily = await repository.accountResourceUsage.listStorageHistory(
        LOCAL_USER_ID,
        new Date("2026-08-23T00:00:00.000Z"),
        new Date("2026-08-24T00:00:00.000Z"),
        "day",
      );
      expect(daily).toHaveLength(initialSnapshots.length);
      expect(
        daily.every(
          (measurement) =>
            measurement.bucketStart.toISOString() ===
            "2026-08-23T00:00:00.000Z",
        ),
      ).toBe(true);

      const totals =
        await repository.accountResourceUsage.getOperationalTotals();
      expect(totals).toMatchObject({
        accountCount: 1,
        logicalWorkerManagedBytes: 0n,
      });
      expect(typeof totals.logicalServerBytes).toBe("bigint");
      expect(totals.logicalServerBytes).toBeGreaterThan(0n);
      if (totals.physicalDatabaseBytes !== null) {
        expect(totals.physicalDatabaseBytes).toBeGreaterThan(0n);
      }

      expect(
        await repository.accountResourceUsage.acquireStorageReconciliationLease(
          "first-instance",
          new Date("2026-08-23T11:00:00.000Z"),
        ),
      ).toBe(true);
      expect(
        await repository.accountResourceUsage.acquireStorageReconciliationLease(
          "second-instance",
          new Date("2026-08-23T11:00:01.000Z"),
        ),
      ).toBe(false);
      await repository.accountResourceUsage.releaseStorageReconciliationLease(
        "first-instance",
      );
    } finally {
      await client.close();
    }
  });

  it("tracks create, update, delete, and account-cascade changes while retaining history", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder });
    const repository = new ServerRepository(
      database,
      new SecretVault({
        activeKeyId: "test",
        keys: [{ id: "test", key: Buffer.alloc(32, 43) }],
      }),
    );
    const accountBytes = async (ownerId = LOCAL_USER_ID) => {
      const rows =
        await repository.accountResourceUsage.listCurrentStorage(ownerId);
      return (
        rows.find(
          (row) => row.storageClass === "server" && row.category === "account",
        )?.logicalBytes ?? 0n
      );
    };

    try {
      await repository.ensureLocalIdentity();
      await repository.accountResourceUsage.reconcileStorage(
        "usage-mutation-test",
        new Date("2026-08-23T10:15:00.000Z"),
      );
      const baseline = await accountBytes();

      await database.insert(schema.userSessions).values({
        id: "usage-session",
        userId: LOCAL_USER_ID,
        tokenHash: "usage-token-hash",
        csrfTokenHash: "usage-csrf-hash",
        authMethod: "password",
        label: "short",
        expiresAt: new Date("2026-08-24T00:00:00.000Z"),
      });
      await repository.accountResourceUsage.reconcileStorage(
        "usage-mutation-test",
        new Date("2026-08-23T11:15:00.000Z"),
      );
      const created = await accountBytes();
      expect(created).toBeGreaterThan(baseline);

      await database
        .update(schema.userSessions)
        .set({ label: randomBytes(768).toString("base64url") })
        .where(eq(schema.userSessions.id, "usage-session"));
      await repository.accountResourceUsage.reconcileStorage(
        "usage-mutation-test",
        new Date("2026-08-23T12:15:00.000Z"),
      );
      const updated = await accountBytes();
      expect(updated).toBeGreaterThan(created);

      await database
        .delete(schema.userSessions)
        .where(eq(schema.userSessions.id, "usage-session"));
      await repository.accountResourceUsage.reconcileStorage(
        "usage-mutation-test",
        new Date("2026-08-23T13:15:00.000Z"),
      );
      expect(await accountBytes()).toBe(baseline);
      const retainedHistory =
        await repository.accountResourceUsage.listStorageHistory(
          LOCAL_USER_ID,
          new Date("2026-08-23T10:00:00.000Z"),
          new Date("2026-08-23T14:00:00.000Z"),
          "hour",
        );
      expect(
        retainedHistory.some(
          (row) => row.category === "account" && row.logicalBytes === updated,
        ),
      ).toBe(true);

      const deletedOwnerId = "usage-deleted-owner";
      await database.insert(schema.users).values({
        id: deletedOwnerId,
        kind: "account",
        displayName: "Deleted usage owner",
        email: "deleted-usage@example.com",
        normalizedEmail: "deleted-usage@example.com",
      });
      await database.insert(schema.userSessions).values({
        id: "deleted-owner-session",
        userId: deletedOwnerId,
        tokenHash: "deleted-owner-token-hash",
        csrfTokenHash: "deleted-owner-csrf-hash",
        authMethod: "account-password",
        expiresAt: new Date("2026-08-24T00:00:00.000Z"),
      });
      await repository.accountResourceUsage.reconcileStorage(
        "usage-mutation-test",
        new Date("2026-08-23T14:15:00.000Z"),
      );
      expect(await accountBytes(deletedOwnerId)).toBeGreaterThan(0n);

      await database
        .delete(schema.users)
        .where(eq(schema.users.id, deletedOwnerId));
      expect(
        await repository.accountResourceUsage.listCurrentStorage(
          deletedOwnerId,
        ),
      ).toEqual([]);
      expect(
        await repository.accountResourceUsage.listStorageHistory(
          deletedOwnerId,
          new Date("2026-08-23T00:00:00.000Z"),
          new Date("2026-08-24T00:00:00.000Z"),
          "hour",
        ),
      ).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("reports ready attachment sources and each ready replica separately", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder });
    const repository = new ServerRepository(
      database,
      new SecretVault({
        activeKeyId: "test",
        keys: [{ id: "test", key: Buffer.alloc(32, 47) }],
      }),
    );

    try {
      await repository.ensureLocalIdentity();
      await database.insert(schema.workers).values([
        {
          id: "usage-source-worker",
          ownerId: LOCAL_USER_ID,
          name: "Source worker",
          platform: "darwin",
          architecture: "arm64",
          startedAt: new Date("2026-08-23T09:00:00.000Z"),
          lastSeenAt: new Date("2026-08-23T09:00:00.000Z"),
        },
        {
          id: "usage-replica-worker",
          ownerId: LOCAL_USER_ID,
          name: "Replica worker",
          platform: "linux",
          architecture: "x64",
          startedAt: new Date("2026-08-23T09:00:00.000Z"),
          lastSeenAt: new Date("2026-08-23T09:00:00.000Z"),
        },
      ]);
      const projectId = "usage-attachment-project";
      await database.insert(schema.projects).values({
        id: projectId,
        ownerId: LOCAL_USER_ID,
        protectedLabel: protectedProjectFields(projectId).nameProtection,
        originKind: "managed-folder",
        folderManagement: "external",
        worktreePolicy: "direct",
      });
      await database.insert(schema.projectSources).values({
        id: "usage-attachment-source",
        projectId,
        workerId: "usage-source-worker",
        sourceKind: "folder",
        absolutePath: "/usage/source",
        displayPath: "/usage/source",
        placementMode: "direct",
        ownershipKind: "user",
        requestedPath: "/usage/source",
      });
      await database.insert(schema.projectWorktrees).values({
        id: "usage-attachment-worktree",
        projectSourceId: "usage-attachment-source",
        workerId: "usage-source-worker",
        rootKind: "folder-root",
        name: "Primary",
        absolutePath: "/usage/source",
        displayPath: "/usage/source",
        isPrimary: true,
        isDefault: true,
        origin: "external",
        lifecycleState: "ready",
      });
      const chatId = "usage-attachment-chat";
      await database.insert(schema.chats).values({
        id: chatId,
        ownerId: LOCAL_USER_ID,
        projectId,
        protectedLabel: protectedChatFields(chatId).titleProtection,
        activeWorkerId: "usage-source-worker",
        activeWorktreeId: "usage-attachment-worktree",
      });
      await database.insert(schema.chatAttachments).values([
        {
          id: "usage-ready-attachment",
          chatId,
          workerId: "usage-source-worker",
          protectedMetadata: protectedAttachmentMetadataFixture("ready"),
          sizeBytes: 100,
          status: "ready",
        },
        {
          id: "usage-pending-attachment",
          chatId,
          workerId: "usage-source-worker",
          protectedMetadata: protectedAttachmentMetadataFixture("pending"),
          sizeBytes: 900,
          status: "pending",
        },
      ]);
      await database.insert(schema.chatAttachmentReplicas).values([
        {
          attachmentId: "usage-ready-attachment",
          workerId: "usage-source-worker",
          status: "ready",
        },
        {
          attachmentId: "usage-ready-attachment",
          workerId: "usage-replica-worker",
          status: "ready",
        },
        {
          attachmentId: "usage-pending-attachment",
          workerId: "usage-replica-worker",
          status: "pending",
        },
      ]);

      await repository.accountResourceUsage.reconcileStorage(
        "usage-attachment-test",
        new Date("2026-08-23T10:15:00.000Z"),
      );
      const current =
        await repository.accountResourceUsage.listCurrentStorage(LOCAL_USER_ID);
      expect(
        current.find((row) => row.category === "attachments"),
      ).toMatchObject({
        storageClass: "worker-managed",
        logicalBytes: 100n,
        rowCount: 1n,
      });
      expect(
        current.find((row) => row.category === "attachment-replicas"),
      ).toMatchObject({
        storageClass: "worker-managed",
        logicalBytes: 200n,
        rowCount: 2n,
      });
    } finally {
      await client.close();
    }
  });
});
