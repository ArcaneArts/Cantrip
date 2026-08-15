import type { ModelRuntime, ServerRepository } from "../db/repository.js";
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
  for (const account of orderedAccounts) {
    if (account.credentialState === "migration-needed") {
      if (account.legacyWorkerAuthenticated) {
        legacy.push(account);
      } else {
        unavailable.push(
          `${runtime.provider.name} account ${account.label} must be migrated; reconnect its original worker`,
        );
      }
      continue;
    }
    if (account.credentialState !== "signed-in") {
      unavailable.push(
        account.credentialState === "conflict"
          ? `${runtime.provider.name} account ${account.label} has a credential identity conflict`
          : `${runtime.provider.name} account ${account.label} requires sign-in`,
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
      unavailable.push(
        `${runtime.provider.name} account ${account.label} is below its ${runtime.provider.weeklyUsageReservePercent}% weekly usage reserve`,
      );
    } else {
      unavailable.push(
        `${runtime.provider.name} account ${account.label} has no weekly usage left`,
      );
    }
  }

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
