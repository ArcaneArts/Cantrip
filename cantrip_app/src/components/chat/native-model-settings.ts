import {
  resolveNativeModelSelection,
  type NativeChatModelInventory,
  type NativeSettingsBinding,
  type NativeSettingsPatch,
  type NativeThreadSettings,
} from "@cantrip/protocol";
import type { OpenedNativeSettingsIntent } from "@/lib/native-settings-intents";

export type NativeModelSelection = {
  model: string;
  effort: string | null;
  serviceTier: string | null;
  collaborationModeKind?: "default" | "plan";
  multiAgentEnabled?: boolean;
  subagentModel?: string | null;
  subagentReasoningEffort?: string | null;
};
export type NativeModelDraft = NativeModelSelection & { routeId: string };
export type NativeModelDirty = Partial<
  Record<
    | "model"
    | "effort"
    | "serviceTier"
    | "multiAgentEnabled"
    | "subagentModel"
    | "subagentReasoningEffort",
    boolean
  >
>;

export function requestedNativeModelSelection(
  confirmed: NativeThreadSettings,
  intents: OpenedNativeSettingsIntent[],
): NativeModelSelection {
  const selected: NativeModelSelection = {
    model: confirmed.model,
    effort: confirmed.effort,
    serviceTier: confirmed.serviceTier,
  };
  if (confirmed.collaborationMode)
    selected.collaborationModeKind = confirmed.collaborationMode.mode;
  for (const field of [
    "multiAgentEnabled",
    "subagentModel",
    "subagentReasoningEffort",
  ] as const) {
    if (confirmed[field] !== undefined)
      Object.assign(selected, { [field]: confirmed[field] });
  }
  for (const intent of intents) {
    if (!intent.pending || intent.status === "rejected") continue;
    applyNativeModelPatch(selected, intent.patch);
  }
  return selected;
}

export function applyNativeModelPatch(
  selected: NativeModelSelection,
  patch: NativeSettingsPatch,
) {
  if (typeof patch.model === "string") selected.model = patch.model;
  for (const field of [
    "effort",
    "collaborationModeKind",
    "multiAgentEnabled",
    "subagentModel",
    "subagentReasoningEffort",
  ] as const) {
    if (patch[field] !== undefined)
      Object.assign(selected, { [field]: patch[field] });
  }
  if (patch.unsetServiceTier === true) selected.serviceTier = null;
  else if (patch.serviceTier !== undefined)
    selected.serviceTier = patch.serviceTier ?? "default";
  // Native StepSettings::apply gives a full collaboration mode precedence
  // over separate model/effort fields in the same admitted update.
  if (patch.collaborationMode) {
    selected.model = patch.collaborationMode.settings.model;
    selected.effort = patch.collaborationMode.settings.reasoning_effort;
    selected.collaborationModeKind = patch.collaborationMode.mode;
  }
  if (patch.collaborationModeKind !== undefined)
    selected.collaborationModeKind = patch.collaborationModeKind;
}

/** Construct only user-edited fields, never the stale snapshot shown when a
 * dialog opened. A native model name cannot select an ambiguous route alias. */
export function nativeModelSettingsPatch(input: {
  binding: NativeSettingsBinding;
  inventory: NativeChatModelInventory;
  draft: NativeModelDraft;
  dirty: NativeModelDirty;
}): NativeSettingsPatch {
  const { binding, inventory, draft, dirty } = input;
  if (
    inventory.bindingId !== binding.bindingId ||
    inventory.workerId !== binding.workerId ||
    inventory.providerAccountId !== binding.providerAccountId
  )
    throw new Error("The model inventory belongs to another native session.");
  const patch: NativeSettingsPatch = {};
  if (dirty.model) {
    const route = inventory.models.find(
      (model) => model.routeId === draft.routeId,
    );
    if (!route)
      throw new Error("Choose a model in this session's provider and account.");
    const resolved = resolveNativeModelSelection(
      inventory,
      route.name,
      binding.modelRouteId,
    );
    if (
      resolved.status !== "resolved" ||
      resolved.model.routeId !== route.routeId
    )
      throw new Error(
        "This native name maps to multiple routes. An explicit route migration is required to select that alias.",
      );
    patch.model = route.name;
  }
  if (dirty.effort) patch.effort = draft.effort;
  if (dirty.serviceTier) {
    if (draft.serviceTier === null) patch.unsetServiceTier = true;
    else patch.serviceTier = draft.serviceTier;
  }
  if (dirty.multiAgentEnabled && draft.multiAgentEnabled !== undefined)
    patch.multiAgentEnabled = draft.multiAgentEnabled;
  if (dirty.subagentModel && draft.subagentModel !== undefined) {
    if (
      draft.subagentModel !== null &&
      !inventory.models.some((model) => model.name === draft.subagentModel)
    )
      throw new Error(
        "Choose a subagent model in this session's provider and account.",
      );
    patch.subagentModel = draft.subagentModel;
  }
  if (
    dirty.subagentReasoningEffort &&
    draft.subagentReasoningEffort !== undefined
  )
    patch.subagentReasoningEffort = draft.subagentReasoningEffort;
  return patch;
}

export function nativeModelPickerMode(input: {
  enabled: boolean;
  status: "pending" | "error" | "success";
  binding: NativeSettingsBinding | null | undefined;
}): "native" | "bootstrap" {
  return input.enabled && (input.status !== "success" || input.binding != null)
    ? "native"
    : "bootstrap";
}
