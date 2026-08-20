import {
  clearSensitiveBytes,
  encodeBase64Url,
  generateAccountMasterKey,
  randomBytes,
} from "@cantrip/crypto";
import type { AuthMode } from "@cantrip/protocol";
import type {
  AccountEncryptionProfile,
  AccountEncryptionProfileInitialize,
  AccountEncryptionProfileInitializeResult,
  AccountEncryptionProfileState,
  AccountPasswordEncryptionChange,
  EncryptionKeyGrant,
  EncryptionKeyGrantCreate,
  EncryptionPrincipal,
  EncryptionPrincipalCreate,
  PasswordKdfParameters,
} from "@cantrip/protocol/encryption";

import {
  ClientEncryptionError,
  ClientEncryptionService,
  clientEncryption,
  type ClientDeviceDescriptor,
  type ClientEncryptionIdentity,
} from "./client-encryption";
import {
  approveEncryptionPrincipal,
  changeAccountPasswordWithEncryption,
  createEncryptionGrant,
  createEncryptionPrincipal,
  getAccountEncryptionProfile,
  initializeAccountEncryptionProfile,
  listEncryptionGrants,
  listEncryptionPrincipals,
  reauthenticateForEncryption,
} from "./encryption-api";
import { CantripApiError } from "./api-client";

export type ClientEncryptionCredential = "password" | "recovery-secret";

export type ClientEncryptionAccess =
  | { status: "ready" }
  | {
      credential: ClientEncryptionCredential;
      reason: "authorize-device" | "initialize";
      status: "credential-required";
    }
  | { recoverySecret: string; status: "recovery-created" };

export interface AccountEncryptionApi {
  approvePrincipal(
    principalId: string,
    expectedRevision: number,
  ): Promise<EncryptionPrincipal>;
  changePassword(
    input: AccountPasswordEncryptionChange,
  ): Promise<AccountEncryptionProfile>;
  createGrant(
    principalId: string,
    input: EncryptionKeyGrantCreate,
  ): Promise<EncryptionKeyGrant>;
  createPrincipal(
    input: EncryptionPrincipalCreate,
  ): Promise<EncryptionPrincipal>;
  getProfile(): Promise<AccountEncryptionProfileState>;
  initializeProfile(
    input: AccountEncryptionProfileInitialize,
  ): Promise<AccountEncryptionProfileInitializeResult>;
  listGrants(principalId: string): Promise<EncryptionKeyGrant[]>;
  listPrincipals(): Promise<EncryptionPrincipal[]>;
  reauthenticate(password: string): Promise<void>;
}

const defaultApi: AccountEncryptionApi = {
  approvePrincipal: approveEncryptionPrincipal,
  changePassword: changeAccountPasswordWithEncryption,
  createGrant: createEncryptionGrant,
  createPrincipal: createEncryptionPrincipal,
  getProfile: getAccountEncryptionProfile,
  initializeProfile: initializeAccountEncryptionProfile,
  listGrants: listEncryptionGrants,
  listPrincipals: listEncryptionPrincipals,
  reauthenticate: async (password) => {
    await reauthenticateForEncryption(password);
  },
};

type PrepareClientEncryptionInput = {
  api?: AccountEncryptionApi;
  authMode: AuthMode;
  identity: ClientEncryptionIdentity;
  password?: string;
  passwordKdf?: PasswordKdfParameters;
  service?: ClientEncryptionService;
};

type AuthorizeDeviceInput = {
  api: AccountEncryptionApi;
  device: ClientDeviceDescriptor;
  identity: ClientEncryptionIdentity;
  principals: EncryptionPrincipal[];
  service: ClientEncryptionService;
};

function publicKeysMatch(
  left: ClientDeviceDescriptor["publicKey"],
  right: ClientDeviceDescriptor["publicKey"],
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

function accountMasterKeyGrant(
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

async function tryDeviceUnlock(input: {
  api: AccountEncryptionApi;
  device: ClientDeviceDescriptor;
  identity: ClientEncryptionIdentity;
  profile: AccountEncryptionProfile;
  principals: EncryptionPrincipal[];
  service: ClientEncryptionService;
}): Promise<boolean> {
  const principal = input.principals.find(
    (candidate) => candidate.id === input.device.clientId,
  );
  if (
    !principal ||
    principal.state !== "approved" ||
    !publicKeysMatch(principal.publicKey, input.device.publicKey)
  ) {
    return false;
  }
  const grant = accountMasterKeyGrant(
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

async function refreshedPrincipal(
  api: AccountEncryptionApi,
  clientId: string,
): Promise<EncryptionPrincipal | null> {
  return (
    (await api.listPrincipals()).find(
      (candidate) => candidate.id === clientId,
    ) ?? null
  );
}

async function authorizeDevice(
  input: AuthorizeDeviceInput,
): Promise<ClientDeviceDescriptor> {
  const device = input.device;
  let principal = input.principals.find(
    (candidate) => candidate.id === device.clientId,
  );
  if (!principal) {
    try {
      principal = await input.api.createPrincipal({
        id: device.clientId,
        kind: "client",
        label: "Cantrip client",
        publicKey: device.publicKey,
      });
    } catch (error) {
      if (!apiConflict(error)) throw error;
      principal =
        (await refreshedPrincipal(input.api, device.clientId)) ?? undefined;
    }
  }
  if (!principal || !publicKeysMatch(principal.publicKey, device.publicKey)) {
    throw new ClientEncryptionError(
      "identity-mismatch",
      "This device authorization conflicts with another key.",
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
      principal =
        (await refreshedPrincipal(input.api, device.clientId)) ?? principal;
    }
  }
  if (principal.state !== "approved") {
    throw new ClientEncryptionError(
      "principal-unavailable",
      "This device could not be authorized for encryption.",
    );
  }

  const revision = input.service.getSnapshot().masterKeyRevision;
  if (!revision) {
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked before authorizing a device.",
    );
  }
  const wrappedKey = await input.service.createDeviceWrapper(input.identity);
  try {
    await input.api.createGrant(principal.id, {
      component: "account-master-key",
      keyRevision: revision,
      wrappedKey,
    });
  } catch (error) {
    if (!apiConflict(error)) throw error;
    const existing = accountMasterKeyGrant(
      await input.api.listGrants(principal.id),
      revision,
    );
    if (!existing) throw error;
  }
  return device;
}

async function unlockExistingProfile(input: {
  api: AccountEncryptionApi;
  authMode: AuthMode;
  device: ClientDeviceDescriptor;
  identity: ClientEncryptionIdentity;
  password: string;
  profile: AccountEncryptionProfile;
  principals: EncryptionPrincipal[];
  service: ClientEncryptionService;
}): Promise<ClientEncryptionAccess> {
  let device = input.device;
  let principals = input.principals;
  const currentPrincipal = principals.find(
    (principal) => principal.id === device.clientId,
  );
  if (
    currentPrincipal &&
    (currentPrincipal.state === "revoked" ||
      !publicKeysMatch(currentPrincipal.publicKey, device.publicKey))
  ) {
    device = await input.service.replaceDevice(input.identity);
    principals = await input.api.listPrincipals();
  }
  if (!input.profile.passwordWrappedMasterKey) {
    throw new ClientEncryptionError(
      "locked",
      "This account does not have password or recovery-key access configured.",
    );
  }
  if (input.authMode !== "none") {
    await input.api.reauthenticate(input.password);
  }
  await input.service.unlockWithPassword({
    identity: input.identity,
    password: input.password,
    wrapper: input.profile.passwordWrappedMasterKey,
  });
  await authorizeDevice({
    api: input.api,
    device,
    identity: input.identity,
    principals,
    service: input.service,
  });
  return { status: "ready" };
}

function createRecoverySecret(): string {
  const bytes = randomBytes(32);
  try {
    return `ctr1_${encodeBase64Url(bytes)}`;
  } finally {
    clearSensitiveBytes(bytes);
  }
}

async function initializeProfile(input: {
  api: AccountEncryptionApi;
  authMode: AuthMode;
  device: ClientDeviceDescriptor;
  identity: ClientEncryptionIdentity;
  password: string;
  passwordKdf?: PasswordKdfParameters;
  recoverySecret: string | null;
  service: ClientEncryptionService;
}): Promise<ClientEncryptionAccess> {
  if (input.authMode !== "none") {
    await input.api.reauthenticate(input.password);
  }
  const accountMasterKey = generateAccountMasterKey();
  try {
    input.service.setAccountMasterKey({
      accountMasterKey,
      identity: input.identity,
      masterKeyRevision: 1,
    });
    const passwordWrappedMasterKey = await input.service.createPasswordWrapper({
      identity: input.identity,
      password: input.password,
      kdf: input.passwordKdf,
    });
    const result = await input.api.initializeProfile({
      profile: {
        formatVersion: 1,
        activeMasterKeyRevision: 1,
        passwordKdf: passwordWrappedMasterKey.kdf,
        passwordWrappedMasterKey,
        payloadMigrationStatus: "pending",
      },
      initialClient: {
        id: input.device.clientId,
        label: "Cantrip client",
        publicKey: input.device.publicKey,
        wrappedMasterKey: await input.service.createDeviceWrapper(
          input.identity,
        ),
      },
    });
    if (!result.created) {
      input.service.lock();
      if (input.authMode === "none") {
        return {
          credential: "recovery-secret",
          reason: "authorize-device",
          status: "credential-required",
        };
      }
      return unlockExistingProfile({
        ...input,
        profile: result.profile,
        principals: await input.api.listPrincipals(),
      });
    }
    input.service.lock();
    await input.service.unlockWithDevice({
      grant: result.grant,
      identity: input.identity,
      principal: result.principal,
    });
    return input.recoverySecret
      ? {
          recoverySecret: input.recoverySecret,
          status: "recovery-created",
        }
      : { status: "ready" };
  } finally {
    clearSensitiveBytes(accountMasterKey);
  }
}

export async function prepareClientEncryption(
  input: PrepareClientEncryptionInput,
): Promise<ClientEncryptionAccess> {
  const api = input.api ?? defaultApi;
  const service = input.service ?? clientEncryption;
  const device = await service.ensureDevice(input.identity);
  const profileState = await api.getProfile();

  if (profileState.status === "uninitialized") {
    if (input.authMode !== "none" && !input.password) {
      return {
        credential: "password",
        reason: "initialize",
        status: "credential-required",
      };
    }
    const recoverySecret =
      input.authMode === "none" ? createRecoverySecret() : null;
    return initializeProfile({
      api,
      authMode: input.authMode,
      device,
      identity: input.identity,
      password: recoverySecret ?? input.password!,
      passwordKdf: input.passwordKdf,
      recoverySecret,
      service,
    });
  }

  const snapshot = service.getSnapshot();
  if (
    snapshot.status === "ready" &&
    snapshot.identity?.ownerId === input.identity.ownerId &&
    snapshot.identity.serverId === input.identity.serverId &&
    snapshot.masterKeyRevision === profileState.profile.activeMasterKeyRevision
  ) {
    return { status: "ready" };
  }

  const principals = await api.listPrincipals();
  if (
    await tryDeviceUnlock({
      api,
      device,
      identity: input.identity,
      profile: profileState.profile,
      principals,
      service,
    })
  ) {
    return { status: "ready" };
  }

  if (!input.password) {
    return {
      credential: input.authMode === "none" ? "recovery-secret" : "password",
      reason: "authorize-device",
      status: "credential-required",
    };
  }

  return unlockExistingProfile({
    api,
    authMode: input.authMode,
    device,
    identity: input.identity,
    password: input.password,
    profile: profileState.profile,
    principals,
    service,
  });
}

export async function changeAccountEncryptionPassword(input: {
  api?: AccountEncryptionApi;
  currentPassword: string;
  identity: ClientEncryptionIdentity;
  newPassword: string;
  passwordKdf?: PasswordKdfParameters;
  service?: ClientEncryptionService;
}): Promise<AccountEncryptionProfile> {
  const api = input.api ?? defaultApi;
  const service = input.service ?? clientEncryption;
  const profileState = await api.getProfile();
  if (profileState.status !== "initialized") {
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be initialized before changing the password.",
    );
  }
  const passwordWrappedMasterKey = await service.createPasswordWrapper({
    identity: input.identity,
    password: input.newPassword,
    kdf: input.passwordKdf,
  });
  return api.changePassword({
    currentPassword: input.currentPassword,
    newPassword: input.newPassword,
    expectedProfileRevision: profileState.profile.revision,
    passwordKdf: passwordWrappedMasterKey.kdf,
    passwordWrappedMasterKey,
  });
}
