import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("account-synchronized app destination", () => {
  it("uses owner-scoped optimistic revisions", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder });
    const repository = new ServerRepository(
      database,
      new SecretVault({
        activeKeyId: "test",
        keys: [{ id: "test", key: Buffer.alloc(32, 53) }],
      }),
    );
    try {
      await repository.ensureLocalIdentity();
      await repository.ensureAccountConfiguration(LOCAL_USER_ID);
      const initial = await repository.getUserSettings(LOCAL_USER_ID);
      expect(initial).toMatchObject({
        lastAppMode: null,
        lastIdeProjectId: null,
        lastIdeWorkspaceId: null,
        lastStandaloneChatId: null,
        destinationRevision: 1,
      });

      await expect(
        repository.updateAppDestination(LOCAL_USER_ID, {
          expectedRevision: 1,
          lastAppMode: "chat",
        }),
      ).resolves.toEqual({
        lastAppMode: "chat",
        lastIdeProjectId: null,
        lastIdeWorkspaceId: null,
        lastStandaloneChatId: null,
        revision: 2,
      });

      await expect(
        repository.updateAppDestination(LOCAL_USER_ID, {
          expectedRevision: 1,
          lastAppMode: "ide",
        }),
      ).resolves.toBeNull();

      await expect(
        repository.updateAppDestination(LOCAL_USER_ID, {
          expectedRevision: 2,
          lastIdeProjectId: "missing-project",
        }),
      ).resolves.toBeNull();

      await expect(
        repository.getUserSettings(LOCAL_USER_ID),
      ).resolves.toMatchObject({
        lastAppMode: "chat",
        destinationRevision: 2,
      });
    } finally {
      await client.close();
    }
  });
});
