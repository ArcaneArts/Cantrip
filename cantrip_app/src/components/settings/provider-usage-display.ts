import type { ModelProviderAccountSummary } from "@cantrip/protocol";

export interface ProviderWeeklyAvailability {
  availablePercent: number;
  reportedAccountCount: number;
  signedInAccountCount: number;
}

export function providerWeeklyRemainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
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
