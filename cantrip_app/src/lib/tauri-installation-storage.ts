import { requireByteLength } from "@cantrip/crypto";
import type { ClientMasterKeyWrapper } from "@cantrip/protocol/encryption";
import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  ClientDeviceKeyProviderError,
  type ClientDeviceKeyDescriptor,
  type ClientDeviceKeyProvider,
} from "./client-device-key-provider";
import {
  InstallationCatalogError,
  type ClientDeviceKeyCustodyBackend,
  type InstallationAccountBinding,
  type InstallationCatalog,
  type InstallationCatalogReader,
  type InstallationCatalogTransaction,
  type InstallationDeviceKey,
  type InstallationMigration,
  type InstallationProfile,
} from "./installation-catalog";

export type NativeInstallationStorageStatus = {
  catalogPath: string;
  keyAliasFormat: string;
  provider: Exclude<
    ClientDeviceKeyCustodyBackend,
    "browser-webcrypto" | "memory" | "stronghold"
  >;
  schemaVersion: number;
};

const nativeCustodyBackends = new Set<
  NativeInstallationStorageStatus["provider"]
>(["apple-keychain", "linux-secret-service", "windows-protected-storage"]);

type NativeInstallationCatalogSnapshot = {
  accountBindings: InstallationAccountBinding[];
  deviceKeys: InstallationDeviceKey[];
  installation: InstallationProfile | null;
  migrations: InstallationMigration[];
  revision: number;
  schemaVersion: number;
};

type NativeCatalogOperation =
  | { profile: InstallationProfile; type: "create-installation" }
  | {
      binding: InstallationAccountBinding;
      type: "put-account-binding";
    }
  | { deviceKey: InstallationDeviceKey; type: "put-device-key" }
  | { migration: InstallationMigration; type: "put-migration" };

type NativeInstallationStorageError = {
  code: string;
  message: string;
  retryable: boolean;
};

function clonePublicKey(
  deviceKey: InstallationDeviceKey,
): InstallationDeviceKey {
  return { ...deviceKey, publicKey: { ...deviceKey.publicKey } };
}

function cloneSnapshot(
  snapshot: NativeInstallationCatalogSnapshot,
): NativeInstallationCatalogSnapshot {
  if (
    snapshot.schemaVersion !== 1 ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    !Array.isArray(snapshot.accountBindings) ||
    !Array.isArray(snapshot.deviceKeys) ||
    !Array.isArray(snapshot.migrations)
  ) {
    throw new InstallationCatalogError(
      "catalog-corrupt",
      "The native installation catalog returned an invalid snapshot.",
    );
  }
  return {
    accountBindings: snapshot.accountBindings.map((binding) => ({
      ...binding,
    })),
    deviceKeys: snapshot.deviceKeys.map(clonePublicKey),
    installation: snapshot.installation ? { ...snapshot.installation } : null,
    migrations: snapshot.migrations.map((migration) => ({ ...migration })),
    revision: snapshot.revision,
    schemaVersion: snapshot.schemaVersion,
  };
}

function parseNativeStatus(value: NativeInstallationStorageStatus) {
  if (
    value.schemaVersion !== 1 ||
    typeof value.catalogPath !== "string" ||
    value.catalogPath.length === 0 ||
    value.keyAliasFormat !== "cantrip.installation.v1.<installation-uuid>" ||
    !nativeCustodyBackends.has(value.provider)
  ) {
    throw new ClientDeviceKeyProviderError(
      "key-store-unavailable",
      "Native installation storage returned an unsupported contract.",
    );
  }
  return value;
}

function parseNativeDescriptor(
  value: ClientDeviceKeyDescriptor,
): ClientDeviceKeyDescriptor {
  if (
    typeof value?.createdAt !== "string" ||
    typeof value.installationId !== "string" ||
    typeof value.keyAlias !== "string" ||
    !nativeCustodyBackends.has(
      value.provider as NativeInstallationStorageStatus["provider"],
    ) ||
    value.publicKey?.algorithm !== "P-256" ||
    value.publicKey.format !== "raw" ||
    value.publicKey.version !== 1 ||
    typeof value.publicKey.value !== "string"
  ) {
    throw new ClientDeviceKeyProviderError(
      "key-unusable",
      "Native installation storage returned invalid key metadata.",
    );
  }
  return { ...value, publicKey: { ...value.publicKey } };
}

function bindingMapKey(serverId: string, ownerId: string): string {
  return JSON.stringify([serverId, ownerId]);
}

function nativeErrorCode(error: unknown): string | null {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

function mapCatalogError(error: unknown): never {
  const code = nativeErrorCode(error);
  if (code === "installation-catalog-conflict") {
    throw new InstallationCatalogError(
      "transaction-conflict",
      "The installation catalog changed in another application window.",
    );
  }
  if (
    code === "installation-catalog-unavailable" ||
    code === "installation-catalog-path-unavailable"
  ) {
    throw new InstallationCatalogError(
      "catalog-unavailable",
      "The native installation catalog is unavailable.",
    );
  }
  if (
    code === "installation-catalog-version-unsupported" ||
    code === "installation-catalog-corrupt"
  ) {
    throw new InstallationCatalogError(
      "catalog-corrupt",
      "The native installation catalog cannot be read safely.",
    );
  }
  if (code === "installation-conflict") {
    throw new InstallationCatalogError(
      "installation-conflict",
      "The catalog already belongs to another installation.",
    );
  }
  if (code === "installation-missing") {
    throw new InstallationCatalogError(
      "installation-missing",
      "The installation profile is missing.",
    );
  }
  const validationCodes = {
    "installation-account-binding-invalid": "account-binding-invalid",
    "installation-device-key-invalid": "device-key-invalid",
    "installation-migration-invalid": "migration-invalid",
    "installation-profile-invalid": "installation-invalid",
  } as const;
  if (code && code in validationCodes) {
    throw new InstallationCatalogError(
      validationCodes[code as keyof typeof validationCodes],
      "The native installation catalog rejected invalid metadata.",
    );
  }
  throw error;
}

function mapProviderError(error: unknown): never {
  const code = nativeErrorCode(error);
  if (code === "native-device-key-missing") {
    throw new ClientDeviceKeyProviderError(
      "key-missing",
      "The native installation key is missing.",
    );
  }
  if (
    code === "native-device-key-invalid" ||
    code === "native-device-key-metadata-mismatch" ||
    code === "client-master-key-decryption-failed"
  ) {
    throw new ClientDeviceKeyProviderError(
      "key-unusable",
      "The native installation key cannot unlock this account binding.",
    );
  }
  if (
    code === "native-device-key-alias-invalid" ||
    code === "native-device-key-conflict" ||
    code === "installation-missing"
  ) {
    throw new ClientDeviceKeyProviderError(
      "key-conflict",
      "The native installation key belongs to another installation.",
    );
  }
  if (code?.includes("unavailable")) {
    throw new ClientDeviceKeyProviderError(
      "key-store-unavailable",
      "The operating system secure-key store is unavailable.",
    );
  }
  throw error;
}

class TauriInstallationCatalogDraft implements InstallationCatalogTransaction {
  readonly operations: NativeCatalogOperation[] = [];

  private readonly accountBindings = new Map<
    string,
    InstallationAccountBinding
  >();
  private readonly deviceKeys = new Map<string, InstallationDeviceKey>();
  private installation: InstallationProfile | null;
  private readonly migrations = new Map<string, InstallationMigration>();

  constructor(snapshot: NativeInstallationCatalogSnapshot) {
    this.installation = snapshot.installation
      ? { ...snapshot.installation }
      : null;
    for (const binding of snapshot.accountBindings) {
      this.accountBindings.set(
        bindingMapKey(binding.serverId, binding.ownerId),
        { ...binding },
      );
    }
    for (const deviceKey of snapshot.deviceKeys) {
      this.deviceKeys.set(deviceKey.keyAlias, clonePublicKey(deviceKey));
    }
    for (const migration of snapshot.migrations) {
      this.migrations.set(migration.migrationId, { ...migration });
    }
  }

  async createInstallation(
    profile: InstallationProfile,
  ): Promise<InstallationProfile> {
    if (
      this.installation &&
      this.installation.installationId !== profile.installationId
    ) {
      throw new InstallationCatalogError(
        "installation-conflict",
        "This catalog already belongs to another installation.",
      );
    }
    if (!this.installation) {
      this.installation = { ...profile };
      this.operations.push({
        profile: { ...profile },
        type: "create-installation",
      });
    }
    return { ...this.installation };
  }

  async getAccountBinding(
    serverId: string,
    ownerId: string,
  ): Promise<InstallationAccountBinding | null> {
    const binding = this.accountBindings.get(bindingMapKey(serverId, ownerId));
    return binding ? { ...binding } : null;
  }

  async getDeviceKey(keyAlias: string): Promise<InstallationDeviceKey | null> {
    const deviceKey = this.deviceKeys.get(keyAlias);
    return deviceKey ? clonePublicKey(deviceKey) : null;
  }

  async getInstallation(): Promise<InstallationProfile | null> {
    return this.installation ? { ...this.installation } : null;
  }

  async getMigration(
    migrationId: string,
  ): Promise<InstallationMigration | null> {
    const migration = this.migrations.get(migrationId);
    return migration ? { ...migration } : null;
  }

  async listAccountBindings(): Promise<InstallationAccountBinding[]> {
    return [...this.accountBindings.values()].map((binding) => ({
      ...binding,
    }));
  }

  async putAccountBinding(binding: InstallationAccountBinding): Promise<void> {
    const stored = { ...binding };
    this.accountBindings.set(
      bindingMapKey(binding.serverId, binding.ownerId),
      stored,
    );
    this.operations.push({ binding: stored, type: "put-account-binding" });
  }

  async putDeviceKey(deviceKey: InstallationDeviceKey): Promise<void> {
    const stored = clonePublicKey(deviceKey);
    this.deviceKeys.set(deviceKey.keyAlias, stored);
    this.operations.push({ deviceKey: stored, type: "put-device-key" });
  }

  async putMigration(migration: InstallationMigration): Promise<void> {
    const stored = { ...migration };
    this.migrations.set(migration.migrationId, stored);
    this.operations.push({ migration: stored, type: "put-migration" });
  }
}

export class TauriInstallationCatalog implements InstallationCatalog {
  private transactionTail: Promise<void> = Promise.resolve();

  private async readSnapshot(): Promise<NativeInstallationCatalogSnapshot> {
    if (!isTauri()) {
      throw new InstallationCatalogError(
        "catalog-unavailable",
        "Native installation storage requires the Tauri runtime.",
      );
    }
    try {
      return cloneSnapshot(
        await invoke<NativeInstallationCatalogSnapshot>(
          "read_native_installation_catalog",
        ),
      );
    } catch (error) {
      return mapCatalogError(error);
    }
  }

  async getAccountBinding(
    serverId: string,
    ownerId: string,
  ): Promise<InstallationAccountBinding | null> {
    const snapshot = await this.readSnapshot();
    return (
      snapshot.accountBindings.find(
        (binding) =>
          binding.serverId === serverId && binding.ownerId === ownerId,
      ) ?? null
    );
  }

  async getDeviceKey(keyAlias: string): Promise<InstallationDeviceKey | null> {
    const snapshot = await this.readSnapshot();
    return snapshot.deviceKeys.find((key) => key.keyAlias === keyAlias) ?? null;
  }

  async getInstallation(): Promise<InstallationProfile | null> {
    return (await this.readSnapshot()).installation;
  }

  async getMigration(
    migrationId: string,
  ): Promise<InstallationMigration | null> {
    const snapshot = await this.readSnapshot();
    return (
      snapshot.migrations.find(
        (migration) => migration.migrationId === migrationId,
      ) ?? null
    );
  }

  async listAccountBindings(): Promise<InstallationAccountBinding[]> {
    return (await this.readSnapshot()).accountBindings;
  }

  async transaction<T>(
    operation: (transaction: InstallationCatalogTransaction) => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const predecessor = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      const snapshot = await this.readSnapshot();
      const transaction = new TauriInstallationCatalogDraft(snapshot);
      const result = await operation(transaction);
      if (transaction.operations.length > 0) {
        try {
          await invoke<NativeInstallationCatalogSnapshot>(
            "apply_native_installation_catalog_transaction",
            {
              request: {
                expectedRevision: snapshot.revision,
                operations: transaction.operations,
              },
            },
          );
        } catch (error) {
          mapCatalogError(error);
        }
      }
      return result;
    } finally {
      release();
    }
  }
}

export class TauriClientDeviceKeyProvider implements ClientDeviceKeyProvider {
  readonly kind = "tauri-native" as const;

  private constructor(
    readonly backend: NativeInstallationStorageStatus["provider"],
  ) {}

  static async open(): Promise<TauriClientDeviceKeyProvider> {
    if (!isTauri()) {
      throw new ClientDeviceKeyProviderError(
        "key-store-unavailable",
        "Native key custody requires the Tauri runtime.",
      );
    }
    try {
      const status = parseNativeStatus(
        await invoke<NativeInstallationStorageStatus>(
          "native_installation_storage_status",
        ),
      );
      return new TauriClientDeviceKeyProvider(status.provider);
    } catch (error) {
      return mapProviderError(error);
    }
  }

  async create(input: {
    createdAt?: string;
    installationId: string;
    keyAlias: string;
  }): Promise<ClientDeviceKeyDescriptor> {
    try {
      return parseNativeDescriptor(
        await invoke<ClientDeviceKeyDescriptor>(
          "create_native_installation_key",
          { input },
        ),
      );
    } catch (error) {
      return mapProviderError(error);
    }
  }

  async inspect(keyAlias: string): Promise<ClientDeviceKeyDescriptor | null> {
    try {
      const value = await invoke<ClientDeviceKeyDescriptor | null>(
        "inspect_native_installation_key",
        { keyAlias },
      );
      return value === null ? null : parseNativeDescriptor(value);
    } catch (error) {
      return mapProviderError(error);
    }
  }

  async unwrapAccountMasterKey(input: {
    keyAlias: string;
    ownerId: string;
    wrapper: ClientMasterKeyWrapper;
  }): Promise<Uint8Array> {
    try {
      const value = new Uint8Array(
        await invoke<number[]>("unwrap_native_account_master_key", {
          input,
        }),
      );
      requireByteLength(value, 32, "Account Master Key");
      return value;
    } catch (error) {
      return mapProviderError(error);
    }
  }
}

export async function inspectNativeInstallationStorage(): Promise<NativeInstallationStorageStatus> {
  if (!isTauri()) {
    throw new InstallationCatalogError(
      "catalog-unavailable",
      "Native installation storage requires the Tauri runtime.",
    );
  }
  return parseNativeStatus(
    await invoke<NativeInstallationStorageStatus>(
      "native_installation_storage_status",
    ),
  );
}

export type { InstallationCatalogReader, NativeInstallationStorageError };
