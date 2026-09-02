import type {
  ModelProviderSummary,
  ProviderQuotaSnapshot,
} from "@cantrip/protocol";
import { useQueries } from "@tanstack/react-query";

import { getProviderRateLimitResets } from "@/lib/api";
import { liveResourceRefreshInterval } from "@/lib/live-resource-refresh";

export interface ProviderResetCreditTarget {
  accountId: string;
  providerId: string;
}

export function chatGptResetCreditTargets(
  providers: readonly ModelProviderSummary[],
): ProviderResetCreditTarget[] {
  return providers.flatMap((provider) =>
    provider.kind === "chatgpt"
      ? provider.accounts
          .filter(
            (account) =>
              account.enabled && account.credentialState === "signed-in",
          )
          .map((account) => ({
            accountId: account.id,
            providerId: provider.id,
          }))
      : [],
  );
}

export function providerRateLimitResetQueryKey(
  providerId: string | null | undefined,
  accountId: string | null | undefined,
  workerId: string | null,
) {
  return [
    "provider-rate-limit-resets",
    providerId ?? null,
    accountId ?? null,
    workerId,
  ] as const;
}

export function availableResetCreditsByAccount(
  targets: readonly ProviderResetCreditTarget[],
  snapshots: readonly (ProviderQuotaSnapshot | undefined)[],
): ReadonlyMap<string, number> {
  return new Map(
    targets.flatMap((target, index) => {
      const availableCount =
        snapshots[index]?.rateLimitResetCredits?.availableCount;
      return availableCount === undefined
        ? []
        : ([[target.accountId, availableCount]] as const);
    }),
  );
}

export function useChatGptAvailableResetCredits(options: {
  enabled: boolean;
  providers: readonly ModelProviderSummary[];
  resourcesLive: boolean;
  workerId: string | null;
}): ReadonlyMap<string, number> {
  const targets = chatGptResetCreditTargets(options.providers);
  const queries = useQueries({
    queries: targets.map((target) => ({
      enabled: options.enabled && Boolean(options.workerId),
      queryFn: () =>
        getProviderRateLimitResets(
          target.providerId,
          target.accountId,
          options.workerId!,
        ),
      queryKey: providerRateLimitResetQueryKey(
        target.providerId,
        target.accountId,
        options.workerId,
      ),
      refetchInterval: liveResourceRefreshInterval(
        options.resourcesLive,
        30_000,
      ),
      retry: false,
      staleTime: 30_000,
    })),
  });
  return availableResetCreditsByAccount(
    targets,
    queries.map(({ data }) => data),
  );
}
