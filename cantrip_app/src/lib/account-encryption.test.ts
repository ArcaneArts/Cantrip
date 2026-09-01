import {
  clearSensitiveBytes,
  createPasswordKdfParameters,
  generateAccountMasterKey,
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
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CantripApiError } from "./api-client";
import {
  changeAccountEncryptionPassword,
  confirmAnonymousRecoveryArtifactSaved,
  prepareClientEncryption,
  recoverAnonymousClientEncryption,
  type AccountEncryptionApi,
} from "./account-encryption";
import { serializeAnonymousRecoveryArtifact } from "./anonymous-recovery-artifact";
import {
  ClientEncryptionError,
  ClientEncryptionService,
  LegacyIndexedDbClientDeviceKeyStore,
  type LegacyClientDeviceKeyStore,
  type ClientEncryptionIdentity,
  type StoredClientDeviceRecord,
} from "./client-encryption";
import {
  MemoryClientDeviceKeyBackend,
  MemoryClientDeviceKeyProvider,
  type ClientDeviceKeyDescriptor,
  type ClientDeviceKeyProvider,
} from "./client-device-key-provider";
import { openBrowserInstallationStorage } from "./browser-installation-storage";
import { installationBindingPrincipalId } from "./durable-account-encryption";
import {
  installationKeyAlias,
  MemoryInstallationCatalog,
} from "./installation-catalog";

const ownerId = "owner-a";
const timestamp = "2026-08-19T12:00:00.000Z";
const password = "correct horse battery staple";
const identity = { ownerId, serverId: "server-a" } as const;

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

const testKdf = () =>
  createPasswordKdfParameters({
    memoryKiB: 8_192,
    iterations: 1,
    parallelism: 1,
  });

class MemoryDeviceKeyStore implements LegacyClientDeviceKeyStore {
  private readonly records = new Map<string, unknown>();

  seed(target: ClientEncryptionIdentity, record: unknown): void {
    this.records.set(this.key(target), record);
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

class DevelopmentFileVaultTestProvider implements ClientDeviceKeyProvider {
  readonly backend = "development-file-vault" as const;
  readonly kind = "tauri-native" as const;

  constructor(
    private readonly delegate = new MemoryClientDeviceKeyProvider(),
  ) {}

  async create(
    input: Parameters<ClientDeviceKeyProvider["create"]>[0],
  ): Promise<ClientDeviceKeyDescriptor> {
    return this.adapt(await this.delegate.create(input));
  }

  async inspect(keyAlias: string): Promise<ClientDeviceKeyDescriptor | null> {
    const device = await this.delegate.inspect(keyAlias);
    return device ? this.adapt(device) : null;
  }

  async replaceMissing(
    input: Parameters<ClientDeviceKeyProvider["replaceMissing"]>[0],
  ): Promise<ClientDeviceKeyDescriptor> {
    return this.adapt(await this.delegate.replaceMissing(input));
  }

  unwrapAccountMasterKey(
    input: Parameters<ClientDeviceKeyProvider["unwrapAccountMasterKey"]>[0],
  ): Promise<Uint8Array> {
    return this.delegate.unwrapAccountMasterKey(input);
  }

  private adapt(device: ClientDeviceKeyDescriptor): ClientDeviceKeyDescriptor {
    return { ...device, provider: this.backend };
  }
}

class MemoryAccountEncryptionApi implements AccountEncryptionApi {
  readonly calls: (keyof AccountEncryptionApi)[] = [];
  profile: AccountEncryptionProfile | null = null;
  readonly principals = new Map<string, EncryptionPrincipal>();
  readonly grants = new Map<string, EncryptionKeyGrant[]>();
  initializationAttempts = 0;
  reauthenticationAttempts = 0;

  constructor(private password: string) {}

  async approvePrincipal(
    principalId: string,
    expectedRevision: number,
  ): Promise<EncryptionPrincipal> {
    this.calls.push("approvePrincipal");
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
    this.calls.push("changePassword");
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
    this.calls.push("createGrant");
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
    this.calls.push("createPrincipal");
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
    this.calls.push("getProfile");
    return Promise.resolve(
      this.profile
        ? ({ status: "initialized", profile: this.profile } as const)
        : ({ status: "uninitialized", profile: null } as const),
    );
  }

  async initializeProfile(
    input: AccountEncryptionProfileInitialize,
  ): Promise<AccountEncryptionProfileInitializeResult> {
    this.calls.push("initializeProfile");
    this.initializationAttempts += 1;
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
    this.calls.push("listGrants");
    return Promise.resolve(
      (this.grants.get(principalId) ?? []).filter(
        (grant) => grant.state === "active",
      ),
    );
  }

  listPrincipals(): Promise<EncryptionPrincipal[]> {
    this.calls.push("listPrincipals");
    return Promise.resolve([...this.principals.values()]);
  }

  async reauthenticate(candidate: string): Promise<void> {
    this.calls.push("reauthenticate");
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

    api.calls.length = 0;
    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        service: firstRun,
      }),
    ).resolves.toEqual({ status: "ready" });
    expect(api.calls).toEqual(["getProfile", "listPrincipals", "listGrants"]);

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
    vi.stubGlobal("indexedDB", new IDBFactory());
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
      reason: "recover-device",
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

  it("preserves a corrupt legacy record and recovers through a new browser installation", async () => {
    const api = new MemoryAccountEncryptionApi(password);
    await prepareClientEncryption({
      api,
      authMode: "accounts",
      identity,
      password,
      passwordKdf: testKdf(),
      service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
    });
    vi.stubGlobal("indexedDB", new IDBFactory());
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
      reason: "recover-device",
      status: "credential-required",
    });
    expect(replacement.getSnapshot()).toMatchObject({
      clientId: null,
      status: "corrupt",
    });
    await expect(store.load(identity)).resolves.toEqual({ version: 1 });
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
    expect(api.principals.size).toBe(1);
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
    expect(results[0]).toMatchObject({
      artifact: {
        ownerId: identity.ownerId,
        serverId: identity.serverId,
      },
      status: "recovery-artifact-required",
    });
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

    expect(result).toMatchObject({
      artifact: {
        ownerId: identity.ownerId,
        serverId: identity.serverId,
      },
      confirmationId: expect.stringMatching(/^anonymous-recovery-v1:/u),
      status: "recovery-artifact-required",
    });
    expect(api.profile?.passwordKdf).toBeNull();
    expect(api.profile?.passwordWrappedMasterKey).toBeNull();
    expect(api.reauthenticationAttempts).toBe(0);
    expect(first.getSnapshot().status).toBe("ready");

    if (result.status !== "recovery-artifact-required") {
      throw new Error("Expected anonymous recovery setup.");
    }
    await confirmAnonymousRecoveryArtifactSaved({
      confirmationId: result.confirmationId,
      runtimePlatform: "browser",
    });

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

    vi.stubGlobal("indexedDB", new IDBFactory());
    const second = new ClientEncryptionService(new MemoryDeviceKeyStore());
    await expect(
      prepareClientEncryption({
        api,
        authMode: "none",
        identity,
        service: second,
      }),
    ).resolves.toMatchObject({
      reason: "anonymous-device-missing",
      status: "recovery-required",
    });
    const storageAfterLoss = await openBrowserInstallationStorage();
    await expect(
      storageAfterLoss.catalog.getInstallation(),
    ).resolves.toBeNull();
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

describe("durable native account encryption", () => {
  function durableStorage() {
    const backend = new MemoryClientDeviceKeyBackend();
    return {
      catalog: new MemoryInstallationCatalog(),
      provider: new MemoryClientDeviceKeyProvider(backend),
    };
  }

  it("uses the stable development vault without blocking on recovery acknowledgement", async () => {
    const api = new MemoryAccountEncryptionApi("unused");
    const catalog = new MemoryInstallationCatalog();
    const storage = {
      catalog,
      provider: new DevelopmentFileVaultTestProvider(),
    };
    const service = new ClientEncryptionService(null);

    await expect(
      prepareClientEncryption({
        api,
        authMode: "none",
        durableStorage: storage,
        identity,
        runtimePlatform: "tauri",
        service,
      }),
    ).resolves.toEqual({ status: "ready" });

    const binding = await catalog.getAccountBinding(
      identity.serverId,
      identity.ownerId,
    );
    await expect(
      catalog.getMigration(`anonymous-recovery-v1:${binding!.principalId}`),
    ).resolves.toMatchObject({
      state: "verified",
      verificationState: "development-file-vault-custody-v1",
    });
  });

  async function initializeLegacyAccount(input: {
    api: MemoryAccountEncryptionApi;
    authMode?: "accounts" | "none";
    store: LegacyClientDeviceKeyStore;
  }) {
    const service = new ClientEncryptionService(input.store);
    const device = await service.ensureLegacyDevice(identity);
    const accountMasterKey = generateAccountMasterKey();
    try {
      service.setAccountMasterKey({
        accountMasterKey,
        identity,
        masterKeyRevision: 1,
      });
      const passwordWrappedMasterKey =
        input.authMode === "none"
          ? null
          : await service.createPasswordWrapper({
              identity,
              kdf: testKdf(),
              password,
            });
      await input.api.initializeProfile({
        initialClient: {
          id: device.clientId,
          label: "Legacy Cantrip browser",
          publicKey: device.publicKey,
          wrappedMasterKey: await service.createLegacyDeviceWrapper(identity),
        },
        profile: {
          activeMasterKeyRevision: 1,
          formatVersion: 1,
          passwordKdf: passwordWrappedMasterKey?.kdf ?? null,
          passwordWrappedMasterKey,
          payloadMigrationStatus: "complete",
        },
      });
    } finally {
      clearSensitiveBytes(accountMasterKey);
      service.lock();
    }
  }

  it("does not provision a first-time account installation before credential verification", async () => {
    const api = new MemoryAccountEncryptionApi(password);
    const storage = durableStorage();
    const create = vi.spyOn(storage.provider, "create");
    const inspect = vi.spyOn(storage.provider, "inspect");
    const service = new ClientEncryptionService(new MemoryDeviceKeyStore());

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        durableStorage: storage,
        identity,
        runtimePlatform: "tauri",
        service,
      }),
    ).resolves.toEqual({
      credential: "password",
      reason: "initialize",
      status: "credential-required",
    });
    await expect(storage.catalog.getInstallation()).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        durableStorage: storage,
        identity,
        password: "incorrect password",
        runtimePlatform: "tauri",
        service,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(storage.catalog.getInstallation()).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        durableStorage: storage,
        identity,
        password,
        passwordKdf: testKdf(),
        runtimePlatform: "tauri",
        service,
      }),
    ).resolves.toEqual({ status: "ready" });
    await expect(storage.catalog.getInstallation()).resolves.not.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("leaves installation custody untouched when the server fails during legacy migration discovery", async () => {
    class MigrationUnavailableApi extends MemoryAccountEncryptionApi {
      migrationUnavailable = false;

      override listPrincipals(): Promise<EncryptionPrincipal[]> {
        return this.migrationUnavailable
          ? Promise.reject(new CantripApiError("Server unavailable.", 503))
          : super.listPrincipals();
      }
    }

    const api = new MigrationUnavailableApi(password);
    const legacyStore = new MemoryDeviceKeyStore();
    await initializeLegacyAccount({ api, store: legacyStore });
    const storage = durableStorage();
    const create = vi.spyOn(storage.provider, "create");
    api.migrationUnavailable = true;

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        durableStorage: storage,
        identity,
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(legacyStore),
      }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(storage.catalog.getInstallation()).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();

    api.migrationUnavailable = false;
    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        durableStorage: storage,
        identity,
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(legacyStore),
      }),
    ).resolves.toEqual({ status: "ready" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("migrates the released per-account browser key into one stable browser installation", async () => {
    const api = new MemoryAccountEncryptionApi(password);
    const legacyStore = new LegacyIndexedDbClientDeviceKeyStore();
    await initializeLegacyAccount({ api, store: legacyStore });
    const legacyPrincipalId = [...api.principals.keys()][0]!;
    const service = new ClientEncryptionService(legacyStore);

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        runtimePlatform: "browser",
        service,
      }),
    ).resolves.toEqual({ status: "ready" });

    const storage = await openBrowserInstallationStorage();
    const installation = await storage.catalog.getInstallation();
    const binding = await storage.catalog.getAccountBinding(
      identity.serverId,
      identity.ownerId,
    );
    expect(installation).not.toBeNull();
    expect(binding).toMatchObject({
      keyAlias: installationKeyAlias(installation!.installationId),
      principalId: expect.not.stringMatching(legacyPrincipalId),
    });
    await expect(
      storage.catalog.getMigration(
        `legacy-indexeddb-v1:${binding!.principalId}`,
      ),
    ).resolves.toMatchObject({ state: "verified" });
    expect(api.principals.get(legacyPrincipalId)?.state).toBe("approved");

    service.lock();
    const stableOnly = new ClientEncryptionService({
      load: () => Promise.reject(new Error("legacy storage not used")),
      save: () => Promise.reject(new Error("legacy storage not used")),
    });
    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        runtimePlatform: "browser",
        service: stableOnly,
      }),
    ).resolves.toEqual({ status: "ready" });
  });

  it("recovers the existing account after browser installation storage is cleared", async () => {
    const api = new MemoryAccountEncryptionApi(password);
    const first = new ClientEncryptionService(new MemoryDeviceKeyStore());
    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        password,
        passwordKdf: testKdf(),
        runtimePlatform: "browser",
        service: first,
      }),
    ).resolves.toEqual({ status: "ready" });
    const profileBeforeStorageLoss = JSON.stringify(api.profile);
    const initializationAttempts = api.initializationAttempts;

    vi.stubGlobal("indexedDB", new IDBFactory());
    const recovered = new ClientEncryptionService(new MemoryDeviceKeyStore());
    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        runtimePlatform: "browser",
        service: recovered,
      }),
    ).resolves.toEqual({
      credential: "password",
      reason: "recover-device",
      status: "credential-required",
    });
    const storageAfterLoss = await openBrowserInstallationStorage();
    await expect(
      storageAfterLoss.catalog.getInstallation(),
    ).resolves.toBeNull();
    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        identity,
        password,
        runtimePlatform: "browser",
        service: recovered,
      }),
    ).resolves.toEqual({ status: "ready" });

    expect(api.initializationAttempts).toBe(initializationAttempts);
    expect(JSON.stringify(api.profile)).toBe(profileBeforeStorageLoss);
    expect(recovered.getSnapshot()).toMatchObject({ status: "ready" });
  });

  it.each(["tauri", "capacitor-ios", "capacitor-android"] as const)(
    "migrates an accessible IndexedDB key on %s, verifies native custody, and retains the legacy principal",
    async (runtimePlatform) => {
      const api = new MemoryAccountEncryptionApi(password);
      const legacyStore = new MemoryDeviceKeyStore();
      await initializeLegacyAccount({ api, store: legacyStore });
      const legacyPrincipalId = [...api.principals.keys()][0]!;
      const legacyGrant = api.grants.get(legacyPrincipalId)![0]!;
      const storage = durableStorage();
      const states: string[] = [];

      await expect(
        prepareClientEncryption({
          api,
          authMode: "accounts",
          durableStorage: storage,
          identity,
          onStartupState: (state) => states.push(state.phase),
          runtimePlatform,
          service: new ClientEncryptionService(legacyStore),
        }),
      ).resolves.toEqual({ status: "ready" });

      const installation = await storage.catalog.getInstallation();
      const binding = await storage.catalog.getAccountBinding(
        identity.serverId,
        identity.ownerId,
      );
      expect(installation).not.toBeNull();
      expect(binding).toMatchObject({
        keyAlias: expect.stringContaining(installation!.installationId),
        masterKeyRevision: 1,
        principalId: expect.not.stringMatching(legacyPrincipalId),
      });
      await expect(
        storage.catalog.getMigration(
          `legacy-indexeddb-v1:${binding!.principalId}`,
        ),
      ).resolves.toMatchObject({
        state: "verified",
        verificationState: "native-grant-unwrapped-and-marker-decrypted-v1",
      });
      expect(api.principals.get(legacyPrincipalId)?.state).toBe("approved");
      expect(api.grants.get(legacyPrincipalId)?.[0]).toEqual(legacyGrant);
      expect(states).toContain("migrating-legacy-device");
      expect(states.at(-1)).toBe("ready");

      const nativeOnly = new ClientEncryptionService({
        load: () => Promise.reject(new Error("legacy storage not used")),
        save: () => Promise.reject(new Error("legacy storage not used")),
      });
      await expect(
        prepareClientEncryption({
          api,
          authMode: "accounts",
          durableStorage: storage,
          identity,
          runtimePlatform,
          service: nativeOnly,
        }),
      ).resolves.toEqual({ status: "ready" });
      expect(nativeOnly.getSnapshot()).toMatchObject({
        clientId: binding!.principalId,
        status: "ready",
      });
    },
  );

  it.each(["tauri", "capacitor-ios", "capacitor-android"] as const)(
    "recovers an existing account on %s with its password without initializing a blank profile",
    async (runtimePlatform) => {
      const api = new MemoryAccountEncryptionApi(password);
      await initializeLegacyAccount({
        api,
        store: new MemoryDeviceKeyStore(),
      });
      const initializationAttempts = api.initializationAttempts;
      const storage = durableStorage();
      const create = vi.spyOn(storage.provider, "create");
      const service = new ClientEncryptionService(new MemoryDeviceKeyStore());

      await expect(
        prepareClientEncryption({
          api,
          authMode: "accounts",
          durableStorage: storage,
          identity,
          runtimePlatform,
          service,
        }),
      ).resolves.toEqual({
        credential: "password",
        reason: "recover-device",
        status: "credential-required",
      });
      await expect(storage.catalog.getInstallation()).resolves.toBeNull();
      expect(create).not.toHaveBeenCalled();
      expect(api.initializationAttempts).toBe(initializationAttempts);

      await expect(
        prepareClientEncryption({
          api,
          authMode: "accounts",
          durableStorage: storage,
          identity,
          password: "incorrect password",
          runtimePlatform,
          service,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(storage.catalog.getInstallation()).resolves.toBeNull();
      expect(create).not.toHaveBeenCalled();

      await expect(
        prepareClientEncryption({
          api,
          authMode: "accounts",
          durableStorage: storage,
          identity,
          password,
          runtimePlatform,
          service,
        }),
      ).resolves.toEqual({ status: "ready" });
      expect(create).toHaveBeenCalledTimes(1);
      expect(api.initializationAttempts).toBe(initializationAttempts);
      expect(
        await storage.catalog.getAccountBinding(
          identity.serverId,
          identity.ownerId,
        ),
      ).toMatchObject({ principalId: service.getSnapshot().clientId });
    },
  );

  it("resumes after an ambiguous grant response without creating another principal", async () => {
    class InterruptedGrantApi extends MemoryAccountEncryptionApi {
      interrupt = true;

      override async createGrant(
        principalId: string,
        input: EncryptionKeyGrantCreate,
      ): Promise<EncryptionKeyGrant> {
        const grant = await super.createGrant(principalId, input);
        if (this.interrupt) {
          this.interrupt = false;
          throw new Error("connection lost after grant commit");
        }
        return grant;
      }
    }

    const api = new InterruptedGrantApi(password);
    const legacyStore = new MemoryDeviceKeyStore();
    await initializeLegacyAccount({ api, store: legacyStore });
    const legacyPrincipalCount = api.principals.size;
    const storage = durableStorage();

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        durableStorage: storage,
        identity,
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(legacyStore),
      }),
    ).rejects.toThrow(/connection lost/iu);
    await expect(
      storage.catalog.getAccountBinding(identity.serverId, identity.ownerId),
    ).resolves.toBeNull();
    const interruptedInstallation = await storage.catalog.getInstallation();
    const interruptedPrincipalId = await installationBindingPrincipalId({
      identity,
      installationId: interruptedInstallation!.installationId,
    });
    await expect(
      storage.catalog.getMigration(
        `legacy-indexeddb-v1:${interruptedPrincipalId}`,
      ),
    ).resolves.toMatchObject({
      completedAt: null,
      state: "in-progress",
    });

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        durableStorage: storage,
        identity,
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(legacyStore),
      }),
    ).resolves.toEqual({ status: "ready" });
    expect(api.principals.size).toBe(legacyPrincipalCount + 1);
    const binding = await storage.catalog.getAccountBinding(
      identity.serverId,
      identity.ownerId,
    );
    expect(api.grants.get(binding!.principalId)).toHaveLength(1);
  });

  it("preserves an anonymous profile and enters a precise recovery state when custody is missing", async () => {
    const api = new MemoryAccountEncryptionApi("unused");
    const startupPhases: string[] = [];
    await initializeLegacyAccount({
      api,
      authMode: "none",
      store: new MemoryDeviceKeyStore(),
    });
    const initializationAttempts = api.initializationAttempts;
    const storage = durableStorage();

    await expect(
      prepareClientEncryption({
        api,
        authMode: "none",
        durableStorage: storage,
        identity,
        onStartupState: (state) => startupPhases.push(state.phase),
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
      }),
    ).resolves.toMatchObject({
      reason: "anonymous-device-missing",
      status: "recovery-required",
    });
    await expect(storage.catalog.getInstallation()).resolves.toBeNull();
    expect(api.initializationAttempts).toBe(initializationAttempts);
    expect(startupPhases.at(-1)).toBe("recovery-required");
  });

  it("imports an anonymous recovery file into a new installation without initializing a blank profile", async () => {
    const api = new MemoryAccountEncryptionApi("unused");
    const sourceStorage = durableStorage();
    const sourceService = new ClientEncryptionService(
      new MemoryDeviceKeyStore(),
    );
    const initial = await prepareClientEncryption({
      api,
      authMode: "none",
      durableStorage: sourceStorage,
      identity,
      runtimePlatform: "tauri",
      service: sourceService,
    });
    expect(initial.status).toBe("recovery-artifact-required");
    if (initial.status !== "recovery-artifact-required") {
      throw new Error("Expected an anonymous recovery artifact.");
    }
    const artifactText = serializeAnonymousRecoveryArtifact(initial.artifact);
    const initializationAttempts = api.initializationAttempts;

    const rejectedStorage = durableStorage();
    const rejectedCreate = vi.spyOn(rejectedStorage.provider, "create");
    const recoverySecret = initial.artifact.recoverySecret;
    const tamperedArtifactText = serializeAnonymousRecoveryArtifact({
      ...initial.artifact,
      recoverySecret: `${recoverySecret[0] === "A" ? "B" : "A"}${recoverySecret.slice(1)}`,
    });
    await expect(
      recoverAnonymousClientEncryption({
        api,
        artifactText: tamperedArtifactText,
        durableStorage: rejectedStorage,
        identity,
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
      }),
    ).rejects.toBeInstanceOf(ClientEncryptionError);
    await expect(rejectedStorage.catalog.getInstallation()).resolves.toBeNull();
    expect(rejectedCreate).not.toHaveBeenCalled();

    const replacementStorage = durableStorage();
    const replacementService = new ClientEncryptionService(
      new MemoryDeviceKeyStore(),
    );
    await expect(
      prepareClientEncryption({
        api,
        authMode: "none",
        durableStorage: replacementStorage,
        identity,
        runtimePlatform: "tauri",
        service: replacementService,
      }),
    ).resolves.toMatchObject({ status: "recovery-required" });

    await recoverAnonymousClientEncryption({
      api,
      artifactText,
      durableStorage: replacementStorage,
      identity,
      runtimePlatform: "tauri",
      service: replacementService,
    });

    expect(api.initializationAttempts).toBe(initializationAttempts);
    expect(replacementService.getSnapshot()).toMatchObject({
      identity,
      masterKeyRevision: 1,
      status: "ready",
    });
    await expect(
      replacementStorage.catalog.getAccountBinding(
        identity.serverId,
        identity.ownerId,
      ),
    ).resolves.toMatchObject({
      principalId: replacementService.getSnapshot().clientId,
    });
  });

  it("uses an anonymous recovery file to replace missing custody without replacing the installation", async () => {
    const api = new MemoryAccountEncryptionApi("unused");
    const backend = new MemoryClientDeviceKeyBackend();
    const provider = new MemoryClientDeviceKeyProvider(backend);
    const storage = {
      catalog: new MemoryInstallationCatalog(),
      provider,
    };
    const initial = await prepareClientEncryption({
      api,
      authMode: "none",
      durableStorage: storage,
      identity,
      runtimePlatform: "tauri",
      service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
    });
    if (initial.status !== "recovery-artifact-required") {
      throw new Error("Expected an anonymous recovery artifact.");
    }
    const artifactText = serializeAnonymousRecoveryArtifact(initial.artifact);
    const installation = await storage.catalog.getInstallation();
    const keyAlias = installationKeyAlias(installation!.installationId);
    const originalBinding = await storage.catalog.getAccountBinding(
      identity.serverId,
      identity.ownerId,
    );
    backend.removeForTests(keyAlias);

    await expect(
      prepareClientEncryption({
        api,
        authMode: "none",
        durableStorage: storage,
        identity,
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
      }),
    ).resolves.toMatchObject({
      reason: "anonymous-device-missing",
      status: "recovery-required",
    });
    await recoverAnonymousClientEncryption({
      api,
      artifactText,
      durableStorage: storage,
      identity,
      runtimePlatform: "tauri",
      service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
    });

    const replacementBinding = await storage.catalog.getAccountBinding(
      identity.serverId,
      identity.ownerId,
    );
    expect((await storage.catalog.getInstallation())?.installationId).toBe(
      installation?.installationId,
    );
    expect(replacementBinding?.keyAlias).toBe(keyAlias);
    expect(replacementBinding?.principalId).not.toBe(
      originalBinding?.principalId,
    );
    expect(api.initializationAttempts).toBe(1);
    await expect(
      prepareClientEncryption({
        api,
        authMode: "none",
        durableStorage: storage,
        identity,
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
      }),
    ).resolves.toEqual({ status: "ready" });
  });

  it("rejects anonymous recovery files for another server without changing server state", async () => {
    const api = new MemoryAccountEncryptionApi("unused");
    const sourceStorage = durableStorage();
    const initial = await prepareClientEncryption({
      api,
      authMode: "none",
      durableStorage: sourceStorage,
      identity,
      runtimePlatform: "tauri",
      service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
    });
    if (initial.status !== "recovery-artifact-required") {
      throw new Error("Expected an anonymous recovery artifact.");
    }
    const principalCount = api.principals.size;

    await expect(
      recoverAnonymousClientEncryption({
        api,
        artifactText: serializeAnonymousRecoveryArtifact({
          ...initial.artifact,
          serverId: "server-b",
        }),
        durableStorage: durableStorage(),
        identity,
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
      }),
    ).rejects.toMatchObject({ code: "identity-mismatch" });
    expect(api.principals.size).toBe(principalCount);
  });

  it("derives distinct stable binding principals without changing the installation key", async () => {
    const installationId = "70da22b4-0474-4680-8cdd-e22715783621";
    const first = await installationBindingPrincipalId({
      identity,
      installationId,
    });
    const repeated = await installationBindingPrincipalId({
      identity,
      installationId,
    });
    const otherServer = await installationBindingPrincipalId({
      identity: { ...identity, serverId: "server-b" },
      installationId,
    });

    expect(repeated).toBe(first);
    expect(otherServer).not.toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("uses one installation key for independent server bindings", async () => {
    const storage = durableStorage();
    const firstApi = new MemoryAccountEncryptionApi(password);
    const secondApi = new MemoryAccountEncryptionApi(password);
    const secondIdentity = { ...identity, serverId: "server-b" };

    await prepareClientEncryption({
      api: firstApi,
      authMode: "accounts",
      durableStorage: storage,
      identity,
      password,
      passwordKdf: testKdf(),
      runtimePlatform: "tauri",
      service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
    });
    await prepareClientEncryption({
      api: secondApi,
      authMode: "accounts",
      durableStorage: storage,
      identity: secondIdentity,
      password,
      passwordKdf: testKdf(),
      runtimePlatform: "tauri",
      service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
    });

    const bindings = await storage.catalog.listAccountBindings();
    expect(bindings).toHaveLength(2);
    expect(bindings[0]!.keyAlias).toBe(bindings[1]!.keyAlias);
    expect(bindings[0]!.principalId).not.toBe(bindings[1]!.principalId);
    expect((await storage.catalog.getInstallation())?.installationId).toBe(
      bindings[0]!.keyAlias.split(".")[2],
    );
  });

  it("replaces a missing cataloged key only after password recovery unlocks the existing profile", async () => {
    const api = new MemoryAccountEncryptionApi(password);
    const backend = new MemoryClientDeviceKeyBackend();
    const provider = new MemoryClientDeviceKeyProvider(backend);
    const storage = {
      catalog: new MemoryInstallationCatalog(),
      provider,
    };
    await prepareClientEncryption({
      api,
      authMode: "accounts",
      durableStorage: storage,
      identity,
      password,
      passwordKdf: testKdf(),
      runtimePlatform: "tauri",
      service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
    });
    const installation = await storage.catalog.getInstallation();
    const keyAlias = installationKeyAlias(installation!.installationId);
    const originalDevice = await provider.inspect(keyAlias);
    const originalBinding = await storage.catalog.getAccountBinding(
      identity.serverId,
      identity.ownerId,
    );
    backend.removeForTests(keyAlias);

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        durableStorage: storage,
        identity,
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
      }),
    ).resolves.toMatchObject({
      reason: "recover-device",
      status: "credential-required",
    });
    await expect(provider.inspect(keyAlias)).resolves.toBeNull();

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        durableStorage: storage,
        identity,
        password,
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
      }),
    ).resolves.toEqual({ status: "ready" });
    const replacement = await provider.inspect(keyAlias);
    const replacementBinding = await storage.catalog.getAccountBinding(
      identity.serverId,
      identity.ownerId,
    );
    expect((await storage.catalog.getInstallation())?.installationId).toBe(
      installation?.installationId,
    );
    expect(replacement?.keyAlias).toBe(keyAlias);
    expect(replacement?.publicKey).not.toEqual(originalDevice?.publicKey);
    expect(replacementBinding?.principalId).not.toBe(
      originalBinding?.principalId,
    );
    expect(api.initializationAttempts).toBe(1);
  });

  it("resumes an interrupted key replacement without creating another installation", async () => {
    class InterruptedReplacementProvider extends MemoryClientDeviceKeyProvider {
      interrupt = true;

      override async replaceMissing(
        input: Parameters<MemoryClientDeviceKeyProvider["replaceMissing"]>[0],
      ) {
        const device = await super.replaceMissing(input);
        if (this.interrupt) {
          this.interrupt = false;
          throw new Error("connection lost after secure key replacement");
        }
        return device;
      }
    }

    const api = new MemoryAccountEncryptionApi(password);
    const backend = new MemoryClientDeviceKeyBackend();
    const provider = new InterruptedReplacementProvider(backend);
    const storage = {
      catalog: new MemoryInstallationCatalog(),
      provider,
    };
    await prepareClientEncryption({
      api,
      authMode: "accounts",
      durableStorage: storage,
      identity,
      password,
      passwordKdf: testKdf(),
      runtimePlatform: "tauri",
      service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
    });
    const installation = await storage.catalog.getInstallation();
    const keyAlias = installationKeyAlias(installation!.installationId);
    backend.removeForTests(keyAlias);

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        durableStorage: storage,
        identity,
        password,
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
      }),
    ).rejects.toThrow(/connection lost after secure key replacement/iu);
    await expect(
      storage.catalog.getMigration(`device-key-replacement-v1:${keyAlias}`),
    ).resolves.toMatchObject({ state: "in-progress" });

    await expect(
      prepareClientEncryption({
        api,
        authMode: "accounts",
        durableStorage: storage,
        identity,
        password,
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
      }),
    ).resolves.toEqual({ status: "ready" });
    expect((await storage.catalog.getInstallation())?.installationId).toBe(
      installation?.installationId,
    );
    await expect(
      storage.catalog.getMigration(`device-key-replacement-v1:${keyAlias}`),
    ).resolves.toMatchObject({ state: "verified" });
    expect(api.initializationAttempts).toBe(1);
  });
});
