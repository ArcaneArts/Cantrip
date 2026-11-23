import {
  codexAuthStatusSchema,
  type CodexAuthStatus,
  type ModelProviderAccountWireSummary,
} from "@cantrip/protocol";

import type { AccountProviderKind } from "./account-provider.js";

function statusError(account: ModelProviderAccountWireSummary): string | null {
  switch (account.credentialState) {
    case "migration-needed":
      return "The original worker must reconnect to migrate this provider account.";
    case "reauth-required":
      return "This provider account requires sign-in.";
    case "conflict":
      return "This provider account has a credential identity conflict.";
    case "signed-out":
    case "signed-in":
      return null;
  }
}

/** Builds the global account status without consulting worker-local storage. */
export function providerAccountAuthStatus(
  kind: AccountProviderKind,
  account: ModelProviderAccountWireSummary,
): CodexAuthStatus {
  const authenticated = account.credentialState === "signed-in";
  return codexAuthStatusSchema.parse({
    authenticated,
    authMode: authenticated ? kind : null,
    email: null,
    planType: account.planType,
    weeklyUsage:
      account.weeklyUsageUsedPercent === null
        ? null
        : {
            usedPercent: account.weeklyUsageUsedPercent,
            resetsAt: account.weeklyUsageResetsAt
              ? Math.floor(Date.parse(account.weeklyUsageResetsAt) / 1_000)
              : null,
          },
    loginPending: false,
    loginError: statusError(account),
  });
}
