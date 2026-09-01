import type { EncryptionPublicKey } from "@cantrip/protocol/encryption";

export const installationCatalogSchemaVersion = 1 as const;
export const installationDeviceKeyVersion = 1 as const;

export type ClientDeviceKeyCustodyBackend =
  | "android-keystore"
  | "apple-keychain"
  | "browser-webcrypto"
  | "development-file-vault"
  | "linux-secret-service"
  | "memory"
  | "stronghold"
  | "windows-protected-storage";

export type InstallationProfile = {
  createdAt: string;
  installationId: string;
  schemaVersion: typeof installationCatalogSchemaVersion;
};

export type InstallationDeviceKey = {
  createdAt: string;
  installationId: string;
  keyAlias: string;
  provider: ClientDeviceKeyCustodyBackend;
  publicKey: EncryptionPublicKey;
  status: "active" | "retired";
  version: typeof installationDeviceKeyVersion;
};

export type InstallationAccountBinding = {
  grantRevision: number;
  keyAlias: string;
  masterKeyRevision: number;
  ownerId: string;
  principalId: string;
  serverId: string;
  updatedAt: string;
};

export type InstallationMigrationState =
  "failed" | "in-progress" | "pending" | "verified";

export type InstallationMigration = {
  completedAt: string | null;
  migrationId: string;
  startedAt: string | null;
  state: InstallationMigrationState;
  verificationState: string | null;
};

export type InstallationCatalogErrorCode =
  | "account-binding-invalid"
  | "catalog-corrupt"
  | "catalog-unavailable"
  | "device-key-invalid"
  | "installation-conflict"
  | "installation-invalid"
  | "installation-missing"
  | "migration-invalid"
  | "transaction-conflict";

export class InstallationCatalogError extends Error {
  constructor(
    readonly code: InstallationCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InstallationCatalogError";
  }
}

export interface InstallationCatalogReader {
  getAccountBinding(
    serverId: string,
    ownerId: string,
  ): Promise<InstallationAccountBinding | null>;
  getDeviceKey(keyAlias: string): Promise<InstallationDeviceKey | null>;
  getInstallation(): Promise<InstallationProfile | null>;
  getMigration(migrationId: string): Promise<InstallationMigration | null>;
  listAccountBindings(): Promise<InstallationAccountBinding[]>;
}

export interface InstallationCatalogTransaction extends InstallationCatalogReader {
  createInstallation(
    profile: InstallationProfile,
  ): Promise<InstallationProfile>;
  putAccountBinding(binding: InstallationAccountBinding): Promise<void>;
  putDeviceKey(deviceKey: InstallationDeviceKey): Promise<void>;
  replaceDeviceKey(deviceKey: InstallationDeviceKey): Promise<void>;
  putMigration(migration: InstallationMigration): Promise<void>;
}

export interface InstallationCatalog extends InstallationCatalogReader {
  transaction<T>(
    operation: (transaction: InstallationCatalogTransaction) => Promise<T>,
  ): Promise<T>;
}

type InstallationCatalogState = {
  accountBindings: Map<string, InstallationAccountBinding>;
  deviceKeys: Map<string, InstallationDeviceKey>;
  installation: InstallationProfile | null;
  migrations: Map<string, InstallationMigration>;
};

export type InstallationCatalogRecords = {
  accountBindings: InstallationAccountBinding[];
  deviceKeys: InstallationDeviceKey[];
  installation: InstallationProfile | null;
  migrations: InstallationMigration[];
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function validateIdentifier(
  value: string,
  label: string,
  code: InstallationCatalogErrorCode,
): void {
  if (!value || value.length > 255) {
    throw new InstallationCatalogError(
      code,
      `${label} must contain between 1 and 255 characters.`,
    );
  }
}

function validateTimestamp(
  value: string | null,
  code: InstallationCatalogErrorCode,
  label: string,
): void {
  if (value !== null && !Number.isFinite(Date.parse(value))) {
    throw new InstallationCatalogError(
      code,
      `${label} must be an ISO timestamp.`,
    );
  }
}

function validateInstallation(profile: InstallationProfile): void {
  if (
    profile.schemaVersion !== installationCatalogSchemaVersion ||
    !uuidPattern.test(profile.installationId)
  ) {
    throw new InstallationCatalogError(
      "installation-invalid",
      "The installation profile has an invalid version or identifier.",
    );
  }
  validateTimestamp(profile.createdAt, "installation-invalid", "createdAt");
}

function validateDeviceKey(
  state: InstallationCatalogState,
  deviceKey: InstallationDeviceKey,
): void {
  if (!state.installation) {
    throw new InstallationCatalogError(
      "installation-missing",
      "Create the installation before storing its device key.",
    );
  }
  if (
    deviceKey.version !== installationDeviceKeyVersion ||
    deviceKey.installationId !== state.installation.installationId ||
    deviceKey.keyAlias !== installationKeyAlias(deviceKey.installationId)
  ) {
    throw new InstallationCatalogError(
      "device-key-invalid",
      "The device key does not belong to the active installation.",
    );
  }
  validateTimestamp(deviceKey.createdAt, "device-key-invalid", "createdAt");
}

function validateAccountBinding(
  state: InstallationCatalogState,
  binding: InstallationAccountBinding,
): void {
  validateIdentifier(binding.serverId, "serverId", "account-binding-invalid");
  validateIdentifier(binding.ownerId, "ownerId", "account-binding-invalid");
  validateIdentifier(
    binding.principalId,
    "principalId",
    "account-binding-invalid",
  );
  if (
    !Number.isInteger(binding.grantRevision) ||
    binding.grantRevision < 1 ||
    !Number.isInteger(binding.masterKeyRevision) ||
    binding.masterKeyRevision < 1 ||
    state.deviceKeys.get(binding.keyAlias)?.status !== "active"
  ) {
    throw new InstallationCatalogError(
      "account-binding-invalid",
      "An account binding requires an active installation key and grant revision.",
    );
  }
  validateTimestamp(binding.updatedAt, "account-binding-invalid", "updatedAt");
}

function validateMigration(migration: InstallationMigration): void {
  validateIdentifier(migration.migrationId, "migrationId", "migration-invalid");
  validateTimestamp(migration.startedAt, "migration-invalid", "startedAt");
  validateTimestamp(migration.completedAt, "migration-invalid", "completedAt");
  if (
    migration.state === "verified" &&
    (!migration.startedAt ||
      !migration.completedAt ||
      !migration.verificationState)
  ) {
    throw new InstallationCatalogError(
      "migration-invalid",
      "A verified migration requires start, completion, and verification records.",
    );
  }
}

export function validateInstallationCatalogRecords(
  records: InstallationCatalogRecords,
): void {
  const state: InstallationCatalogState = {
    accountBindings: new Map(),
    deviceKeys: new Map(),
    installation: records.installation ? { ...records.installation } : null,
    migrations: new Map(),
  };
  if (
    !state.installation &&
    (records.deviceKeys.length > 0 ||
      records.accountBindings.length > 0 ||
      records.migrations.length > 0)
  ) {
    throw new InstallationCatalogError(
      "catalog-corrupt",
      "Installation metadata cannot exist without an installation profile.",
    );
  }
  if (state.installation) validateInstallation(state.installation);
  for (const deviceKey of records.deviceKeys) {
    if (state.deviceKeys.has(deviceKey.keyAlias)) {
      throw new InstallationCatalogError(
        "catalog-corrupt",
        "The installation catalog contains duplicate device keys.",
      );
    }
    validateDeviceKey(state, deviceKey);
    state.deviceKeys.set(deviceKey.keyAlias, cloneDeviceKey(deviceKey));
  }
  for (const binding of records.accountBindings) {
    const key = accountBindingKey(binding.serverId, binding.ownerId);
    if (state.accountBindings.has(key)) {
      throw new InstallationCatalogError(
        "catalog-corrupt",
        "The installation catalog contains duplicate account bindings.",
      );
    }
    validateAccountBinding(state, binding);
    state.accountBindings.set(key, { ...binding });
  }
  for (const migration of records.migrations) {
    if (state.migrations.has(migration.migrationId)) {
      throw new InstallationCatalogError(
        "catalog-corrupt",
        "The installation catalog contains duplicate migrations.",
      );
    }
    validateMigration(migration);
    state.migrations.set(migration.migrationId, { ...migration });
  }
}

function cloneDeviceKey(
  deviceKey: InstallationDeviceKey,
): InstallationDeviceKey {
  return { ...deviceKey, publicKey: { ...deviceKey.publicKey } };
}

function accountBindingKey(serverId: string, ownerId: string): string {
  return JSON.stringify([installationCatalogSchemaVersion, serverId, ownerId]);
}

function cloneState(state: InstallationCatalogState): InstallationCatalogState {
  return {
    accountBindings: new Map(
      [...state.accountBindings].map(([key, value]) => [key, { ...value }]),
    ),
    deviceKeys: new Map(
      [...state.deviceKeys].map(([key, value]) => [key, cloneDeviceKey(value)]),
    ),
    installation: state.installation ? { ...state.installation } : null,
    migrations: new Map(
      [...state.migrations].map(([key, value]) => [key, { ...value }]),
    ),
  };
}

class MemoryInstallationCatalogTransaction implements InstallationCatalogTransaction {
  constructor(private readonly state: InstallationCatalogState) {}

  async createInstallation(
    profile: InstallationProfile,
  ): Promise<InstallationProfile> {
    validateInstallation(profile);
    if (
      this.state.installation &&
      this.state.installation.installationId !== profile.installationId
    ) {
      throw new InstallationCatalogError(
        "installation-conflict",
        "This catalog already belongs to another installation.",
      );
    }
    this.state.installation ??= { ...profile };
    return { ...this.state.installation };
  }

  async getAccountBinding(
    serverId: string,
    ownerId: string,
  ): Promise<InstallationAccountBinding | null> {
    const binding = this.state.accountBindings.get(
      accountBindingKey(serverId, ownerId),
    );
    return binding ? { ...binding } : null;
  }

  async getDeviceKey(keyAlias: string): Promise<InstallationDeviceKey | null> {
    const deviceKey = this.state.deviceKeys.get(keyAlias);
    return deviceKey ? cloneDeviceKey(deviceKey) : null;
  }

  async getInstallation(): Promise<InstallationProfile | null> {
    return this.state.installation ? { ...this.state.installation } : null;
  }

  async getMigration(
    migrationId: string,
  ): Promise<InstallationMigration | null> {
    const migration = this.state.migrations.get(migrationId);
    return migration ? { ...migration } : null;
  }

  async listAccountBindings(): Promise<InstallationAccountBinding[]> {
    return [...this.state.accountBindings.values()].map((binding) => ({
      ...binding,
    }));
  }

  async putAccountBinding(binding: InstallationAccountBinding): Promise<void> {
    validateAccountBinding(this.state, binding);
    this.state.accountBindings.set(
      accountBindingKey(binding.serverId, binding.ownerId),
      { ...binding },
    );
  }

  async putDeviceKey(deviceKey: InstallationDeviceKey): Promise<void> {
    validateDeviceKey(this.state, deviceKey);
    this.state.deviceKeys.set(deviceKey.keyAlias, cloneDeviceKey(deviceKey));
  }

  async replaceDeviceKey(deviceKey: InstallationDeviceKey): Promise<void> {
    validateDeviceKey(this.state, deviceKey);
    const existing = this.state.deviceKeys.get(deviceKey.keyAlias);
    if (
      !existing ||
      existing.installationId !== deviceKey.installationId ||
      existing.provider !== deviceKey.provider ||
      existing.version !== deviceKey.version
    ) {
      throw new InstallationCatalogError(
        "device-key-invalid",
        "Only matching cataloged installation key metadata can be replaced.",
      );
    }
    this.state.deviceKeys.set(deviceKey.keyAlias, cloneDeviceKey(deviceKey));
  }

  async putMigration(migration: InstallationMigration): Promise<void> {
    validateMigration(migration);
    this.state.migrations.set(migration.migrationId, { ...migration });
  }
}

export class MemoryInstallationCatalog implements InstallationCatalog {
  private state: InstallationCatalogState = {
    accountBindings: new Map(),
    deviceKeys: new Map(),
    installation: null,
    migrations: new Map(),
  };

  private transactionQueue: Promise<void> = Promise.resolve();

  getAccountBinding(
    serverId: string,
    ownerId: string,
  ): Promise<InstallationAccountBinding | null> {
    return new MemoryInstallationCatalogTransaction(
      this.state,
    ).getAccountBinding(serverId, ownerId);
  }

  getDeviceKey(keyAlias: string): Promise<InstallationDeviceKey | null> {
    return new MemoryInstallationCatalogTransaction(this.state).getDeviceKey(
      keyAlias,
    );
  }

  getInstallation(): Promise<InstallationProfile | null> {
    return new MemoryInstallationCatalogTransaction(
      this.state,
    ).getInstallation();
  }

  getMigration(migrationId: string): Promise<InstallationMigration | null> {
    return new MemoryInstallationCatalogTransaction(this.state).getMigration(
      migrationId,
    );
  }

  listAccountBindings(): Promise<InstallationAccountBinding[]> {
    return new MemoryInstallationCatalogTransaction(
      this.state,
    ).listAccountBindings();
  }

  transaction<T>(
    operation: (transaction: InstallationCatalogTransaction) => Promise<T>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const draft = cloneState(this.state);
      const result = await operation(
        new MemoryInstallationCatalogTransaction(draft),
      );
      this.state = draft;
      return result;
    };
    const result = this.transactionQueue.then(run, run);
    this.transactionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function installationKeyAlias(installationId: string): string {
  if (!uuidPattern.test(installationId)) {
    throw new InstallationCatalogError(
      "installation-invalid",
      "The installation identifier must be a canonical lowercase UUID.",
    );
  }
  return `cantrip.installation.${installationId}.hpke.v1`;
}
