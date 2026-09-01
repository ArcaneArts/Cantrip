import type { ClientMasterKeyWrapper } from "@cantrip/protocol/encryption";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => tauri);

import {
  TauriClientDeviceKeyProvider,
  TauriInstallationCatalog,
} from "./tauri-installation-storage";
import type {
  InstallationDeviceKey,
  InstallationProfile,
} from "./installation-catalog";

const installationId = "5f83bb42-5671-4b11-a87f-32842af21af2";
const keyAlias = `cantrip.installation.v1.${installationId}`;
const createdAt = "2026-08-31T20:00:00.000Z";
const profile: InstallationProfile = {
  createdAt,
  installationId,
  schemaVersion: 1,
};
const deviceKey: InstallationDeviceKey = {
  createdAt,
  installationId,
  keyAlias,
  provider: "apple-keychain",
  publicKey: {
    algorithm: "P-256",
    format: "raw",
    value:
      "BK_oGka5tq0KHF7w8mbDBiTYOoZQ2v_qpT5LMAuZ1Qu7bJY3eTbnzK5N-aW7QjdMmpzeQ4gJGlC_ryYO9HhD_QQ",
    version: 1,
  },
  status: "active",
  version: 1,
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    accountBindings: [],
    deviceKeys: [],
    installation: null,
    migrations: [],
    revision: 4,
    schemaVersion: 1,
    ...overrides,
  };
}

describe("Tauri installation catalog", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.isTauri.mockReturnValue(true);
  });

  it("commits a transaction as one revision-checked native batch", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "read_native_installation_catalog") {
        return Promise.resolve(snapshot());
      }
      if (command === "apply_native_installation_catalog_transaction") {
        return Promise.resolve(
          snapshot({ installation: profile, revision: 5 }),
        );
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const catalog = new TauriInstallationCatalog();

    await catalog.transaction(async (transaction) => {
      await transaction.createInstallation(profile);
      await transaction.putMigration({
        completedAt: null,
        migrationId: "legacy-indexeddb-v1",
        startedAt: null,
        state: "pending",
        verificationState: null,
      });
    });

    expect(tauri.invoke).toHaveBeenCalledTimes(2);
    expect(tauri.invoke).toHaveBeenLastCalledWith(
      "apply_native_installation_catalog_transaction",
      {
        request: {
          expectedRevision: 4,
          operations: [
            { profile, type: "create-installation" },
            {
              migration: {
                completedAt: null,
                migrationId: "legacy-indexeddb-v1",
                startedAt: null,
                state: "pending",
                verificationState: null,
              },
              type: "put-migration",
            },
          ],
        },
      },
    );
  });

  it("does not send a commit when the transaction callback fails", async () => {
    tauri.invoke.mockResolvedValue(snapshot());
    const catalog = new TauriInstallationCatalog();

    await expect(
      catalog.transaction(async (transaction) => {
        await transaction.createInstallation(profile);
        throw new Error("simulated interruption");
      }),
    ).rejects.toThrow("simulated interruption");

    expect(tauri.invoke).toHaveBeenCalledOnce();
    expect(tauri.invoke).toHaveBeenCalledWith(
      "read_native_installation_catalog",
    );
  });

  it("maps a native compare-and-swap conflict precisely", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "read_native_installation_catalog") {
        return Promise.resolve(snapshot());
      }
      return Promise.reject({
        code: "installation-catalog-conflict",
        message: "conflict",
        retryable: true,
      });
    });
    const catalog = new TauriInstallationCatalog();

    await expect(
      catalog.transaction((transaction) =>
        transaction.createInstallation(profile),
      ),
    ).rejects.toMatchObject({ code: "transaction-conflict" });
  });
});

describe("Tauri client device-key provider", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.isTauri.mockReturnValue(true);
  });

  it("uses the exact native custody backend and never exposes private material", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "native_installation_storage_status") {
        return Promise.resolve({
          catalogPath: "/native/installation/v1/catalog.sqlite3",
          keyAliasFormat: "cantrip.installation.v1.<installation-uuid>",
          provider: "apple-keychain",
          schemaVersion: 1,
        });
      }
      if (command === "create_native_installation_key") {
        const { status: _status, version: _version, ...descriptor } = deviceKey;
        return Promise.resolve(descriptor);
      }
      if (command === "inspect_native_installation_key") {
        const { status: _status, version: _version, ...descriptor } = deviceKey;
        return Promise.resolve(descriptor);
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const provider = await TauriClientDeviceKeyProvider.open();

    expect(provider.backend).toBe("apple-keychain");
    const created = await provider.create({ installationId, keyAlias });
    expect(created).not.toHaveProperty("privateKey");
    await expect(provider.inspect(keyAlias)).resolves.toEqual(created);
  });

  it("returns only the unwrapped Account Master Key bytes", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "native_installation_storage_status") {
        return Promise.resolve({
          catalogPath: "/native/installation/v1/catalog.sqlite3",
          keyAliasFormat: "cantrip.installation.v1.<installation-uuid>",
          provider: "apple-keychain",
          schemaVersion: 1,
        });
      }
      if (command === "unwrap_native_account_master_key") {
        return Promise.resolve(new Array<number>(32).fill(47));
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const provider = await TauriClientDeviceKeyProvider.open();

    const opened = await provider.unwrapAccountMasterKey({
      keyAlias,
      ownerId: "owner-a",
      wrapper: {} as ClientMasterKeyWrapper,
    });
    expect(opened).toEqual(new Uint8Array(32).fill(47));
  });

  it("rejects an unsupported native custody contract", async () => {
    tauri.invoke.mockResolvedValue({
      catalogPath: "/native/installation/v1/catalog.sqlite3",
      keyAliasFormat: "cantrip.installation.v2.<installation-uuid>",
      provider: "apple-keychain",
      schemaVersion: 2,
    });

    await expect(TauriClientDeviceKeyProvider.open()).rejects.toMatchObject({
      code: "key-store-unavailable",
    });
  });

  it("rejects malformed native key metadata", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "native_installation_storage_status") {
        return Promise.resolve({
          catalogPath: "/native/installation/v1/catalog.sqlite3",
          keyAliasFormat: "cantrip.installation.v1.<installation-uuid>",
          provider: "apple-keychain",
          schemaVersion: 1,
        });
      }
      if (command === "inspect_native_installation_key") {
        return Promise.resolve({ ...deviceKey, provider: "indexeddb" });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const provider = await TauriClientDeviceKeyProvider.open();

    await expect(provider.inspect(keyAlias)).rejects.toMatchObject({
      code: "key-unusable",
    });
  });

  it("does not create a replacement after a missing-key failure", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "native_installation_storage_status") {
        return Promise.resolve({
          catalogPath: "/native/installation/v1/catalog.sqlite3",
          keyAliasFormat: "cantrip.installation.v1.<installation-uuid>",
          provider: "apple-keychain",
          schemaVersion: 1,
        });
      }
      if (command === "unwrap_native_account_master_key") {
        return Promise.reject({
          code: "native-device-key-missing",
          message: "missing",
          retryable: false,
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const provider = await TauriClientDeviceKeyProvider.open();

    await expect(
      provider.unwrapAccountMasterKey({
        keyAlias,
        ownerId: "owner-a",
        wrapper: {} as ClientMasterKeyWrapper,
      }),
    ).rejects.toMatchObject({ code: "key-missing" });
    expect(tauri.invoke).not.toHaveBeenCalledWith(
      "create_native_installation_key",
      expect.anything(),
    );
  });
});
