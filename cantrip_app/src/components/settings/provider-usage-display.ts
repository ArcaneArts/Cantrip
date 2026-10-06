import type {
  ModelProviderAccountSummary,
  ProviderQuotaSnapshot,
  ProviderWeeklyUsage,
  ProviderCreditsSnapshot,
} from "@cantrip/protocol";
import { providerCreditBalance } from "@cantrip/protocol";

const creditFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

export function providerAccountCredits(
  account: ModelProviderAccountSummary | null | undefined,
  snapshot?: ProviderQuotaSnapshot | null,
): ProviderCreditsSnapshot | null | undefined {
  if (account?.credentialState === "signed-out") return account.credits;
  if (!snapshot?.credits) return account?.credits;
  const accountObservedAt = account?.creditsObservedAt
    ? Date.parse(account.creditsObservedAt)
    : 0;
  return Date.parse(snapshot.observedAt) >= accountObservedAt
    ? snapshot.credits
    : account?.credits;
}

export function providerCreditsText(
  credits: ProviderCreditsSnapshot | null | undefined,
): string {
  if (credits?.unlimited) return "Unlimited credits";
  const balance = providerCreditBalance(credits);
  return balance === null
    ? "Credits unavailable"
    : `${creditFormat.format(balance)} credits`;
}

export function providerTotalCreditsText(
  accounts: ModelProviderAccountSummary[],
): string {
  const signedIn = accounts.filter(
    (account) => account.enabled && account.credentialState === "signed-in",
  );
  if (signedIn.some((account) => account.credits?.unlimited))
    return "Unlimited credits";
  const balances = signedIn
    .map((account) => providerCreditBalance(account.credits))
    .filter((balance): balance is number => balance !== null);
  if (!balances.length) return "Credits unavailable";
  const suffix =
    balances.length === signedIn.length
      ? ""
      : ` reported (${balances.length}/${signedIn.length} accounts)`;
  return `${creditFormat.format(balances.reduce((sum, balance) => sum + balance, 0))} credits${suffix}`;
}

export interface ProviderWeeklyAvailability {
  availablePercent: number;
  bankedResetCount: number;
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

export function providerWeeklyUsageFromQuotaSnapshot(
  snapshot: ProviderQuotaSnapshot | null | undefined,
): ProviderWeeklyUsage | null {
  const weekly = snapshot?.windows.find((window) => window.isWeeklyProjection);
  return weekly
    ? { usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt }
    : null;
}

export function providerRateLimitResetImpact(
  usage: ProviderWeeklyUsage | null,
): { gainPercent: number; remainingPercent: number } | null {
  if (!usage) return null;
  const remainingPercent = Math.round(
    providerWeeklyRemainingPercent(usage.usedPercent),
  );
  return {
    remainingPercent,
    gainPercent: 100 - remainingPercent,
  };
}

export function providerWeeklyAvailability(
  accounts: ModelProviderAccountSummary[],
  availableResetCredits?: ReadonlyMap<string, number>,
): ProviderWeeklyAvailability | null {
  const signedIn = accounts.filter(
    (account) => account.enabled && account.credentialState === "signed-in",
  );
  let availablePercent = 0;
  let bankedResetCount = 0;
  let reportedAccountCount = 0;
  for (const account of signedIn) {
    if (account.weeklyUsageUsedPercent !== null) {
      availablePercent += providerWeeklyRemainingPercent(
        account.weeklyUsageUsedPercent,
      );
      reportedAccountCount += 1;
    }
    const resetCount = availableResetCredits?.get(account.id) ?? 0;
    if (resetCount > 0) {
      bankedResetCount += resetCount;
      availablePercent += resetCount * 100;
    }
  }
  if (!reportedAccountCount && !bankedResetCount) return null;
  return {
    availablePercent,
    bankedResetCount,
    reportedAccountCount,
    signedInAccountCount: signedIn.length,
  };
}
