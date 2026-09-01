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
import { openBrowserInstallationStorage } from "./browser-installation-storage";
import {
  prepareDurableClientEncryption,
  type DurableClientEncryptionStorage,
} from "./durable-account-encryption";
import { openNativeInstallationStorage } from "./native-installation-storage";
import { detectClientRuntimePlatform } from "./runtime-platform";

export type ClientEncryptionCredential = "password";

export type ClientEncryptionAccess =
  | { status: "ready" }
  | {
      credential: ClientEncryptionCredential;
      reason: "authorize-device" | "initialize" | "recover-device";
      status: "credential-required";
    }
  | {
      message: string;
      reason:
        | "anonymous-binding-missing"
        | "anonymous-device-missing"
        | "legacy-device-corrupt"
        | "legacy-device-unsupported";
      status: "recovery-required";
    };

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
  durableStorage?: DurableClientEncryptionStorage;
  identity: ClientEncryptionIdentity;
  onStartupState?: Parameters<
    typeof prepareDurableClientEncryption
  >[0]["onStartupState"];
  password?: string;
  passwordKdf?: PasswordKdfParameters;
  runtimePlatform?: ReturnType<typeof detectClientRuntimePlatform>;
  service?: ClientEncryptionService;
};

type PrepareClientEncryptionRuntime = WeakMap<
  ClientEncryptionService,
  WeakMap<AccountEncryptionApi, Map<string, Promise<ClientEncryptionAccess>>>
>;

type AccountEncryptionHotState = {
  prepareClientEncryptionRuntime?: PrepareClientEncryptionRuntime;
};

function prepareClientEncryptionRuntime(
  hotState?: AccountEncryptionHotState,
): PrepareClientEncryptionRuntime {
  if (!hotState) return new WeakMap();
  return (hotState.prepareClientEncryptionRuntime ??= new WeakMap());
}

// React deliberately replays effects in development. Keep passwordless
// session preparation single-flight so two refreshes cannot generate competing
// device keys or Account Master Keys for the same account.
const preparationFlights = prepareClientEncryptionRuntime(
  import.meta.hot?.data as AccountEncryptionHotState | undefined,
);

async function prepareClientEncryptionOnce(
  input: PrepareClientEncryptionInput,
): Promise<ClientEncryptionAccess> {
  const api = input.api ?? defaultApi;
  const service = input.service ?? clientEncryption;
  const runtimePlatform =
    input.runtimePlatform ?? detectClientRuntimePlatform();
  return prepareDurableClientEncryption({
    api,
    authMode: input.authMode,
    identity: input.identity,
    onStartupState: input.onStartupState,
    password: input.password,
    passwordKdf: input.passwordKdf,
    service,
    storage:
      input.durableStorage ??
      (runtimePlatform === "browser"
        ? await openBrowserInstallationStorage()
        : await openNativeInstallationStorage(runtimePlatform)),
  });
}

export function prepareClientEncryption(
  input: PrepareClientEncryptionInput,
): Promise<ClientEncryptionAccess> {
  const api = input.api ?? defaultApi;
  const service = input.service ?? clientEncryption;
  const resolvedInput = { ...input, api, service };
  if (input.password !== undefined) {
    return prepareClientEncryptionOnce(resolvedInput);
  }

  let apiFlights = preparationFlights.get(service);
  if (!apiFlights) {
    apiFlights = new WeakMap();
    preparationFlights.set(service, apiFlights);
  }
  let identityFlights = apiFlights.get(api);
  if (!identityFlights) {
    identityFlights = new Map();
    apiFlights.set(api, identityFlights);
  }
  const key = JSON.stringify([
    input.authMode,
    input.identity.serverId,
    input.identity.ownerId,
  ]);
  const existing = identityFlights.get(key);
  if (existing) return existing;

  const pending = prepareClientEncryptionOnce(resolvedInput).finally(() => {
    if (identityFlights.get(key) === pending) identityFlights.delete(key);
  });
  identityFlights.set(key, pending);
  return pending;
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
