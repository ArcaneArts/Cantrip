import {
  clearSensitiveBytes,
  createPasswordKdfParameters,
  unwrapAccountMasterKeyWithPassword,
} from "@cantrip/crypto";
import type {
  AccountEncryptionProfile,
  AccountEncryptionProfileInitialize,
  AccountEncryptionProfileInitializeResult,
  AccountPasswordEncryptionChange,
  EncryptionKeyGrant,
  EncryptionKeyGrantCreate,
  EncryptionPrincipal,
  EncryptionPrincipalCreate,
} from "@cantrip/protocol/encryption";
import { describe, expect, it } from "vitest";

import { CantripApiError } from "./api-client";
import {
  changeAccountEncryptionPassword,
  prepareClientEncryption,
  type AccountEncryptionApi,
} from "./account-encryption";
import {
  ClientEncryptionService,
  type ClientDeviceKeyStore,
  type ClientEncryptionIdentity,
  type StoredClientDeviceRecord,
} from "./client-encryption";

const ownerId = "owner-a";
const timestamp = "2026-08-19T12:00:00.000Z";
const password = "correct horse battery staple";
const identity = { ownerId, serverId: "server-a" } as const;
const testKdf = () =>
  createPasswordKdfParameters({
    memoryKiB: 8_192,
    iterations: 1,
    parallelism: 1,
  });

class MemoryDeviceKeyStore implements ClientDeviceKeyStore {
  private readonly records = new Map<string, unknown>();

  seed(target: ClientEncryptionIdentity, record: unknown): void {
    this.records.set(this.key(target), record);
  }

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

  private key(target: ClientEncryptionIdentity): string {
    return `${target.serverId}:${target.ownerId}`;
  }
}

class MemoryAccountEncryptionApi implements AccountEncryptionApi {
  profile: AccountEncryptionProfile | null = null;
  readonly principals = new Map<string, EncryptionPrincipal>();
  readonly grants = new Map<string, EncryptionKeyGrant[]>();
  reauthenticationAttempts = 0;

  constructor(private password: string) {}

  async approvePrincipal(
    principalId: string,
    expectedRevision: number,
  ): Promise<EncryptionPrincipal> {
    const principal = this.principals.get(principalId);
    if (
      !principal ||
      principal.state !== "pending" ||
      principal.revision !== expectedRevision
    ) {
      throw new CantripApiError("Principal changed.", 409);
    }
    const approved: EncryptionPrincipal = {
      ...principal,
      state: "approved",
      revision: principal.revision + 1,
      approvedAt: timestamp,
      updatedAt: timestamp,
    };
    this.principals.set(principalId, approved);
    return approved;
  }

  async changePassword(
    input: AccountPasswordEncryptionChange,
  ): Promise<AccountEncryptionProfile> {
    if (input.currentPassword !== this.password) {
      throw new CantripApiError("Current password is incorrect.", 403);
    }
    if (
      !this.profile ||
      this.profile.revision !== input.expectedProfileRevision ||
      this.profile.activeMasterKeyRevision !==
        input.passwordWrappedMasterKey.masterKeyRevision
    ) {
      throw new CantripApiError("Profile changed.", 409);
    }
    this.password = input.newPassword;
    this.profile = {
      ...this.profile,
      passwordKdf: input.passwordKdf,
      passwordWrappedMasterKey: input.passwordWrappedMasterKey,
      revision: this.profile.revision + 1,
      updatedAt: timestamp,
    };
    return this.profile;
  }

  async createGrant(
    principalId: string,
    input: EncryptionKeyGrantCreate,
  ): Promise<EncryptionKeyGrant> {
    const existing = this.grants.get(principalId) ?? [];
    if (
      existing.some(
        (grant) =>
          grant.component === input.component &&
          grant.keyRevision === input.keyRevision &&
          grant.state === "active",
      )
    ) {
      throw new CantripApiError("Grant exists.", 409);
    }
    const grant: EncryptionKeyGrant = {
      id: crypto.randomUUID(),
      ownerId,
      principalId,
      component: input.component,
      keyRevision: input.keyRevision,
      wrappedKey: input.wrappedKey,
      state: "active",
      revision: 1,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.grants.set(principalId, [...existing, grant]);
    return grant;
  }

  async createPrincipal(
    input: EncryptionPrincipalCreate,
  ): Promise<EncryptionPrincipal> {
    if (this.principals.has(input.id)) {
      throw new CantripApiError("Principal exists.", 409);
    }
    if (input.kind !== "client") throw new Error("Expected a client.");
    const principal: EncryptionPrincipal = {
      id: input.id,
      ownerId,
      kind: "client",
      workerId: null,
      label: input.label,
      publicKey: input.publicKey,
      state: "pending",
      revision: 1,
      approvedAt: null,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.principals.set(principal.id, principal);
    return principal;
  }

  getProfile() {
    return Promise.resolve(
      this.profile
        ? ({ status: "initialized", profile: this.profile } as const)
        : ({ status: "uninitialized", profile: null } as const),
    );
  }

  async initializeProfile(
    input: AccountEncryptionProfileInitialize,
  ): Promise<AccountEncryptionProfileInitializeResult> {
    if (this.profile) return { created: false, profile: this.profile };
    this.profile = {
      ownerId,
      ...input.profile,
      initializationStatus: "initialized",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const principal: EncryptionPrincipal = {
      id: input.initialClient.id,
      ownerId,
      kind: "client",
      workerId: null,
      label: input.initialClient.label,
      publicKey: input.initialClient.publicKey,
      state: "approved",
      revision: 1,
      approvedAt: timestamp,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.principals.set(principal.id, principal);
    const grant: EncryptionKeyGrant = {
      id: crypto.randomUUID(),
      ownerId,
      principalId: principal.id,
      component: "account-master-key",
      keyRevision: 1,
      wrappedKey: input.initialClient.wrappedMasterKey,
      state: "active",
      revision: 1,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.grants.set(principal.id, [grant]);
    return { created: true, profile: this.profile, principal, grant };
  }

  listGrants(principalId: string): Promise<EncryptionKeyGrant[]> {
    return Promise.resolve(
      (this.grants.get(principalId) ?? []).filter(
        (grant) => grant.state === "active",
      ),
    );
  }

  listPrincipals(): Promise<EncryptionPrincipal[]> {
    return Promise.resolve([...this.principals.values()]);
  }

  async reauthenticate(candidate: string): Promise<void> {
    this.reauthenticationAttempts += 1;
    if (candidate !== this.password) {
      throw new CantripApiError("Password is incorrect.", 403);
    }
  }
}

describe("account encryption initialization", () => {
  it("requires one password confirmation, initializes, and later unlocks from the device key", async () => {
    const api = new MemoryAccountEncryptionApi(password);
    const store = new MemoryDeviceKeyStore();
    const firstRun = new ClientEncryptionService(store);

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        service: firstRun,
      }),
    ).resolves.toEqual({
      credential: "password",
      reason: "initialize",
      status: "credential-required",
    });
    expect(api.profile).toBeNull();

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        password,
        passwordKdf: testKdf(),
        service: firstRun,
      }),
    ).resolves.toEqual({ status: "ready" });
    expect(api.profile?.passwordWrappedMasterKey).not.toBeNull();
    expect(api.reauthenticationAttempts).toBe(1);

    const refreshStatuses: string[] = [];
    const unsubscribe = firstRun.subscribe(() => {
      refreshStatuses.push(firstRun.getSnapshot().status);
    });
    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        service: firstRun,
      }),
    ).resolves.toEqual({ status: "ready" });
    unsubscribe();
    expect(refreshStatuses).toEqual([]);

    firstRun.lock();
    const restarted = new ClientEncryptionService(store);
    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        service: restarted,
      }),
    ).resolves.toEqual({ status: "ready" });
    expect(api.reauthenticationAttempts).toBe(1);
  });

  it("authorizes a new device once and leaves the profile unchanged after a wrong password", async () => {
    const api = new MemoryAccountEncryptionApi(password);
    await prepareClientEncryption({
      api,
      authMode: "accounts",
      identity,
      password,
      passwordKdf: testKdf(),
      service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
    });
    const newDevice = new ClientEncryptionService(new MemoryDeviceKeyStore());
    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        service: newDevice,
      }),
    ).resolves.toEqual({
      credential: "password",
      reason: "authorize-device",
      status: "credential-required",
    });
    expect(() =>
      newDevice.componentKey({
        component: "workspace-display-name",
        identity,
        keyRevision: 1,
      }),
    ).toThrow(/locked/iu);
    const unchangedProfile = JSON.stringify(api.profile);

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        password: "incorrect password",
        service: newDevice,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(JSON.stringify(api.profile)).toBe(unchangedProfile);
    expect(newDevice.getSnapshot().status).toBe("locked");

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        password,
        service: newDevice,
      }),
    ).resolves.toEqual({ status: "ready" });
    newDevice.lock();
    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        service: newDevice,
      }),
    ).resolves.toEqual({ status: "ready" });
  });

  it("replaces an unrecoverable local device record and requires authorization once", async () => {
    const api = new MemoryAccountEncryptionApi(password);
    await prepareClientEncryption({
      api,
      authMode: "accounts",
      identity,
      password,
      passwordKdf: testKdf(),
      service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
    });
    const store = new MemoryDeviceKeyStore();
    store.seed(identity, { version: 1 });
    const replacement = new ClientEncryptionService(store);

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        service: replacement,
      }),
    ).resolves.toEqual({
      credential: "password",
      reason: "authorize-device",
      status: "credential-required",
    });
    expect(replacement.getSnapshot()).toMatchObject({
      clientId: expect.any(String),
      status: "locked",
    });
    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        password,
        service: replacement,
      }),
    ).resolves.toEqual({ status: "ready" });
  });

  it("resolves concurrent account initialization without replacing the winner's master key", async () => {
    const api = new MemoryAccountEncryptionApi(password);
    const first = new ClientEncryptionService(new MemoryDeviceKeyStore());
    const second = new ClientEncryptionService(new MemoryDeviceKeyStore());

    const results = await Promise.all([
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        password,
        passwordKdf: testKdf(),
        service: first,
      }),
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        password,
        passwordKdf: testKdf(),
        service: second,
      }),
    ]);

    expect(results).toEqual([{ status: "ready" }, { status: "ready" }]);
    expect(api.principals.size).toBe(2);
    expect(first.getSnapshot().status).toBe("ready");
    expect(second.getSnapshot().status).toBe("ready");
  });

  it("shares one local initialization across concurrent session refreshes", async () => {
    const api = new MemoryAccountEncryptionApi("unused");
    const store = new MemoryDeviceKeyStore();
    const service = new ClientEncryptionService(store);

    const results = await Promise.all([
      prepareClientEncryption({
        api,
        authMode: "none",
        identity,
        passwordKdf: testKdf(),
        service,
      }),
      prepareClientEncryption({
        api,
        authMode: "none",
        identity,
        passwordKdf: testKdf(),
        service,
      }),
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({ status: "ready" });
    expect(api.principals.size).toBe(1);
    expect(api.profile?.passwordKdf).toBeNull();
    expect(api.profile?.passwordWrappedMasterKey).toBeNull();
    expect(service.getSnapshot().status).toBe("ready");
  });

  it("bootstraps anonymous mode with device-only custody and no user credential", async () => {
    const api = new MemoryAccountEncryptionApi("unused");
    const store = new MemoryDeviceKeyStore();
    const first = new ClientEncryptionService(store);
    const result = await prepareClientEncryption({
      api,
      authMode: "none",
      identity,
      passwordKdf: testKdf(),
      service: first,
    });

    expect(result).toEqual({ status: "ready" });
    expect(api.profile?.passwordKdf).toBeNull();
    expect(api.profile?.passwordWrappedMasterKey).toBeNull();
    expect(api.reauthenticationAttempts).toBe(0);
    expect(first.getSnapshot().status).toBe("ready");

    first.lock();
    const restarted = new ClientEncryptionService(store);
    await expect(
      prepareClientEncryption({
        api,
        authMode: "none",
        identity,
        service: restarted,
      }),
    ).resolves.toEqual({ status: "ready" });

    const second = new ClientEncryptionService(new MemoryDeviceKeyStore());
    await expect(
      prepareClientEncryption({
        api,
        authMode: "none",
        identity,
        service: second,
      }),
    ).rejects.toThrow(/existing local device|reset the local encrypted data/iu);
  });

  it("rewraps the same Account Master Key while changing the account password", async () => {
    const api = new MemoryAccountEncryptionApi(password);
    const service = new ClientEncryptionService(new MemoryDeviceKeyStore());
    await prepareClientEncryption({
      api,
      authMode: "accounts",
      identity,
      password,
      passwordKdf: testKdf(),
      service,
    });
    const previousProfile = api.profile!;
    const previousWrapper = previousProfile.passwordWrappedMasterKey!;
    const nextPassword = "a different correct password";

    const changed = await changeAccountEncryptionPassword({
      api,
      currentPassword: password,
      identity,
      newPassword: nextPassword,
      passwordKdf: testKdf(),
      service,
    });
    const nextWrapper = changed.passwordWrappedMasterKey!;
    const previousMasterKey = await unwrapAccountMasterKeyWithPassword({
      password,
      ownerId,
      wrapper: previousWrapper,
    });
    const nextMasterKey = await unwrapAccountMasterKeyWithPassword({
      password: nextPassword,
      ownerId,
      wrapper: nextWrapper,
    });

    expect(nextMasterKey).toEqual(previousMasterKey);
    expect(changed.activeMasterKeyRevision).toBe(
      previousProfile.activeMasterKeyRevision,
    );
    expect(changed.revision).toBe(previousProfile.revision + 1);
    clearSensitiveBytes(previousMasterKey);
    clearSensitiveBytes(nextMasterKey);
  });
});
