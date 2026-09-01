import { describe, expect, it } from "vitest";

import {
  CapacitorClientDeviceKeyProvider,
  CapacitorInstallationCatalog,
} from "./capacitor-installation-storage";
import { installationKeyAlias } from "./installation-catalog";
import type {
  NativeCatalogOperation,
  NativeInstallationCatalogSnapshot,
  NativeInstallationStorageBridge,
} from "./tauri-installation-storage";

const installationId = "5f83bb42-5671-4b11-a87f-32842af21af2";
const keyAlias = installationKeyAlias(installationId);
const createdAt = "2026-08-31T20:00:01.000Z";
const publicKey = {
  algorithm: "P-256" as const,
  format: "raw" as const,
  value:
    "BFm_YxDfIRPBuAS45UTQYjE8vzxylVItLMAVyHFU6lIiPo7gCNlzos45NP7Dn2vfhj1cxO-yYGwrBdlAmOzin1M",
  version: 1 as const,
};

function fakeBridge(
  overrides: Partial<NativeInstallationStorageBridge> = {},
): NativeInstallationStorageBridge & { operations: NativeCatalogOperation[] } {
  let snapshot: NativeInstallationCatalogSnapshot = {
    accountBindings: [],
    deviceKeys: [],
    installation: null,
    migrations: [],
    revision: 0,
    schemaVersion: 1,
  };
  const operations: NativeCatalogOperation[] = [];
  return {
    runtimeLabel: "Capacitor test",
    applyCatalogTransaction: async (request) => {
      expect(request.expectedRevision).toBe(snapshot.revision);
      operations.push(...request.operations);
      for (const operation of request.operations) {
        if (operation.type === "create-installation") {
          snapshot.installation = { ...operation.profile };
        } else if (
          operation.type === "put-device-key" ||
          operation.type === "replace-device-key"
        ) {
          snapshot.deviceKeys = [
            {
              ...operation.deviceKey,
              publicKey: { ...operation.deviceKey.publicKey },
            },
          ];
        } else if (operation.type === "put-account-binding") {
          snapshot.accountBindings = [{ ...operation.binding }];
        } else {
          snapshot.migrations = [{ ...operation.migration }];
        }
      }
      snapshot = { ...snapshot, revision: snapshot.revision + 1 };
      return structuredClone(snapshot);
    },
    createKey: async (input) => ({
      createdAt: input.createdAt ?? createdAt,
      installationId: input.installationId,
      keyAlias: input.keyAlias,
      provider: "android-keystore",
      publicKey,
    }),
    inspectKey: async (requestedAlias) =>
      requestedAlias === keyAlias
        ? {
            createdAt,
            installationId,
            keyAlias,
            provider: "android-keystore",
            publicKey,
          }
        : null,
    replaceMissingKey: async (input) => ({
      createdAt: input.createdAt ?? createdAt,
      installationId: input.installationId,
      keyAlias: input.keyAlias,
      provider: "android-keystore",
      publicKey,
    }),
    isAvailable: () => true,
    operations,
    readCatalog: () => Promise.resolve(structuredClone(snapshot)),
    status: () =>
      Promise.resolve({
        catalogPath: "/native/installation/v1/catalog.sqlite3",
        keyAliasFormat: "cantrip.installation.<installation-uuid>.hpke.v1",
        provider: "android-keystore",
        schemaVersion: 1,
      }),
    unwrapAccountMasterKey: () => Promise.resolve(Array(32).fill(47)),
    ...overrides,
  };
}

describe("Capacitor native installation storage bridge", () => {
  it("persists the shared installation catalog contract transactionally", async () => {
    const bridge = fakeBridge();
    const catalog = new CapacitorInstallationCatalog(bridge);
    await catalog.transaction(async (transaction) => {
      await transaction.createInstallation({
        createdAt,
        installationId,
        schemaVersion: 1,
      });
    });

    expect(await catalog.getInstallation()).toEqual({
      createdAt,
      installationId,
      schemaVersion: 1,
    });
    expect(bridge.operations).toEqual([
      {
        profile: { createdAt, installationId, schemaVersion: 1 },
        type: "create-installation",
      },
    ]);
  });

  it("selects Android Keystore custody and keeps the master key byte boundary", async () => {
    const provider = await CapacitorClientDeviceKeyProvider.open(fakeBridge());
    expect(provider.kind).toBe("capacitor-native");
    expect(provider.backend).toBe("android-keystore");
    expect(await provider.create({ installationId, keyAlias })).toMatchObject({
      installationId,
      keyAlias,
      provider: "android-keystore",
    });
    const accountMasterKey = await provider.unwrapAccountMasterKey({
      keyAlias,
      ownerId: "owner-a",
      wrapper: {
        clientId: "principal-a",
        envelope: {
          algorithm: "HPKE-RFC9180",
          ciphertext: "fixture",
          encapsulatedKey: "fixture",
          suite: {
            aead: "AES-256-GCM",
            kdf: "HKDF-SHA256",
            kem: "DHKEM(P-256,HKDF-SHA256)",
            mode: "base",
          },
          version: 1,
        },
        masterKeyRevision: 1,
        purpose: "client-account-master-key",
        version: 1,
      },
    });
    expect(accountMasterKey).toEqual(Uint8Array.from(Array(32).fill(47)));
    accountMasterKey.fill(0);
  });

  it("rejects a native provider that does not match a mobile platform", async () => {
    await expect(
      CapacitorClientDeviceKeyProvider.open(
        fakeBridge({
          status: () =>
            Promise.resolve({
              catalogPath: "/native/catalog.sqlite3",
              keyAliasFormat:
                "cantrip.installation.<installation-uuid>.hpke.v1",
              provider: "windows-protected-storage",
              schemaVersion: 1,
            }),
        }),
      ),
    ).rejects.toMatchObject({ code: "key-store-unavailable" });
  });

  it("accepts Apple Keychain custody through the same mobile contract", async () => {
    const provider = await CapacitorClientDeviceKeyProvider.open(
      fakeBridge({
        status: () =>
          Promise.resolve({
            catalogPath: "/native/installation/v1/catalog.sqlite3",
            keyAliasFormat: "cantrip.installation.<installation-uuid>.hpke.v1",
            provider: "apple-keychain",
            schemaVersion: 1,
          }),
      }),
    );

    expect(provider.backend).toBe("apple-keychain");
    expect(provider.kind).toBe("capacitor-native");
  });
});
