import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("account bandwidth usage repository", () => {
  it("applies flushes once and adds concurrent instance deltas", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder });
    const repository = new ServerRepository(
      database,
      new SecretVault({
        activeKeyId: "test",
        keys: [{ id: "test", key: Buffer.alloc(32, 17) }],
      }),
    );
    await repository.ensureLocalIdentity();
    const bucketStart = new Date("2026-08-23T10:00:00.000Z");
    const first = {
      meterId: "instance-a:boot-one",
      sequence: 1n,
      flushedAt: new Date("2026-08-23T10:05:00.000Z"),
      entries: [
        {
          ownerId: LOCAL_USER_ID,
          bucketStart,
          channel: "http" as const,
          direction: "ingress" as const,
          bytes: 10n,
          operationCount: 1n,
        },
      ],
    };

    try {
      await expect(
        repository.accountResourceUsage.flushBandwidthBatch(first),
      ).resolves.toEqual({ applied: true, ownerIds: [LOCAL_USER_ID] });
      await expect(
        repository.accountResourceUsage.flushBandwidthBatch(first),
      ).resolves.toEqual({ applied: false, ownerIds: [LOCAL_USER_ID] });
      await repository.accountResourceUsage.flushBandwidthBatch({
        ...first,
        meterId: "instance-b:boot-two",
        flushedAt: new Date("2026-08-23T10:06:00.000Z"),
        entries: [{ ...first.entries[0]!, bytes: 5n, operationCount: 2n }],
      });

      const hourly = await repository.accountResourceUsage.listBandwidthHistory(
        LOCAL_USER_ID,
        new Date("2026-08-23T10:00:00.000Z"),
        new Date("2026-08-23T11:00:00.000Z"),
        "hour",
      );
      expect(hourly).toEqual([
        expect.objectContaining({
          bucketStart,
          channel: "http",
          direction: "ingress",
          bytes: 15n,
          operationCount: 3n,
        }),
      ]);
      const daily = await repository.accountResourceUsage.listBandwidthHistory(
        LOCAL_USER_ID,
        new Date("2026-08-23T00:00:00.000Z"),
        new Date("2026-08-24T00:00:00.000Z"),
        "day",
      );
      expect(daily[0]).toMatchObject({
        bucketStart: new Date("2026-08-23T00:00:00.000Z"),
        bytes: 15n,
        operationCount: 3n,
      });

      await database.insert(schema.users).values({
        id: "deleted-owner",
        kind: "account",
        displayName: "Deleted Owner",
        email: "deleted@example.com",
        normalizedEmail: "deleted@example.com",
      });
      await repository.accountResourceUsage.flushBandwidthBatch({
        ...first,
        meterId: "deleted-owner-meter",
        entries: [{ ...first.entries[0]!, ownerId: "deleted-owner" }],
      });
      await database
        .delete(schema.users)
        .where(eq(schema.users.id, "deleted-owner"));
      expect(
        await database
          .select()
          .from(schema.accountBandwidthUsageBuckets)
          .where(
            eq(schema.accountBandwidthUsageBuckets.ownerId, "deleted-owner"),
          ),
      ).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("rolls complete days up once, preserves storage state, and expires old history", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder });
    const repository = new ServerRepository(
      database,
      new SecretVault({
        activeKeyId: "test",
        keys: [{ id: "test", key: Buffer.alloc(32, 29) }],
      }),
    );
    await repository.ensureLocalIdentity();
    const now = new Date("2026-08-23T12:00:00.000Z");
    const flush = async (meterId: string, bucketStart: string, bytes: bigint) =>
      repository.accountResourceUsage.flushBandwidthBatch({
        meterId,
        sequence: 1n,
        flushedAt: new Date(bucketStart),
        entries: [
          {
            ownerId: LOCAL_USER_ID,
            bucketStart: new Date(bucketStart),
            channel: "http",
            direction: "egress",
            bytes,
            operationCount: 1n,
          },
        ],
      });

    try {
      await flush("old-1", "2026-08-20T10:00:00.000Z", 10n);
      await flush("old-2", "2026-08-20T18:00:00.000Z", 15n);
      await flush("recent", "2026-08-22T10:00:00.000Z", 7n);
      await flush("expired", "2026-08-10T10:00:00.000Z", 99n);
      await database.insert(schema.accountBandwidthUsageBuckets).values({
        ownerId: LOCAL_USER_ID,
        bucketStart: new Date("2026-08-10T00:00:00.000Z"),
        resolution: "day",
        channel: "http",
        direction: "egress",
        bytes: 40n,
        operationCount: 4n,
      });
      await database.insert(schema.accountStorageUsageSnapshots).values([
        {
          ownerId: LOCAL_USER_ID,
          bucketStart: new Date("2026-08-20T10:00:00.000Z"),
          resolution: "hour",
          storageClass: "server",
          category: "chats",
          logicalBytes: 100n,
          rowCount: 1n,
          basisVersion: "test",
          measuredAt: new Date("2026-08-20T10:01:00.000Z"),
        },
        {
          ownerId: LOCAL_USER_ID,
          bucketStart: new Date("2026-08-20T18:00:00.000Z"),
          resolution: "hour",
          storageClass: "server",
          category: "chats",
          logicalBytes: 120n,
          rowCount: 2n,
          basisVersion: "test",
          measuredAt: new Date("2026-08-20T18:01:00.000Z"),
        },
        {
          ownerId: LOCAL_USER_ID,
          bucketStart: new Date("2026-08-22T10:00:00.000Z"),
          resolution: "hour",
          storageClass: "server",
          category: "chats",
          logicalBytes: 130n,
          rowCount: 3n,
          basisVersion: "test",
          measuredAt: new Date("2026-08-22T10:01:00.000Z"),
        },
        {
          ownerId: LOCAL_USER_ID,
          bucketStart: new Date("2026-08-10T00:00:00.000Z"),
          resolution: "day",
          storageClass: "server",
          category: "chats",
          logicalBytes: 40n,
          rowCount: 1n,
          basisVersion: "test",
          measuredAt: new Date("2026-08-10T20:00:00.000Z"),
        },
      ]);

      const options = {
        dailyRetentionDays: 10,
        flushRetentionDays: 3,
        hourlyRetentionDays: 2,
      };
      const first = await repository.accountResourceUsage.maintainUsageHistory(
        "maintenance-a",
        now,
        options,
      );
      expect(first).toMatchObject({
        acquired: true,
        bandwidthDailyRowsDeleted: 1,
        bandwidthDaysRolled: 1,
        bandwidthHourlyRowsDeleted: 3,
        flushRowsDeleted: 2,
        storageDailyRowsDeleted: 1,
        storageDaysRolled: 1,
        storageHourlyRowsDeleted: 2,
      });

      const bandwidth =
        await repository.accountResourceUsage.listBandwidthHistory(
          LOCAL_USER_ID,
          new Date("2026-08-19T00:00:00.000Z"),
          new Date("2026-08-23T00:00:00.000Z"),
          "day",
        );
      expect(
        bandwidth.map(({ bucketStart, bytes }) => [bucketStart, bytes]),
      ).toEqual([
        [new Date("2026-08-20T00:00:00.000Z"), 25n],
        [new Date("2026-08-22T00:00:00.000Z"), 7n],
      ]);
      const storage = await repository.accountResourceUsage.listStorageHistory(
        LOCAL_USER_ID,
        new Date("2026-08-19T00:00:00.000Z"),
        new Date("2026-08-23T00:00:00.000Z"),
        "day",
      );
      expect(
        storage.map(({ bucketStart, logicalBytes }) => [
          bucketStart,
          logicalBytes,
        ]),
      ).toEqual([
        [new Date("2026-08-20T00:00:00.000Z"), 120n],
        [new Date("2026-08-22T00:00:00.000Z"), 130n],
      ]);

      const replay = await repository.accountResourceUsage.maintainUsageHistory(
        "maintenance-a",
        now,
        options,
      );
      expect(replay).toMatchObject({
        acquired: true,
        bandwidthDaysRolled: 0,
        bandwidthHourlyRowsDeleted: 0,
        storageDaysRolled: 0,
        storageHourlyRowsDeleted: 0,
      });

      await flush("late", "2026-08-20T12:00:00.000Z", 5n);
      await database.insert(schema.accountStorageUsageSnapshots).values({
        ownerId: LOCAL_USER_ID,
        bucketStart: new Date("2026-08-20T12:00:00.000Z"),
        resolution: "hour",
        storageClass: "server",
        category: "chats",
        logicalBytes: 110n,
        rowCount: 1n,
        basisVersion: "test",
        measuredAt: new Date("2026-08-20T12:01:00.000Z"),
      });
      const late = await repository.accountResourceUsage.maintainUsageHistory(
        "maintenance-a",
        now,
        options,
      );
      expect(late).toMatchObject({
        bandwidthDaysRolled: 1,
        storageDaysRolled: 1,
      });
      const afterLateBandwidth =
        await repository.accountResourceUsage.listBandwidthHistory(
          LOCAL_USER_ID,
          new Date("2026-08-20T00:00:00.000Z"),
          new Date("2026-08-21T00:00:00.000Z"),
          "day",
        );
      expect(afterLateBandwidth[0]?.bytes).toBe(30n);
      const afterLateStorage =
        await repository.accountResourceUsage.listStorageHistory(
          LOCAL_USER_ID,
          new Date("2026-08-20T00:00:00.000Z"),
          new Date("2026-08-21T00:00:00.000Z"),
          "day",
        );
      expect(afterLateStorage[0]?.logicalBytes).toBe(120n);

      await repository.accountResourceUsage.acquireUsageLease(
        "usage-history-maintenance",
        "maintenance-a",
        now,
      );
      await expect(
        repository.accountResourceUsage.maintainUsageHistory(
          "maintenance-b",
          new Date(now.getTime() + 1_000),
          options,
        ),
      ).resolves.toMatchObject({ acquired: false });
      await repository.accountResourceUsage.releaseUsageLease(
        "usage-history-maintenance",
        "maintenance-a",
      );
    } finally {
      await client.close();
    }
  });
});
