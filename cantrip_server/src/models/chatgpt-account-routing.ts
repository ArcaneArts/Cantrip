import { codexAuthStatusSchema } from "@cantrip/protocol";

import type { ModelRuntime, ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

interface AccountRoutingLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface ChatGptAccountRoutingResult {
  runtimes: ModelRuntime[];
  unavailable: string[];
}

export async function resolveChatGptAccountRuntimes(input: {
  bridge: WorkerCommandBus;
  logger: AccountRoutingLogger;
  ownerId: string;
  preferredAccountId?: string | null;
  repository: ServerRepository;
  runtime: ModelRuntime;
  workerId: string;
}): Promise<ChatGptAccountRoutingResult> {
  const { runtime } = input;
  if (runtime.provider.kind !== "chatgpt") {
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
        account.enabled && account.modelAvailability !== "unavailable",
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
    return {
      runtimes: [],
      unavailable: [`${runtime.provider.name} has no enabled accounts`],
    };
  }

  const inspected = await Promise.all(
    orderedAccounts.map(async (account) => {
      try {
        const status = codexAuthStatusSchema.parse(
          await input.bridge.request(input.workerId, {
            type: "codex.auth.status",
            providerId: runtime.provider.id,
            credentialHomeKey: account.credentialHomeKey,
          }),
        );
        await input.repository.recordModelProviderAccountStatus(
          account.accountId,
          input.workerId,
          status,
        );
        return { account, status };
      } catch (error) {
        input.logger.warn(
          {
            accountId: account.accountId,
            err: error,
            providerId: runtime.provider.id,
          },
          "Could not preflight a ChatGPT account",
        );
        return { account, status: null };
      }
    }),
  );
  const healthy: typeof inspected = [];
  const unknown: typeof inspected = [];
  const unavailable: string[] = [];
  for (const candidate of inspected) {
    const { account, status } = candidate;
    if (!status) {
      if (account.authState !== "signed-out") unknown.push(candidate);
      continue;
    }
    if (!status.authenticated || status.authMode !== "chatgpt") {
      unavailable.push(
        `${runtime.provider.name} account ${account.label} is not signed in`,
      );
      continue;
    }
    const remainingPercent = status.weeklyUsage
      ? Math.max(0, 100 - status.weeklyUsage.usedPercent)
      : null;
    if (remainingPercent === null) {
      healthy.push(candidate);
    } else if (remainingPercent > runtime.provider.weeklyUsageReservePercent) {
      healthy.push(candidate);
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
    runtimes: [...healthy, ...unknown].map(({ account }) => ({
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
