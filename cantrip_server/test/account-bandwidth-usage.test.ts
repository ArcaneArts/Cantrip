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
});
