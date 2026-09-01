import type { AuthMode } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  beginClientEncryptionStartup,
  canMountProtectedApplication,
  transitionClientEncryptionStartup,
  type ClientEncryptionStartupBinding,
  type ClientEncryptionStartupEvent,
  type ClientEncryptionStartupState,
} from "./client-encryption-startup";

const identity = { ownerId: "owner-a", serverId: "server-a" } as const;
const installationId = "8d982003-a042-4b6e-94ca-0cf987264e75";
const keyAlias = `cantrip.installation.${installationId}.hpke.v1`;
const binding: ClientEncryptionStartupBinding = {
  grantRevision: 3,
  keyAlias,
  masterKeyRevision: 2,
  principalId: "principal-a",
};

type WithoutGeneration<Event> = Event extends unknown
  ? Omit<Event, "generation">
  : never;
type StartupEventInput = WithoutGeneration<ClientEncryptionStartupEvent>;

function begin(authMode: AuthMode = "accounts"): ClientEncryptionStartupState {
  return beginClientEncryptionStartup({ authMode, generation: 7, identity });
}

function apply(
  state: ClientEncryptionStartupState,
  event: StartupEventInput,
): ClientEncryptionStartupState {
  return transitionClientEncryptionStartup(state, {
    ...event,
    generation: state.generation,
  } as ClientEncryptionStartupEvent);
}

function reachDeviceKeyLookup(
  authMode: AuthMode = "accounts",
): ClientEncryptionStartupState {
  let state = begin(authMode);
  state = apply(state, {
    installationId,
    keyAlias,
    type: "installation-ready",
  });
  return apply(state, {
    masterKeyRevision: binding.masterKeyRevision,
    status: "initialized",
    type: "profile-loaded",
  });
}

function reachBindingLookup(
  authMode: AuthMode = "accounts",
): ClientEncryptionStartupState {
  return apply(reachDeviceKeyLookup(authMode), {
    keyAlias,
    status: "available",
    type: "device-key-loaded",
  });
}

function completion() {
  return { binding, installationId };
}

describe("client encryption startup state machine", () => {
  it("locates the installation key before looking up an account binding", () => {
    let state = reachDeviceKeyLookup();
    expect(state.phase).toBe("locating-device-key");

    state = apply(state, {
      keyAlias,
      status: "available",
      type: "device-key-loaded",
    });
    expect(state).toMatchObject({
      deviceKeyAvailable: true,
      phase: "locating-account-binding",
    });
  });

  it("looks for a legacy binding before requesting account recovery", () => {
    let state = reachBindingLookup();
    state = apply(state, { status: "missing", type: "binding-loaded" });
    expect(state.phase).toBe("locating-legacy-device");

    state = apply(state, { status: "missing", type: "legacy-device-loaded" });
    expect(state).toMatchObject({
      credentialReason: "recover-device",
      phase: "credential-required",
    });

    state = apply(state, { type: "credential-submitted" });
    expect(state.phase).toBe("recovering-account");
    state = apply(state, { ...completion(), type: "account-recovered" });
    expect(state.phase).toBe("ready");
    expect(canMountProtectedApplication(state)).toBe(true);
  });

  it("does not create or authorize a device for missing anonymous custody", () => {
    let state = reachDeviceKeyLookup("none");
    state = apply(state, { status: "missing", type: "device-key-loaded" });
    state = apply(state, { status: "missing", type: "legacy-device-loaded" });

    expect(state).toMatchObject({
      phase: "recovery-required",
      recoveryReason: "anonymous-device-missing",
    });
    expect(canMountProtectedApplication(state)).toBe(false);
  });

  it("distinguishes a missing anonymous binding from a missing device key", () => {
    let state = reachBindingLookup("none");
    state = apply(state, { status: "missing", type: "binding-loaded" });
    state = apply(state, { status: "missing", type: "legacy-device-loaded" });

    expect(state).toMatchObject({
      phase: "recovery-required",
      recoveryReason: "anonymous-binding-missing",
    });
  });

  it("unlocks a verified binding without entering recovery", () => {
    let state = reachBindingLookup();
    state = apply(state, {
      binding,
      status: "available",
      type: "binding-loaded",
    });
    expect(state.phase).toBe("unlocking-device");

    state = apply(state, { ...completion(), type: "device-unlocked" });
    expect(state).toMatchObject({ binding, phase: "ready" });
    expect(canMountProtectedApplication(state)).toBe(true);
  });

  it("requires account credentials before initializing a new profile", () => {
    let state = begin();
    state = apply(state, {
      installationId,
      keyAlias,
      type: "installation-ready",
    });
    state = apply(state, { status: "uninitialized", type: "profile-loaded" });
    expect(state.phase).toBe("initialization-required");

    state = apply(state, {
      credentialAvailable: false,
      type: "initialization-requested",
    });
    expect(state).toMatchObject({
      credentialReason: "initialize",
      phase: "credential-required",
    });
    state = apply(state, { type: "credential-submitted" });
    expect(state.phase).toBe("initializing-profile");
    state = apply(state, { ...completion(), type: "profile-initialized" });
    expect(canMountProtectedApplication(state)).toBe(true);
  });

  it.each(["corrupt", "unsupported"] as const)(
    "uses password recovery for an account with a %s legacy record",
    (status) => {
      let state = reachDeviceKeyLookup();
      state = apply(state, { status: "missing", type: "device-key-loaded" });
      state = apply(state, { status, type: "legacy-device-loaded" });

      expect(state).toMatchObject({
        credentialReason: "recover-device",
        phase: "credential-required",
      });
    },
  );

  it("preserves unsupported anonymous legacy state for explicit recovery", () => {
    let state = reachDeviceKeyLookup("none");
    state = apply(state, { status: "missing", type: "device-key-loaded" });
    state = apply(state, {
      status: "unsupported",
      type: "legacy-device-loaded",
    });

    expect(state).toMatchObject({
      phase: "recovery-required",
      recoveryReason: "legacy-device-unsupported",
    });
  });

  it("rejects a binding for a different installation key", () => {
    const state = reachBindingLookup();
    expect(() =>
      apply(state, {
        binding: { ...binding, keyAlias: "other-installation-key" },
        status: "available",
        type: "binding-loaded",
      }),
    ).toThrow(/locating-account-binding/iu);
  });

  it("rejects a completion for a different installation or master-key revision", () => {
    let state = reachDeviceKeyLookup();
    state = apply(state, { status: "missing", type: "device-key-loaded" });
    state = apply(state, { status: "missing", type: "legacy-device-loaded" });
    state = apply(state, { type: "credential-submitted" });

    expect(() =>
      apply(state, {
        binding: { ...binding, masterKeyRevision: 99 },
        installationId,
        type: "account-recovered",
      }),
    ).toThrow(/recovering-account/iu);
    expect(() =>
      apply(state, {
        binding,
        installationId: "different-installation",
        type: "account-recovered",
      }),
    ).toThrow(/recovering-account/iu);
  });

  it("ignores stale async results from an earlier identity generation", () => {
    const state = begin();
    const result = transitionClientEncryptionStartup(state, {
      generation: state.generation - 1,
      installationId,
      keyAlias,
      type: "installation-ready",
    });

    expect(result).toBe(state);
    expect(result.phase).toBe("locating-installation");
  });

  it("records precise retryable storage failure without mounting", () => {
    const state = apply(begin(), {
      reason: "native-key-store-unavailable",
      retryable: true,
      type: "failed",
    });

    expect(state).toMatchObject({
      failureReason: "native-key-store-unavailable",
      phase: "failed",
      retryable: true,
    });
    expect(canMountProtectedApplication(state)).toBe(false);
  });

  it("does not let a late same-generation failure demote a ready session", () => {
    let state = reachBindingLookup();
    state = apply(state, {
      binding,
      status: "available",
      type: "binding-loaded",
    });
    state = apply(state, { ...completion(), type: "device-unlocked" });

    const lateFailure = apply(state, {
      reason: "late-storage-failure",
      retryable: true,
      type: "failed",
    });
    expect(lateFailure).toBe(state);
    expect(lateFailure.phase).toBe("ready");
  });

  it("rejects transitions that skip authoritative profile discovery", () => {
    expect(() =>
      apply(begin(), { status: "missing", type: "binding-loaded" }),
    ).toThrow(/locating-installation/iu);
  });
});
