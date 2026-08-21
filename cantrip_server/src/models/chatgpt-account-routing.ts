import type { ModelRuntime, ServerRepository } from "../db/repository.js";
import { serverLogger } from "../logger.js";
import { isAccountProviderKind } from "./account-provider.js";
import { accountProviderSupportsModel } from "./model-route-availability.js";

export interface AccountProviderRoutingResult {
  runtimes: ModelRuntime[];
  unavailable: string[];
}

export async function resolveAccountProviderRuntimes(input: {
  ownerId: string;
  preferredAccountId?: string | null;
  repository: ServerRepository;
  runtime: ModelRuntime;
  workerId: string;
}): Promise<AccountProviderRoutingResult> {
  const { runtime } = input;
  const providerKind = runtime.provider.kind;
  if (!isAccountProviderKind(providerKind)) {
    return { runtimes: [runtime], unavailable: [] };
  }

  const accounts = await input.repository.listModelProviderAccountRuntimes(
    input.ownerId,
    runtime.provider.id,
    input.workerId,
    runtime.model.providerModelId,
  );
  const orderedAccounts = accounts
    .filter(
      (account) =>
        account.enabled &&
        accountProviderSupportsModel(
          runtime.model.providerModelId,
          account.modelAvailability,
        ),
    )
    .sort((left, right) => {
      const leftPreferred = left.accountId === input.preferredAccountId;
      const rightPreferred = right.accountId === input.preferredAccountId;
      return leftPreferred === rightPreferred
        ? left.position - right.position
        : leftPreferred
          ? -1
          : 1;
    });
  if (!orderedAccounts.length) {
    const hasEnabledAccounts = accounts.some(({ enabled }) => enabled);
    serverLogger.rateLimited(
      `provider-account-route-unavailable:${runtime.provider.id}:${input.workerId}`,
      "warn",
      "Account provider has no routable accounts",
      {
        event: "provider.account_route.unavailable",
        subsystem: "provider-routing",
        operation: "resolve-account-route",
        status: "unavailable",
        reasonCode: hasEnabledAccounts
          ? "model_unavailable"
          : "no_enabled_accounts",
        providerId: runtime.provider.id,
        workerId: input.workerId,
        counts: { accounts: accounts.length },
      },
      { summaryEvery: 10, windowMs: 60_000 },
    );
    return {
      runtimes: [],
      unavailable: [
        hasEnabledAccounts
          ? `${runtime.model.name} is not available to any ${runtime.provider.name} account`
          : `${runtime.provider.name} has no enabled accounts`,
      ],
    };
  }

  const healthy: typeof orderedAccounts = [];
  const legacy: typeof orderedAccounts = [];
  const unavailable: string[] = [];
  const unavailableCounts = {
    migrationNeeded: 0,
    requiresSignIn: 0,
    belowReserve: 0,
    exhausted: 0,
  };
  for (const account of orderedAccounts) {
    if (account.credentialState === "migration-needed") {
      if (account.legacyWorkerAuthenticated) {
        legacy.push(account);
      } else {
        unavailableCounts.migrationNeeded += 1;
        unavailable.push(
          `${runtime.provider.name} account ${account.accountId} must be migrated; reconnect its original worker`,
        );
      }
      continue;
    }
    if (account.credentialState !== "signed-in") {
      unavailableCounts.requiresSignIn += 1;
      unavailable.push(
        account.credentialState === "conflict"
          ? `${runtime.provider.name} account ${account.accountId} has a credential identity conflict`
          : `${runtime.provider.name} account ${account.accountId} requires sign-in`,
      );
      continue;
    }
    const remainingPercent =
      account.weeklyUsageUsedPercent === null
        ? null
        : Math.max(0, 100 - account.weeklyUsageUsedPercent);
    if (remainingPercent === null) {
      healthy.push(account);
    } else if (remainingPercent > runtime.provider.weeklyUsageReservePercent) {
      healthy.push(account);
    } else if (remainingPercent > 0) {
      unavailableCounts.belowReserve += 1;
      unavailable.push(
        `${runtime.provider.name} account ${account.accountId} is below its ${runtime.provider.weeklyUsageReservePercent}% weekly usage reserve`,
      );
    } else {
      unavailableCounts.exhausted += 1;
      unavailable.push(
        `${runtime.provider.name} account ${account.accountId} has no weekly usage left`,
      );
    }
  }

  serverLogger.sampled(
    `provider-account-route:${runtime.provider.id}:${input.workerId}`,
    20,
    "debug",
    "Account provider routes resolved",
    {
      event: "provider.account_route.resolved",
      subsystem: "provider-routing",
      operation: "resolve-account-route",
      status: healthy.length + legacy.length > 0 ? "completed" : "unavailable",
      providerId: runtime.provider.id,
      workerId: input.workerId,
      counts: {
        accounts: accounts.length,
        healthy: healthy.length,
        legacy: legacy.length,
        ...unavailableCounts,
      },
    },
  );

  return {
    runtimes: [...healthy, ...legacy].map((account) => ({
      ...runtime,
      provider: {
        ...runtime.provider,
        accountId: account.accountId,
        credentialHomeKey: account.credentialHomeKey,
      },
    })),
    unavailable,
  };
}
