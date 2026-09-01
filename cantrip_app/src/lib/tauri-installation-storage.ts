import { decodeBase64Url, requireByteLength } from "@cantrip/crypto";
import type { ClientMasterKeyWrapper } from "@cantrip/protocol/encryption";
import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  ClientDeviceKeyProviderError,
  type ClientDeviceKeyDescriptor,
  type ClientDeviceKeyProvider,
  type ClientDeviceKeyProviderKind,
} from "./client-device-key-provider";
import {
  InstallationCatalogError,
  installationKeyAlias,
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

const tauriCustodyBackends = new Set<
  NativeInstallationStorageStatus["provider"]
>(["apple-keychain", "linux-secret-service", "windows-protected-storage"]);

export type NativeInstallationCatalogSnapshot = {
  accountBindings: InstallationAccountBinding[];
  deviceKeys: InstallationDeviceKey[];
  installation: InstallationProfile | null;
  migrations: InstallationMigration[];
  revision: number;
  schemaVersion: number;
};

export type NativeCatalogOperation =
  | { profile: InstallationProfile; type: "create-installation" }
  | {
      binding: InstallationAccountBinding;
      type: "put-account-binding";
    }
  | { deviceKey: InstallationDeviceKey; type: "put-device-key" }
  | { migration: InstallationMigration; type: "put-migration" };

type NativeCatalogTransactionRequest = {
  expectedRevision: number;
  operations: NativeCatalogOperation[];
};

export type NativeInstallationStorageError = {
  code: string;
  message: string;
  retryable: boolean;
};

export interface NativeInstallationStorageBridge {
  readonly runtimeLabel: string;
  applyCatalogTransaction(
    request: NativeCatalogTransactionRequest,
  ): Promise<NativeInstallationCatalogSnapshot>;
  createKey(input: {
    createdAt?: string;
    installationId: string;
    keyAlias: string;
  }): Promise<ClientDeviceKeyDescriptor>;
  inspectKey(keyAlias: string): Promise<ClientDeviceKeyDescriptor | null>;
  isAvailable(): boolean;
  readCatalog(): Promise<NativeInstallationCatalogSnapshot>;
  status(): Promise<NativeInstallationStorageStatus>;
  unwrapAccountMasterKey(input: {
    keyAlias: string;
    ownerId: string;
    wrapper: ClientMasterKeyWrapper;
  }): Promise<unknown>;
}

const tauriBridge: NativeInstallationStorageBridge = {
  runtimeLabel: "Tauri",
  applyCatalogTransaction: (request) =>
    invoke<NativeInstallationCatalogSnapshot>(
      "apply_native_installation_catalog_transaction",
      { request },
    ),
  createKey: (input) =>
    invoke<ClientDeviceKeyDescriptor>("create_native_installation_key", {
      input,
    }),
  inspectKey: (keyAlias) =>
    invoke<ClientDeviceKeyDescriptor | null>(
      "inspect_native_installation_key",
      { keyAlias },
    ),
  isAvailable: isTauri,
  readCatalog: () =>
    invoke<NativeInstallationCatalogSnapshot>(
      "read_native_installation_catalog",
    ),
  status: () =>
    invoke<NativeInstallationStorageStatus>(
      "native_installation_storage_status",
    ),
  unwrapAccountMasterKey: (input) =>
    invoke<number[]>("unwrap_native_account_master_key", { input }),
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

function parseNativeStatus(
  value: NativeInstallationStorageStatus,
  allowedBackends: ReadonlySet<NativeInstallationStorageStatus["provider"]>,
) {
  if (
    value.schemaVersion !== 1 ||
    typeof value.catalogPath !== "string" ||
    value.catalogPath.length === 0 ||
    value.keyAliasFormat !==
      "cantrip.installation.<installation-uuid>.hpke.v1" ||
    !allowedBackends.has(value.provider)
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
  expected: {
    installationId?: string;
    keyAlias: string;
    provider: NativeInstallationStorageStatus["provider"];
  },
): ClientDeviceKeyDescriptor {
  let canonicalAlias: string | null = null;
  let publicKeyLength = 0;
  try {
    canonicalAlias = installationKeyAlias(value?.installationId);
    publicKeyLength = decodeBase64Url(value.publicKey?.value).byteLength;
  } catch {
    // The typed provider failure below owns the native boundary.
  }
  if (
    typeof value?.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.installationId !== "string" ||
    typeof value.keyAlias !== "string" ||
    value.keyAlias !== expected.keyAlias ||
    value.keyAlias !== canonicalAlias ||
    (expected.installationId !== undefined &&
      value.installationId !== expected.installationId) ||
    value.provider !== expected.provider ||
    value.publicKey?.algorithm !== "P-256" ||
    value.publicKey.format !== "raw" ||
    value.publicKey.version !== 1 ||
    typeof value.publicKey.value !== "string" ||
    publicKeyLength !== 65
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
    "native-device-key-invalid": "device-key-invalid",
    "native-device-key-metadata-mismatch": "device-key-invalid",
    "native-device-key-missing": "device-key-invalid",
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
    code === "client-master-key-decryption-failed" ||
    code === "client-master-key-wrapper-invalid" ||
    code === "base64url-value-invalid" ||
    code === "installation-catalog-corrupt" ||
    code === "installation-device-key-invalid" ||
    code === "installation-identifier-invalid" ||
    code === "installation-profile-invalid" ||
    code === "installation-timestamp-invalid"
  ) {
    throw new ClientDeviceKeyProviderError(
      "key-unusable",
      "The native installation key cannot unlock this account binding.",
    );
  }
  if (
    code === "native-device-key-alias-invalid" ||
    code === "native-device-key-conflict" ||
    code === "native-device-key-metadata-mismatch" ||
    code === "installation-missing"
  ) {
    throw new ClientDeviceKeyProviderError(
      "key-conflict",
      "The native installation key belongs to another installation.",
    );
  }
  if (code?.includes("unavailable") || code === "native-storage-task-failed") {
    throw new ClientDeviceKeyProviderError(
      "key-store-unavailable",
      "The operating system secure-key store is unavailable.",
    );
  }
  throw error;
}

class NativeInstallationCatalogDraft implements InstallationCatalogTransaction {
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

export class NativeInstallationCatalog implements InstallationCatalog {
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private readonly bridge: NativeInstallationStorageBridge) {}

  private async readSnapshot(): Promise<NativeInstallationCatalogSnapshot> {
    if (!this.bridge.isAvailable()) {
      throw new InstallationCatalogError(
        "catalog-unavailable",
        `Native installation storage requires the ${this.bridge.runtimeLabel} runtime.`,
      );
    }
    try {
      return cloneSnapshot(await this.bridge.readCatalog());
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
      const transaction = new NativeInstallationCatalogDraft(snapshot);
      const result = await operation(transaction);
      if (transaction.operations.length > 0) {
        try {
          await this.bridge.applyCatalogTransaction({
            expectedRevision: snapshot.revision,
            operations: transaction.operations,
          });
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

export class NativeClientDeviceKeyProvider implements ClientDeviceKeyProvider {
  protected constructor(
    private readonly bridge: NativeInstallationStorageBridge,
    readonly backend: NativeInstallationStorageStatus["provider"],
    readonly kind: ClientDeviceKeyProviderKind,
  ) {}

  protected static async openBackend(
    bridge: NativeInstallationStorageBridge,
    allowedBackends: ReadonlySet<NativeInstallationStorageStatus["provider"]>,
  ): Promise<NativeInstallationStorageStatus["provider"]> {
    if (!bridge.isAvailable()) {
      throw new ClientDeviceKeyProviderError(
        "key-store-unavailable",
        `Native key custody requires the ${bridge.runtimeLabel} runtime.`,
      );
    }
    try {
      return parseNativeStatus(await bridge.status(), allowedBackends).provider;
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
      if (installationKeyAlias(input.installationId) !== input.keyAlias) {
        throw new ClientDeviceKeyProviderError(
          "key-conflict",
          "The native installation key alias does not match the installation.",
        );
      }
      return parseNativeDescriptor(await this.bridge.createKey(input), {
        installationId: input.installationId,
        keyAlias: input.keyAlias,
        provider: this.backend,
      });
    } catch (error) {
      if (error instanceof ClientDeviceKeyProviderError) throw error;
      return mapProviderError(error);
    }
  }

  async inspect(keyAlias: string): Promise<ClientDeviceKeyDescriptor | null> {
    try {
      const value = await this.bridge.inspectKey(keyAlias);
      return value === null
        ? null
        : parseNativeDescriptor(value, {
            keyAlias,
            provider: this.backend,
          });
    } catch (error) {
      if (error instanceof ClientDeviceKeyProviderError) throw error;
      return mapProviderError(error);
    }
  }

  async unwrapAccountMasterKey(input: {
    keyAlias: string;
    ownerId: string;
    wrapper: ClientMasterKeyWrapper;
  }): Promise<Uint8Array> {
    let source: unknown = null;
    try {
      source = await this.bridge.unwrapAccountMasterKey(input);
      if (
        !Array.isArray(source) ||
        !source.every(
          (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
        )
      ) {
        throw new ClientDeviceKeyProviderError(
          "key-unusable",
          "Native installation storage returned invalid key bytes.",
        );
      }
      const accountMasterKey = Uint8Array.from(source);
      try {
        requireByteLength(accountMasterKey, 32, "Account Master Key");
      } catch {
        accountMasterKey.fill(0);
        throw new ClientDeviceKeyProviderError(
          "key-unusable",
          "Native installation storage returned an invalid Account Master Key.",
        );
      }
      return accountMasterKey;
    } catch (error) {
      if (error instanceof ClientDeviceKeyProviderError) throw error;
      return mapProviderError(error);
    } finally {
      if (Array.isArray(source)) source.fill(0);
    }
  }
}

export class TauriInstallationCatalog extends NativeInstallationCatalog {
  constructor() {
    super(tauriBridge);
  }
}

export class TauriClientDeviceKeyProvider extends NativeClientDeviceKeyProvider {
  private constructor(backend: NativeInstallationStorageStatus["provider"]) {
    super(tauriBridge, backend, "tauri-native");
  }

  static async open(): Promise<TauriClientDeviceKeyProvider> {
    return new TauriClientDeviceKeyProvider(
      await this.openBackend(tauriBridge, tauriCustodyBackends),
    );
  }
}

export async function inspectNativeInstallationStorage(): Promise<NativeInstallationStorageStatus> {
  if (!isTauri()) {
    throw new InstallationCatalogError(
      "catalog-unavailable",
      "Native installation storage requires the Tauri runtime.",
    );
  }
  return parseNativeStatus(await tauriBridge.status(), tauriCustodyBackends);
}

export type { InstallationCatalogReader };
