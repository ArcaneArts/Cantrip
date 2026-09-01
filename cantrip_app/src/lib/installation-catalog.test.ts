import type { EncryptionPublicKey } from "@cantrip/protocol/encryption";
import { describe, expect, it } from "vitest";

import {
  MemoryInstallationCatalog,
  installationKeyAlias,
  type InstallationAccountBinding,
  type InstallationDeviceKey,
  type InstallationProfile,
} from "./installation-catalog";

const installationId = "5f83bb42-5671-4b11-a87f-32842af21af2";
const createdAt = "2026-08-31T17:00:00.000Z";
const publicKey: EncryptionPublicKey = {
  algorithm: "P-256",
  format: "raw",
  value:
    "BK_oGka5tq0KHF7w8mbDBiTYOoZQ2v_qpT5LMAuZ1Qu7bJY3eTbnzK5N-aW7QjdMmpzeQ4gJGlC_ryYO9HhD_QQ",
  version: 1,
};

function profile(id = installationId): InstallationProfile {
  return { createdAt, installationId: id, schemaVersion: 1 };
}

function deviceKey(): InstallationDeviceKey {
  return {
    createdAt,
    installationId,
    keyAlias: installationKeyAlias(installationId),
    provider: "apple-keychain",
    publicKey,
    status: "active",
    version: 1,
  };
}

function binding(
  serverId: string,
  ownerId: string,
): InstallationAccountBinding {
  return {
    grantRevision: 1,
    keyAlias: installationKeyAlias(installationId),
    masterKeyRevision: 1,
    ownerId,
    principalId: `${ownerId}-principal`,
    serverId,
    updatedAt: createdAt,
  };
}

describe("installation catalog contract", () => {
  it("keeps one immutable installation while accepting idempotent initialization", async () => {
    const catalog = new MemoryInstallationCatalog();

    await catalog.transaction(async (transaction) => {
      await expect(transaction.createInstallation(profile())).resolves.toEqual(
        profile(),
      );
      await expect(transaction.createInstallation(profile())).resolves.toEqual(
        profile(),
      );
    });

    await expect(
      catalog.transaction((transaction) =>
        transaction.createInstallation(
          profile("1cb99f8a-6ccf-44e7-8b11-882d77381d56"),
        ),
      ),
    ).rejects.toMatchObject({ code: "installation-conflict" });
    await expect(catalog.getInstallation()).resolves.toEqual(profile());
  });

  it("maps multiple server accounts to the same installation key", async () => {
    const catalog = new MemoryInstallationCatalog();
    const first = binding("server-a", "owner-a");
    const second = binding("server-b", "owner-b");

    await catalog.transaction(async (transaction) => {
      await transaction.createInstallation(profile());
      await transaction.putDeviceKey(deviceKey());
      await transaction.putAccountBinding(first);
      await transaction.putAccountBinding(second);
    });

    await expect(catalog.listAccountBindings()).resolves.toEqual([
      first,
      second,
    ]);
    await expect(
      catalog.getAccountBinding(first.serverId, first.ownerId),
    ).resolves.toMatchObject({ keyAlias: deviceKey().keyAlias });
    await expect(
      catalog.getAccountBinding(second.serverId, second.ownerId),
    ).resolves.toMatchObject({ keyAlias: deviceKey().keyAlias });
  });

  it("rolls back a failed transaction without creating a partial profile", async () => {
    const catalog = new MemoryInstallationCatalog();

    await expect(
      catalog.transaction(async (transaction) => {
        await transaction.createInstallation(profile());
        await transaction.putDeviceKey(deviceKey());
        throw new Error("simulated interruption");
      }),
    ).rejects.toThrow("simulated interruption");

    await expect(catalog.getInstallation()).resolves.toBeNull();
    await expect(
      catalog.getDeviceKey(installationKeyAlias(installationId)),
    ).resolves.toBeNull();
  });

  it("requires verified migrations to contain durable verification evidence", async () => {
    const catalog = new MemoryInstallationCatalog();

    await expect(
      catalog.transaction((transaction) =>
        transaction.putMigration({
          completedAt: null,
          migrationId: "legacy-indexeddb-v1",
          startedAt: createdAt,
          state: "verified",
          verificationState: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "migration-invalid" });

    await catalog.transaction((transaction) =>
      transaction.putMigration({
        completedAt: "2026-08-31T17:00:01.000Z",
        migrationId: "legacy-indexeddb-v1",
        startedAt: createdAt,
        state: "verified",
        verificationState: "account-master-key-round-trip",
      }),
    );

    await expect(
      catalog.getMigration("legacy-indexeddb-v1"),
    ).resolves.toMatchObject({
      state: "verified",
      verificationState: "account-master-key-round-trip",
    });
  });
});
