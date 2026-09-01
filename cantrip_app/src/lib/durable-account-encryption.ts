import {
  bytesEqual,
  clearSensitiveBytes,
  decryptPayload,
  encryptPayload,
  generateAccountMasterKey,
} from "@cantrip/crypto";
import type { AuthMode } from "@cantrip/protocol";
import type {
  AccountEncryptionProfile,
  AccountEncryptionProfileInitializeResult,
  EncryptionKeyGrant,
  EncryptionPrincipal,
  EncryptedPayloadEnvelope,
  PasswordKdfParameters,
} from "@cantrip/protocol/encryption";

import { CantripApiError } from "./api-client";
import type {
  AccountEncryptionApi,
  ClientEncryptionAccess,
} from "./account-encryption";
import type {
  ClientDeviceKeyDescriptor,
  ClientDeviceKeyProvider,
} from "./client-device-key-provider";
import {
  ClientEncryptionError,
  type ClientDeviceDescriptor,
  type ClientEncryptionIdentity,
  type ClientEncryptionService,
} from "./client-encryption";
import {
  beginClientEncryptionStartup,
  transitionClientEncryptionStartup,
  type ClientEncryptionStartupBinding,
  type ClientEncryptionStartupEvent,
  type ClientEncryptionStartupState,
} from "./client-encryption-startup";
import {
  installationCatalogSchemaVersion,
  installationDeviceKeyVersion,
  installationKeyAlias,
  type InstallationAccountBinding,
  type InstallationCatalog,
  type InstallationDeviceKey,
  type InstallationMigration,
  type InstallationProfile,
} from "./installation-catalog";

export type DurableClientEncryptionStorage = {
  catalog: InstallationCatalog;
  provider: ClientDeviceKeyProvider;
};

export type PrepareDurableClientEncryptionInput = {
  api: AccountEncryptionApi;
  authMode: AuthMode;
  identity: ClientEncryptionIdentity;
  onStartupState?: (state: ClientEncryptionStartupState) => void;
  password?: string;
  passwordKdf?: PasswordKdfParameters;
  service: ClientEncryptionService;
  storage: DurableClientEncryptionStorage;
};

type WithoutGeneration<Event> = Event extends unknown
  ? Omit<Event, "generation">
  : never;

type StartupDriver = {
  emit(event: WithoutGeneration<ClientEncryptionStartupEvent>): void;
  state(): ClientEncryptionStartupState;
};

type NativeInstallation = {
  device: ClientDeviceKeyDescriptor | null;
  deviceMetadata: InstallationDeviceKey | null;
  keyAlias: string;
  profile: InstallationProfile;
};

type NativeAuthorization = {
  grant: EncryptionKeyGrant;
  principal: EncryptionPrincipal;
};

const bindingPrincipalNamespace = "bbf6dc9d-87b0-5f02-bd56-e9b92e96cbc8";

function startupDriver(
  input: PrepareDurableClientEncryptionInput,
): StartupDriver {
  let current = beginClientEncryptionStartup({
    authMode: input.authMode,
    generation: 1,
    identity: input.identity,
  });
  input.onStartupState?.(current);
  return {
    emit(event) {
      current = transitionClientEncryptionStartup(current, {
        ...event,
        generation: current.generation,
      } as ClientEncryptionStartupEvent);
      input.onStartupState?.(current);
    },
    state: () => current,
  };
}

function publicKeysMatch(
  left: ClientDeviceKeyDescriptor["publicKey"],
  right: ClientDeviceKeyDescriptor["publicKey"],
): boolean {
  return (
    left.version === right.version &&
    left.algorithm === right.algorithm &&
    left.format === right.format &&
    left.value === right.value
  );
}

function apiConflict(error: unknown): boolean {
  return error instanceof CantripApiError && error.status === 409;
}

function activeMasterKeyGrant(
  grants: EncryptionKeyGrant[],
  revision: number,
): EncryptionKeyGrant | null {
  return (
    grants.find(
      (grant) =>
        grant.state === "active" &&
        grant.component === "account-master-key" &&
        grant.keyRevision === revision &&
        grant.wrappedKey.purpose === "client-account-master-key",
    ) ?? null
  );
}

function uuidBytes(value: string): Uint8Array {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(hex)) {
    throw new ClientEncryptionError(
      "identity-mismatch",
      "The installation principal namespace is invalid.",
    );
  }
  return Uint8Array.from(
    hex.match(/.{2}/gu)!.map((part) => Number.parseInt(part, 16)),
  );
}

function formatUuid(bytes: Uint8Array): string {
  const value = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
}

/** Stable UUIDv5 for one installation's binding to one server account. */
export async function installationBindingPrincipalId(input: {
  identity: ClientEncryptionIdentity;
  installationId: string;
}): Promise<string> {
  const namespace = uuidBytes(bindingPrincipalNamespace);
  const name = new TextEncoder().encode(
    JSON.stringify([
      "cantrip-installation-binding-v1",
      input.installationId,
      input.identity.serverId,
      input.identity.ownerId,
    ]),
  );
  const source = new Uint8Array(namespace.byteLength + name.byteLength);
  source.set(namespace);
  source.set(name, namespace.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", source));
  const uuid = digest.slice(0, 16);
  uuid[6] = (uuid[6]! & 0x0f) | 0x50;
  uuid[8] = (uuid[8]! & 0x3f) | 0x80;
  source.fill(0);
  digest.fill(0);
  return formatUuid(uuid);
}

async function createInstallation(
  catalog: InstallationCatalog,
): Promise<InstallationProfile> {
  const existing = await catalog.getInstallation();
  if (existing) return existing;
  const profile: InstallationProfile = {
    createdAt: new Date().toISOString(),
    installationId: crypto.randomUUID(),
    schemaVersion: installationCatalogSchemaVersion,
  };
  try {
    return await catalog.transaction(async (transaction) => {
      const concurrent = await transaction.getInstallation();
      return concurrent ?? transaction.createInstallation(profile);
    });
  } catch (error) {
    const concurrent = await catalog.getInstallation();
    if (concurrent) return concurrent;
    throw error;
  }
}

function deviceMetadata(
  device: ClientDeviceKeyDescriptor,
): InstallationDeviceKey {
  return {
    createdAt: device.createdAt,
    installationId: device.installationId,
    keyAlias: device.keyAlias,
    provider: device.provider,
    publicKey: { ...device.publicKey },
    status: "active",
    version: installationDeviceKeyVersion,
  };
}

async function locateNativeDevice(
  storage: DurableClientEncryptionStorage,
  profile: InstallationProfile,
  allowCreate: boolean,
): Promise<NativeInstallation> {
  const keyAlias = installationKeyAlias(profile.installationId);
  const metadata = await storage.catalog.getDeviceKey(keyAlias);
  let device = await storage.provider.inspect(keyAlias);
  if (metadata && !device) {
    return { device: null, deviceMetadata: metadata, keyAlias, profile };
  }
  if (!device && allowCreate) {
    device = await storage.provider.create({
      installationId: profile.installationId,
      keyAlias,
    });
  }
  if (!device) {
    return { device: null, deviceMetadata: metadata, keyAlias, profile };
  }
  if (
    device.installationId !== profile.installationId ||
    device.keyAlias !== keyAlias ||
    device.provider !== storage.provider.backend ||
    (metadata &&
      (metadata.installationId !== device.installationId ||
        metadata.provider !== device.provider ||
        !publicKeysMatch(metadata.publicKey, device.publicKey) ||
        metadata.status !== "active"))
  ) {
    throw new ClientEncryptionError(
      "identity-mismatch",
      "The native installation key conflicts with its catalog metadata.",
    );
  }
  const stored = metadata ?? deviceMetadata(device);
  if (!metadata) {
    await storage.catalog.transaction((transaction) =>
      transaction.putDeviceKey(stored),
    );
  }
  return { device, deviceMetadata: stored, keyAlias, profile };
}

async function reconcilePrincipal(input: {
  api: AccountEncryptionApi;
  device: ClientDeviceKeyDescriptor;
  principalId: string;
  principals?: EncryptionPrincipal[];
}): Promise<EncryptionPrincipal> {
  let principal = (input.principals ?? (await input.api.listPrincipals())).find(
    (candidate) => candidate.id === input.principalId,
  );
  if (!principal) {
    try {
      principal = await input.api.createPrincipal({
        id: input.principalId,
        kind: "client",
        label: "Cantrip installation",
        publicKey: input.device.publicKey,
      });
    } catch (error) {
      if (!apiConflict(error)) throw error;
      principal = (await input.api.listPrincipals()).find(
        (candidate) => candidate.id === input.principalId,
      );
    }
  }
  if (
    !principal ||
    principal.kind !== "client" ||
    !publicKeysMatch(principal.publicKey, input.device.publicKey)
  ) {
    throw new ClientEncryptionError(
      "identity-mismatch",
      "This installation binding conflicts with another encryption key.",
    );
  }
  if (principal.state === "pending") {
    try {
      principal = await input.api.approvePrincipal(
        principal.id,
        principal.revision,
      );
    } catch (error) {
      if (!apiConflict(error)) throw error;
      principal = (await input.api.listPrincipals()).find(
        (candidate) => candidate.id === input.principalId,
      );
    }
  }
  if (!principal || principal.state !== "approved") {
    throw new ClientEncryptionError(
      "principal-unavailable",
      "This installation binding is not approved for encryption.",
    );
  }
  return principal;
}

async function provisionNativeAuthorization(input: {
  api: AccountEncryptionApi;
  device: ClientDeviceKeyDescriptor;
  identity: ClientEncryptionIdentity;
  principalId: string;
  principals?: EncryptionPrincipal[];
  service: ClientEncryptionService;
}): Promise<NativeAuthorization> {
  const principal = await reconcilePrincipal(input);
  const revision = input.service.getSnapshot().masterKeyRevision;
  if (!revision) {
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked before provisioning an installation binding.",
    );
  }
  let grant = activeMasterKeyGrant(
    await input.api.listGrants(principal.id),
    revision,
  );
  if (!grant) {
    const wrappedKey = await input.service.createDeviceWrapperFor({
      clientId: principal.id,
      identity: input.identity,
      publicKey: input.device.publicKey,
    });
    try {
      grant = await input.api.createGrant(principal.id, {
        component: "account-master-key",
        keyRevision: revision,
        wrappedKey,
      });
    } catch (error) {
      if (!apiConflict(error)) throw error;
      grant = activeMasterKeyGrant(
        await input.api.listGrants(principal.id),
        revision,
      );
    }
  }
  if (!grant) {
    throw new ClientEncryptionError(
      "principal-unavailable",
      "The installation's Account Master Key grant is unavailable.",
    );
  }
  return { grant, principal };
}

function startupBinding(input: {
  grant: EncryptionKeyGrant;
  keyAlias: string;
  principal: EncryptionPrincipal;
}): ClientEncryptionStartupBinding {
  return {
    grantRevision: input.grant.revision,
    keyAlias: input.keyAlias,
    masterKeyRevision: input.grant.keyRevision,
    principalId: input.principal.id,
  };
}

function bindingRecord(input: {
  authorization: NativeAuthorization;
  identity: ClientEncryptionIdentity;
  keyAlias: string;
}): InstallationAccountBinding {
  return {
    ...startupBinding({
      ...input.authorization,
      keyAlias: input.keyAlias,
    }),
    ownerId: input.identity.ownerId,
    serverId: input.identity.serverId,
    updatedAt: new Date().toISOString(),
  };
}

function startupBindingFromRecord(
  binding: InstallationAccountBinding,
): ClientEncryptionStartupBinding {
  return {
    grantRevision: binding.grantRevision,
    keyAlias: binding.keyAlias,
    masterKeyRevision: binding.masterKeyRevision,
    principalId: binding.principalId,
  };
}

function bindingIdentityMatches(
  existing: InstallationAccountBinding,
  candidate: InstallationAccountBinding,
): boolean {
  return (
    existing.serverId === candidate.serverId &&
    existing.ownerId === candidate.ownerId &&
    existing.principalId === candidate.principalId &&
    existing.keyAlias === candidate.keyAlias
  );
}

async function commitBinding(
  catalog: InstallationCatalog,
  binding: InstallationAccountBinding,
  migration?: InstallationMigration,
): Promise<void> {
  await catalog.transaction(async (transaction) => {
    const existing = await transaction.getAccountBinding(
      binding.serverId,
      binding.ownerId,
    );
    if (existing && !bindingIdentityMatches(existing, binding)) {
      throw new ClientEncryptionError(
        "identity-mismatch",
        "The installation catalog contains a conflicting account binding.",
      );
    }
    if (
      existing &&
      (binding.masterKeyRevision < existing.masterKeyRevision ||
        (binding.masterKeyRevision === existing.masterKeyRevision &&
          binding.grantRevision < existing.grantRevision))
    ) {
      throw new ClientEncryptionError(
        "identity-mismatch",
        "The installation catalog rejected a stale account binding.",
      );
    }
    await transaction.putAccountBinding(binding);
    if (migration) await transaction.putMigration(migration);
  });
}

async function findNativeAuthorization(input: {
  api: AccountEncryptionApi;
  binding: InstallationAccountBinding;
  device: ClientDeviceKeyDescriptor;
  masterKeyRevision: number;
}): Promise<NativeAuthorization | null> {
  if (
    input.binding.keyAlias !== input.device.keyAlias ||
    input.binding.masterKeyRevision !== input.masterKeyRevision
  ) {
    return null;
  }
  const principal = (await input.api.listPrincipals()).find(
    (candidate) => candidate.id === input.binding.principalId,
  );
  if (!principal || principal.state !== "approved") return null;
  if (!publicKeysMatch(principal.publicKey, input.device.publicKey)) {
    throw new ClientEncryptionError(
      "identity-mismatch",
      "The stored installation binding conflicts with its server principal.",
    );
  }
  const grant = activeMasterKeyGrant(
    await input.api.listGrants(principal.id),
    input.masterKeyRevision,
  );
  return grant ? { grant, principal } : null;
}

async function legacyDeviceStatus(
  service: ClientEncryptionService,
  identity: ClientEncryptionIdentity,
): Promise<
  | { device: ClientDeviceDescriptor; status: "available" }
  | { status: "corrupt" | "missing" | "unsupported" }
> {
  try {
    const device = await service.loadDevice(identity);
    return device ? { device, status: "available" } : { status: "missing" };
  } catch (error) {
    if (error instanceof ClientEncryptionError) {
      if (error.code === "unsupported-version")
        return { status: "unsupported" };
      if (error.code === "corrupt-device-record") return { status: "corrupt" };
    }
    throw error;
  }
}

async function unlockLegacy(input: {
  api: AccountEncryptionApi;
  device: ClientDeviceDescriptor;
  identity: ClientEncryptionIdentity;
  profile: AccountEncryptionProfile;
  service: ClientEncryptionService;
}): Promise<boolean> {
  const principal = (await input.api.listPrincipals()).find(
    (candidate) => candidate.id === input.device.clientId,
  );
  if (
    !principal ||
    principal.state !== "approved" ||
    !publicKeysMatch(principal.publicKey, input.device.publicKey)
  ) {
    return false;
  }
  const grant = activeMasterKeyGrant(
    await input.api.listGrants(principal.id),
    input.profile.activeMasterKeyRevision,
  );
  if (!grant) return false;
  await input.service.unlockWithDevice({
    grant,
    identity: input.identity,
    principal,
  });
  return true;
}

function migrationId(principalId: string): string {
  return `legacy-indexeddb-v1:${principalId}`;
}

const migrationMarkerPlaintext = new TextEncoder().encode(
  "cantrip-native-migration-verification-v1",
);

function migrationMarkerAssociatedData(input: {
  identity: ClientEncryptionIdentity;
  migrationId: string;
  revision: number;
}) {
  return {
    component: "client-control-content" as const,
    field: "verification_marker",
    formatVersion: 1 as const,
    keyRevision: input.revision,
    ownerId: input.identity.ownerId,
    rowId: input.migrationId,
    table: "installation_migration",
  };
}

async function createMigrationMarker(input: {
  identity: ClientEncryptionIdentity;
  migrationId: string;
  service: ClientEncryptionService;
}): Promise<EncryptedPayloadEnvelope> {
  const revision = input.service.getSnapshot().masterKeyRevision;
  if (!revision) {
    throw new ClientEncryptionError(
      "locked",
      "The legacy Account Master Key is unavailable for migration verification.",
    );
  }
  const key = input.service.componentKey({
    component: "client-control-content",
    identity: input.identity,
    keyRevision: revision,
  });
  try {
    return await encryptPayload({
      associatedData: migrationMarkerAssociatedData({
        identity: input.identity,
        migrationId: input.migrationId,
        revision,
      }),
      key,
      plaintext: migrationMarkerPlaintext,
    });
  } finally {
    clearSensitiveBytes(key);
  }
}

async function verifyMigrationMarker(input: {
  envelope: EncryptedPayloadEnvelope;
  identity: ClientEncryptionIdentity;
  migrationId: string;
  service: ClientEncryptionService;
}): Promise<void> {
  const revision = input.service.getSnapshot().masterKeyRevision;
  if (!revision) {
    throw new ClientEncryptionError(
      "locked",
      "The native Account Master Key is unavailable for migration verification.",
    );
  }
  const key = input.service.componentKey({
    component: "client-control-content",
    identity: input.identity,
    keyRevision: revision,
  });
  let opened: Uint8Array | null = null;
  try {
    opened = await decryptPayload({
      associatedData: migrationMarkerAssociatedData({
        identity: input.identity,
        migrationId: input.migrationId,
        revision,
      }),
      envelope: input.envelope,
      key,
    });
    if (!bytesEqual(opened, migrationMarkerPlaintext)) {
      throw new ClientEncryptionError(
        "decryption-failed",
        "The native installation key failed migration marker verification.",
      );
    }
  } finally {
    clearSensitiveBytes(key);
    if (opened) clearSensitiveBytes(opened);
  }
}

async function markMigrationStarted(input: {
  catalog: InstallationCatalog;
  migrationId: string;
}): Promise<InstallationMigration> {
  return input.catalog.transaction(async (transaction) => {
    const existing = await transaction.getMigration(input.migrationId);
    if (existing?.state === "verified") return existing;
    const migration: InstallationMigration = {
      completedAt: null,
      migrationId: input.migrationId,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      state: "in-progress",
      verificationState: "legacy-account-master-key-unlocked-v1",
    };
    await transaction.putMigration(migration);
    return migration;
  });
}

async function migrateLegacyDevice(input: {
  api: AccountEncryptionApi;
  device: ClientDeviceKeyDescriptor;
  identity: ClientEncryptionIdentity;
  keyAlias: string;
  principalId: string;
  service: ClientEncryptionService;
  storage: DurableClientEncryptionStorage;
}): Promise<{
  binding: InstallationAccountBinding;
  migration: InstallationMigration;
}> {
  const id = migrationId(input.principalId);
  const started = await markMigrationStarted({
    catalog: input.storage.catalog,
    migrationId: id,
  });
  const verificationMarker = await createMigrationMarker({
    identity: input.identity,
    migrationId: id,
    service: input.service,
  });
  const authorization = await provisionNativeAuthorization(input);
  await input.service.unlockWithKeyProvider({
    device: input.device,
    grant: authorization.grant,
    identity: input.identity,
    principal: authorization.principal,
    provider: input.storage.provider,
    verifyCurrentMasterKey: true,
  });
  await verifyMigrationMarker({
    envelope: verificationMarker,
    identity: input.identity,
    migrationId: id,
    service: input.service,
  });
  const binding = bindingRecord({
    authorization,
    identity: input.identity,
    keyAlias: input.keyAlias,
  });
  const migration: InstallationMigration = {
    ...started,
    completedAt: new Date().toISOString(),
    state: "verified",
    verificationState: "native-grant-unwrapped-and-marker-decrypted-v1",
  };
  await commitBinding(input.storage.catalog, binding, migration);
  return { binding, migration };
}

async function recoverAccount(input: {
  api: AccountEncryptionApi;
  device: ClientDeviceKeyDescriptor;
  identity: ClientEncryptionIdentity;
  keyAlias: string;
  password: string;
  principalId: string;
  profile: AccountEncryptionProfile;
  service: ClientEncryptionService;
  storage: DurableClientEncryptionStorage;
}): Promise<InstallationAccountBinding> {
  if (!input.profile.passwordWrappedMasterKey) {
    throw new ClientEncryptionError(
      "locked",
      "This account does not have password recovery configured.",
    );
  }
  await input.api.reauthenticate(input.password);
  await input.service.unlockWithPassword({
    identity: input.identity,
    password: input.password,
    wrapper: input.profile.passwordWrappedMasterKey,
  });
  const authorization = await provisionNativeAuthorization(input);
  await input.service.unlockWithKeyProvider({
    device: input.device,
    grant: authorization.grant,
    identity: input.identity,
    principal: authorization.principal,
    provider: input.storage.provider,
    verifyCurrentMasterKey: true,
  });
  const binding = bindingRecord({
    authorization,
    identity: input.identity,
    keyAlias: input.keyAlias,
  });
  await commitBinding(input.storage.catalog, binding);
  return binding;
}

async function initializeNativeProfile(input: {
  api: AccountEncryptionApi;
  authMode: AuthMode;
  device: ClientDeviceKeyDescriptor;
  identity: ClientEncryptionIdentity;
  keyAlias: string;
  password?: string;
  passwordKdf?: PasswordKdfParameters;
  principalId: string;
  service: ClientEncryptionService;
  storage: DurableClientEncryptionStorage;
}): Promise<{
  binding: InstallationAccountBinding;
  result: AccountEncryptionProfileInitializeResult;
}> {
  const accountPassword =
    input.authMode === "none" ? undefined : input.password;
  if (input.authMode !== "none" && !accountPassword) {
    throw new ClientEncryptionError(
      "locked",
      "Normal sign-in is required to initialize private data encryption.",
    );
  }
  if (accountPassword) await input.api.reauthenticate(accountPassword);
  const accountMasterKey = generateAccountMasterKey();
  try {
    input.service.setAccountMasterKey({
      accountMasterKey,
      identity: input.identity,
      masterKeyRevision: 1,
    });
    const passwordWrappedMasterKey = accountPassword
      ? await input.service.createPasswordWrapper({
          identity: input.identity,
          password: accountPassword,
          kdf: input.passwordKdf,
        })
      : null;
    const result = await input.api.initializeProfile({
      profile: {
        activeMasterKeyRevision: 1,
        formatVersion: 1,
        passwordKdf: passwordWrappedMasterKey?.kdf ?? null,
        passwordWrappedMasterKey,
        payloadMigrationStatus: "complete",
      },
      initialClient: {
        id: input.principalId,
        label: "Cantrip installation",
        publicKey: input.device.publicKey,
        wrappedMasterKey: await input.service.createDeviceWrapperFor({
          clientId: input.principalId,
          identity: input.identity,
          publicKey: input.device.publicKey,
        }),
      },
    });
    if (!result.created) {
      input.service.lock();
      if (input.authMode === "none") {
        const authorization = await findNativeAuthorization({
          api: input.api,
          binding: {
            grantRevision: 1,
            keyAlias: input.keyAlias,
            masterKeyRevision: result.profile.activeMasterKeyRevision,
            ownerId: input.identity.ownerId,
            principalId: input.principalId,
            serverId: input.identity.serverId,
            updatedAt: new Date().toISOString(),
          },
          device: input.device,
          masterKeyRevision: result.profile.activeMasterKeyRevision,
        });
        if (!authorization) {
          throw new ClientEncryptionError(
            "locked",
            "Anonymous encryption was initialized elsewhere and requires its existing device key or recovery artifact.",
          );
        }
        await input.service.unlockWithKeyProvider({
          device: input.device,
          grant: authorization.grant,
          identity: input.identity,
          principal: authorization.principal,
          provider: input.storage.provider,
        });
        const binding = bindingRecord({
          authorization,
          identity: input.identity,
          keyAlias: input.keyAlias,
        });
        await commitBinding(input.storage.catalog, binding);
        return { binding, result };
      }
      const binding = await recoverAccount({
        ...input,
        password: accountPassword!,
        profile: result.profile,
      });
      return { binding, result };
    }
    await input.service.unlockWithKeyProvider({
      device: input.device,
      grant: result.grant,
      identity: input.identity,
      principal: result.principal,
      provider: input.storage.provider,
      verifyCurrentMasterKey: true,
    });
    const binding = bindingRecord({
      authorization: { grant: result.grant, principal: result.principal },
      identity: input.identity,
      keyAlias: input.keyAlias,
    });
    await commitBinding(input.storage.catalog, binding);
    return { binding, result };
  } finally {
    clearSensitiveBytes(accountMasterKey);
  }
}

function recoveryAccess(
  reason:
    | "anonymous-binding-missing"
    | "anonymous-device-missing"
    | "legacy-device-corrupt"
    | "legacy-device-unsupported",
): ClientEncryptionAccess {
  const messages = {
    "anonymous-binding-missing":
      "This anonymous profile is not authorized for the native installation key. Import its recovery artifact to continue.",
    "anonymous-device-missing":
      "This anonymous profile's device key is missing. Import its recovery artifact to continue; without it the encrypted data is unrecoverable.",
    "legacy-device-corrupt":
      "The legacy device registration is corrupt. Import the anonymous recovery artifact to continue.",
    "legacy-device-unsupported":
      "The legacy device registration requires a compatible Cantrip version before it can be migrated.",
  } as const;
  return { message: messages[reason], reason, status: "recovery-required" };
}

export async function prepareDurableClientEncryption(
  input: PrepareDurableClientEncryptionInput,
): Promise<ClientEncryptionAccess> {
  const startup = startupDriver(input);
  try {
    const profile = await createInstallation(input.storage.catalog);
    const keyAlias = installationKeyAlias(profile.installationId);
    const principalId = await installationBindingPrincipalId({
      identity: input.identity,
      installationId: profile.installationId,
    });
    startup.emit({
      installationId: profile.installationId,
      keyAlias,
      type: "installation-ready",
    });
    const serverProfile = await input.api.getProfile();
    if (serverProfile.status === "uninitialized") {
      startup.emit({ status: "uninitialized", type: "profile-loaded" });
      startup.emit({
        credentialAvailable:
          input.authMode === "none" || Boolean(input.password),
        type: "initialization-requested",
      });
      if (startup.state().phase === "credential-required") {
        return {
          credential: "password",
          reason: "initialize",
          status: "credential-required",
        };
      }
      const native = await locateNativeDevice(input.storage, profile, true);
      if (!native.device) {
        throw new ClientEncryptionError(
          "device-not-found",
          "The native installation key could not be created.",
        );
      }
      const initialized = await initializeNativeProfile({
        ...input,
        device: native.device,
        keyAlias,
        principalId,
      });
      startup.emit({
        binding: startupBindingFromRecord(initialized.binding),
        installationId: profile.installationId,
        type: "profile-initialized",
      });
      return { status: "ready" };
    }

    const activeRevision = serverProfile.profile.activeMasterKeyRevision;
    startup.emit({
      masterKeyRevision: activeRevision,
      status: "initialized",
      type: "profile-loaded",
    });
    const native = await locateNativeDevice(input.storage, profile, true);
    startup.emit(
      native.device
        ? { keyAlias, status: "available", type: "device-key-loaded" }
        : { status: "missing", type: "device-key-loaded" },
    );

    const localBinding = native.device
      ? await input.storage.catalog.getAccountBinding(
          input.identity.serverId,
          input.identity.ownerId,
        )
      : null;
    if (localBinding && localBinding.principalId !== principalId) {
      throw new ClientEncryptionError(
        "identity-mismatch",
        "The installation catalog contains a noncanonical account binding.",
      );
    }
    const nativeAuthorization =
      native.device && localBinding
        ? await findNativeAuthorization({
            api: input.api,
            binding: localBinding,
            device: native.device,
            masterKeyRevision: activeRevision,
          })
        : null;
    if (native.device && localBinding && nativeAuthorization) {
      const currentBinding = startupBinding({
        ...nativeAuthorization,
        keyAlias,
      });
      startup.emit({
        binding: currentBinding,
        status: "available",
        type: "binding-loaded",
      });
      await input.service.unlockWithKeyProvider({
        device: native.device,
        grant: nativeAuthorization.grant,
        identity: input.identity,
        principal: nativeAuthorization.principal,
        provider: input.storage.provider,
      });
      await commitBinding(
        input.storage.catalog,
        bindingRecord({
          authorization: nativeAuthorization,
          identity: input.identity,
          keyAlias,
        }),
      );
      startup.emit({
        binding: currentBinding,
        installationId: profile.installationId,
        type: "device-unlocked",
      });
      return { status: "ready" };
    }
    if (native.device) {
      startup.emit({ status: "missing", type: "binding-loaded" });
    }

    const legacy = await legacyDeviceStatus(input.service, input.identity);
    let legacyUnlocked = false;
    if (legacy.status === "available") {
      legacyUnlocked = await unlockLegacy({
        api: input.api,
        device: legacy.device,
        identity: input.identity,
        profile: serverProfile.profile,
        service: input.service,
      });
    }
    startup.emit({
      status:
        legacyUnlocked && native.device
          ? "available"
          : legacy.status === "available"
            ? "missing"
            : legacy.status,
      type: "legacy-device-loaded",
    });
    if (legacyUnlocked && native.device) {
      const migrated = await migrateLegacyDevice({
        ...input,
        device: native.device,
        keyAlias,
        principalId,
      });
      startup.emit({
        binding: startupBindingFromRecord(migrated.binding),
        installationId: profile.installationId,
        type: "migration-completed",
      });
      return { status: "ready" };
    }

    if (input.authMode === "none") {
      return recoveryAccess(
        legacy.status === "corrupt"
          ? "legacy-device-corrupt"
          : legacy.status === "unsupported"
            ? "legacy-device-unsupported"
            : native.device
              ? "anonymous-binding-missing"
              : "anonymous-device-missing",
      );
    }
    if (!input.password) {
      return {
        credential: "password",
        reason:
          startup.state().credentialReason === "recover-device"
            ? "recover-device"
            : "authorize-device",
        status: "credential-required",
      };
    }
    startup.emit({ type: "credential-submitted" });
    if (!native.device) {
      throw new ClientEncryptionError(
        "device-not-found",
        "The operating system installation key is missing. Cantrip preserved the catalog and did not replace it.",
      );
    }
    const binding = await recoverAccount({
      ...input,
      device: native.device,
      keyAlias,
      password: input.password,
      principalId,
      profile: serverProfile.profile,
    });
    startup.emit({
      binding: {
        grantRevision: binding.grantRevision,
        keyAlias: binding.keyAlias,
        masterKeyRevision: binding.masterKeyRevision,
        principalId: binding.principalId,
      },
      installationId: profile.installationId,
      type: "account-recovered",
    });
    return { status: "ready" };
  } catch (error) {
    if (
      !["failed", "ready", "recovery-required", "unrecoverable"].includes(
        startup.state().phase,
      )
    ) {
      startup.emit({
        reason:
          error instanceof ClientEncryptionError
            ? error.code
            : "durable-encryption-startup-failed",
        retryable:
          !(error instanceof ClientEncryptionError) ||
          error.code === "storage-unavailable",
        type: "failed",
      });
    }
    throw error;
  }
}
