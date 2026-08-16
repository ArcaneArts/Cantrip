import type { ModelProviderAccountSummary } from "@cantrip/protocol";

export interface ProviderWeeklyAvailability {
  availablePercent: number;
  reportedAccountCount: number;
  signedInAccountCount: number;
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
      (total, usedPercent) => total + Math.max(0, 100 - usedPercent),
      0,
    ),
    reportedAccountCount: reported.length,
    signedInAccountCount: signedIn.length,
  };
}
