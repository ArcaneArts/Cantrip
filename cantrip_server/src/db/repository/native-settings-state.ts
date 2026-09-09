import { isDeepStrictEqual } from "node:util";
import {
  nativeSettingsBindingSchema,
  nativeSettingsIntentSchema,
  nativeSettingsStateSchema,
  protectedNativeSettingsSnapshotSchema,
  type NativeSettingsBinding,
  type NativeSettingsIntent,
  type NativeSettingsState,
  type ProtectedNativeSettingsSnapshot,
} from "@cantrip/protocol";

/** Pure state transitions. Repository callers must serialize on the chat and
 * authorize commands/read bindings before invoking these; no native effects occur here. */
export function emptyNativeSettingsState(chatId: string): NativeSettingsState {
  return nativeSettingsStateSchema.parse({
    chatId,
    revision: "0",
    desiredRevision: "0",
    desired: null,
    desiredStatus: null,
    pending: [],
    binding: null,
    effective: null,
  });
}
function advance(state: NativeSettingsState): NativeSettingsState {
  return { ...state, revision: (BigInt(state.revision) + 1n).toString() };
}

function matchesSource(
  binding: NativeSettingsBinding,
  source: NativeSettingsIntent["source"],
): boolean {
  return (
    binding.workerId === source.workerId &&
    binding.threadId === source.threadId &&
    binding.runtimeGeneration === source.runtimeGeneration
  );
}

export function requestNativeSettings(
  value: NativeSettingsState,
  input: NativeSettingsIntent,
): NativeSettingsState {
  const state = nativeSettingsStateSchema.parse(value);
  const intent = nativeSettingsIntentSchema.parse(input);
  const existing =
    state.pending.find(
      (entry) => entry.intent.operationId === intent.operationId,
    )?.intent ??
    (state.desired?.operationId === intent.operationId
      ? state.desired
      : undefined);
  if (existing) {
    if (
      existing.operationGeneration !== intent.operationGeneration ||
      existing.origin !== intent.origin ||
      existing.payloadDigest !== intent.payloadDigest ||
      !isDeepStrictEqual(existing.source, intent.source)
    )
      throw new Error(
        "Settings operation identity was reused with another intent.",
      );
    return state;
  }
  const desiredRevision = (BigInt(state.desiredRevision) + 1n).toString();
  return advance({
    ...state,
    desiredRevision,
    desired: intent,
    desiredStatus: "accepted",
    pending: [
      ...state.pending,
      {
        intent,
        desiredRevision,
        bindingId:
          state.binding && matchesSource(state.binding, intent.source)
            ? state.binding.bindingId
            : null,
        status: "accepted",
      },
    ],
  });
}

function inBinding(
  binding: NativeSettingsBinding,
  snapshot: ProtectedNativeSettingsSnapshot,
): boolean {
  const source = snapshot.context;
  return (
    source.chatId === binding.chatId &&
    source.workerId === binding.workerId &&
    source.threadId === binding.threadId &&
    source.runtimeGeneration === binding.runtimeGeneration &&
    source.settingsVersion.epoch === binding.nativeEpoch
  );
}

/** Only a fresh, authorized native read may establish or replace a binding.
 * expectedBindingId is a compare-and-set token, not a cached readiness check. */
export function bindNativeSettingsRead(
  value: NativeSettingsState,
  expectedBindingId: string | null,
  inputBinding: NativeSettingsBinding,
  inputSnapshot: ProtectedNativeSettingsSnapshot,
): NativeSettingsState {
  const state = nativeSettingsStateSchema.parse(value);
  const binding = nativeSettingsBindingSchema.parse(inputBinding);
  const snapshot = protectedNativeSettingsSnapshotSchema.parse(inputSnapshot);
  if ((state.binding?.bindingId ?? null) !== expectedBindingId)
    throw new Error("Settings read binding was replaced before publication.");
  if (binding.chatId !== state.chatId || !inBinding(binding, snapshot))
    throw new Error("Settings read does not match its authorized binding.");
  if (state.binding?.bindingId === binding.bindingId) {
    if (!isDeepStrictEqual(state.binding, binding))
      throw new Error("Settings binding identity was reused.");
    return observeNativeSettings(state, binding.bindingId, snapshot);
  }
  const sameNativeSource =
    state.effective !== null && inBinding(binding, state.effective);
  let effective = snapshot;
  if (sameNativeSource && state.effective) {
    const prior = BigInt(state.effective.context.settingsVersion.revision);
    const next = BigInt(snapshot.context.settingsVersion.revision);
    if (next < prior) effective = state.effective;
    else if (
      next === prior &&
      state.effective.protectedContent.keyRevision ===
        snapshot.protectedContent.keyRevision &&
      state.effective.contentFingerprint !== snapshot.contentFingerprint
    )
      throw new Error("Settings version has conflicting content.");
  }
  const pending = state.pending.map((entry) =>
    !sameNativeSource &&
    ((entry.bindingId && entry.bindingId !== binding.bindingId) ||
      (entry.intent.source.runtimeGeneration !== null &&
        !matchesSource(binding, entry.intent.source)))
      ? { ...entry, status: "uncertain" as const }
      : entry,
  );
  return advance({
    ...state,
    binding,
    effective,
    pending,
    desiredStatus:
      pending.find(
        (entry) => entry.intent.operationId === state.desired?.operationId,
      )?.status ?? state.desiredStatus,
  });
}

/** An observation never changes desired intent or proves which request applied. */
export function observeNativeSettings(
  value: NativeSettingsState,
  bindingId: string,
  input: ProtectedNativeSettingsSnapshot,
): NativeSettingsState {
  const state = nativeSettingsStateSchema.parse(value);
  const snapshot = protectedNativeSettingsSnapshotSchema.parse(input);
  if (
    !state.binding ||
    state.binding.bindingId !== bindingId ||
    !inBinding(state.binding, snapshot)
  )
    throw new Error("Settings observation belongs to a retired binding.");
  const previous = state.effective;
  if (previous) {
    const prior = BigInt(previous.context.settingsVersion.revision);
    const next = BigInt(snapshot.context.settingsVersion.revision);
    if (next < prior) return state;
    if (next === prior) {
      if (
        previous.protectedContent.keyRevision !==
        snapshot.protectedContent.keyRevision
      )
        throw new Error(
          "Settings key rotation requires a fresh authorized read binding.",
        );
      if (previous.contentFingerprint !== snapshot.contentFingerprint)
        throw new Error("Settings version has conflicting content.");
      return state; // Fresh encryption nonces do not create a new settings revision.
    }
  }
  return advance({ ...state, effective: snapshot });
}

/** Correlated durable application/rejection evidence resolves only its own intent.
 * Late evidence may settle an old request but cannot replace current settings. */
export function settleNativeSettingsIntent(
  value: NativeSettingsState,
  operation: { operationId: string; operationGeneration: string },
  outcome: "dispatched" | "applied" | "rejected" | "uncertain",
): NativeSettingsState {
  const state = nativeSettingsStateSchema.parse(value);
  const pending = state.pending.find(
    (entry) => entry.intent.operationId === operation.operationId,
  );
  const desired =
    state.desired?.operationId === operation.operationId ? state.desired : null;
  const intent = pending?.intent ?? desired;
  if (!intent) return state; // Old terminal fact replay is handled by the immutable command ledger.
  if (intent.operationGeneration !== operation.operationGeneration)
    throw new Error("Settings result belongs to another command generation.");
  const current = pending?.status ?? state.desiredStatus;
  if (outcome === "dispatched" && current !== "accepted") return state;
  if (outcome === current || (!pending && current === "uncertain"))
    return state;
  const desiredStatus =
    desired &&
    ((state.desiredStatus === "applied" && outcome === "rejected") ||
      (state.desiredStatus === "rejected" && outcome === "applied"))
      ? "uncertain"
      : desired
        ? outcome
        : state.desiredStatus;
  return advance({
    ...state,
    desiredStatus,
    pending: state.pending.flatMap((entry) => {
      if (entry !== pending) return [entry];
      return outcome === "applied" || outcome === "rejected"
        ? []
        : [
            {
              ...entry,
              status: outcome,
              bindingId: entry.bindingId,
            },
          ];
    }),
  });
}
