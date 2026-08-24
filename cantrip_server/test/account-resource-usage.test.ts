import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { getTableName, is } from "drizzle-orm";
import { PgTable, type AnyPgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { STORAGE_ACCOUNTING_MANIFEST } from "../src/account-usage/storage-manifest.js";
import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

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
      expect(first).toMatchObject({ acquired: true, accountCount: 1 });
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
});
