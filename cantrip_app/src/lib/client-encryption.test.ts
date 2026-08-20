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
  clientEncryption,
  clientEncryptionForRuntime,
  type ClientDeviceKeyStore,
  type ClientEncryptionIdentity,
  type StoredClientDeviceRecord,
} from "./client-encryption";
import { clearClientSession, setClientSession } from "./client-session";

const timestamp = "2026-08-19T12:00:00.000Z";
const identity = { ownerId: "owner-a", serverId: "server-a" } as const;

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
  clearClientSession();
});

describe("client encryption key custody", () => {
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

  it("accepts a structured-cloned WebKit FrozenArray for device-key usages", async () => {
    const store = new MemoryDeviceKeyStore();
    const service = new ClientEncryptionService(store);
    const device = await service.ensureDevice(identity);
    const stored = store.read(identity) as StoredClientDeviceRecord;
    const usages = {
      0: "deriveBits",
      length: 1,
      *[Symbol.iterator]() {
        yield "deriveBits";
      },
    } as unknown as CryptoKey["usages"];
    store.seed(identity, {
      ...stored,
      privateKey: {
        algorithm: stored.privateKey.algorithm,
        extractable: false,
        type: "private",
        usages,
      },
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

    store.seed(identity, { version: 1 });
    await expect(service.loadDevice(identity)).rejects.toMatchObject({
      code: "corrupt-device-record",
    });
    expect(service.getSnapshot().status).toBe("corrupt");
  });
});
