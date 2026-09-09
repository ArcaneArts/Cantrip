import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  resolveNativeModelSelection,
  type NativeSettingsPatch,
  type NativeSettingsUpdateRequest,
} from "@cantrip/protocol";
import { useNativeSettingsState } from "./use-native-settings-state";
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
import {
  prepareNativeSettingsUpdate,
  sendNativeSettingsUpdate,
} from "@/lib/native-settings-update";
import { clientSessionIdentityMatches } from "@/lib/client-session";

export function useNativeModelSettings(input: {
  chatId: string;
  enabled: boolean;
  workerId: string | null;
  projectId: string | null;
  placementId: string | null;
  contextKind: "project" | "standalone";
}) {
  const observed = useNativeSettingsState(input.chatId, input.enabled);
  const queryClient = useQueryClient();
  const source = observed.state.data?.binding;
  const binding =
    source &&
    source.workerId === input.workerId &&
    source.contextKind === input.contextKind &&
    source.projectId === input.projectId &&
    source.placementId === input.placementId
      ? source
      : null;
  const identity = observed.identity;
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
  const [local, setLocal] = useState<
    {
      bindingId: string;
      identity: typeof identity;
      request: NativeSettingsUpdateRequest;
      patch: NativeSettingsPatch;
      previousDesiredRevision: string;
      status: "requesting" | "queued" | "applied" | "rejected" | "uncertain";
    }[]
  >([]);
  // Keep decrypted selections only in this mounted controller. Mutation/query
  // caches must not retain a user's private desired settings after lock/logout.
  const lifetime = useRef(0);
  const busy = useRef<symbol | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [updateError, setUpdateError] = useState<Error | null>(null);
  useEffect(() => {
    lifetime.current += 1;
    busy.current = null;
    setLocal([]);
    setIsPending(false);
    setUpdateError(null);
    return () => {
      lifetime.current += 1;
    };
  }, [identity, binding?.bindingId, observed.encryption]);
  useEffect(() => {
    const state = observed.state.data;
    if (!state) return;
    const known = new Set([
      state.desired?.operationId,
      ...state.pending.map((entry) => entry.intent.operationId),
    ]);
    setLocal((previous) => {
      if (!previous.some((entry) => known.has(entry.request.operationId)))
        return previous;
      return previous
        .filter((entry) => !known.has(entry.request.operationId))
        .map((entry) => ({
          ...entry,
          previousDesiredRevision: state.desiredRevision,
        }));
    });
  }, [observed.state.data]);
  const submitPatch = async (
    patch: NativeSettingsPatch,
    expectedBindingId: string,
  ) => {
    if (busy.current)
      throw new Error("A settings change is already being submitted.");
    const activeLifetime = lifetime.current;
    const current = () =>
      activeLifetime === lifetime.current &&
      identity &&
      clientSessionIdentityMatches(identity);
    const submissionToken = Symbol();
    busy.current = submissionToken;
    setIsPending(true);
    setUpdateError(null);
    let request: NativeSettingsUpdateRequest | null = null;
    try {
      if (!identity || !binding || binding.bindingId !== expectedBindingId)
        throw new Error(
          "The selected native session changed. Reopen model settings.",
        );
      if (!Object.keys(patch).length) return null;
      request = await prepareNativeSettingsUpdate({
        chatId: input.chatId,
        binding,
        patch,
        operationId: crypto.randomUUID(),
      });
      if (!current()) throw new Error("The authenticated session changed.");
      const pending = {
        bindingId: binding.bindingId,
        identity,
        request,
        patch,
        previousDesiredRevision: observed.state.data?.desiredRevision ?? "0",
        status: "requesting" as const,
      };
      setLocal((previous) => [...previous, pending]);
      const receipt = await sendNativeSettingsUpdate({
        chatId: input.chatId,
        identity,
        request,
      });
      if (current())
        setLocal((previous) =>
          previous.map((entry) =>
            entry.request.operationId === pending.request.operationId
              ? { ...entry, status: receipt.status }
              : entry,
          ),
        );
      if (receipt.status === "rejected")
        throw new Error("The native session rejected this settings change.");
      return receipt;
    } catch (error) {
      if (current()) {
        setUpdateError(
          error instanceof Error
            ? error
            : new Error("Could not submit session settings."),
        );
        setLocal((previous) =>
          previous.map((entry) =>
            entry.request.operationId === request?.operationId &&
            entry.status !== "rejected"
              ? { ...entry, status: "uncertain" }
              : entry,
          ),
        );
      }
      throw error;
    } finally {
      if (busy.current === submissionToken) busy.current = null;
      if (current()) {
        setIsPending(false);
        void queryClient.invalidateQueries({
          queryKey: ["native-settings", input.chatId],
        });
      }
    }
  };
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
    const result = requestedNativeModelSelection(
      observed.confirmed,
      observed.intents,
    );
    const acknowledged = local.findIndex(
      (entry) =>
        entry.request.operationId === observed.state.data?.desired?.operationId,
    );
    for (const [index, entry] of local.entries()) {
      if (
        entry.bindingId !== binding.bindingId ||
        entry.identity !== identity ||
        entry.status === "rejected"
      )
        continue;
      if (
        observed.intents.some(
          (intent) => intent.operationId === entry.request.operationId,
        )
      )
        continue;
      if (
        BigInt(observed.state.data?.desiredRevision ?? "0") <=
          BigInt(entry.previousDesiredRevision) ||
        (acknowledged >= 0 && index > acknowledged)
      )
        applyNativeModelPatch(result, entry.patch);
    }
    return result;
  }, [
    binding,
    observed.confirmed,
    observed.intents,
    observed.state.data,
    identity,
    local,
  ]);
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
    pending: observed.state.data?.pending.length ?? 0,
    localStatus:
      local.at(-1)?.bindingId === binding?.bindingId &&
      local.at(-1)?.identity === identity
        ? (local.at(-1)?.status ?? null)
        : null,
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
