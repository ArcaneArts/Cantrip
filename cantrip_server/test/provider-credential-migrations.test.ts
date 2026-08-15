import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { ProviderCredentialMigrationCoordinator } from "../src/models/provider-credential-migrations.js";
import { SecretVault } from "../src/security/secret-vault.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

function credential(accountId = "upstream-account") {
  return {
    accessToken: "captured-access-token",
    accountId,
    email: "person@example.test",
    expiresAt: Date.UTC(2026, 7, 20),
    idToken: "captured-identity-token",
    kind: "chatgpt" as const,
    planType: "pro",
    refreshToken: "captured-refresh-token",
    userId: "upstream-user",
    version: 1 as const,
  };
}

describe("provider credential migration", () => {
  it("captures idempotently, defers purge, and quarantines identity conflicts", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    const commands: Array<Record<string, unknown>> = [];
    let localCredential = credential();
    const workers = {
      attach() {},
      close() {},
      isConnected: () => true,
      request: async (_workerId, command) => {
        commands.push(command);
        if (command.type === "provider.auth.legacy.capture") {
          return { credential: localCredential, status: "available" };
        }
        if (command.type === "provider.auth.legacy.purge") {
          return {
            purged: true,
            serverCredentialRevision: command.serverCredentialRevision,
            subject: command.expectedSubject,
          };
        }
        throw new Error("Unexpected worker command.");
      },
      sendSurfaceFrame: () => false,
      subscribeSurfaceFrames: () => () => undefined,
      subscribeWorkerDisconnect: () => () => undefined,
    } satisfies WorkerCommandBus;
    try {
      await migrate(database, { migrationsFolder });
      const repository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "test",
          keys: [{ id: "test", key: Buffer.alloc(32, 12) }],
        }),
      );
      await repository.ensureLocalIdentity();
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        kind: "chatgpt",
        name: "ChatGPT",
      });
      const accountId = provider.accounts[0]!.id;
      await client.exec(`
        UPDATE model_provider_accounts
        SET credential_state = 'migration-needed'
        WHERE id = '${accountId}'
      `);

      const coordinator = new ProviderCredentialMigrationCoordinator(
        repository,
        workers,
      );
      const first = await coordinator.migrateWorker(
        LOCAL_USER_ID,
        "worker-one",
      );
      expect(first).toEqual({
        alreadyCaptured: 0,
        captured: 1,
        checked: 1,
        conflicts: 0,
        failed: 0,
        malformed: 0,
        missing: 0,
        purged: 0,
      });
      expect(commands.map(({ type }) => type)).toEqual([
        "provider.auth.legacy.capture",
      ]);
      expect(
        await repository.getModelProviderAccountCredential(
          LOCAL_USER_ID,
          provider.id,
          accountId,
        ),
      ).toMatchObject({
        credential: localCredential,
        revision: 1,
        state: "signed-in",
      });

      commands.length = 0;
      const resumed = await coordinator.migrateWorker(
        LOCAL_USER_ID,
        "worker-one",
      );
      expect(resumed).toMatchObject({ alreadyCaptured: 1, captured: 0 });
      expect(commands.map(({ type }) => type)).toEqual([
        "provider.auth.legacy.capture",
      ]);
      expect(
        (
          await repository.getModelProviderAccountCredential(
            LOCAL_USER_ID,
            provider.id,
            accountId,
          )
        )?.revision,
      ).toBe(1);

      commands.length = 0;
      const purgeCoordinator = new ProviderCredentialMigrationCoordinator(
        repository,
        workers,
        { purgeEnabledKinds: new Set(["chatgpt"]) },
      );
      const purged = await purgeCoordinator.migrateWorker(
        LOCAL_USER_ID,
        "worker-one",
      );
      expect(purged).toMatchObject({ alreadyCaptured: 1, purged: 1 });
      expect(commands).toEqual([
        expect.objectContaining({
          type: "provider.auth.legacy.capture",
        }),
        expect.objectContaining({
          expectedSubject: "chatgpt:upstream-account",
          serverCredentialRevision: 1,
          type: "provider.auth.legacy.purge",
        }),
      ]);

      localCredential = credential("different-upstream-account");
      const conflicted = await coordinator.migrateWorker(
        LOCAL_USER_ID,
        "worker-two",
      );
      expect(conflicted).toMatchObject({ conflicts: 1, purged: 0 });
      const raw = await client.query<{ credential_state: string }>(`
        SELECT credential_state
        FROM model_provider_accounts
        WHERE id = '${accountId}'
      `);
      expect(raw.rows[0]?.credential_state).toBe("conflict");
      expect(
        (
          await repository.getModelProviderAccountCredential(
            LOCAL_USER_ID,
            provider.id,
            accountId,
          )
        )?.credential.accountId,
      ).toBe("upstream-account");
      expect(JSON.stringify(conflicted)).not.toContain(
        "captured-refresh-token",
      );
    } finally {
      await client.close();
    }
  });

  it("keeps missing and malformed local credentials resumable", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    let status: "malformed" | "missing" = "missing";
    const workers = {
      attach() {},
      close() {},
      isConnected: () => true,
      request: async () => ({ status }),
      sendSurfaceFrame: () => false,
      subscribeSurfaceFrames: () => () => undefined,
      subscribeWorkerDisconnect: () => () => undefined,
    } satisfies WorkerCommandBus;
    try {
      await migrate(database, { migrationsFolder });
      const repository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "test",
          keys: [{ id: "test", key: Buffer.alloc(32, 13) }],
        }),
      );
      await repository.ensureLocalIdentity();
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        baseUrl: "https://api.x.ai/v1",
        kind: "grok",
        name: "Grok",
      });
      const accountId = provider.accounts[0]!.id;
      await client.exec(`
        UPDATE model_provider_accounts
        SET credential_state = 'migration-needed'
        WHERE id = '${accountId}'
      `);
      const coordinator = new ProviderCredentialMigrationCoordinator(
        repository,
        workers,
      );
      expect(
        await coordinator.migrateWorker(LOCAL_USER_ID, "worker-one"),
      ).toMatchObject({ missing: 1, malformed: 0, failed: 0 });
      status = "malformed";
      expect(
        await coordinator.migrateWorker(LOCAL_USER_ID, "worker-one"),
      ).toMatchObject({ missing: 0, malformed: 1, failed: 0 });
      expect(
        await repository.listModelProviderAccountCredentialMigrations(
          LOCAL_USER_ID,
        ),
      ).toEqual([
        expect.objectContaining({
          accountId,
          state: "migration-needed",
        }),
      ]);
    } finally {
      await client.close();
    }
  });
});
