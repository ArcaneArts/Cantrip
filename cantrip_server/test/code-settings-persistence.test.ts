import { fileURLToPath } from "node:url";

import type { ProtectedCodeSettingsRecord } from "@cantrip/protocol/code-settings";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { CodeSettingsRevisionConflictError } from "../src/db/code-settings.js";
import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const workerId = "code-settings-worker";

function record(revision: number, operationSuffix: string) {
  const operationId = `11111111-1111-4111-8111-${operationSuffix.padStart(12, "0")}`;
  return {
    operationId,
    revision,
    protectedContent: {
      formatVersion: 1 as const,
      domain: "customization-content" as const,
      keyRevision: 1,
      envelope: {
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: Buffer.from(
          `opaque-${operationSuffix}`.padEnd(32, "x"),
        ).toString("base64url"),
      },
    },
  } satisfies ProtectedCodeSettingsRecord;
}

describe("global Code settings persistence", () => {
  it("stores only opaque content and atomically enforces initialization and CAS", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      const repository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "unrelated-server-vault",
          keys: [{ id: "unrelated-server-vault", key: Buffer.alloc(32, 9) }],
        }),
      );
      await repository.ensureLocalIdentity();
      const now = new Date();
      await database.insert(schema.workers).values({
        id: workerId,
        ownerId: LOCAL_USER_ID,
        name: "Code settings worker",
        platform: "darwin",
        architecture: "arm64",
        startedAt: now,
        lastSeenAt: now,
      });

      await expect(
        repository.codeSettings.publicStatus(LOCAL_USER_ID),
      ).resolves.toMatchObject({
        initialized: false,
        profileId: "default",
        revision: null,
      });

      const initializers = await Promise.allSettled([
        repository.codeSettings.compareAndSwap(
          LOCAL_USER_ID,
          workerId,
          "default",
          { expectedRevision: null, record: record(1, "1") },
        ),
        repository.codeSettings.compareAndSwap(
          LOCAL_USER_ID,
          workerId,
          "default",
          { expectedRevision: null, record: record(1, "2") },
        ),
      ]);
      expect(
        initializers.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        initializers.filter(({ status }) => status === "rejected"),
      ).toHaveLength(1);
      expect(
        initializers.find(({ status }) => status === "rejected"),
      ).toMatchObject({
        reason: expect.any(CodeSettingsRevisionConflictError),
      });

      const initialized = await repository.codeSettings.get(LOCAL_USER_ID);
      expect(initialized).toMatchObject({
        profileId: "default",
        record: { revision: 1 },
        updatedByWorkerId: workerId,
      });
      await expect(
        repository.codeSettings.get("another-owner"),
      ).resolves.toBeNull();

      const updates = await Promise.allSettled([
        repository.codeSettings.compareAndSwap(
          LOCAL_USER_ID,
          workerId,
          "default",
          { expectedRevision: 1, record: record(2, "3") },
        ),
        repository.codeSettings.compareAndSwap(
          LOCAL_USER_ID,
          workerId,
          "default",
          { expectedRevision: 1, record: record(2, "4") },
        ),
      ]);
      expect(
        updates.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        updates.filter(({ status }) => status === "rejected"),
      ).toHaveLength(1);
      await expect(
        repository.codeSettings.compareAndSwap(
          LOCAL_USER_ID,
          workerId,
          "default",
          { expectedRevision: 1, record: record(2, "5") },
        ),
      ).rejects.toBeInstanceOf(CodeSettingsRevisionConflictError);

      const raw = await client.query<{
        profile_id: string;
        protected_content: unknown;
        protected_operation_id: string;
        revision: number;
      }>(`
        SELECT profile_id, protected_content, protected_operation_id, revision
        FROM code_settings_profiles
        WHERE owner_id = '${LOCAL_USER_ID}'
      `);
      expect(raw.rows).toHaveLength(1);
      expect(raw.rows[0]).toMatchObject({
        profile_id: "default",
        protected_content: expect.objectContaining({
          domain: "customization-content",
        }),
        revision: 2,
      });
      expect(JSON.stringify(raw.rows[0])).not.toContain(
        "GLOBAL_CODE_SETTINGS_PLAINTEXT_SENTINEL",
      );

      await client.exec(`DELETE FROM users WHERE id = '${LOCAL_USER_ID}'`);
      const afterCascade = await client.query(
        "SELECT owner_id FROM code_settings_profiles",
      );
      expect(afterCascade.rows).toEqual([]);
    } finally {
      await client.close();
    }
  }, 20_000);
});
