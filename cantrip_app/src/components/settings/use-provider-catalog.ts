import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

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

export function useProviderCatalog(
  providerId: string | null | undefined,
  workerId: string | null,
  enabled: boolean,
) {
  const cachedCatalog = useMemo(
    () =>
      providerId ? cachedProviderModelCatalog(providerId, workerId) : undefined,
    [providerId, workerId],
  );

  return useQuery({
    enabled: Boolean(enabled && providerId),
    placeholderData: cachedCatalog,
    queryFn: async () => {
      const catalog = await getProviderModelCatalog(providerId!, workerId);
      cacheProviderModelCatalog(providerId!, workerId, catalog);
      return catalog;
    },
    queryKey: providerCatalogQueryKey(providerId, workerId),
    retry: false,
    staleTime: 60_000,
  });
}
