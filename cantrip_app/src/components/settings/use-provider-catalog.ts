import { useQuery } from "@tanstack/react-query";

import { getProviderModelCatalog } from "@/lib/api";
import {
  cachedProviderModelCatalog,
  cacheProviderModelCatalog,
} from "./provider-catalog-cache";

export function providerCatalogQueryKey(
  providerId: string | null | undefined,
  workerId: string | null,
  connectionRevision?: number | string,
) {
  return connectionRevision === undefined
    ? (["provider-catalog", providerId ?? null, workerId] as const)
    : ([
        "provider-catalog",
        providerId ?? null,
        workerId,
        connectionRevision,
      ] as const);
}

export function providerCatalogQueryOptions(
  providerId: string | null | undefined,
  workerId: string | null,
  enabled: boolean,
  connectionRevision?: number | string,
) {
  const queryEnabled = Boolean(enabled && providerId);
  return {
    enabled: queryEnabled,
    placeholderData: queryEnabled
      ? cachedProviderModelCatalog(providerId!, workerId, connectionRevision)
      : undefined,
    queryFn: async () => {
      const catalog = await getProviderModelCatalog(providerId!, workerId);
      cacheProviderModelCatalog(
        providerId!,
        workerId,
        catalog,
        connectionRevision,
      );
      return catalog;
    },
    queryKey: providerCatalogQueryKey(providerId, workerId, connectionRevision),
    retry: false,
    staleTime: 60_000,
  };
}

export function useProviderCatalog(
  providerId: string | null | undefined,
  workerId: string | null,
  enabled: boolean,
  connectionRevision?: number | string,
) {
  return useQuery(
    providerCatalogQueryOptions(
      providerId,
      workerId,
      enabled,
      connectionRevision,
    ),
  );
}
