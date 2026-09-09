import {
  clearSensitiveBytes,
  decryptNativeCommandRequest,
} from "@cantrip/crypto";
import {
  nativeSettingsStateSchema,
  nativeSettingsPatchSchema,
  type NativeSettingsPatch,
  type NativeSettingsIntent,
} from "@cantrip/protocol";
import {
  clientEncryption,
  ClientEncryptionError,
  type ClientEncryptionService,
} from "./client-encryption";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  type ClientSessionIdentitySnapshot,
} from "./client-session";

export interface OpenedNativeSettingsIntent {
  operationId: string;
  status: "accepted" | "dispatched" | "applied" | "rejected" | "uncertain";
  pending: boolean;
  patch: Pick<
    NativeSettingsPatch,
    | "model"
    | "effort"
    | "serviceTier"
    | "unsetServiceTier"
    | "collaborationMode"
    | "collaborationModeKind"
    | "multiAgentEnabled"
    | "subagentModel"
    | "subagentReasoningEffort"
  >;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Plaintext belongs to the mounted controller, never a query cache. */
export async function openNativeSettingsIntents(input: {
  chatId: string;
  state: unknown;
  options?: {
    service?: ClientEncryptionService;
    identity?: () => ClientSessionIdentitySnapshot | null;
    identityMatches?: (expected: ClientSessionIdentitySnapshot) => boolean;
  };
}): Promise<OpenedNativeSettingsIntent[]> {
  const state = nativeSettingsStateSchema.parse(input.state);
  if (state.chatId !== input.chatId)
    throw new Error("Native settings belong to another chat.");
  const binding = state.binding;
  if (!binding) return [];
  const service = input.options?.service ?? clientEncryption;
  const identity = (
    input.options?.identity ?? getClientSessionIdentitySnapshot
  )();
  const matches =
    input.options?.identityMatches ?? clientSessionIdentityMatches;
  const unlocked = service.getSnapshot();
  if (
    !identity ||
    !matches(identity) ||
    unlocked.status !== "ready" ||
    unlocked.identity?.ownerId !== identity.userId ||
    unlocked.identity.serverId !== identity.serverId
  )
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked for this account.",
    );
  const entries: {
    intent: NativeSettingsIntent;
    status: OpenedNativeSettingsIntent["status"];
    pending: boolean;
  }[] = [...state.pending]
    .filter((entry) => entry.bindingId === binding.bindingId)
    .sort((a, b) =>
      BigInt(a.desiredRevision) < BigInt(b.desiredRevision) ? -1 : 1,
    )
    .map((entry) => ({
      intent: entry.intent,
      status: entry.status,
      pending: true as boolean,
    }));
  if (
    state.desired &&
    state.desiredStatus &&
    !entries.some(
      ({ intent }) => intent.operationId === state.desired!.operationId,
    )
  )
    entries.push({
      intent: state.desired,
      status: state.desiredStatus,
      pending: false,
    });
  const opened: OpenedNativeSettingsIntent[] = [];
  for (const { intent, status, pending } of entries) {
    if (
      intent.source.workerId !== binding.workerId ||
      intent.source.threadId !== binding.threadId ||
      intent.source.runtimeGeneration !== binding.runtimeGeneration
    )
      continue;
    const keyRevision = intent.protectedContent.keyRevision;
    const componentKey = service.componentKey({
      component: "chat-content",
      identity: unlocked.identity,
      keyRevision,
    });
    try {
      const frame = await decryptNativeCommandRequest({
        ownerId: identity.userId,
        serverId: identity.serverId,
        componentKey,
        keyRevision,
        chatId: input.chatId,
        operationId: intent.operationId,
        envelope: intent.protectedContent,
      });
      if (
        !object(frame) ||
        frame.method !== "thread/settings/update" ||
        !object(frame.params) ||
        frame.params.threadId !== binding.threadId
      )
        throw new Error(
          "Native settings intent does not match its bound thread.",
        );
      const params = frame.params;
      const patch: OpenedNativeSettingsIntent["patch"] = {};
      if (typeof params.model === "string") patch.model = params.model;
      if (typeof params.effort === "string" || params.effort === null)
        patch.effort = params.effort;
      if (typeof params.serviceTier === "string" || params.serviceTier === null)
        patch.serviceTier = params.serviceTier;
      if (typeof params.unsetServiceTier === "boolean")
        patch.unsetServiceTier = params.unsetServiceTier;
      // Reject contradictory encrypted intent instead of showing an invented
      // pending selection. Native dispatch independently validates this too.
      if (patch.unsetServiceTier === true && patch.serviceTier !== undefined)
        throw new Error(
          "Native service tier intent contains conflicting choices.",
        );
      if (
        params.collaborationModeKind === "default" ||
        params.collaborationModeKind === "plan"
      )
        patch.collaborationModeKind = params.collaborationModeKind;
      if (typeof params.multiAgentEnabled === "boolean")
        patch.multiAgentEnabled = params.multiAgentEnabled;
      for (const field of ["subagentModel", "subagentReasoningEffort"] as const)
        if (typeof params[field] === "string" || params[field] === null)
          patch[field] = params[field];
      if (
        object(params.collaborationMode) &&
        object(params.collaborationMode.settings)
      ) {
        if (
          params.collaborationMode.mode === "default" ||
          params.collaborationMode.mode === "plan"
        )
          patch.collaborationModeKind = params.collaborationMode.mode;
        const collaboration =
          nativeSettingsPatchSchema.shape.collaborationMode.safeParse(
            params.collaborationMode,
          );
        if (collaboration.success) patch.collaborationMode = collaboration.data;
        // Model and effort embedded in collaboration settings are also explicit choices.
        if (typeof params.collaborationMode.settings.model === "string")
          patch.model = params.collaborationMode.settings.model;
        const effort = params.collaborationMode.settings.reasoning_effort;
        if (typeof effort === "string" || effort === null)
          patch.effort = effort;
      }
      opened.push({ operationId: intent.operationId, status, pending, patch });
    } finally {
      clearSensitiveBytes(componentKey);
    }
    if (!matches(identity) || service.getSnapshot() !== unlocked)
      throw new ClientEncryptionError(
        "locked",
        "The encryption session changed while reading settings.",
      );
  }
  return opened;
}
