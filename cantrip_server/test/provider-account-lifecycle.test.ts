import { fileURLToPath } from "node:url";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it, vi } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { ProviderAccountLifecycleService } from "../src/models/provider-account-lifecycle.js";
import { SecretVault } from "../src/security/secret-vault.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";
import {
  protectedProviderCredentialFixture,
  providerCredentialMetadataFixture,
} from "./protected-provider-credential-fixture.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("global provider account lifecycle", () => {
  it("clears the opaque credential before closing every worker runtime", async () => {
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
    const provider = await repository.createModelProvider(LOCAL_USER_ID, {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      kind: "chatgpt",
      name: "ChatGPT",
    });
    const account = provider.accounts[0]!;
    const protectedCredential = protectedProviderCredentialFixture("K");
    await repository.storeModelProviderAccountCredential(
      LOCAL_USER_ID,
      provider.id,
      account.id,
      protectedCredential,
      providerCredentialMetadataFixture(),
    );
    for (const workerId of ["worker-a", "worker-b"]) {
      await repository.recordWorker(LOCAL_USER_ID, {
        architecture: "arm64",
        codexRuntime: unprobedCodexRuntimeReport,
        codexVersion: "0.148.0",
        name: workerId,
        platform: "darwin",
        startedAt: "2026-08-15T00:00:00.000Z",
        workerId,
      });
      await repository.recordModelProviderAccountStatus(account.id, workerId, {
        authenticated: true,
        email: "person@example.test",
        planType: "pro",
        weeklyUsage: null,
      });
    }
    const commands: Array<{ workerId: string; command: unknown }> = [];
    const bridge = {
      attach() {},
      close() {},
      isConnected: () => true,
      request: async (workerId, command) => {
        commands.push({ workerId, command });
        return { accepted: true };
      },
      sendSurfaceFrame: () => false,
      subscribeSurfaceFrames: () => () => undefined,
      subscribeWorkerDisconnect: () => () => undefined,
    } satisfies WorkerCommandBus;
    const invalidateCatalog = vi.fn(async () => undefined);
    const logger = { warn: vi.fn() };
    const lifecycle = new ProviderAccountLifecycleService(repository, bridge, {
      invalidateCatalog,
      logger,
    });

    try {
      await expect(
        lifecycle.signOut({
          accountId: account.id,
          credentialHomeKey: account.credentialHomeKey,
          kind: "chatgpt",
          ownerId: LOCAL_USER_ID,
          providerId: provider.id,
        }),
      ).resolves.toEqual({
        catalogInvalidated: true,
        credentialCleared: true,
        revocation: "not-applicable",
        workersClosed: 2,
        workersFailed: 0,
      });
      expect(invalidateCatalog).toHaveBeenCalledOnce();
      expect(commands).toEqual(
        ["worker-a", "worker-b"].map((workerId) => ({
          workerId,
          command: {
            type: "provider.auth.account.clear",
            providerId: provider.id,
            providerKind: "chatgpt",
            providerAccountId: account.id,
            credentialHomeKey: account.credentialHomeKey,
          },
        })),
      );
      expect(
        await repository.getModelProviderAccountCredential(
          LOCAL_USER_ID,
          provider.id,
          account.id,
        ),
      ).toBeNull();
      expect(
        (
          await repository.listModelProviderAccounts(LOCAL_USER_ID, provider.id)
        )[0],
      ).toMatchObject({
        credentialState: "signed-out",
        workerBindings: [
          { authState: "signed-out" },
          { authState: "signed-out" },
        ],
      });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
        protectedCredential.protectedCredential.envelope.ciphertext,
      );
    } finally {
      await client.close();
    }
  });
});
