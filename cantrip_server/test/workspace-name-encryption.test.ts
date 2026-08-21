import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import type { EncryptedProjectWorkspaceName } from "@cantrip/protocol";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import {
  LOCAL_USER_ID,
  ProjectWorkspaceInvariantError,
  ServerRepository,
} from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

function encryptedName(fill: number): EncryptedProjectWorkspaceName {
  return {
    state: "encrypted",
    formatVersion: 1,
    keyRevision: 1,
    blindIndex: Buffer.alloc(32, fill).toString("base64url"),
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: Buffer.alloc(12, fill).toString("base64url"),
      ciphertext: Buffer.alloc(16, fill).toString("base64url"),
    },
  };
}

describe("workspace name encrypted persistence", () => {
  it("seals the system default and rejects duplicate encrypted blind tags", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      const repository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "test",
          keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
        }),
      );
      await repository.ensureLocalIdentity();
      await client.exec(`
        INSERT INTO account_encryption_profiles (
          owner_id,
          format_version,
          active_master_key_revision,
          initialization_status,
          payload_migration_status,
          revision
        ) VALUES (
          '${LOCAL_USER_ID}', 1, 1, 'initialized', 'pending', 1
        );
      `);

      const initial = await repository.listProjectWorkspaceWire(LOCAL_USER_ID);
      const defaultWorkspace = initial.workspaces[0]!;
      expect(defaultWorkspace).toMatchObject({
        nameProtection: { state: "system-default" },
        position: 0,
        isDefault: true,
        projectIds: [],
        revision: 1,
      });

      const protectedDefault = encryptedName(3);
      await repository.updateEncryptedProjectWorkspace(
        LOCAL_USER_ID,
        defaultWorkspace.id,
        {
          expectedRevision: defaultWorkspace.revision,
          nameProtection: protectedDefault,
        },
      );
      const sealed = await repository.listProjectWorkspaceWire(LOCAL_USER_ID);
      expect(sealed.workspaces[0]).toMatchObject({
        id: defaultWorkspace.id,
        nameProtection: { state: "encrypted" },
        position: 0,
        isDefault: true,
        projectIds: [],
        revision: 2,
      });

      const stored = await client.query<{
        name_envelope: unknown;
      }>(`SELECT name_envelope FROM project_workspaces`);
      expect(stored.rows).toHaveLength(1);
      expect(JSON.stringify(stored.rows[0]?.name_envelope)).not.toContain(
        "Default",
      );
      const plaintextColumns = await client.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'project_workspaces' AND column_name = 'name'
      `);
      expect(plaintextColumns.rows).toEqual([]);

      await expect(
        repository.updateEncryptedProjectWorkspace(
          LOCAL_USER_ID,
          defaultWorkspace.id,
          {
            expectedRevision: defaultWorkspace.revision,
            nameProtection: protectedDefault,
          },
        ),
      ).rejects.toBeInstanceOf(ProjectWorkspaceInvariantError);
      await repository.createEncryptedProjectWorkspace(LOCAL_USER_ID, {
        id: "bcb5c558-3dcb-4dca-8561-90f014b1860c",
        nameProtection: encryptedName(9),
      });
      await expect(
        repository.createEncryptedProjectWorkspace(LOCAL_USER_ID, {
          id: "3d931cba-1d7c-4883-bcd0-a32434b434c9",
          nameProtection: encryptedName(9),
        }),
      ).rejects.toThrow();

      await migrate(database, { migrationsFolder });
      expect(
        (await repository.listProjectWorkspaceWire(LOCAL_USER_ID)).workspaces,
      ).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
