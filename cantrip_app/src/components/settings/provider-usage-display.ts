import type {
  ModelProviderAccountSummary,
  ProviderWeeklyUsage,
} from "@cantrip/protocol";

export interface ProviderWeeklyAvailability {
  availablePercent: number;
  reportedAccountCount: number;
  signedInAccountCount: number;
}

export function providerWeeklyRemainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function providerAccountWeeklyUsage(
  account: ModelProviderAccountSummary | null,
): ProviderWeeklyUsage | null {
  if (!account || account.weeklyUsageUsedPercent === null) return null;
  const resetMilliseconds = account.weeklyUsageResetsAt
    ? Date.parse(account.weeklyUsageResetsAt)
    : Number.NaN;
  return {
    usedPercent: account.weeklyUsageUsedPercent,
    resetsAt: Number.isFinite(resetMilliseconds)
      ? Math.floor(resetMilliseconds / 1_000)
      : null,
  };
}

export function providerWeeklyAvailability(
  accounts: ModelProviderAccountSummary[],
): ProviderWeeklyAvailability | null {
  const signedIn = accounts.filter(
    (account) => account.enabled && account.credentialState === "signed-in",
  );
  const reported = signedIn.flatMap((account) =>
    account.weeklyUsageUsedPercent === null
      ? []
      : [account.weeklyUsageUsedPercent],
  );
  if (!reported.length) return null;
  return {
    availablePercent: reported.reduce(
      (total, usedPercent) =>
        total + providerWeeklyRemainingPercent(usedPercent),
      0,
    ),
    reportedAccountCount: reported.length,
    signedInAccountCount: signedIn.length,
  };
}
