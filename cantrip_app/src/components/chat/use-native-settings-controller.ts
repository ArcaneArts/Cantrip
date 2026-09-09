import {
  sendNativePermissionUpdate,
  nativePermissionUpdateRejected,
} from "@/lib/native-permission-update";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  NativeSettingsPatch,
  NativeSettingsUpdateReceipt,
} from "@cantrip/protocol";
import { useNativeSettingsState } from "./use-native-settings-state";
import {
  prepareNativeSettingsUpdate,
  sendNativeSettingsUpdate,
} from "@/lib/native-settings-update";
import { clientSessionIdentityMatches } from "@/lib/client-session";

/** One source-owned mutation lane shared by all controls for this native session. */
export function useNativeSettingsController(input: {
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
  const [local, setLocal] = useState<
    {
      bindingId: string;
      identity: typeof identity;
      request: { operationId: string };
      permissionSelection?: { id: string | null; expectedRevision: string };
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
  const submitOperation = async <T extends { operationId: string }>({
    patch,
    expectedBindingId,
    permissionSelection,
    prepare,
    send,
  }: {
    patch: NativeSettingsPatch;
    expectedBindingId: string;
    permissionSelection?: { id: string | null; expectedRevision: string };
    prepare(operationId: string): Promise<T>;
    send(request: T): Promise<NativeSettingsUpdateReceipt>;
  }) => {
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
    let request: T | null = null;
    try {
      if (!identity || !binding || binding.bindingId !== expectedBindingId)
        throw new Error(
          "The selected native session changed. Reopen session settings.",
        );
      request = await prepare(crypto.randomUUID());
      if (!current()) throw new Error("The authenticated session changed.");
      const pending = {
        bindingId: binding.bindingId,
        identity,
        request,
        patch,
        permissionSelection,
        previousDesiredRevision: observed.state.data?.desiredRevision ?? "0",
        status: "requesting" as const,
      };
      setLocal((previous) => [...previous, pending]);
      const receipt = await send(request);
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
              ? {
                  ...entry,
                  status:
                    permissionSelection && nativePermissionUpdateRejected(error)
                      ? "rejected"
                      : "uncertain",
                }
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
        void queryClient.invalidateQueries({
          queryKey: ["permission-profiles", input.chatId],
        });
      }
    }
  };
  const submitPatch = async (
    patch: NativeSettingsPatch,
    expectedBindingId: string,
  ) => {
    if (!Object.keys(patch).length) return null;
    return submitOperation({
      patch,
      expectedBindingId,
      prepare: (operationId) =>
        prepareNativeSettingsUpdate({
          chatId: input.chatId,
          binding: binding!,
          patch,
          operationId,
        }),
      send: (request) =>
        sendNativeSettingsUpdate({
          chatId: input.chatId,
          identity: identity!,
          request,
        }),
    });
  };
  const submitPermission = (
    id: string | null,
    expectedRevision: string,
    expectedBindingId: string,
  ) =>
    submitOperation({
      patch: {},
      expectedBindingId,
      permissionSelection: { id, expectedRevision },
      prepare: async (operationId) => ({
        id,
        expectedRevision,
        bindingId: expectedBindingId,
        operationId,
      }),
      send: (request) =>
        sendNativePermissionUpdate({
          chatId: input.chatId,
          identity: identity!,
          request,
        }),
    });
  const pendingPatches = useMemo(() => {
    if (!binding) return [];
    const result: NativeSettingsPatch[] = observed.intents
      .filter((intent) => intent.pending && intent.status !== "rejected")
      .map((intent) => intent.patch);
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
        result.push(entry.patch);
    }
    return result;
  }, [binding, observed.intents, observed.state.data, identity, local]);
  return {
    observed,
    binding,
    identity,
    submitPatch,
    submitPermission,
    pendingPatches,
    isPending,
    localPermission:
      [...local]
        .reverse()
        .find(
          (entry) =>
            entry.permissionSelection &&
            entry.bindingId === binding?.bindingId &&
            entry.identity === identity,
        ) ?? null,
    setUpdateError,
    updateError,
    pending: observed.state.data?.pending.length ?? 0,
    localStatus:
      local.at(-1)?.bindingId === binding?.bindingId &&
      local.at(-1)?.identity === identity
        ? (local.at(-1)?.status ?? null)
        : null,
    error: observed.state.error ?? observed.decryptionError ?? updateError,
  };
}
export type NativeSettingsController = ReturnType<
  typeof useNativeSettingsController
>;
