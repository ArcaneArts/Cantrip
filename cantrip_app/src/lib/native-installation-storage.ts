import {
  CapacitorClientDeviceKeyProvider,
  CapacitorInstallationCatalog,
} from "./capacitor-installation-storage";
import { ClientDeviceKeyProviderError } from "./client-device-key-provider";
import type { DurableClientEncryptionStorage } from "./durable-account-encryption";
import type { ClientRuntimePlatform } from "./runtime-platform";
import {
  TauriClientDeviceKeyProvider,
  TauriInstallationCatalog,
} from "./tauri-installation-storage";

export type NativeInstallationStorageFactories = {
  capacitor(): Promise<DurableClientEncryptionStorage>;
  tauri(): Promise<DurableClientEncryptionStorage>;
};

const defaultFactories: NativeInstallationStorageFactories = {
  capacitor: () =>
    CapacitorClientDeviceKeyProvider.open().then((provider) => ({
      catalog: new CapacitorInstallationCatalog(),
      provider,
    })),
  tauri: () =>
    TauriClientDeviceKeyProvider.open().then((provider) => ({
      catalog: new TauriInstallationCatalog(),
      provider,
    })),
};

type NativeStorageLane = keyof NativeInstallationStorageFactories;

const storageFlights = new Map<
  NativeStorageLane,
  Promise<DurableClientEncryptionStorage>
>();

function storageLane(platform: ClientRuntimePlatform): NativeStorageLane {
  if (platform === "tauri") return "tauri";
  if (platform === "capacitor-ios" || platform === "capacitor-android") {
    return "capacitor";
  }
  throw new ClientDeviceKeyProviderError(
    "key-store-unavailable",
    `Native installation storage is unavailable for ${platform}.`,
  );
}

export async function openNativeInstallationStorage(
  platform: ClientRuntimePlatform,
  factories: NativeInstallationStorageFactories = defaultFactories,
): Promise<DurableClientEncryptionStorage> {
  const lane = storageLane(platform);
  if (factories !== defaultFactories) return factories[lane]();

  const active = storageFlights.get(lane);
  if (active) return active;
  const opening = factories[lane]().catch((error: unknown) => {
    if (storageFlights.get(lane) === opening) storageFlights.delete(lane);
    throw error;
  });
  storageFlights.set(lane, opening);
  return opening;
}
