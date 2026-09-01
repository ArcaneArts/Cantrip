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
import {
  MemoryClientDeviceKeyBackend,
  MemoryClientDeviceKeyProvider,
} from "./client-device-key-provider";
import { installationBindingPrincipalId } from "./durable-account-encryption";
import { MemoryInstallationCatalog } from "./installation-catalog";

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
  initializationAttempts = 0;
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

describe("durable native account encryption", () => {
  function durableStorage() {
    const backend = new MemoryClientDeviceKeyBackend();
    return {
      catalog: new MemoryInstallationCatalog(),
      provider: new MemoryClientDeviceKeyProvider(backend),
    };
  }

  async function initializeLegacyAccount(input: {
    api: MemoryAccountEncryptionApi;
    authMode?: "accounts" | "none";
    store: MemoryDeviceKeyStore;
  }) {
    const service = new ClientEncryptionService(input.store);
    await prepareClientEncryption({
      api: input.api,
      authMode: input.authMode ?? "accounts",
      identity,
      password: input.authMode === "none" ? undefined : password,
      passwordKdf: testKdf(),
      runtimePlatform: "browser",
      service,
    });
    service.lock();
  }

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
        delete: () => Promise.reject(new Error("legacy storage not used")),
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
        reason: "authorize-device",
        status: "credential-required",
      });
      expect(api.initializationAttempts).toBe(initializationAttempts);

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

    await expect(
      prepareClientEncryption({
        api,
        authMode: "none",
        durableStorage: durableStorage(),
        identity,
        onStartupState: (state) => startupPhases.push(state.phase),
        runtimePlatform: "tauri",
        service: new ClientEncryptionService(new MemoryDeviceKeyStore()),
      }),
    ).resolves.toMatchObject({
      reason: "anonymous-binding-missing",
      status: "recovery-required",
    });
    expect(api.initializationAttempts).toBe(initializationAttempts);
    expect(startupPhases.at(-1)).toBe("recovery-required");
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

  it("does not regenerate a cataloged native key that disappears from secure storage", async () => {
    class LossSimulatingProvider extends MemoryClientDeviceKeyProvider {
      createCalls = 0;
      lost = false;

      override create(
        input: Parameters<MemoryClientDeviceKeyProvider["create"]>[0],
      ) {
        this.createCalls += 1;
        return super.create(input);
      }

      override inspect(keyAlias: string) {
        return this.lost ? Promise.resolve(null) : super.inspect(keyAlias);
      }
    }

    const api = new MemoryAccountEncryptionApi(password);
    const provider = new LossSimulatingProvider(
      new MemoryClientDeviceKeyBackend(),
    );
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
    provider.lost = true;

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
    ).rejects.toMatchObject({ code: "device-not-found" });
    expect(provider.createCalls).toBe(1);
    expect(api.initializationAttempts).toBe(1);
  });
});
