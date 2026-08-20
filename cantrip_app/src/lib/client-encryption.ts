import {
  bytesEqual,
  clearSensitiveBytes,
  deriveComponentKey as deriveCryptoComponentKey,
  exportHpkePublicKey,
  generateHpkeKeyPair,
  importHpkePublicKey,
  unwrapAccountMasterKeyForClient,
  unwrapAccountMasterKeyWithPassword,
  wrapAccountMasterKeyForClient,
  wrapAccountMasterKeyWithPassword,
} from "@cantrip/crypto";
import {
  clientMasterKeyWrapperSchema,
  encryptionKeyGrantSchema,
  encryptionPrincipalSchema,
  encryptionPublicKeySchema,
  passwordWrappedMasterKeySchema,
  type ClientMasterKeyWrapper,
  type EncryptionComponentScope,
  type EncryptionKeyGrant,
  type EncryptionPrincipal,
  type EncryptionPublicKey,
  type PasswordKdfParameters,
  type PasswordWrappedMasterKey,
} from "@cantrip/protocol/encryption";

import { clientLogger, operationalErrorMetadata } from "./client-log-relay";

const deviceDatabaseName = "cantrip-client-encryption";
const deviceDatabaseVersion = 1;
const deviceObjectStoreName = "device-keys";

export type ClientEncryptionIdentity = {
  ownerId: string;
  serverId: string;
};

export type StoredClientDeviceRecord = {
  clientId: string;
  createdAt: string;
  ownerId: string;
  privateKey: CryptoKey;
  publicKey: EncryptionPublicKey;
  serverId: string;
  version: 1;
};

export type ClientDeviceDescriptor = Omit<
  StoredClientDeviceRecord,
  "privateKey"
>;

export interface ClientDeviceKeyStore {
  delete(identity: ClientEncryptionIdentity): Promise<void>;
  load(identity: ClientEncryptionIdentity): Promise<unknown | null>;
  save(record: StoredClientDeviceRecord): Promise<void>;
}

export type ClientEncryptionStatus =
  | "corrupt"
  | "locked"
  | "ready"
  | "revoked"
  | "unavailable"
  | "unsupported-version";

export type ClientEncryptionSnapshot = {
  clientId: string | null;
  identity: ClientEncryptionIdentity | null;
  masterKeyRevision: number | null;
  status: ClientEncryptionStatus;
};

export type ClientEncryptionErrorCode =
  | "corrupt-device-record"
  | "decryption-failed"
  | "device-not-found"
  | "identity-mismatch"
  | "locked"
  | "principal-unavailable"
  | "storage-unavailable"
  | "unsupported-version";

export class ClientEncryptionError extends Error {
  constructor(
    readonly code: ClientEncryptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClientEncryptionError";
  }
}

export class IndexedDbClientDeviceKeyStore implements ClientDeviceKeyStore {
  constructor(
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
  ) {}

  async delete(identity: ClientEncryptionIdentity): Promise<void> {
    const database = await this.open();
    try {
      await completeRequest(database, "readwrite", (store) =>
        store.delete(deviceStorageKey(identity)),
      );
    } finally {
      database.close();
    }
  }

  async load(identity: ClientEncryptionIdentity): Promise<unknown | null> {
    const database = await this.open();
    try {
      return (
        (await completeRequest(database, "readonly", (store) =>
          store.get(deviceStorageKey(identity)),
        )) ?? null
      );
    } finally {
      database.close();
    }
  }

  async save(record: StoredClientDeviceRecord): Promise<void> {
    const database = await this.open();
    try {
      await completeRequest(database, "readwrite", (store) =>
        store.put(record, deviceStorageKey(record)),
      );
    } finally {
      database.close();
    }
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!this.factory) {
        reject(
          new ClientEncryptionError(
            "storage-unavailable",
            "Secure browser device storage is unavailable.",
          ),
        );
        return;
      }
      const request = this.factory.open(
        deviceDatabaseName,
        deviceDatabaseVersion,
      );
      request.onerror = () =>
        reject(
          new ClientEncryptionError(
            "storage-unavailable",
            "Secure browser device storage could not be opened.",
          ),
        );
      request.onblocked = () =>
        reject(
          new ClientEncryptionError(
            "storage-unavailable",
            "Secure browser device storage is blocked by another session.",
          ),
        );
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(deviceObjectStoreName)) {
          request.result.createObjectStore(deviceObjectStoreName);
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }
}

function completeRequest<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  createRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(deviceObjectStoreName, mode);
    const request = createRequest(
      transaction.objectStore(deviceObjectStoreName),
    );
    let result: T;
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      result = request.result;
    };
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve(result);
  });
}

function deviceStorageKey(identity: ClientEncryptionIdentity): string {
  validateIdentity(identity);
  return JSON.stringify([1, identity.serverId, identity.ownerId]);
}

function validateIdentity(identity: ClientEncryptionIdentity): void {
  if (
    !identity.serverId ||
    identity.serverId.length > 255 ||
    !identity.ownerId ||
    identity.ownerId.length > 255
  ) {
    throw new ClientEncryptionError(
      "identity-mismatch",
      "Encryption identity is invalid.",
    );
  }
}

function sameIdentity(
  left: ClientEncryptionIdentity | null,
  right: ClientEncryptionIdentity,
): boolean {
  return left?.serverId === right.serverId && left.ownerId === right.ownerId;
}

function isOpaquePrivateKeyHandle(value: unknown): value is CryptoKey {
  // WebKit may restore a usable CryptoKey from IndexedDB without preserving a
  // stable JS descriptor/prototype shape. Treat it as an opaque native handle;
  // the HPKE unwrap operation is the authoritative compatibility check and
  // still fails closed for a wrong, malformed, or unusable key.
  return Boolean(value && typeof value === "object");
}

type DeviceRecordRejectionReason =
  | "client-id-invalid"
  | "created-at-invalid"
  | "owner-binding-mismatch"
  | "private-key-handle-missing"
  | "public-key-invalid"
  | "record-invalid"
  | "server-binding-mismatch"
  | "unsupported-version"
  | "version-missing";

function deviceRecordRejectionReason(
  raw: unknown,
  identity: ClientEncryptionIdentity,
): DeviceRecordRejectionReason | null {
  if (!raw || typeof raw !== "object") return "record-invalid";
  const record = raw as Partial<StoredClientDeviceRecord>;
  if ("version" in raw && record.version !== 1) {
    return "unsupported-version";
  }
  if (record.version !== 1) return "version-missing";
  if (record.serverId !== identity.serverId) return "server-binding-mismatch";
  if (record.ownerId !== identity.ownerId) return "owner-binding-mismatch";
  if (
    typeof record.clientId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record.clientId,
    )
  ) {
    return "client-id-invalid";
  }
  if (
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    return "created-at-invalid";
  }
  if (!encryptionPublicKeySchema.safeParse(record.publicKey).success) {
    return "public-key-invalid";
  }
  if (!isOpaquePrivateKeyHandle(record.privateKey)) {
    return "private-key-handle-missing";
  }
  return null;
}

function logDeviceRecordRejection(
  raw: unknown,
  identity: ClientEncryptionIdentity,
  operation: "load-device" | "load-device-key",
  error: unknown,
): void {
  clientLogger.warn("Stored client encryption device key was rejected", {
    ...operationalErrorMetadata(error),
    event: "encryption.device-record.rejected",
    operation,
    reasonCode:
      deviceRecordRejectionReason(raw, identity) ?? "record-parse-failed",
    status: "rejected",
    subsystem: "encryption",
  });
}

function parseDeviceRecord(
  raw: unknown,
  identity: ClientEncryptionIdentity,
): StoredClientDeviceRecord {
  const rejectionReason = deviceRecordRejectionReason(raw, identity);
  if (rejectionReason === "unsupported-version") {
    throw new ClientEncryptionError(
      "unsupported-version",
      "This device key uses an unsupported encryption format. Update Cantrip to continue.",
    );
  }
  if (rejectionReason) {
    throw new ClientEncryptionError(
      "corrupt-device-record",
      "This device key is corrupt or belongs to another server or account.",
    );
  }
  const record = raw as StoredClientDeviceRecord;
  return {
    clientId: record.clientId,
    createdAt: record.createdAt,
    ownerId: record.ownerId,
    privateKey: record.privateKey,
    publicKey: encryptionPublicKeySchema.parse(record.publicKey),
    serverId: record.serverId,
    version: 1,
  };
}

function descriptor(record: StoredClientDeviceRecord): ClientDeviceDescriptor {
  const { privateKey: _privateKey, ...publicRecord } = record;
  return publicRecord;
}

function assertSupportedWrapperVersion(value: unknown): void {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    (value as { version?: unknown }).version !== 1
  ) {
    throw new ClientEncryptionError(
      "unsupported-version",
      "This key envelope uses an unsupported encryption format. Update Cantrip to continue.",
    );
  }
}

function initialSnapshot(): ClientEncryptionSnapshot {
  return {
    clientId: null,
    identity: null,
    masterKeyRevision: null,
    status: "locked",
  };
}

export class ClientEncryptionService {
  private accountMasterKey: Uint8Array | null = null;
  private readonly componentKeys = new Map<string, Uint8Array>();
  private readonly listeners = new Set<() => void>();
  private snapshot = initialSnapshot();

  constructor(
    private readonly deviceStore: ClientDeviceKeyStore = new IndexedDbClientDeviceKeyStore(),
  ) {}

  getSnapshot = (): ClientEncryptionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async ensureDevice(
    identity: ClientEncryptionIdentity,
  ): Promise<ClientDeviceDescriptor> {
    this.requireCrypto();
    const existing = await this.loadDevice(identity);
    if (existing) return existing;
    const keyPair = await generateHpkeKeyPair(false);
    if (keyPair.privateKey.extractable) {
      throw this.fail(
        "unavailable",
        identity,
        null,
        "storage-unavailable",
        "This runtime cannot create a nonextractable device key.",
      );
    }
    const record: StoredClientDeviceRecord = {
      clientId: globalThis.crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ownerId: identity.ownerId,
      privateKey: keyPair.privateKey,
      publicKey: await exportHpkePublicKey(keyPair.publicKey),
      serverId: identity.serverId,
      version: 1,
    };
    try {
      await this.deviceStore.save(record);
    } catch (error) {
      throw this.storageFailure(error, identity);
    }
    this.publish({
      clientId: record.clientId,
      identity: { ...identity },
      masterKeyRevision: null,
      status: "locked",
    });
    return descriptor(record);
  }

  async loadDevice(
    identity: ClientEncryptionIdentity,
  ): Promise<ClientDeviceDescriptor | null> {
    this.requireCrypto();
    validateIdentity(identity);
    let raw: unknown | null;
    try {
      raw = await this.deviceStore.load(identity);
    } catch (error) {
      throw this.storageFailure(error, identity);
    }
    if (raw === null) {
      clientLogger.info("No stored client encryption device key was found", {
        event: "encryption.device-record.missing",
        operation: "load-device",
        reasonCode: "device-record-missing",
        status: "missing",
        subsystem: "encryption",
      });
      this.clearKeyMaterial();
      this.publish({
        clientId: null,
        identity: { ...identity },
        masterKeyRevision: null,
        status: "locked",
      });
      return null;
    }
    let record: StoredClientDeviceRecord;
    try {
      record = parseDeviceRecord(raw, identity);
    } catch (error) {
      logDeviceRecordRejection(raw, identity, "load-device", error);
      if (
        error instanceof ClientEncryptionError &&
        error.code === "unsupported-version"
      ) {
        throw this.fail(
          "unsupported-version",
          identity,
          null,
          error.code,
          error.message,
        );
      }
      throw this.fail(
        "corrupt",
        identity,
        null,
        "corrupt-device-record",
        error instanceof Error ? error.message : "Device key is corrupt.",
      );
    }
    const preservesReadyKey =
      sameIdentity(this.snapshot.identity, identity) &&
      this.snapshot.status === "ready" &&
      this.snapshot.clientId === record.clientId &&
      this.accountMasterKey !== null;
    if (preservesReadyKey) {
      return descriptor(record);
    }
    this.clearKeyMaterial();
    this.publish({
      clientId: record.clientId,
      identity: { ...identity },
      masterKeyRevision: null,
      status: "locked",
    });
    return descriptor(record);
  }

  async replaceDevice(
    identity: ClientEncryptionIdentity,
  ): Promise<ClientDeviceDescriptor> {
    this.requireCrypto();
    validateIdentity(identity);
    this.lock();
    try {
      await this.deviceStore.delete(identity);
    } catch (error) {
      throw this.storageFailure(error, identity);
    }
    return this.ensureDevice(identity);
  }

  setAccountMasterKey(input: {
    accountMasterKey: Uint8Array;
    identity: ClientEncryptionIdentity;
    masterKeyRevision: number;
  }): void {
    this.requireCrypto();
    validateIdentity(input.identity);
    if (input.accountMasterKey.byteLength !== 32) {
      throw new ClientEncryptionError(
        "decryption-failed",
        "Account Master Key must contain exactly 32 bytes.",
      );
    }
    if (
      !Number.isInteger(input.masterKeyRevision) ||
      input.masterKeyRevision < 1
    ) {
      throw new ClientEncryptionError(
        "unsupported-version",
        "Account Master Key revision is invalid.",
      );
    }
    this.clearKeyMaterial();
    this.accountMasterKey = new Uint8Array(input.accountMasterKey);
    this.publish({
      clientId: sameIdentity(this.snapshot.identity, input.identity)
        ? this.snapshot.clientId
        : null,
      identity: { ...input.identity },
      masterKeyRevision: input.masterKeyRevision,
      status: "ready",
    });
  }

  async unlockWithDevice(input: {
    grant: EncryptionKeyGrant;
    identity: ClientEncryptionIdentity;
    principal: EncryptionPrincipal;
  }): Promise<void> {
    this.requireCrypto();
    validateIdentity(input.identity);
    let principal: EncryptionPrincipal;
    let grant: EncryptionKeyGrant;
    try {
      assertSupportedWrapperVersion(input.grant.wrappedKey);
      principal = encryptionPrincipalSchema.parse(input.principal);
      grant = encryptionKeyGrantSchema.parse(input.grant);
    } catch (error) {
      if (error instanceof ClientEncryptionError) {
        throw this.fail(
          "unsupported-version",
          input.identity,
          null,
          error.code,
          error.message,
        );
      }
      throw this.fail(
        "corrupt",
        input.identity,
        null,
        "corrupt-device-record",
        "The server returned malformed device authorization data.",
      );
    }
    if (principal.state === "revoked") {
      throw this.fail(
        "revoked",
        input.identity,
        principal.id,
        "principal-unavailable",
        "This device authorization was revoked.",
      );
    }
    if (grant.state === "revoked") {
      throw this.fail(
        "revoked",
        input.identity,
        principal.id,
        "principal-unavailable",
        "This device key grant was revoked.",
      );
    }
    if (
      principal.state !== "approved" ||
      principal.kind !== "client" ||
      principal.ownerId !== input.identity.ownerId ||
      grant.ownerId !== input.identity.ownerId ||
      grant.principalId !== principal.id ||
      grant.component !== "account-master-key" ||
      grant.wrappedKey.purpose !== "client-account-master-key"
    ) {
      throw this.fail(
        "locked",
        input.identity,
        principal.id,
        "principal-unavailable",
        "This device does not have an active Account Master Key grant.",
      );
    }
    const raw = await this.loadRawDevice(input.identity);
    if (
      raw.clientId !== principal.id ||
      JSON.stringify(raw.publicKey) !== JSON.stringify(principal.publicKey)
    ) {
      clientLogger.warn(
        "Stored device key does not match its server authorization",
        {
          event: "encryption.device.authorization-mismatch",
          operation: "unlock-device-key",
          reasonCode: "device-registration-mismatch",
          status: "rejected",
          subsystem: "encryption",
        },
      );
      throw this.fail(
        "corrupt",
        input.identity,
        raw.clientId,
        "identity-mismatch",
        "The stored device key does not match its server authorization.",
      );
    }
    let accountMasterKey: Uint8Array | null = null;
    try {
      accountMasterKey = await unwrapAccountMasterKeyForClient({
        ownerId: input.identity.ownerId,
        wrapper: clientMasterKeyWrapperSchema.parse(grant.wrappedKey),
        clientKeyPair: {
          privateKey: raw.privateKey,
          publicKey: await importHpkePublicKey(raw.publicKey),
        },
      });
      this.setAccountMasterKey({
        accountMasterKey,
        identity: input.identity,
        masterKeyRevision: grant.keyRevision,
      });
      this.publish({ ...this.snapshot, clientId: raw.clientId });
    } catch (error) {
      clientLogger.warn("Client device key could not unwrap the account key", {
        ...operationalErrorMetadata(error),
        event: "encryption.device.unlock.failed",
        operation: "unlock-device-key",
        reasonCode: "device-key-unwrapping-failed",
        status: "locked",
        subsystem: "encryption",
      });
      throw this.fail(
        "locked",
        input.identity,
        raw.clientId,
        "decryption-failed",
        "The device could not unlock the Account Master Key.",
      );
    } finally {
      if (accountMasterKey) clearSensitiveBytes(accountMasterKey);
    }
  }

  async unlockWithPassword(input: {
    identity: ClientEncryptionIdentity;
    password: string;
    wrapper: PasswordWrappedMasterKey;
  }): Promise<void> {
    this.requireCrypto();
    validateIdentity(input.identity);
    let accountMasterKey: Uint8Array | null = null;
    try {
      assertSupportedWrapperVersion(input.wrapper);
      const wrapper = passwordWrappedMasterKeySchema.parse(input.wrapper);
      accountMasterKey = await unwrapAccountMasterKeyWithPassword({
        password: input.password,
        ownerId: input.identity.ownerId,
        wrapper,
      });
      this.setAccountMasterKey({
        accountMasterKey,
        identity: input.identity,
        masterKeyRevision: wrapper.masterKeyRevision,
      });
    } catch (error) {
      if (
        error instanceof ClientEncryptionError &&
        error.code === "unsupported-version"
      ) {
        throw this.fail(
          "unsupported-version",
          input.identity,
          null,
          error.code,
          error.message,
        );
      }
      throw this.fail(
        "locked",
        input.identity,
        null,
        "decryption-failed",
        "The password could not unlock the Account Master Key.",
      );
    } finally {
      if (accountMasterKey) clearSensitiveBytes(accountMasterKey);
    }
  }

  async createPasswordWrapper(input: {
    identity: ClientEncryptionIdentity;
    password: string;
    kdf?: PasswordKdfParameters;
  }): Promise<PasswordWrappedMasterKey> {
    const accountMasterKey = this.requireUnlocked(input.identity);
    const wrapper = await wrapAccountMasterKeyWithPassword({
      password: input.password,
      ownerId: input.identity.ownerId,
      accountMasterKey,
      masterKeyRevision: this.snapshot.masterKeyRevision!,
      kdf: input.kdf,
    });
    const verified = await unwrapAccountMasterKeyWithPassword({
      password: input.password,
      ownerId: input.identity.ownerId,
      wrapper,
    });
    try {
      if (!bytesEqual(verified, accountMasterKey)) {
        throw new ClientEncryptionError(
          "decryption-failed",
          "The replacement password wrapper failed local verification.",
        );
      }
      return wrapper;
    } finally {
      clearSensitiveBytes(verified);
    }
  }

  async createDeviceWrapper(
    identity: ClientEncryptionIdentity,
  ): Promise<ClientMasterKeyWrapper> {
    const accountMasterKey = this.requireUnlocked(identity);
    const device = await this.loadRawDevice(identity);
    return wrapAccountMasterKeyForClient({
      ownerId: identity.ownerId,
      clientId: device.clientId,
      accountMasterKey,
      masterKeyRevision: this.snapshot.masterKeyRevision!,
      clientPublicKey: device.publicKey,
    });
  }

  componentKey(input: {
    component: EncryptionComponentScope;
    identity: ClientEncryptionIdentity;
    keyRevision: number;
  }): Uint8Array {
    const accountMasterKey = this.requireUnlocked(input.identity);
    const cacheKey = `${input.component}:${input.keyRevision}`;
    let key = this.componentKeys.get(cacheKey);
    if (!key) {
      key = deriveCryptoComponentKey({
        accountMasterKey,
        ownerId: input.identity.ownerId,
        component: input.component,
        keyRevision: input.keyRevision,
      });
      this.componentKeys.set(cacheKey, key);
    }
    return new Uint8Array(key);
  }

  lock(): void {
    this.clearKeyMaterial();
    this.publish(initialSnapshot());
  }

  private async loadRawDevice(
    identity: ClientEncryptionIdentity,
  ): Promise<StoredClientDeviceRecord> {
    let raw: unknown | null;
    try {
      raw = await this.deviceStore.load(identity);
    } catch (error) {
      throw this.storageFailure(error, identity);
    }
    if (raw === null) {
      clientLogger.warn("Stored client encryption device key was not found", {
        event: "encryption.device-record.missing",
        operation: "load-device-key",
        reasonCode: "device-record-missing",
        status: "missing",
        subsystem: "encryption",
      });
      throw this.fail(
        "locked",
        identity,
        null,
        "device-not-found",
        "This browser does not have a device key for the current account.",
      );
    }
    try {
      return parseDeviceRecord(raw, identity);
    } catch (error) {
      logDeviceRecordRejection(raw, identity, "load-device-key", error);
      if (
        error instanceof ClientEncryptionError &&
        error.code === "unsupported-version"
      ) {
        throw this.fail(
          "unsupported-version",
          identity,
          null,
          error.code,
          error.message,
        );
      }
      throw this.fail(
        "corrupt",
        identity,
        null,
        "corrupt-device-record",
        error instanceof Error ? error.message : "Device key is corrupt.",
      );
    }
  }

  private requireCrypto(): void {
    if (!globalThis.crypto?.subtle || !globalThis.crypto.randomUUID) {
      throw this.fail(
        "unavailable",
        null,
        null,
        "storage-unavailable",
        "This runtime does not support the required WebCrypto APIs.",
      );
    }
  }

  private requireUnlocked(identity: ClientEncryptionIdentity): Uint8Array {
    validateIdentity(identity);
    if (
      this.snapshot.status !== "ready" ||
      !sameIdentity(this.snapshot.identity, identity) ||
      !this.accountMasterKey
    ) {
      throw new ClientEncryptionError(
        "locked",
        "Encryption is locked for the current server and account.",
      );
    }
    return this.accountMasterKey;
  }

  private storageFailure(
    error: unknown,
    identity: ClientEncryptionIdentity,
  ): ClientEncryptionError {
    clientLogger.warn("Client encryption device storage is unavailable", {
      ...operationalErrorMetadata(error),
      event: "encryption.device-storage.failed",
      operation: "access-device-storage",
      reasonCode: "device-storage-unavailable",
      status: "unavailable",
      subsystem: "encryption",
    });
    const message =
      error instanceof ClientEncryptionError
        ? error.message
        : "Secure browser device storage is unavailable.";
    return this.fail(
      "unavailable",
      identity,
      null,
      "storage-unavailable",
      message,
    );
  }

  private fail(
    status: Exclude<ClientEncryptionStatus, "ready">,
    identity: ClientEncryptionIdentity | null,
    clientId: string | null,
    code: ClientEncryptionErrorCode,
    message: string,
  ): ClientEncryptionError {
    this.clearKeyMaterial();
    this.publish({
      clientId,
      identity: identity ? { ...identity } : null,
      masterKeyRevision: null,
      status,
    });
    return new ClientEncryptionError(code, message);
  }

  private clearKeyMaterial(): void {
    if (this.accountMasterKey) clearSensitiveBytes(this.accountMasterKey);
    this.accountMasterKey = null;
    for (const key of this.componentKeys.values()) clearSensitiveBytes(key);
    this.componentKeys.clear();
  }

  private publish(snapshot: ClientEncryptionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

type ClientEncryptionHotState = {
  clientEncryption?: ClientEncryptionService;
};

export function clientEncryptionForRuntime(
  hotState?: ClientEncryptionHotState,
): ClientEncryptionService {
  if (!hotState) return new ClientEncryptionService();
  hotState.clientEncryption ??= new ClientEncryptionService();
  return hotState.clientEncryption;
}

// Vite can replace this module without remounting the authenticated session.
// Preserve the unlocked service across that development-only replacement so
// encrypted workspace and Task actions do not suddenly observe a new, locked
// singleton. Explicit session/server lifecycle calls still lock this instance.
export const clientEncryption = clientEncryptionForRuntime(
  import.meta.hot?.data as ClientEncryptionHotState | undefined,
);

export function clearClientEncryptionMemory(): void {
  clientEncryption.lock();
}
