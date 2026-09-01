import {
  exportHpkePublicKey,
  generateHpkeKeyPair,
  importHpkePublicKey,
  unwrapAccountMasterKeyForClient,
} from "@cantrip/crypto";
import {
  encryptionPublicKeySchema,
  type ClientMasterKeyWrapper,
} from "@cantrip/protocol/encryption";

import {
  ClientDeviceKeyProviderError,
  type ClientDeviceKeyDescriptor,
  type ClientDeviceKeyProvider,
} from "./client-device-key-provider";
import { clientLogger, operationalErrorMetadata } from "./client-log-relay";
import type { DurableClientEncryptionStorage } from "./durable-account-encryption";
import {
  InstallationCatalogError,
  installationKeyAlias,
  validateInstallationCatalogRecords,
  type InstallationAccountBinding,
} from "./installation-catalog";
import {
  PersistentInstallationCatalog,
  type InstallationCatalogPersistenceBridge,
  type InstallationCatalogTransactionRequest,
  type NativeInstallationCatalogSnapshot,
} from "./tauri-installation-storage";

const browserInstallationDatabaseName = "cantrip-browser-installation";
const browserInstallationDatabaseVersion = 1;
const catalogObjectStoreName = "installation-catalog";
const catalogStorageKey = "catalog-v1";
const deviceKeyObjectStoreName = "device-keys";

type StoredBrowserDeviceKey = {
  descriptor: ClientDeviceKeyDescriptor;
  privateKey: CryptoKey;
  version: 1;
};

export type BrowserStoragePersistence =
  "best-effort" | "persistent" | "unsupported";

type BrowserStorageManager = Pick<StorageManager, "persist" | "persisted">;

function emptyCatalog(): NativeInstallationCatalogSnapshot {
  return {
    accountBindings: [],
    deviceKeys: [],
    installation: null,
    migrations: [],
    revision: 0,
    schemaVersion: 1,
  };
}

function cloneCatalog(
  value: NativeInstallationCatalogSnapshot,
): NativeInstallationCatalogSnapshot {
  const snapshot = structuredClone(value);
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
      "The browser installation catalog is malformed.",
    );
  }
  validateInstallationCatalogRecords(snapshot);
  return snapshot;
}

function bindingKey(binding: InstallationAccountBinding): string {
  return JSON.stringify([binding.serverId, binding.ownerId]);
}

function applyCatalogOperations(
  current: NativeInstallationCatalogSnapshot,
  request: InstallationCatalogTransactionRequest,
): NativeInstallationCatalogSnapshot {
  if (current.revision !== request.expectedRevision) {
    throw new InstallationCatalogError(
      "transaction-conflict",
      "The browser installation catalog changed in another window.",
    );
  }
  const next = cloneCatalog(current);
  for (const operation of request.operations) {
    switch (operation.type) {
      case "create-installation":
        if (
          next.installation &&
          next.installation.installationId !== operation.profile.installationId
        ) {
          throw new InstallationCatalogError(
            "installation-conflict",
            "The browser already has another installation profile.",
          );
        }
        next.installation ??= { ...operation.profile };
        break;
      case "put-device-key":
        next.deviceKeys = [
          ...next.deviceKeys.filter(
            (entry) => entry.keyAlias !== operation.deviceKey.keyAlias,
          ),
          structuredClone(operation.deviceKey),
        ];
        break;
      case "put-account-binding": {
        const key = bindingKey(operation.binding);
        next.accountBindings = [
          ...next.accountBindings.filter((entry) => bindingKey(entry) !== key),
          { ...operation.binding },
        ];
        break;
      }
      case "put-migration":
        next.migrations = [
          ...next.migrations.filter(
            (entry) => entry.migrationId !== operation.migration.migrationId,
          ),
          { ...operation.migration },
        ];
        break;
    }
  }
  next.revision += 1;
  validateInstallationCatalogRecords(next);
  return next;
}

function parseStoredDeviceKey(
  value: unknown,
  expectedAlias: string,
): StoredBrowserDeviceKey {
  if (!value || typeof value !== "object") {
    throw new ClientDeviceKeyProviderError(
      "key-unusable",
      "The browser installation key record is malformed.",
    );
  }
  const record = value as Partial<StoredBrowserDeviceKey>;
  const descriptor = record.descriptor;
  let canonicalAlias: string | null = null;
  try {
    canonicalAlias = installationKeyAlias(descriptor?.installationId ?? "");
  } catch {
    // The typed validation failure below owns this persistence boundary.
  }
  if (
    record.version !== 1 ||
    !descriptor ||
    descriptor.keyAlias !== expectedAlias ||
    descriptor.keyAlias !== canonicalAlias ||
    descriptor.provider !== "browser-webcrypto" ||
    !Number.isFinite(Date.parse(descriptor.createdAt)) ||
    !encryptionPublicKeySchema.safeParse(descriptor.publicKey).success ||
    !record.privateKey ||
    typeof record.privateKey !== "object"
  ) {
    throw new ClientDeviceKeyProviderError(
      "key-unusable",
      "The browser installation key record is invalid.",
    );
  }
  return {
    descriptor: {
      ...descriptor,
      publicKey: encryptionPublicKeySchema.parse(descriptor.publicKey),
    },
    privateKey: record.privateKey,
    version: 1,
  };
}

function storageError(
  message: string,
  error?: unknown,
): InstallationCatalogError {
  return new InstallationCatalogError(
    "catalog-unavailable",
    error instanceof Error ? `${message} ${error.message}` : message,
  );
}

class BrowserInstallationDatabase implements InstallationCatalogPersistenceBridge {
  readonly runtimeLabel = "browser";

  constructor(private readonly factory: IDBFactory | undefined) {}

  isAvailable(): boolean {
    return Boolean(this.factory);
  }

  async readCatalog(): Promise<NativeInstallationCatalogSnapshot> {
    const database = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(
          catalogObjectStoreName,
          "readonly",
        );
        const request = transaction
          .objectStore(catalogObjectStoreName)
          .get(catalogStorageKey);
        let result = emptyCatalog();
        request.onsuccess = () => {
          try {
            result = request.result
              ? cloneCatalog(
                  request.result as NativeInstallationCatalogSnapshot,
                )
              : emptyCatalog();
          } catch (error) {
            reject(error);
          }
        };
        request.onerror = () =>
          reject(
            storageError(
              "The browser installation catalog could not be read.",
              request.error,
            ),
          );
        transaction.onabort = () =>
          reject(
            storageError(
              "The browser installation catalog read was aborted.",
              transaction.error,
            ),
          );
        transaction.onerror = () =>
          reject(
            storageError(
              "The browser installation catalog read failed.",
              transaction.error,
            ),
          );
        transaction.oncomplete = () => resolve(result);
      });
    } finally {
      database.close();
    }
  }

  async applyCatalogTransaction(
    request: InstallationCatalogTransactionRequest,
  ): Promise<NativeInstallationCatalogSnapshot> {
    const database = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(
          catalogObjectStoreName,
          "readwrite",
        );
        const store = transaction.objectStore(catalogObjectStoreName);
        const read = store.get(catalogStorageKey);
        let next: NativeInstallationCatalogSnapshot | null = null;
        let operationError: unknown = null;
        read.onsuccess = () => {
          try {
            const current = read.result
              ? cloneCatalog(read.result as NativeInstallationCatalogSnapshot)
              : emptyCatalog();
            next = applyCatalogOperations(current, request);
            store.put(next, catalogStorageKey);
          } catch (error) {
            operationError = error;
            transaction.abort();
          }
        };
        read.onerror = () =>
          reject(
            storageError(
              "The browser installation catalog could not be read for update.",
              read.error,
            ),
          );
        transaction.onabort = () =>
          reject(
            operationError ??
              storageError(
                "The browser installation catalog update was aborted.",
                transaction.error,
              ),
          );
        transaction.onerror = () =>
          reject(
            operationError ??
              storageError(
                "The browser installation catalog update failed.",
                transaction.error,
              ),
          );
        transaction.oncomplete = () => {
          if (!next) {
            reject(
              storageError(
                "The browser installation catalog update did not complete.",
              ),
            );
            return;
          }
          resolve(cloneCatalog(next));
        };
      });
    } finally {
      database.close();
    }
  }

  async createKey(input: {
    createdAt?: string;
    installationId: string;
    keyAlias: string;
  }): Promise<ClientDeviceKeyDescriptor> {
    if (installationKeyAlias(input.installationId) !== input.keyAlias) {
      throw new ClientDeviceKeyProviderError(
        "key-conflict",
        "The browser key alias does not match the installation.",
      );
    }
    const keyPair = await generateHpkeKeyPair(false);
    if (keyPair.privateKey.extractable) {
      throw new ClientDeviceKeyProviderError(
        "key-unusable",
        "The browser did not create a nonextractable installation key.",
      );
    }
    const proposed: StoredBrowserDeviceKey = {
      descriptor: {
        createdAt: input.createdAt ?? new Date().toISOString(),
        installationId: input.installationId,
        keyAlias: input.keyAlias,
        provider: "browser-webcrypto",
        publicKey: await exportHpkePublicKey(keyPair.publicKey),
      },
      privateKey: keyPair.privateKey,
      version: 1,
    };
    const database = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(
          deviceKeyObjectStoreName,
          "readwrite",
        );
        const store = transaction.objectStore(deviceKeyObjectStoreName);
        const read = store.get(input.keyAlias);
        let result: StoredBrowserDeviceKey | null = null;
        let operationError: unknown = null;
        read.onsuccess = () => {
          try {
            result = read.result
              ? parseStoredDeviceKey(read.result, input.keyAlias)
              : proposed;
            if (!read.result) store.put(proposed, input.keyAlias);
          } catch (error) {
            operationError = error;
            transaction.abort();
          }
        };
        read.onerror = () =>
          reject(
            this.keyStorageError(
              "The browser installation key could not be checked.",
              read.error,
            ),
          );
        transaction.onabort = () =>
          reject(
            operationError ??
              this.keyStorageError(
                "The browser installation key write was aborted.",
                transaction.error,
              ),
          );
        transaction.onerror = () =>
          reject(
            operationError ??
              this.keyStorageError(
                "The browser installation key could not be saved.",
                transaction.error,
              ),
          );
        transaction.oncomplete = () => {
          if (!result) {
            reject(
              this.keyStorageError(
                "The browser installation key write did not complete.",
              ),
            );
            return;
          }
          resolve(structuredClone(result.descriptor));
        };
      });
    } finally {
      database.close();
    }
  }

  async inspectKey(
    keyAlias: string,
  ): Promise<ClientDeviceKeyDescriptor | null> {
    const record = await this.readKey(keyAlias);
    return record ? structuredClone(record.descriptor) : null;
  }

  async unwrapAccountMasterKey(input: {
    keyAlias: string;
    ownerId: string;
    wrapper: ClientMasterKeyWrapper;
  }): Promise<Uint8Array> {
    const record = await this.readKey(input.keyAlias);
    if (!record) {
      throw new ClientDeviceKeyProviderError(
        "key-missing",
        "The browser installation key is missing.",
      );
    }
    try {
      return await unwrapAccountMasterKeyForClient({
        clientKeyPair: {
          privateKey: record.privateKey,
          publicKey: await importHpkePublicKey(record.descriptor.publicKey),
        },
        ownerId: input.ownerId,
        wrapper: input.wrapper,
      });
    } catch (error) {
      throw new ClientDeviceKeyProviderError(
        "key-unusable",
        error instanceof Error
          ? `The browser installation key could not unlock the account. ${error.message}`
          : "The browser installation key could not unlock the account.",
      );
    }
  }

  private async readKey(
    keyAlias: string,
  ): Promise<StoredBrowserDeviceKey | null> {
    const database = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(
          deviceKeyObjectStoreName,
          "readonly",
        );
        const request = transaction
          .objectStore(deviceKeyObjectStoreName)
          .get(keyAlias);
        let result: StoredBrowserDeviceKey | null = null;
        request.onsuccess = () => {
          try {
            result = request.result
              ? parseStoredDeviceKey(request.result, keyAlias)
              : null;
          } catch (error) {
            reject(error);
          }
        };
        request.onerror = () =>
          reject(
            this.keyStorageError(
              "The browser installation key could not be read.",
              request.error,
            ),
          );
        transaction.onabort = () =>
          reject(
            this.keyStorageError(
              "The browser installation key read was aborted.",
              transaction.error,
            ),
          );
        transaction.onerror = () =>
          reject(
            this.keyStorageError(
              "The browser installation key read failed.",
              transaction.error,
            ),
          );
        transaction.oncomplete = () => resolve(result);
      });
    } finally {
      database.close();
    }
  }

  private keyStorageError(message: string, error?: unknown) {
    return new ClientDeviceKeyProviderError(
      "key-store-unavailable",
      error instanceof Error ? `${message} ${error.message}` : message,
    );
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!this.factory) {
        reject(storageError("Browser IndexedDB is unavailable."));
        return;
      }
      const request = this.factory.open(
        browserInstallationDatabaseName,
        browserInstallationDatabaseVersion,
      );
      request.onblocked = () =>
        reject(
          storageError(
            "Browser installation storage is blocked by another window.",
          ),
        );
      request.onerror = () =>
        reject(
          storageError(
            "Browser installation storage could not be opened.",
            request.error,
          ),
        );
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(catalogObjectStoreName)) {
          request.result.createObjectStore(catalogObjectStoreName);
        }
        if (
          !request.result.objectStoreNames.contains(deviceKeyObjectStoreName)
        ) {
          request.result.createObjectStore(deviceKeyObjectStoreName);
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }
}

export class BrowserInstallationCatalog extends PersistentInstallationCatalog {
  constructor(database: BrowserInstallationDatabase) {
    super(database);
  }
}

export class BrowserClientDeviceKeyProvider implements ClientDeviceKeyProvider {
  readonly backend = "browser-webcrypto" as const;
  readonly kind = "browser-webcrypto" as const;

  constructor(private readonly database: BrowserInstallationDatabase) {}

  create(input: {
    createdAt?: string;
    installationId: string;
    keyAlias: string;
  }): Promise<ClientDeviceKeyDescriptor> {
    return this.database.createKey(input);
  }

  inspect(keyAlias: string): Promise<ClientDeviceKeyDescriptor | null> {
    return this.database.inspectKey(keyAlias);
  }

  unwrapAccountMasterKey(input: {
    keyAlias: string;
    ownerId: string;
    wrapper: ClientMasterKeyWrapper;
  }): Promise<Uint8Array> {
    return this.database.unwrapAccountMasterKey(input);
  }
}

export async function requestBrowserStoragePersistence(
  storageManager: BrowserStorageManager | undefined = typeof navigator ===
  "undefined"
    ? undefined
    : navigator.storage,
): Promise<BrowserStoragePersistence> {
  if (
    !storageManager ||
    typeof storageManager.persist !== "function" ||
    typeof storageManager.persisted !== "function"
  ) {
    return "unsupported";
  }
  try {
    if (await storageManager.persisted()) return "persistent";
    return (await storageManager.persist()) ? "persistent" : "best-effort";
  } catch {
    return "best-effort";
  }
}

const persistenceRequested = new WeakSet<IDBFactory>();

export function openBrowserInstallationStorage(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  storageManager: BrowserStorageManager | undefined = typeof navigator ===
  "undefined"
    ? undefined
    : navigator.storage,
): Promise<DurableClientEncryptionStorage> {
  const open = async () => {
    const database = new BrowserInstallationDatabase(factory);
    if (!database.isAvailable()) {
      throw storageError("Browser IndexedDB is unavailable.");
    }
    if (factory && !persistenceRequested.has(factory)) {
      persistenceRequested.add(factory);
      void requestBrowserStoragePersistence(storageManager).then(
        (persistence) => {
          const metadata = {
            event: "encryption.browser-storage.persistence",
            operation: "request-persistent-storage",
            reasonCode: persistence,
            status: persistence === "persistent" ? "ready" : "best-effort",
            subsystem: "encryption",
          };
          if (persistence === "persistent") {
            clientLogger.info(
              "Browser storage persistence is enabled",
              metadata,
            );
          } else {
            clientLogger.warn(
              "Browser encryption storage remains subject to browser eviction",
              metadata,
            );
          }
        },
        (error: unknown) => {
          clientLogger.warn("Browser storage persistence request failed", {
            ...operationalErrorMetadata(error),
            event: "encryption.browser-storage.persistence",
            operation: "request-persistent-storage",
            status: "best-effort",
            subsystem: "encryption",
          });
        },
      );
    }
    return {
      catalog: new BrowserInstallationCatalog(database),
      provider: new BrowserClientDeviceKeyProvider(database),
    };
  };
  return open();
}
