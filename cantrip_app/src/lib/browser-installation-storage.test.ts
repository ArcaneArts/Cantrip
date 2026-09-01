import {
  clearSensitiveBytes,
  generateAccountMasterKey,
  wrapAccountMasterKeyForClient,
} from "@cantrip/crypto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import {
  openBrowserInstallationStorage,
  requestBrowserStoragePersistence,
} from "./browser-installation-storage";
import {
  installationCatalogSchemaVersion,
  installationDeviceKeyVersion,
  installationKeyAlias,
} from "./installation-catalog";

const installationId = "16e8ad51-8520-4ca5-b008-f29f7523531a";
const createdAt = "2026-08-31T12:00:00.000Z";

describe("browser installation storage", () => {
  it("requests persistent storage when the browser has not granted it", async () => {
    const manager = {
      persist: vi.fn(() => Promise.resolve(true)),
      persisted: vi.fn(() => Promise.resolve(false)),
    };

    await expect(requestBrowserStoragePersistence(manager)).resolves.toBe(
      "persistent",
    );
    expect(manager.persisted).toHaveBeenCalledOnce();
    expect(manager.persist).toHaveBeenCalledOnce();
  });

  it("continues explicitly as best-effort when persistence is denied", async () => {
    await expect(
      requestBrowserStoragePersistence({
        persist: () => Promise.resolve(false),
        persisted: () => Promise.resolve(false),
      }),
    ).resolves.toBe("best-effort");
    await expect(requestBrowserStoragePersistence(undefined)).resolves.toBe(
      "unsupported",
    );
  });

  it("persists one nonextractable installation key and multiple account bindings", async () => {
    const factory = new IDBFactory();
    const storage = await openBrowserInstallationStorage(factory, undefined);
    const profile = await storage.catalog.transaction((transaction) =>
      transaction.createInstallation({
        createdAt,
        installationId,
        schemaVersion: installationCatalogSchemaVersion,
      }),
    );
    const keyAlias = installationKeyAlias(profile.installationId);
    const device = await storage.provider.create({
      createdAt,
      installationId,
      keyAlias,
    });
    await storage.catalog.transaction(async (transaction) => {
      await transaction.putDeviceKey({
        ...device,
        status: "active",
        version: installationDeviceKeyVersion,
      });
      await transaction.putAccountBinding({
        grantRevision: 1,
        keyAlias,
        masterKeyRevision: 1,
        ownerId: "owner-a",
        principalId: "principal-a",
        serverId: "server-a",
        updatedAt: createdAt,
      });
      await transaction.putAccountBinding({
        grantRevision: 2,
        keyAlias,
        masterKeyRevision: 1,
        ownerId: "owner-b",
        principalId: "principal-b",
        serverId: "server-b",
        updatedAt: createdAt,
      });
    });

    const reopened = await openBrowserInstallationStorage(factory, undefined);
    await expect(reopened.catalog.getInstallation()).resolves.toEqual(profile);
    await expect(reopened.catalog.listAccountBindings()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerId: "owner-a", keyAlias }),
        expect.objectContaining({ ownerId: "owner-b", keyAlias }),
      ]),
    );
    await expect(reopened.provider.inspect(keyAlias)).resolves.toEqual(device);

    const accountMasterKey = generateAccountMasterKey();
    try {
      const wrapper = await wrapAccountMasterKeyForClient({
        accountMasterKey,
        clientId: "principal-a",
        clientPublicKey: device.publicKey,
        masterKeyRevision: 1,
        ownerId: "owner-a",
      });
      const unwrapped = await reopened.provider.unwrapAccountMasterKey({
        keyAlias,
        ownerId: "owner-a",
        wrapper,
      });
      expect(unwrapped).toEqual(accountMasterKey);
      clearSensitiveBytes(unwrapped);
    } finally {
      clearSensitiveBytes(accountMasterKey);
    }
  });

  it("retries a concurrent transaction without overwriting another installation", async () => {
    const factory = new IDBFactory();
    const first = await openBrowserInstallationStorage(factory, undefined);
    const second = await openBrowserInstallationStorage(factory, undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const stale = first.catalog.transaction(async (transaction) => {
      await gate;
      return transaction.createInstallation({
        createdAt,
        installationId,
        schemaVersion: installationCatalogSchemaVersion,
      });
    });
    await second.catalog.transaction((transaction) =>
      transaction.createInstallation({
        createdAt,
        installationId: "36bef765-ebdf-46c3-a0a2-36a1dc08577f",
        schemaVersion: installationCatalogSchemaVersion,
      }),
    );
    release();

    await expect(stale).rejects.toMatchObject({
      code: "installation-conflict",
    });
    await expect(first.catalog.getInstallation()).resolves.toMatchObject({
      installationId: "36bef765-ebdf-46c3-a0a2-36a1dc08577f",
    });
  });
});
