import type { ModelProviderSummary } from "@cantrip/protocol";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { refreshProviderModelCatalog } from "@/lib/api";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
} from "@/lib/client-session";

export type OllamaModelPickerScope = {
  providers: readonly Pick<ModelProviderSummary, "id" | "kind">[] | undefined;
  workerId: string | null;
};

export function OllamaModelPickerRefresh({
  providers,
  workerId,
  chatId,
}: OllamaModelPickerScope & { chatId?: string }) {
  const queryClient = useQueryClient();
  const attempt = useRef<{ scope: string; providerIds: Set<string> } | null>(
    null,
  );

  useEffect(() => {
    const identity = getClientSessionIdentitySnapshot();
    if (!identity || !providers) return;

    const scope = JSON.stringify([identity.generation, workerId, chatId]);
    if (attempt.current?.scope !== scope) {
      attempt.current = { scope, providerIds: new Set() };
    }
    const { providerIds } = attempt.current;
    const pickerQuery = ({ queryKey: [key, id] }: Query) =>
      key === "settings" ||
      (chatId !== undefined &&
        id === chatId &&
        (key === "native-model-inventory" || key === "native-runtime-handoffs"));

    for (const provider of providers) {
      if (provider.kind !== "ollama" || providerIds.has(provider.id)) continue;
      providerIds.add(provider.id);
      void refreshProviderModelCatalog(provider.id, workerId, identity)
        .then(async () => {
          if (!clientSessionIdentityMatches(identity)) return;
          // An initial read could have started before the catalog was updated.
          await queryClient.cancelQueries({
            predicate: (query) =>
              query.state.data === undefined && pickerQuery(query),
          });
          if (!clientSessionIdentityMatches(identity)) return;
          await queryClient.invalidateQueries({ predicate: pickerQuery });
        })
        .catch(() => {
          // Keep the cached choices usable if discovery is unavailable.
        });
    }
  }, [chatId, providers, queryClient, workerId]);

  return null;
}
