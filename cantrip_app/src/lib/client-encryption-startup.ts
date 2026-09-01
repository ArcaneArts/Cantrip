import type { AuthMode } from "@cantrip/protocol";

import type { ClientEncryptionIdentity } from "./client-encryption";

export type ClientEncryptionStartupPhase =
  | "credential-required"
  | "failed"
  | "idle"
  | "importing-anonymous-recovery"
  | "initialization-required"
  | "initializing-profile"
  | "loading-server-profile"
  | "locating-account-binding"
  | "locating-device-key"
  | "locating-installation"
  | "locating-legacy-device"
  | "migrating-legacy-device"
  | "ready"
  | "recovering-account"
  | "recovery-required"
  | "unlocking-device"
  | "unrecoverable";

export type ClientEncryptionRecoveryReason =
  | "anonymous-binding-missing"
  | "anonymous-device-missing"
  | "legacy-device-corrupt"
  | "legacy-device-unsupported";

export type ClientEncryptionCredentialReason =
  "authorize-device" | "initialize" | "recover-device";

export type ClientEncryptionStartupBinding = {
  grantRevision: number;
  keyAlias: string;
  masterKeyRevision: number;
  principalId: string;
};

export type ClientEncryptionStartupState = {
  authMode: AuthMode;
  binding: ClientEncryptionStartupBinding | null;
  credentialReason: ClientEncryptionCredentialReason | null;
  deviceKeyAvailable: boolean;
  failureReason: string | null;
  generation: number;
  identity: ClientEncryptionIdentity;
  installationId: string | null;
  keyAlias: string | null;
  phase: ClientEncryptionStartupPhase;
  recoveryReason: ClientEncryptionRecoveryReason | null;
  retryable: boolean;
  serverMasterKeyRevision: number | null;
};

type StartupEventWithGeneration = { generation: number };
type StartupCompletion = {
  binding: ClientEncryptionStartupBinding;
  installationId: string;
};

export type ClientEncryptionStartupEvent =
  | (StartupEventWithGeneration &
      StartupCompletion & {
        type: "account-recovered";
      })
  | (StartupEventWithGeneration &
      StartupCompletion & {
        type: "anonymous-recovery-completed";
      })
  | (StartupEventWithGeneration & {
      type: "anonymous-recovery-submitted";
    })
  | (StartupEventWithGeneration & {
      binding: ClientEncryptionStartupBinding;
      status: "available";
      type: "binding-loaded";
    })
  | (StartupEventWithGeneration & {
      status: "missing";
      type: "binding-loaded";
    })
  | (StartupEventWithGeneration & { type: "credential-submitted" })
  | (StartupEventWithGeneration & {
      reason: string;
      retryable: boolean;
      type: "failed";
    })
  | (StartupEventWithGeneration & {
      keyAlias: string;
      status: "available";
      type: "device-key-loaded";
    })
  | (StartupEventWithGeneration & {
      status: "missing" | "unusable";
      type: "device-key-loaded";
    })
  | (StartupEventWithGeneration &
      StartupCompletion & {
        type: "device-unlocked";
      })
  | (StartupEventWithGeneration & {
      installationId: string;
      keyAlias: string;
      type: "installation-ready";
    })
  | (StartupEventWithGeneration & {
      type: "installation-missing";
    })
  | (StartupEventWithGeneration & {
      credentialAvailable: boolean;
      type: "initialization-requested";
    })
  | (StartupEventWithGeneration &
      StartupCompletion & {
        type: "profile-initialized";
      })
  | (StartupEventWithGeneration & {
      status: "available" | "corrupt" | "missing" | "unsupported";
      type: "legacy-device-loaded";
    })
  | (StartupEventWithGeneration &
      StartupCompletion & {
        type: "migration-completed";
      })
  | (StartupEventWithGeneration & {
      masterKeyRevision: number;
      status: "initialized";
      type: "profile-loaded";
    })
  | (StartupEventWithGeneration & {
      status: "uninitialized";
      type: "profile-loaded";
    })
  | (StartupEventWithGeneration & {
      reason: string;
      type: "unrecoverable";
    });

export class ClientEncryptionStartupTransitionError extends Error {
  constructor(
    readonly phase: ClientEncryptionStartupPhase,
    readonly event: ClientEncryptionStartupEvent["type"],
  ) {
    super(`Cannot apply ${event} while client encryption is ${phase}.`);
    this.name = "ClientEncryptionStartupTransitionError";
  }
}

export function beginClientEncryptionStartup(input: {
  authMode: AuthMode;
  generation: number;
  identity: ClientEncryptionIdentity;
}): ClientEncryptionStartupState {
  return {
    authMode: input.authMode,
    binding: null,
    credentialReason: null,
    deviceKeyAvailable: false,
    failureReason: null,
    generation: input.generation,
    identity: { ...input.identity },
    installationId: null,
    keyAlias: null,
    phase: "locating-installation",
    recoveryReason: null,
    retryable: false,
    serverMasterKeyRevision: null,
  };
}

function advance(
  state: ClientEncryptionStartupState,
  phase: ClientEncryptionStartupPhase,
  detail: Partial<ClientEncryptionStartupState> = {},
): ClientEncryptionStartupState {
  return {
    ...state,
    credentialReason: null,
    failureReason: null,
    phase,
    recoveryReason: null,
    retryable: false,
    ...detail,
  };
}

function invalidTransition(
  state: ClientEncryptionStartupState,
  event: ClientEncryptionStartupEvent,
): never {
  throw new ClientEncryptionStartupTransitionError(state.phase, event.type);
}

function validBinding(binding: ClientEncryptionStartupBinding): boolean {
  return (
    binding.keyAlias.length > 0 &&
    binding.principalId.length > 0 &&
    Number.isInteger(binding.grantRevision) &&
    binding.grantRevision > 0 &&
    Number.isInteger(binding.masterKeyRevision) &&
    binding.masterKeyRevision > 0
  );
}

function bindingMatches(
  left: ClientEncryptionStartupBinding,
  right: ClientEncryptionStartupBinding,
): boolean {
  return (
    left.grantRevision === right.grantRevision &&
    left.keyAlias === right.keyAlias &&
    left.masterKeyRevision === right.masterKeyRevision &&
    left.principalId === right.principalId
  );
}

function completionMatchesInstallation(
  state: ClientEncryptionStartupState,
  completion: StartupCompletion,
): boolean {
  return (
    state.installationId !== null &&
    completion.installationId === state.installationId &&
    state.keyAlias !== null &&
    completion.binding.keyAlias === state.keyAlias &&
    validBinding(completion.binding) &&
    (state.serverMasterKeyRevision === null ||
      completion.binding.masterKeyRevision === state.serverMasterKeyRevision)
  );
}

function finishWithBinding(
  state: ClientEncryptionStartupState,
  event: ClientEncryptionStartupEvent,
  completion: StartupCompletion,
): ClientEncryptionStartupState {
  if (!completionMatchesInstallation(state, completion)) {
    return invalidTransition(state, event);
  }
  return advance(state, "ready", {
    binding: { ...completion.binding },
    deviceKeyAvailable: true,
    serverMasterKeyRevision: completion.binding.masterKeyRevision,
  });
}

function accountRecoveryPhase(
  state: ClientEncryptionStartupState,
  reason: ClientEncryptionRecoveryReason,
): ClientEncryptionStartupState {
  if (state.authMode !== "none") {
    return advance(state, "credential-required", {
      credentialReason: "recover-device",
    });
  }
  return advance(state, "recovery-required", { recoveryReason: reason });
}

export function transitionClientEncryptionStartup(
  state: ClientEncryptionStartupState,
  event: ClientEncryptionStartupEvent,
): ClientEncryptionStartupState {
  if (event.generation !== state.generation) return state;
  if (
    state.phase === "failed" ||
    state.phase === "ready" ||
    state.phase === "unrecoverable"
  ) {
    return state;
  }

  if (event.type === "failed") {
    return advance(state, "failed", {
      failureReason: event.reason,
      retryable: event.retryable,
    });
  }
  switch (state.phase) {
    case "locating-installation":
      if (event.type === "installation-missing") {
        return advance(state, "loading-server-profile");
      }
      if (
        event.type === "installation-ready" &&
        event.installationId.length > 0 &&
        event.keyAlias.length > 0
      ) {
        return advance(state, "loading-server-profile", {
          installationId: event.installationId,
          keyAlias: event.keyAlias,
        });
      }
      break;
    case "loading-server-profile":
      if (event.type === "profile-loaded") {
        if (event.status === "uninitialized") {
          return advance(state, "initialization-required");
        }
        if (
          Number.isInteger(event.masterKeyRevision) &&
          event.masterKeyRevision > 0
        ) {
          return advance(state, "locating-device-key", {
            serverMasterKeyRevision: event.masterKeyRevision,
          });
        }
      }
      break;
    case "initialization-required":
      if (event.type === "initialization-requested") {
        if (state.authMode !== "none" && !event.credentialAvailable) {
          return advance(state, "credential-required", {
            credentialReason: "initialize",
          });
        }
        return advance(state, "initializing-profile");
      }
      break;
    case "initializing-profile":
      if (
        event.type === "installation-ready" &&
        event.installationId.length > 0 &&
        event.keyAlias.length > 0
      ) {
        return {
          ...state,
          installationId: event.installationId,
          keyAlias: event.keyAlias,
        };
      }
      if (event.type === "profile-initialized") {
        return finishWithBinding(state, event, event);
      }
      break;
    case "locating-device-key":
      if (event.type === "device-key-loaded") {
        if (event.status === "available") {
          if (event.keyAlias !== state.keyAlias) break;
          return advance(state, "locating-account-binding", {
            deviceKeyAvailable: true,
          });
        }
        return advance(state, "locating-legacy-device", {
          deviceKeyAvailable: false,
        });
      }
      break;
    case "locating-account-binding":
      if (event.type === "binding-loaded") {
        if (event.status === "missing") {
          return advance(state, "locating-legacy-device");
        }
        if (
          event.binding.keyAlias !== state.keyAlias ||
          event.binding.masterKeyRevision !== state.serverMasterKeyRevision ||
          !validBinding(event.binding)
        ) {
          break;
        }
        return advance(state, "unlocking-device", {
          binding: { ...event.binding },
        });
      }
      break;
    case "unlocking-device":
      if (
        event.type === "device-unlocked" &&
        state.binding &&
        bindingMatches(state.binding, event.binding)
      ) {
        return finishWithBinding(state, event, event);
      }
      break;
    case "locating-legacy-device":
      if (event.type === "legacy-device-loaded") {
        if (event.status === "available") {
          return advance(state, "migrating-legacy-device");
        }
        if (event.status === "unsupported") {
          return accountRecoveryPhase(state, "legacy-device-unsupported");
        }
        if (event.status === "corrupt") {
          return accountRecoveryPhase(state, "legacy-device-corrupt");
        }
        return accountRecoveryPhase(
          state,
          state.deviceKeyAvailable
            ? "anonymous-binding-missing"
            : "anonymous-device-missing",
        );
      }
      break;
    case "migrating-legacy-device":
      if (
        event.type === "installation-ready" &&
        event.installationId.length > 0 &&
        event.keyAlias.length > 0
      ) {
        return {
          ...state,
          installationId: event.installationId,
          keyAlias: event.keyAlias,
        };
      }
      if (event.type === "migration-completed") {
        return finishWithBinding(state, event, event);
      }
      break;
    case "credential-required":
      if (event.type === "credential-submitted") {
        return advance(
          state,
          state.credentialReason === "initialize"
            ? "initializing-profile"
            : "recovering-account",
        );
      }
      break;
    case "recovering-account":
      if (
        event.type === "installation-ready" &&
        event.installationId.length > 0 &&
        event.keyAlias.length > 0
      ) {
        return {
          ...state,
          installationId: event.installationId,
          keyAlias: event.keyAlias,
        };
      }
      if (event.type === "account-recovered") {
        return finishWithBinding(state, event, event);
      }
      break;
    case "recovery-required":
      if (event.type === "anonymous-recovery-submitted") {
        return advance(state, "importing-anonymous-recovery");
      }
      if (event.type === "unrecoverable") {
        return advance(state, "unrecoverable", {
          failureReason: event.reason,
        });
      }
      break;
    case "importing-anonymous-recovery":
      if (event.type === "anonymous-recovery-completed") {
        return finishWithBinding(state, event, event);
      }
      if (event.type === "unrecoverable") {
        return advance(state, "unrecoverable", {
          failureReason: event.reason,
        });
      }
      break;
    case "idle":
      break;
  }
  return invalidTransition(state, event);
}

export function canMountProtectedApplication(
  state: ClientEncryptionStartupState,
): boolean {
  return (
    state.phase === "ready" &&
    state.installationId !== null &&
    state.keyAlias !== null &&
    state.deviceKeyAvailable &&
    state.binding !== null &&
    state.binding.keyAlias === state.keyAlias
  );
}
