import { Capacitor, registerPlugin } from "@capacitor/core";

import type { ClientDeviceKeyDescriptor } from "./client-device-key-provider";
import { InstallationCatalogError } from "./installation-catalog";
import {
  NativeClientDeviceKeyProvider,
  NativeInstallationCatalog,
  type NativeInstallationCatalogSnapshot,
  type NativeInstallationStorageBridge,
  type NativeInstallationStorageStatus,
  type NativeCatalogOperation,
} from "./tauri-installation-storage";

type NativeCatalogTransactionRequest = {
  expectedRevision: number;
  operations: NativeCatalogOperation[];
};

interface CapacitorInstallationStoragePlugin {
  applyCatalogTransaction(options: {
    request: NativeCatalogTransactionRequest;
  }): Promise<NativeInstallationCatalogSnapshot>;
  createKey(options: {
    input: {
      createdAt?: string;
      installationId: string;
      keyAlias: string;
    };
  }): Promise<ClientDeviceKeyDescriptor>;
  inspectKey(options: {
    keyAlias: string;
  }): Promise<ClientDeviceKeyDescriptor | null | undefined>;
  readCatalog(): Promise<NativeInstallationCatalogSnapshot>;
  status(): Promise<NativeInstallationStorageStatus>;
  unwrapAccountMasterKey(options: {
    input: Parameters<
      NativeInstallationStorageBridge["unwrapAccountMasterKey"]
    >[0];
  }): Promise<{ bytes: number[] }>;
}

const plugin = registerPlugin<CapacitorInstallationStoragePlugin>(
  "CantripInstallationStorage",
);

const capacitorCustodyBackends = new Set<
  NativeInstallationStorageStatus["provider"]
>(["android-keystore", "apple-keychain"]);

function capacitorRuntimeAvailable(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    (Capacitor.getPlatform() === "ios" ||
      Capacitor.getPlatform() === "android") &&
    Capacitor.isPluginAvailable("CantripInstallationStorage")
  );
}

export const capacitorInstallationStorageBridge: NativeInstallationStorageBridge =
  {
    runtimeLabel: "Capacitor",
    applyCatalogTransaction: (request) =>
      plugin.applyCatalogTransaction({ request }),
    createKey: (input) => plugin.createKey({ input }),
    inspectKey: async (keyAlias) =>
      (await plugin.inspectKey({ keyAlias })) ?? null,
    isAvailable: capacitorRuntimeAvailable,
    readCatalog: () => plugin.readCatalog(),
    status: () => plugin.status(),
    unwrapAccountMasterKey: async (input) =>
      (await plugin.unwrapAccountMasterKey({ input })).bytes,
  };

export class CapacitorInstallationCatalog extends NativeInstallationCatalog {
  constructor(
    bridge: NativeInstallationStorageBridge = capacitorInstallationStorageBridge,
  ) {
    super(bridge);
  }
}

export class CapacitorClientDeviceKeyProvider extends NativeClientDeviceKeyProvider {
  private constructor(
    bridge: NativeInstallationStorageBridge,
    backend: NativeInstallationStorageStatus["provider"],
  ) {
    super(bridge, backend, "capacitor-native");
  }

  static async open(
    bridge: NativeInstallationStorageBridge = capacitorInstallationStorageBridge,
  ): Promise<CapacitorClientDeviceKeyProvider> {
    return new CapacitorClientDeviceKeyProvider(
      bridge,
      await this.openBackend(bridge, capacitorCustodyBackends),
    );
  }
}

export async function inspectCapacitorInstallationStorage(): Promise<NativeInstallationStorageStatus> {
  if (!capacitorRuntimeAvailable()) {
    throw new InstallationCatalogError(
      "catalog-unavailable",
      "Native installation storage requires the Capacitor runtime.",
    );
  }
  return plugin.status();
}
