import { useQuery } from "@tanstack/react-query";
import { getClaudeCodeAccountUsage } from "@/lib/api/models";
import { providerWeeklyRemainingPercent } from "./provider-usage-display";
import { ProviderUsageBar } from "./provider-usage-bar";

export const claudeUsageQueryKey = (providerId: string, accountId: string) =>
  ["claude-account-usage", providerId, accountId] as const;

export function ClaudeAccountUsage({
  providerId,
  accountId,
  showPlan = true,
}: {
  providerId: string;
  accountId: string;
  showPlan?: boolean;
}) {
  const usage = useQuery({
    queryKey: claudeUsageQueryKey(providerId, accountId),
    queryFn: () => getClaudeCodeAccountUsage(providerId, accountId),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  if (!usage.data)
    return (
      <p className="text-xs text-muted-foreground">
        {usage.isPending
          ? "Loading subscription usage…"
          : "Subscription usage unavailable."}
      </p>
    );
  return (
    <div className="grid gap-2" aria-label="Subscription usage">
      {showPlan && usage.data.subscriptionType ? (
        <p className="text-xs capitalize text-muted-foreground">
          Claude {usage.data.subscriptionType}
        </p>
      ) : null}
      {usage.data.windows.map(({ label, usedPercent, resetText }) => (
        <ProviderUsageBar
          key={label}
          label={label}
          remainingPercent={providerWeeklyRemainingPercent(usedPercent)}
          resetText={resetText ? `Resets ${resetText}` : null}
        />
      ))}
      {usage.isError ? (
        <p className="text-xs text-muted-foreground">
          Showing previously reported usage.
        </p>
      ) : null}
    </div>
  );
}
