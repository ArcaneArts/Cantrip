import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  NativeSettingsState,
  NativeThreadSettings,
} from "@cantrip/protocol";
import { useAppLiveScope } from "@/lib/app-live-react";
import {
  clientEncryption,
  type ClientEncryptionSnapshot,
} from "@/lib/client-encryption";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import {
  nativeSettingsQueryKey,
  readNativeSettingsState,
  retainLatestNativeSettings,
} from "@/lib/native-settings-api";
import { openNativeSettingsState } from "@/lib/native-settings-encryption";
import {
  openNativeSettingsIntents,
  type OpenedNativeSettingsIntent,
} from "@/lib/native-settings-intents";

// The session accessor returns a fresh object. React requires a stable snapshot
// between notifications; serializing this small identity also scopes the cache.
const identitySnapshot = () =>
  JSON.stringify(getClientSessionIdentitySnapshot());
const subscribeIdentity = (listener: () => void) =>
  onClientSessionIdentityChanged(listener);
type Opened = {
  source: NativeSettingsState;
  identityKey: string;
  encryption: ClientEncryptionSnapshot;
  value: NativeThreadSettings | null;
  intents: OpenedNativeSettingsIntent[];
  error: Error | null;
};

/** Query caches contain ciphertext only. Plaintext belongs to this mounted view
 * and is hidden immediately when its account, encryption lifetime or source changes. */
export function useNativeSettingsState(chatId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const identityKey = useSyncExternalStore(
    subscribeIdentity,
    identitySnapshot,
    identitySnapshot,
  );
  const identity = useMemo(
    () => JSON.parse(identityKey) as ClientSessionIdentitySnapshot | null,
    [identityKey],
  );
  const encryption = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
    clientEncryption.getSnapshot,
  );
  const queryKey = nativeSettingsQueryKey(chatId, identity);
  const lastNativeRefresh = useRef<{ scope: string; at: number } | null>(null);
  useAppLiveScope(enabled && identity ? { kind: "chat", chatId } : null);
  const state = useQuery({
    queryKey,
    enabled: enabled && identity !== null,
    queryFn: ({ signal }) => {
      if (!identity) throw new Error("A signed-in account is required.");
      const previous = queryClient.getQueryData<NativeSettingsState>(queryKey);
      const scope = JSON.stringify([chatId, identityKey]);
      const now = Date.now();
      // Refresh publishes an invalidation itself. Coalesce those reads so a
      // pending operation cannot create a native-read/invalidation feedback loop.
      const refresh =
        Boolean(previous?.pending.length) &&
        (lastNativeRefresh.current?.scope !== scope ||
          now - lastNativeRefresh.current.at >= 3_000);
      if (refresh) lastNativeRefresh.current = { scope, at: now };
      return readNativeSettingsState({ chatId, identity, signal, refresh });
    },
    structuralSharing: (previous, next) =>
      retainLatestNativeSettings(previous, next as NativeSettingsState),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.pending.length || query.state.status === "error"
        ? 3_000
        : false,
  });
  const refresh = useMutation({
    mutationFn: async () => {
      if (!identity) throw new Error("A signed-in account is required.");
      const next = await readNativeSettingsState({
        chatId,
        identity,
        refresh: true,
      });
      if (clientSessionIdentityMatches(identity))
        queryClient.setQueryData(queryKey, (old: unknown) =>
          retainLatestNativeSettings(old, next),
        );
      return next;
    },
    retry: false,
  });
  const [opened, setOpened] = useState<Opened | null>(null);
  useEffect(() => {
    let cancelled = false;
    const source = state.data;
    if (!enabled || !source || !identity || encryption.status !== "ready") {
      setOpened(null);
      return;
    }
    const scope = { source, identityKey, encryption };
    void Promise.allSettled([
      openNativeSettingsState({ chatId, state: source }),
      openNativeSettingsIntents({ chatId, state: source }),
    ]).then(([value, intents]) => {
      if (!cancelled)
        setOpened({
          ...scope,
          value: value.status === "fulfilled" ? value.value : null,
          intents: intents.status === "fulfilled" ? intents.value : [],
          error:
            value.status === "rejected"
              ? new Error("Could not open confirmed native settings.")
              : intents.status === "rejected"
                ? new Error("Could not open requested native settings.")
                : null,
        });
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, enabled, state.data, identity, identityKey, encryption]);
  const current =
    enabled &&
    encryption.status === "ready" &&
    opened !== null &&
    opened.source === state.data &&
    opened.identityKey === identityKey &&
    opened.encryption === encryption
      ? opened
      : null;
  return {
    identity,
    encryption,
    state,
    refresh,
    // This is the last confirmed native selection, not an optimistic request or
    // proof that its runtime is still connected. Controllers must compare scope.
    confirmed: current?.value ?? null,
    intents: current?.intents ?? [],
    decryptionError: current?.error ?? null,
  };
}
