import { describe, expect, it } from "vitest";
import type {
  NativeSettingsBinding,
  NativeSettingsIntent,
  ProtectedNativeSettingsSnapshot,
} from "@cantrip/protocol";
import {
  emptyNativeSettingsState,
  requestNativeSettings,
  bindNativeSettingsRead,
  observeNativeSettings,
  settleNativeSettingsIntent,
} from "../src/db/repository/native-settings-state.js";

const envelope = {
  version: 1 as const,
  algorithm: "AES-256-GCM" as const,
  keyRevision: 1,
  nonce: "AAAAAAAAAAAAAAAA",
  ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
};
const binding: NativeSettingsBinding = {
  bindingId: "binding-one",
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  runtimeGeneration: "runtime",
  nativeEpoch: "core",
  contextKind: "project",
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route",
  providerAccountId: null,
};
function snapshot(
  revision: string,
  source = binding,
): ProtectedNativeSettingsSnapshot {
  return {
    context: {
      chatId: source.chatId,
      workerId: source.workerId,
      threadId: source.threadId,
      runtimeGeneration: source.runtimeGeneration,
      settingsVersion: { epoch: source.nativeEpoch, revision },
    },
    contentFingerprint: (BigInt(revision) % 2n === 0n ? "a" : "b").repeat(64),
    protectedContent: envelope,
  };
}
const intent = (operationId: string): NativeSettingsIntent => ({
  operationId,
  operationGeneration: `generation:${operationId}`,
  origin: "terminal",
  source: {
    workerId: binding.workerId,
    threadId: binding.threadId,
    runtimeGeneration: binding.runtimeGeneration,
  },
  protectedContent: envelope,
  payloadDigest: "c".repeat(64),
});
const initial = () =>
  bindNativeSettingsRead(
    emptyNativeSettingsState("chat"),
    null,
    binding,
    snapshot("0"),
  );

describe("canonical native settings transitions", () => {
  it("does not associate an old runtime request with an unrelated live read", () => {
    const oldIntent = {
      ...intent("old"),
      source: { ...intent("old").source, runtimeGeneration: "retired-runtime" },
    };
    let state = requestNativeSettings(initial(), oldIntent);
    expect(state.pending[0]?.bindingId).toBeNull();
    state = settleNativeSettingsIntent(state, oldIntent, "dispatched");
    expect(state.pending[0]?.bindingId).toBeNull();
    state = bindNativeSettingsRead(
      state,
      binding.bindingId,
      {
        ...binding,
        bindingId: "new-live-binding",
        runtimeGeneration: "new-runtime",
        nativeEpoch: "new-core",
      },
      snapshot("0", {
        ...binding,
        runtimeGeneration: "new-runtime",
        nativeEpoch: "new-core",
      }),
    );
    expect(state.pending[0]?.status).toBe("uncertain");
    expect(state.desired?.source.runtimeGeneration).toBe("retired-runtime");
    expect(state.effective?.context.runtimeGeneration).toBe("new-runtime");
  });

  it("keeps desired, pending and effective independent through out-of-order results", () => {
    let state = requestNativeSettings(initial(), intent("one"));
    state = settleNativeSettingsIntent(state, intent("one"), "dispatched");
    state = requestNativeSettings(state, intent("two"));
    const desiredRevision = state.desiredRevision;
    expect(state.effective).toEqual(snapshot("0"));
    state = observeNativeSettings(state, binding.bindingId, snapshot("2"));
    expect(state.pending).toHaveLength(2); // Observed state is not an operation receipt.
    state = settleNativeSettingsIntent(state, intent("one"), "applied");
    expect(state.desired?.operationId).toBe("two");
    expect(state.desiredStatus).toBe("accepted");
    expect(state.pending.map((entry) => entry.intent.operationId)).toEqual([
      "two",
    ]);
    state = observeNativeSettings(state, binding.bindingId, snapshot("1"));
    expect(state.effective).toEqual(snapshot("2"));
    state = settleNativeSettingsIntent(state, intent("two"), "rejected");
    expect(state.desiredStatus).toBe("rejected");
    expect(state.pending).toEqual([]);
    expect(state.desiredRevision).toBe(desiredRevision);
    expect(state.effective).toEqual(snapshot("2"));
  });

  it("does not churn canonical revisions for duplicate intent, nonce or old snapshots", () => {
    const state = requestNativeSettings(initial(), intent("one"));
    expect(
      requestNativeSettings(state, {
        ...intent("one"),
        protectedContent: { ...envelope, nonce: "BBBBBBBBBBBBBBBB" },
      }),
    ).toEqual(state);
    expect(
      observeNativeSettings(state, binding.bindingId, {
        ...snapshot("0"),
        protectedContent: { ...envelope, nonce: "BBBBBBBBBBBBBBBB" },
      }),
    ).toEqual(state);
    expect(() =>
      requestNativeSettings(state, {
        ...intent("one"),
        payloadDigest: "d".repeat(64),
      }),
    ).toThrow("reused");
  });

  it("compares revisions above the JavaScript safe integer boundary exactly", () => {
    const state = observeNativeSettings(
      initial(),
      binding.bindingId,
      snapshot("9007199254740993"),
    );
    expect(
      observeNativeSettings(
        state,
        binding.bindingId,
        snapshot("9007199254740992"),
      ),
    ).toEqual(state);
    expect(
      observeNativeSettings(
        state,
        binding.bindingId,
        snapshot("9007199254740994"),
      ).effective,
    ).toEqual(snapshot("9007199254740994"));
  });

  it("refreshes observation bindings without rolling back a newer notification or disturbing pending work", () => {
    let state = requestNativeSettings(initial(), intent("one"));
    state = observeNativeSettings(state, binding.bindingId, snapshot("2"));
    const replacement = { ...binding, bindingId: "binding-two" };
    const refreshed = bindNativeSettingsRead(
      state,
      binding.bindingId,
      replacement,
      snapshot("1"),
    );
    expect(refreshed.effective).toEqual(snapshot("2"));
    expect(refreshed.pending).toEqual(state.pending);
    expect(() =>
      observeNativeSettings(refreshed, binding.bindingId, snapshot("3")),
    ).toThrow("retired");
    expect(() =>
      bindNativeSettingsRead(
        refreshed,
        binding.bindingId,
        { ...binding, bindingId: "late" },
        snapshot("3"),
      ),
    ).toThrow("replaced");
  });

  it("makes old-runtime requests uncertain while keeping the latest desired selection", () => {
    let state = requestNativeSettings(initial(), intent("one"));
    state = settleNativeSettingsIntent(state, intent("one"), "dispatched");
    const replacement = {
      ...binding,
      bindingId: "binding-two",
      runtimeGeneration: "runtime-two",
      nativeEpoch: "core-two",
    };
    state = bindNativeSettingsRead(
      state,
      binding.bindingId,
      replacement,
      snapshot("0", replacement),
    );
    expect(state.pending[0]?.status).toBe("uncertain");
    expect(state.desiredStatus).toBe("uncertain");
    expect(state.desired).toEqual(intent("one"));
    const current = state.effective;
    state = settleNativeSettingsIntent(state, intent("one"), "applied");
    expect(state.desiredStatus).toBe("applied");
    expect(state.effective).toEqual(current); // Historical settlement is never a current snapshot.
    expect(() =>
      observeNativeSettings(state, replacement.bindingId, snapshot("9")),
    ).toThrow("retired");
  });

  it("rejects conflicting versions and permits key rotation only through a fresh authorized binding", () => {
    const state = initial();
    const conflict = { ...snapshot("0"), contentFingerprint: "f".repeat(64) };
    expect(() =>
      observeNativeSettings(state, binding.bindingId, conflict),
    ).toThrow("conflicting");
    expect(() =>
      bindNativeSettingsRead(
        state,
        binding.bindingId,
        { ...binding, bindingId: "next" },
        conflict,
      ),
    ).toThrow("conflicting");
    const rotated = {
      ...conflict,
      protectedContent: { ...envelope, keyRevision: 2 },
    };
    expect(() =>
      observeNativeSettings(state, binding.bindingId, rotated),
    ).toThrow("key rotation");
    expect(
      bindNativeSettingsRead(
        state,
        binding.bindingId,
        { ...binding, bindingId: "rotated" },
        rotated,
      ).effective,
    ).toEqual(rotated);
  });

  it("does not regress a terminal result on a late queue acknowledgment, and preserves conflicts", () => {
    let state = requestNativeSettings(initial(), intent("one"));
    state = settleNativeSettingsIntent(state, intent("one"), "applied");
    expect(
      settleNativeSettingsIntent(state, intent("one"), "dispatched"),
    ).toEqual(state);
    state = settleNativeSettingsIntent(state, intent("one"), "rejected");
    expect(state.desiredStatus).toBe("uncertain");
    expect(settleNativeSettingsIntent(state, intent("one"), "applied")).toEqual(
      state,
    );
    expect(() =>
      settleNativeSettingsIntent(
        state,
        { operationId: "one", operationGeneration: "wrong" },
        "applied",
      ),
    ).toThrow("generation");
  });
});

describe("version-bound model attribution", () => {
  const attribution = (routeId = "selected") => ({
    selection: {
      status: "resolved" as const,
      workerId: "worker",
      providerId: "provider",
      providerAccountId: null,
      modelId: "selected-model",
      routeId,
    },
    fingerprint: "a".repeat(64),
  });
  it("fills missing metadata at the same native revision without changing desired settings or the session route", () => {
    const state = initial();
    const mapped = observeNativeSettings(state, binding.bindingId, {
      ...state.effective!,
      modelAttribution: attribution(),
    });
    expect(mapped.revision).toBe(String(BigInt(state.revision) + 1n));
    expect(mapped.effective!.context).toEqual(state.effective!.context);
    expect(mapped.effective!.contentFingerprint).toBe(
      state.effective!.contentFingerprint,
    );
    expect(mapped.desired).toEqual(state.desired);
    expect(mapped.binding!.modelRouteId).toBe("route");
    expect(
      observeNativeSettings(mapped, binding.bindingId, { ...state.effective! }),
    ).toEqual(mapped);
  });
  it("rejects contradictory route identity at one native version and ignores late older settings", () => {
    const state = initial();
    const mapped = observeNativeSettings(state, binding.bindingId, {
      ...snapshot("5"),
      modelAttribution: attribution(),
    });
    expect(() =>
      observeNativeSettings(mapped, binding.bindingId, {
        ...snapshot("5"),
        modelAttribution: attribution("other"),
      }),
    ).toThrow("conflicting model attribution");
    expect(
      observeNativeSettings(mapped, binding.bindingId, {
        ...snapshot("4"),
        modelAttribution: attribution("old"),
      }),
    ).toEqual(mapped);
    const next = observeNativeSettings(mapped, binding.bindingId, {
      ...snapshot("6"),
      modelAttribution: attribution("new"),
    });
    expect(next.effective!.modelAttribution!.selection).toMatchObject({
      routeId: "new",
    });
  });
});
