import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  NativeRuntimeHandoffRequest,
  NativeSettingsBinding,
} from "@cantrip/protocol";
import {
  clientSessionIdentityMatches,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import {
  readRuntimeHandoffs,
  startRuntimeHandoff,
  controlRuntimeHandoff,
  runtimeHandoffActive,
} from "@/lib/native-runtime-handoff";
import { CantripApiError } from "@/lib/api-client";

export function useRuntimeHandoff(input: {
  binding: NativeSettingsBinding | null | undefined;
  identity: ClientSessionIdentitySnapshot | null;
  open: boolean;
  unlocked: boolean;
}) {
  const { binding, identity } = input;
  const chatId = binding?.chatId;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Preserve the exact begin request after an uncertain HTTP result. Retrying
  // cannot allocate a second transfer identity or silently select another target.
  const [unconfirmed, setUnconfirmed] =
    useState<NativeRuntimeHandoffRequest | null>(null);
  const guard = useRef(false);
  const lifetime = useRef(0);
  useEffect(() => {
    lifetime.current++;
    guard.current = false;
    setBusy(false);
    setTracking(false);
    setError(null);
    setUnconfirmed(null);
    return () => {
      lifetime.current++;
    };
  }, [chatId, identity, input.unlocked]);
  const query = useQuery({
    queryKey: ["native-runtime-handoffs", chatId, identity],
    enabled: Boolean(
      chatId &&
      identity &&
      input.unlocked &&
      (input.open || tracking || busy || unconfirmed),
    ),
    queryFn: ({ signal }) =>
      readRuntimeHandoffs({ chatId: chatId!, identity: identity! }, signal),
    retry: false,
    refetchOnMount: "always",
    refetchInterval: (query) =>
      input.unlocked &&
      (input.open ||
        busy ||
        unconfirmed ||
        runtimeHandoffActive(query.state.data?.latest?.phase))
        ? 1500
        : false,
  });
  const latest = query.data?.latest;
  useEffect(() => {
    if (!latest) return;
    setTracking(runtimeHandoffActive(latest.phase));
    if (latest.operationId === unconfirmed?.operationId) {
      setUnconfirmed(null);
      setError(null);
    }
    void client.invalidateQueries({ queryKey: ["native-settings", chatId] });
  }, [
    latest?.operationId,
    latest?.phase,
    latest?.binding?.bindingId,
    unconfirmed?.operationId,
  ]);
  const run = async (
    action: "start" | "retry" | "cancel",
    selection?: { routeId: string; accountId: string | null },
  ) => {
    if (guard.current || !binding || !identity || !input.unlocked) return;
    guard.current = true;
    setBusy(true);
    setError(null);
    const version = lifetime.current;
    const current = () =>
      version === lifetime.current && clientSessionIdentityMatches(identity);
    try {
      const scope = { chatId: binding.chatId, identity };
      let result;
      if (action === "start" || (action === "retry" && unconfirmed)) {
        const begin = unconfirmed ?? {
          operationId: crypto.randomUUID(),
          bindingId: binding.bindingId,
          targetModelRouteId: selection!.routeId,
          targetProviderAccountId: selection!.accountId,
        };
        setUnconfirmed(begin);
        result = await startRuntimeHandoff(scope, begin);
      } else {
        if (!latest)
          throw new Error("Read the current transfer before continuing.");
        result = await controlRuntimeHandoff(scope, latest.operationId, action);
      }
      if (current()) {
        setUnconfirmed(null);
        // Re-read the durable inventory; operation responses need not include
        // concurrent target/configuration changes from another view.
        await query.refetch();
        void client.invalidateQueries({
          queryKey: ["native-settings", chatId],
        });
      }
      return result;
    } catch (error) {
      if (current()) {
        if (
          error instanceof CantripApiError &&
          [400, 403, 404, 409].includes(error.status)
        )
          setUnconfirmed(null);
        setError(
          error instanceof Error
            ? error.message
            : "The transfer request was not confirmed.",
        );
        await query.refetch();
      }
    } finally {
      if (current()) {
        guard.current = false;
        setBusy(false);
      }
    }
  };
  return {
    query,
    latest,
    busy,
    error,
    unconfirmed,
    run,
    active: runtimeHandoffActive(latest?.phase),
  };
}
