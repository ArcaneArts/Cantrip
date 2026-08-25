import { useQuery } from "@tanstack/react-query";

import { getProviderModelCatalog } from "@/lib/api";
import {
  cachedProviderModelCatalog,
  cacheProviderModelCatalog,
} from "./provider-catalog-cache";

export function providerCatalogQueryKey(
  providerId: string | null | undefined,
  workerId: string | null,
) {
  return ["provider-catalog", providerId ?? null, workerId] as const;
}

export function providerCatalogQueryOptions(
  providerId: string | null | undefined,
  workerId: string | null,
  enabled: boolean,
) {
  const queryEnabled = Boolean(enabled && providerId);
  return {
    enabled: queryEnabled,
    placeholderData: queryEnabled
      ? cachedProviderModelCatalog(providerId!, workerId)
      : undefined,
    queryFn: async () => {
      const catalog = await getProviderModelCatalog(providerId!, workerId);
      cacheProviderModelCatalog(providerId!, workerId, catalog);
      return catalog;
    },
    queryKey: providerCatalogQueryKey(providerId, workerId),
    retry: false,
    staleTime: 60_000,
  };
}

export function useProviderCatalog(
  providerId: string | null | undefined,
  workerId: string | null,
  enabled: boolean,
) {
  return useQuery(providerCatalogQueryOptions(providerId, workerId, enabled));
}
