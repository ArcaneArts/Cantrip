import {
  bytesEqual,
  clearSensitiveBytes,
  createAnonymousRecoveryArtifact as createCryptoAnonymousRecoveryArtifact,
  deriveComponentKey as deriveCryptoComponentKey,
  exportHpkePublicKey,
  generateHpkeKeyPair,
  importHpkePublicKey,
  openAnonymousRecoveryArtifact,
  unwrapAccountMasterKeyForClient,
  unwrapAccountMasterKeyWithPassword,
  wrapAccountMasterKeyForClient,
  wrapAccountMasterKeyWithPassword,
} from "@cantrip/crypto";
import {
  anonymousRecoveryArtifactSchema,
  clientMasterKeyWrapperSchema,
  encryptionKeyGrantSchema,
  encryptionPrincipalSchema,
  encryptionPublicKeySchema,
  passwordWrappedMasterKeySchema,
  type ClientMasterKeyWrapper,
  type AnonymousRecoveryArtifact,
  type EncryptionComponentScope,
  type EncryptionKeyGrant,
  type EncryptionPrincipal,
  type EncryptionPublicKey,
  type PasswordKdfParameters,
  type PasswordWrappedMasterKey,
} from "@cantrip/protocol/encryption";

import type {
  ClientDeviceKeyDescriptor,
  ClientDeviceKeyProvider,
} from "./client-device-key-provider";
import { clientLogger, operationalErrorMetadata } from "./client-log-relay";

const legacyDeviceDatabaseName = "cantrip-client-encryption";
const legacyDeviceDatabaseVersion = 1;
const legacyDeviceObjectStoreName = "device-keys";

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

export interface LegacyClientDeviceKeyStore {
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
  | "recovery-artifact-invalid"
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

/**
 * Compatibility access to the origin-scoped device records created before the
 * installation catalog existed. Durable startup may read this store only to
 * migrate an existing Account Master Key; it is never primary key custody.
 */
export class LegacyIndexedDbClientDeviceKeyStore implements LegacyClientDeviceKeyStore {
  constructor(
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
  ) {}

  async load(identity: ClientEncryptionIdentity): Promise<unknown | null> {
    const database = await this.open(false);
    if (!database) return null;
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
    const database = await this.open(true);
    if (!database) {
      throw new ClientEncryptionError(
        "storage-unavailable",
        "Legacy browser device storage could not be created.",
      );
    }
    try {
      await completeRequest(database, "readwrite", (store) =>
        store.put(record, deviceStorageKey(record)),
      );
    } finally {
      database.close();
    }
  }

  private open(createIfMissing: boolean): Promise<IDBDatabase | null> {
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
        legacyDeviceDatabaseName,
        legacyDeviceDatabaseVersion,
      );
      let missing = false;
      request.onerror = () => {
        if (missing) {
          resolve(null);
          return;
        }
        reject(
          new ClientEncryptionError(
            "storage-unavailable",
            "Secure browser device storage could not be opened.",
          ),
        );
      };
      request.onblocked = () =>
        reject(
          new ClientEncryptionError(
            "storage-unavailable",
            "Secure browser device storage is blocked by another session.",
          ),
        );
      request.onupgradeneeded = (event) => {
        if (!createIfMissing && event.oldVersion === 0) {
          missing = true;
          request.transaction?.abort();
          return;
        }
        if (
          !request.result.objectStoreNames.contains(legacyDeviceObjectStoreName)
        ) {
          request.result.createObjectStore(legacyDeviceObjectStoreName);
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
    const transaction = database.transaction(legacyDeviceObjectStoreName, mode);
    const request = createRequest(
      transaction.objectStore(legacyDeviceObjectStoreName),
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
  private pendingLegacyDevice: StoredClientDeviceRecord | null = null;
  private snapshot = initialSnapshot();

  constructor(
    private readonly legacyDeviceStore: LegacyClientDeviceKeyStore | null = null,
  ) {}

  getSnapshot = (): ClientEncryptionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Creates a pre-installation-catalog record for compatibility fixtures. */
  async ensureLegacyDevice(
    identity: ClientEncryptionIdentity,
  ): Promise<ClientDeviceDescriptor> {
    this.requireCrypto();
    const existing = await this.loadLegacyDevice(identity);
    if (existing) return existing;
    if (!this.legacyDeviceStore) {
      throw this.storageFailure(
        new ClientEncryptionError(
          "storage-unavailable",
          "Legacy device storage was not configured.",
        ),
        identity,
      );
    }
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
      await this.legacyDeviceStore.save(record);
    } catch (error) {
      throw this.storageFailure(error, identity);
    }
    this.pendingLegacyDevice = record;
    this.publish({
      clientId: record.clientId,
      identity: { ...identity },
      masterKeyRevision: null,
      status: "locked",
    });
    return descriptor(record);
  }

  async loadLegacyDevice(
    identity: ClientEncryptionIdentity,
  ): Promise<ClientDeviceDescriptor | null> {
    this.requireCrypto();
    validateIdentity(identity);
    if (!this.legacyDeviceStore) return null;
    let raw: unknown | null;
    try {
      raw = await this.legacyDeviceStore.load(identity);
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
    this.pendingLegacyDevice = record;
    this.publish({
      clientId: record.clientId,
      identity: { ...identity },
      masterKeyRevision: null,
      status: "locked",
    });
    return descriptor(record);
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

  async unlockWithLegacyDevice(input: {
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
    const raw = await this.loadRawLegacyDevice(input.identity);
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

  async createLegacyDeviceWrapper(
    identity: ClientEncryptionIdentity,
  ): Promise<ClientMasterKeyWrapper> {
    const device = await this.loadRawLegacyDevice(identity);
    return this.createDeviceWrapperFor({
      clientId: device.clientId,
      identity,
      publicKey: device.publicKey,
    });
  }

  async createDeviceWrapperFor(input: {
    clientId: string;
    identity: ClientEncryptionIdentity;
    publicKey: EncryptionPublicKey;
  }): Promise<ClientMasterKeyWrapper> {
    const accountMasterKey = this.requireUnlocked(input.identity);
    return wrapAccountMasterKeyForClient({
      ownerId: input.identity.ownerId,
      clientId: input.clientId,
      accountMasterKey,
      masterKeyRevision: this.snapshot.masterKeyRevision!,
      clientPublicKey: encryptionPublicKeySchema.parse(input.publicKey),
    });
  }

  async unlockWithKeyProvider(input: {
    device: ClientDeviceKeyDescriptor;
    grant: EncryptionKeyGrant;
    identity: ClientEncryptionIdentity;
    principal: EncryptionPrincipal;
    provider: ClientDeviceKeyProvider;
    verifyCurrentMasterKey?: boolean;
  }): Promise<void> {
    this.requireCrypto();
    validateIdentity(input.identity);
    const principal = encryptionPrincipalSchema.parse(input.principal);
    const grant = encryptionKeyGrantSchema.parse(input.grant);
    const wrapper = clientMasterKeyWrapperSchema.parse(grant.wrappedKey);
    if (
      principal.id !== wrapper.clientId ||
      principal.id !== grant.principalId ||
      principal.ownerId !== input.identity.ownerId ||
      principal.kind !== "client" ||
      principal.state !== "approved" ||
      grant.ownerId !== input.identity.ownerId ||
      grant.state !== "active" ||
      grant.component !== "account-master-key" ||
      grant.keyRevision !== wrapper.masterKeyRevision ||
      JSON.stringify(principal.publicKey) !==
        JSON.stringify(input.device.publicKey) ||
      input.device.keyAlias.length === 0
    ) {
      const error = new ClientEncryptionError(
        "principal-unavailable",
        "The native installation key does not match its server authorization.",
      );
      if (input.verifyCurrentMasterKey) throw error;
      throw this.fail(
        "locked",
        input.identity,
        principal.id,
        error.code,
        error.message,
      );
    }

    const currentMasterKey = input.verifyCurrentMasterKey
      ? this.requireUnlocked(input.identity)
      : null;
    let accountMasterKey: Uint8Array | null = null;
    try {
      accountMasterKey = await input.provider.unwrapAccountMasterKey({
        keyAlias: input.device.keyAlias,
        ownerId: input.identity.ownerId,
        wrapper,
      });
      if (currentMasterKey && !bytesEqual(currentMasterKey, accountMasterKey)) {
        throw new ClientEncryptionError(
          "decryption-failed",
          "The native installation key did not recover the active Account Master Key.",
        );
      }
      this.setAccountMasterKey({
        accountMasterKey,
        identity: input.identity,
        masterKeyRevision: grant.keyRevision,
      });
      this.publish({ ...this.snapshot, clientId: principal.id });
    } catch (error) {
      if (!input.verifyCurrentMasterKey && accountMasterKey === null) {
        this.clearKeyMaterial();
        this.publish({
          clientId: principal.id,
          identity: { ...input.identity },
          masterKeyRevision: null,
          status: "locked",
        });
      }
      throw error;
    } finally {
      if (accountMasterKey) clearSensitiveBytes(accountMasterKey);
    }
  }

  async createAnonymousRecoveryArtifact(
    identity: ClientEncryptionIdentity,
  ): Promise<AnonymousRecoveryArtifact> {
    const accountMasterKey = this.requireUnlocked(identity);
    return createCryptoAnonymousRecoveryArtifact({
      accountMasterKey,
      masterKeyRevision: this.snapshot.masterKeyRevision!,
      ownerId: identity.ownerId,
      serverId: identity.serverId,
    });
  }

  async unlockWithAnonymousRecoveryArtifact(input: {
    artifact: unknown;
    identity: ClientEncryptionIdentity;
  }): Promise<AnonymousRecoveryArtifact> {
    this.requireCrypto();
    validateIdentity(input.identity);
    let artifact: AnonymousRecoveryArtifact;
    try {
      artifact = anonymousRecoveryArtifactSchema.parse(input.artifact);
    } catch {
      throw this.fail(
        "locked",
        input.identity,
        null,
        "recovery-artifact-invalid",
        "The anonymous recovery file is invalid or unsupported.",
      );
    }
    if (
      artifact.serverId !== input.identity.serverId ||
      artifact.ownerId !== input.identity.ownerId
    ) {
      throw this.fail(
        "locked",
        input.identity,
        null,
        "identity-mismatch",
        "The anonymous recovery file belongs to another server or account.",
      );
    }
    let accountMasterKey: Uint8Array | null = null;
    try {
      accountMasterKey = await openAnonymousRecoveryArtifact(artifact);
      this.setAccountMasterKey({
        accountMasterKey,
        identity: input.identity,
        masterKeyRevision: artifact.masterKeyRevision,
      });
      return artifact;
    } catch (error) {
      if (error instanceof ClientEncryptionError) throw error;
      throw this.fail(
        "locked",
        input.identity,
        null,
        "decryption-failed",
        "The anonymous recovery file could not unlock private data.",
      );
    } finally {
      if (accountMasterKey) clearSensitiveBytes(accountMasterKey);
    }
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

  private async loadRawLegacyDevice(
    identity: ClientEncryptionIdentity,
  ): Promise<StoredClientDeviceRecord> {
    if (
      this.pendingLegacyDevice &&
      sameIdentity(this.pendingLegacyDevice, identity)
    ) {
      return this.pendingLegacyDevice;
    }
    if (!this.legacyDeviceStore) {
      throw this.fail(
        "locked",
        identity,
        null,
        "device-not-found",
        "No legacy browser device reader is configured.",
      );
    }
    let raw: unknown | null;
    try {
      raw = await this.legacyDeviceStore.load(identity);
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
      const record = parseDeviceRecord(raw, identity);
      this.pendingLegacyDevice = record;
      return record;
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
    this.pendingLegacyDevice = null;
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
  legacyDeviceStore: LegacyClientDeviceKeyStore | null = null,
): ClientEncryptionService {
  if (!hotState) return new ClientEncryptionService(legacyDeviceStore);
  hotState.clientEncryption ??= new ClientEncryptionService(legacyDeviceStore);
  return hotState.clientEncryption;
}

// Vite can replace this module without remounting the authenticated session.
// Preserve the unlocked service across that development-only replacement so
// encrypted workspace and Task actions do not suddenly observe a new, locked
// singleton. Explicit session/server lifecycle calls still lock this instance.
export const clientEncryption = clientEncryptionForRuntime(
  import.meta.hot?.data as ClientEncryptionHotState | undefined,
  new LegacyIndexedDbClientDeviceKeyStore(),
);

export function clearClientEncryptionMemory(): void {
  clientEncryption.lock();
}
