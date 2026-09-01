import {
  clearSensitiveBytes,
  createPasswordKdfParameters,
} from "@cantrip/crypto";
import type {
  ClientMasterKeyWrapper,
  EncryptionKeyGrant,
  EncryptionPrincipal,
} from "@cantrip/protocol/encryption";
import { afterEach, describe, expect, it } from "vitest";

import {
  ClientEncryptionService,
  IndexedDbClientDeviceKeyStore,
  clientEncryption,
  clientEncryptionForRuntime,
  type ClientDeviceKeyStore,
  type ClientEncryptionIdentity,
  type StoredClientDeviceRecord,
} from "./client-encryption";
import { clearClientLogs, readClientLogs } from "./client-log-relay";
import { clearClientSession, setClientSession } from "./client-session";

const timestamp = "2026-08-19T12:00:00.000Z";
const identity = { ownerId: "owner-a", serverId: "server-a" } as const;

type IndexedDbContractObservation = {
  databaseName?: string;
  databaseVersion?: number;
  lookupKey?: IDBValidKey | IDBKeyRange;
  objectStoreName?: string;
  transactionMode?: IDBTransactionMode;
};

function missingRecordIndexedDbFactory(
  observation: IndexedDbContractObservation = {},
): IDBFactory {
  const request = { result: undefined } as unknown as IDBRequest<unknown>;
  let transaction: IDBTransaction;
  const database = {
    close() {},
    transaction(storeName: string | string[], mode?: IDBTransactionMode) {
      observation.objectStoreName = String(storeName);
      observation.transactionMode = mode;
      transaction = {
        objectStore(name: string) {
          observation.objectStoreName = name;
          return {
            get(key: IDBValidKey | IDBKeyRange) {
              observation.lookupKey = key;
              queueMicrotask(() => {
                request.onsuccess?.(new Event("success"));
                transaction.oncomplete?.(new Event("complete"));
              });
              return request;
            },
          } as unknown as IDBObjectStore;
        },
      } as unknown as IDBTransaction;
      return transaction;
    },
  } as unknown as IDBDatabase;
  const openRequest = { result: database } as unknown as IDBOpenDBRequest;
  return {
    open(name: string, version?: number) {
      observation.databaseName = name;
      observation.databaseVersion = version;
      queueMicrotask(() => openRequest.onsuccess?.(new Event("success")));
      return openRequest;
    },
  } as unknown as IDBFactory;
}

class MemoryDeviceKeyStore implements ClientDeviceKeyStore {
  private readonly records = new Map<string, unknown>();

  delete(target: ClientEncryptionIdentity): Promise<void> {
    this.records.delete(this.key(target));
    return Promise.resolve();
  }

  load(target: ClientEncryptionIdentity): Promise<unknown | null> {
    return Promise.resolve(this.records.get(this.key(target)) ?? null);
  }

  save(record: StoredClientDeviceRecord): Promise<void> {
    this.records.set(this.key(record), record);
    return Promise.resolve();
  }

  read(target: ClientEncryptionIdentity): unknown {
    return this.records.get(this.key(target));
  }

  seed(target: ClientEncryptionIdentity, value: unknown): void {
    this.records.set(this.key(target), value);
  }

  private key(target: ClientEncryptionIdentity): string {
    return `${target.serverId}:${target.ownerId}`;
  }
}

function authorization(
  clientId: string,
  publicKey: StoredClientDeviceRecord["publicKey"],
  wrappedKey: ClientMasterKeyWrapper,
): { grant: EncryptionKeyGrant; principal: EncryptionPrincipal } {
  return {
    principal: {
      id: clientId,
      ownerId: identity.ownerId,
      kind: "client",
      workerId: null,
      label: "Test browser",
      publicKey,
      state: "approved",
      revision: 1,
      approvedAt: timestamp,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    grant: {
      id: "89a82258-bebf-4cd8-b7d4-7069bf8f54c1",
      ownerId: identity.ownerId,
      principalId: clientId,
      component: "account-master-key",
      keyRevision: 1,
      wrappedKey,
      state: "active",
      revision: 1,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

afterEach(() => {
  clearClientLogs();
  clearClientSession();
});

describe("client encryption key custody", () => {
  it("normalizes IndexedDB's undefined missing-record result to null", async () => {
    const store = new IndexedDbClientDeviceKeyStore(
      missingRecordIndexedDbFactory(),
    );

    await expect(store.load(identity)).resolves.toBeNull();
  });

  it("preserves the exact legacy IndexedDB address for migration readers", async () => {
    const observation: IndexedDbContractObservation = {};
    const store = new IndexedDbClientDeviceKeyStore(
      missingRecordIndexedDbFactory(observation),
    );

    await expect(store.load(identity)).resolves.toBeNull();
    expect(observation).toEqual({
      databaseName: "cantrip-client-encryption",
      databaseVersion: 1,
      lookupKey: JSON.stringify([1, identity.serverId, identity.ownerId]),
      objectStoreName: "device-keys",
      transactionMode: "readonly",
    });
  });

  it("preserves an unlocked singleton across development hot reloads", () => {
    const hotState: Parameters<typeof clientEncryptionForRuntime>[0] = {};
    const first = clientEncryptionForRuntime(hotState);
    first.setAccountMasterKey({
      accountMasterKey: new Uint8Array(32).fill(31),
      identity,
      masterKeyRevision: 1,
    });

    const reloaded = clientEncryptionForRuntime(hotState);
    expect(reloaded).toBe(first);
    expect(reloaded.getSnapshot()).toMatchObject({
      identity,
      masterKeyRevision: 1,
      status: "ready",
    });

    reloaded.lock();
  });

  it("persists a nonextractable device key and unlocks after a simulated restart", async () => {
    const store = new MemoryDeviceKeyStore();
    const firstRun = new ClientEncryptionService(store);
    const device = await firstRun.ensureDevice(identity);
    const stored = store.read(identity) as StoredClientDeviceRecord;

    expect(stored.privateKey.extractable).toBe(false);
    await expect(
      crypto.subtle.exportKey("pkcs8", stored.privateKey),
    ).rejects.toThrow();

    const accountMasterKey = new Uint8Array(32).fill(19);
    firstRun.setAccountMasterKey({
      accountMasterKey,
      identity,
      masterKeyRevision: 1,
    });
    const deviceWrapper = await firstRun.createDeviceWrapper(identity);
    const passwordWrapper = await firstRun.createPasswordWrapper({
      identity,
      password: "a correct test password",
      kdf: createPasswordKdfParameters({
        memoryKiB: 8_192,
        iterations: 1,
        parallelism: 1,
      }),
    });
    const expectedComponentKey = firstRun.componentKey({
      component: "workspace-display-name",
      identity,
      keyRevision: 1,
    });
    const expectedSurfaceStateKey = firstRun.componentKey({
      component: "surface-private-state",
      identity,
      keyRevision: 1,
    });
    await expect(firstRun.loadDevice(identity)).resolves.toEqual(device);
    expect(firstRun.getSnapshot().status).toBe("ready");
    expect(
      firstRun.componentKey({
        component: "workspace-display-name",
        identity,
        keyRevision: 1,
      }),
    ).toEqual(expectedComponentKey);
    firstRun.lock();

    const restarted = new ClientEncryptionService(store);
    await expect(restarted.loadDevice(identity)).resolves.toEqual(device);
    await restarted.unlockWithDevice({
      identity,
      ...authorization(device.clientId, device.publicKey, deviceWrapper),
    });
    expect(restarted.getSnapshot()).toMatchObject({
      clientId: device.clientId,
      masterKeyRevision: 1,
      status: "ready",
    });
    expect(
      restarted.componentKey({
        component: "workspace-display-name",
        identity,
        keyRevision: 1,
      }),
    ).toEqual(expectedComponentKey);
    expect(
      restarted.componentKey({
        component: "surface-private-state",
        identity,
        keyRevision: 1,
      }),
    ).toEqual(expectedSurfaceStateKey);

    restarted.lock();
    await restarted.unlockWithPassword({
      identity,
      password: "a correct test password",
      wrapper: passwordWrapper,
    });
    expect(restarted.getSnapshot().status).toBe("ready");

    clearSensitiveBytes(accountMasterKey);
    clearSensitiveBytes(expectedComponentKey);
    clearSensitiveBytes(expectedSurfaceStateKey);
    restarted.lock();
  });

  it("treats a structured-cloned WebKit device key as an opaque native handle", async () => {
    const store = new MemoryDeviceKeyStore();
    const service = new ClientEncryptionService(store);
    const device = await service.ensureDevice(identity);
    const stored = store.read(identity) as StoredClientDeviceRecord;
    store.seed(identity, {
      ...stored,
      // WKWebView can restore the native handle while presenting descriptor
      // fields differently across its IndexedDB structured-clone boundary.
      privateKey: {} as CryptoKey,
    });

    await expect(service.loadDevice(identity)).resolves.toEqual(device);
  });

  it("isolates keys by server and account and clears the singleton on sign-out", async () => {
    const service = new ClientEncryptionService(new MemoryDeviceKeyStore());
    await service.ensureDevice(identity);
    service.setAccountMasterKey({
      accountMasterKey: new Uint8Array(32).fill(23),
      identity,
      masterKeyRevision: 1,
    });

    await expect(
      service.loadDevice({ ownerId: "owner-a", serverId: "server-b" }),
    ).resolves.toBeNull();
    expect(service.getSnapshot()).toMatchObject({
      identity: { ownerId: "owner-a", serverId: "server-b" },
      status: "locked",
    });
    expect(() =>
      service.componentKey({
        component: "workspace-display-name",
        identity,
        keyRevision: 1,
      }),
    ).toThrow(/locked/iu);

    clientEncryption.setAccountMasterKey({
      accountMasterKey: new Uint8Array(32).fill(29),
      identity,
      masterKeyRevision: 1,
    });
    setClientSession({
      authMode: "accounts",
      csrfToken: "c".repeat(32),
      expiresAt: "2026-08-19T13:00:00.000Z",
      serverId: identity.serverId,
      user: {
        id: identity.ownerId,
        kind: "account",
        displayName: "Owner A",
        email: "owner-a@example.com",
        role: "owner",
      },
    });
    clearClientSession();
    expect(clientEncryption.getSnapshot().status).toBe("locked");
  });

  it("fails closed for corrupt, unsupported, and revoked device state", async () => {
    const store = new MemoryDeviceKeyStore();
    const service = new ClientEncryptionService(store);
    const device = await service.ensureDevice(identity);
    service.setAccountMasterKey({
      accountMasterKey: new Uint8Array(32).fill(31),
      identity,
      masterKeyRevision: 1,
    });
    const wrapper = await service.createDeviceWrapper(identity);
    const approved = authorization(device.clientId, device.publicKey, wrapper);

    await expect(
      service.unlockWithDevice({
        identity,
        grant: approved.grant,
        principal: {
          ...approved.principal,
          state: "revoked",
          revokedAt: timestamp,
          revokedReason: "test revocation",
        },
      }),
    ).rejects.toMatchObject({ code: "principal-unavailable" });
    expect(service.getSnapshot().status).toBe("revoked");

    await expect(
      service.unlockWithDevice({
        identity,
        grant: {
          ...approved.grant,
          wrappedKey: { ...wrapper, version: 2 },
        } as unknown as EncryptionKeyGrant,
        principal: approved.principal,
      }),
    ).rejects.toMatchObject({ code: "unsupported-version" });
    expect(service.getSnapshot().status).toBe("unsupported-version");

    const stored = store.read(identity) as StoredClientDeviceRecord;
    store.seed(identity, { ...stored, privateKey: {} as CryptoKey });
    await expect(
      service.unlockWithDevice({
        identity,
        grant: approved.grant,
        principal: approved.principal,
      }),
    ).rejects.toMatchObject({ code: "decryption-failed" });
    expect(service.getSnapshot().status).toBe("locked");

    store.seed(identity, {
      ownerId: identity.ownerId,
      serverId: identity.serverId,
      version: 1,
    });
    await expect(service.loadDevice(identity)).rejects.toMatchObject({
      code: "corrupt-device-record",
    });
    expect(service.getSnapshot().status).toBe("corrupt");
    expect(readClientLogs().records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: expect.objectContaining({
            event: "encryption.device-record.rejected",
            reasonCode: "client-id-invalid",
          }),
        }),
      ]),
    );
  });
});
