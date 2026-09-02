import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import type { EncryptedProjectWorkspaceName } from "@cantrip/protocol";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  LOCAL_USER_ID,
  ProjectWorkspaceInvariantError,
  ServerRepository,
} from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";
import { protectedProjectFields } from "./private-label-fixture.js";

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
        storage: { kind: "system" },
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
      const customWorkspace = await repository.createEncryptedProjectWorkspace(
        LOCAL_USER_ID,
        {
          id: "bcb5c558-3dcb-4dca-8561-90f014b1860c",
          nameProtection: encryptedName(9),
          storage: { kind: "managed" },
        },
      );
      await expect(
        repository.createEncryptedProjectWorkspace(LOCAL_USER_ID, {
          id: "3d931cba-1d7c-4883-bcd0-a32434b434c9",
          nameProtection: encryptedName(9),
          storage: { kind: "managed" },
        }),
      ).rejects.toThrow();
      expect(customWorkspace.storage).toEqual({ kind: "managed" });
      const promotedCustomWorkspace =
        await repository.updateEncryptedProjectWorkspace(
          LOCAL_USER_ID,
          customWorkspace.id,
          { expectedRevision: customWorkspace.revision, isDefault: true },
        );
      expect(promotedCustomWorkspace?.isDefault).toBe(true);
      await expect(
        repository.deleteProjectWorkspace(LOCAL_USER_ID, defaultWorkspace.id),
      ).rejects.toThrow(/cannot be deleted/iu);

      await client.exec(`
        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'workspace-worker', '${LOCAL_USER_ID}', 'Workspace worker',
          'linux', 'x64', now(), now()
        );
      `);
      await expect(
        repository.createEncryptedProjectWorkspace(LOCAL_USER_ID, {
          id: "732416b3-3d23-4411-b449-dd4bbb603f57",
          nameProtection: encryptedName(11),
          storage: {
            kind: "attached",
            workerId: "workspace-worker",
            rootPathHandle: `ctrr_${"c".repeat(43)}`,
            displayHandle: `ctrr_${"d".repeat(43)}`,
          },
        }),
      ).rejects.toThrow(/verified root attachment/iu);
      const attachedWorkspaceId = "65bd154a-b14d-4346-b8f4-e81e2536df14";
      await database.insert(schema.projectWorkspaces).values({
        id: attachedWorkspaceId,
        ownerId: LOCAL_USER_ID,
        nameEnvelope: encryptedName(10).envelope,
        nameBlindIndex: encryptedName(10).blindIndex,
        nameFormatVersion: 1,
        nameKeyRevision: 1,
        position: 2,
      });
      await database.insert(schema.projectWorkspaceStorageProfiles).values({
        workspaceId: attachedWorkspaceId,
        kind: "attached",
        workerId: "workspace-worker",
        protectedRootPathHandle: `ctrr_${"a".repeat(43)}`,
        protectedDisplayHandle: `ctrr_${"b".repeat(43)}`,
      });
      await expect(
        repository.updateEncryptedProjectWorkspace(
          LOCAL_USER_ID,
          attachedWorkspaceId,
          { expectedRevision: 1, isDefault: true },
        ),
      ).rejects.toThrow(/cannot be the default/iu);
      expect(
        (
          await repository.listProjectWorkspaceWire(LOCAL_USER_ID)
        ).workspaces.find(({ id }) => id === attachedWorkspaceId)?.storage,
      ).toEqual({
        kind: "attached",
        workerId: "workspace-worker",
        rootPathHandle: `ctrr_${"a".repeat(43)}`,
        displayHandle: `ctrr_${"b".repeat(43)}`,
      });
      await database
        .update(schema.projectWorkspaces)
        .set({ isDefault: false })
        .where(eq(schema.projectWorkspaces.id, customWorkspace.id));
      await database
        .update(schema.projectWorkspaces)
        .set({ isDefault: true })
        .where(eq(schema.projectWorkspaces.id, attachedWorkspaceId));
      await expect(
        repository.ensureDefaultProjectWorkspace(LOCAL_USER_ID),
      ).resolves.toMatchObject({ id: defaultWorkspace.id, isDefault: true });
      expect(
        (
          await repository.listProjectWorkspaceWire(LOCAL_USER_ID)
        ).workspaces.find(({ id }) => id === attachedWorkspaceId)?.isDefault,
      ).toBe(false);
      await expect(
        repository.deleteProjectWorkspace(LOCAL_USER_ID, attachedWorkspaceId),
      ).resolves.toBe(true);
      expect(
        await database
          .select()
          .from(schema.projectWorkspaceStorageProfiles)
          .where(
            eq(
              schema.projectWorkspaceStorageProfiles.workspaceId,
              attachedWorkspaceId,
            ),
          ),
      ).toEqual([]);
      const project = await repository.createGithubProject(LOCAL_USER_ID, {
        workerId: "workspace-worker",
        workspaceId: customWorkspace.id,
        ...protectedProjectFields("0ef1618a-a40c-4c61-9fd8-b709400477db"),
        repositoryBlindIndex: Buffer.alloc(32, 17).toString("base64url"),
        repositoryId: "opaque-workspace-project",
        nameWithOwner: "ArcaneArts/WorkspaceProject",
        url: "https://github.com/ArcaneArts/WorkspaceProject",
      });
      const assigned = await repository.listProjectWorkspaceWire(LOCAL_USER_ID);
      await expect(
        repository.getProjectWorkspaceStorageContext(LOCAL_USER_ID, project.id),
      ).resolves.toEqual({
        kind: "managed",
        workspaceId: customWorkspace.id,
      });
      expect(
        assigned.workspaces.filter(({ projectIds }) =>
          projectIds.includes(project.id),
        ),
      ).toEqual([expect.objectContaining({ id: customWorkspace.id })]);
      await expect(
        database.insert(schema.projectWorkspaceMemberships).values({
          workspaceId: defaultWorkspace.id,
          projectId: project.id,
        }),
      ).rejects.toThrow();
      await expect(
        repository.deleteProjectWorkspace(LOCAL_USER_ID, customWorkspace.id),
      ).rejects.toBeInstanceOf(ProjectWorkspaceInvariantError);

      await migrate(database, { migrationsFolder });
      expect(
        (await repository.listProjectWorkspaceWire(LOCAL_USER_ID)).workspaces,
      ).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
