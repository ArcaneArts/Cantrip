import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  resolveNativeModelSelection,
  type NativeSettingsPatch,
} from "@cantrip/protocol";
import { useNativeSettingsController } from "./use-native-settings-controller";
import {
  requestedNativeModelSelection,
  applyNativeModelPatch,
  nativeModelSettingsPatch,
  nativeModelPickerMode,
  type NativeModelDraft,
  type NativeModelDirty,
} from "./native-model-settings";
import {
  nativeChatModelInventoryQueryKey,
  readNativeChatModelInventory,
} from "@/lib/native-model-inventory";

export function useNativeModelSettings(input: {
  chatId: string;
  enabled: boolean;
  workerId: string | null;
  projectId: string | null;
  placementId: string | null;
  contextKind: "project" | "standalone";
}) {
  const session = useNativeSettingsController(input);
  const {
    observed,
    binding,
    identity,
    submitPatch,
    isPending,
    updateError,
    setUpdateError,
  } = session;
  const inventory = useQuery({
    queryKey: nativeChatModelInventoryQueryKey(
      input.chatId,
      binding?.bindingId ?? "",
      identity,
    ),
    enabled: Boolean(input.enabled && binding && identity),
    queryFn: ({ signal }) => {
      if (!identity || !binding)
        throw new Error("A bound native session is required.");
      return readNativeChatModelInventory({
        chatId: input.chatId,
        bindingId: binding.bindingId,
        identity,
        signal,
      });
    },
    retry: false,
    staleTime: 30_000,
  });
  const update = {
    isPending,
    error: updateError,
    mutateAsync: async (selection: {
      draft: NativeModelDraft;
      dirty: NativeModelDirty;
      bindingId: string;
    }) => {
      if (
        !binding ||
        binding.bindingId !== selection.bindingId ||
        !inventory.data
      )
        throw new Error(
          "The selected native session changed. Reopen model settings.",
        );
      let patch: NativeSettingsPatch;
      try {
        patch = nativeModelSettingsPatch({
          binding,
          inventory: inventory.data,
          ...selection,
        });
      } catch (error) {
        setUpdateError(
          error instanceof Error
            ? error
            : new Error("Could not change session settings."),
        );
        throw error;
      }
      return submitPatch(patch, selection.bindingId);
    },
  };
  const updateMode = async (mode: "default" | "plan") => {
    if (!binding) throw new Error("The selected native session changed.");
    const receipt = await submitPatch(
      { collaborationModeKind: mode },
      binding.bindingId,
    );
    if (receipt?.status !== "queued" && receipt?.status !== "applied")
      throw new Error(
        "The mode change is not confirmed as queued. Check session settings before submitting again.",
      );
    return receipt;
  };
  const selected = useMemo(() => {
    if (!binding || !observed.confirmed) return null;
    const result = requestedNativeModelSelection(observed.confirmed, []);
    for (const patch of session.pendingPatches)
      applyNativeModelPatch(result, patch);
    return result;
  }, [binding, observed.confirmed, session.pendingPatches]);
  const mapped =
    inventory.data && selected
      ? resolveNativeModelSelection(
          inventory.data,
          selected.model,
          binding?.modelRouteId,
        )
      : null;
  return {
    observed,
    pickerMode: nativeModelPickerMode({
      enabled: input.enabled,
      status: observed.state.status,
      binding: observed.state.data?.binding,
    }),
    binding,
    inventory,
    selected,
    selectedRouteId: mapped?.status === "resolved" ? mapped.model.routeId : "",
    update,
    updateMode,
    session,
    pending: session.pending,
    localStatus: session.localStatus,
    error:
      observed.state.error ??
      observed.decryptionError ??
      inventory.error ??
      update.error,
  };
}
export type NativeModelSettingsController = ReturnType<
  typeof useNativeModelSettings
>;
