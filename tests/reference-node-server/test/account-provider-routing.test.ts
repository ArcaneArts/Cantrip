import { describe, expect, it, vi } from "vitest";
import { agentActivitySchema } from "@cantrip/protocol";
import {
  createModelRoutingRuntime,
  type ModelRoutingRuntimeDependencies,
} from "../src/app/runtime/model-routing-runtime.js";

import type {
  ModelProviderAccountRuntime,
  ModelRuntime,
  ServerRepository,
} from "../src/db/repository.js";
import {
  canAutomaticallySwitchProviderAccount,
  resolveAccountProviderRuntimes,
  updateRuntimeAccountCredits,
} from "../src/models/chatgpt-account-routing.js";

const runtime: ModelRuntime = {
  routeId: "route-one",
  model: {
    id: "model-one",
    profileName: "Codex",
    routeId: "route-one",
    name: "gpt-5.6-sol",
    reasoningEffort: "medium",
    providerModelId: "provider-model-one",
    catalog: null,
  },
  provider: {
    id: "provider-one",
    name: "ChatGPT",
    kind: "chatgpt",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    protectedApiKey: null,
    accountId: null,
    credentialHomeKey: null,
    weeklyUsageReservePercent: 3,
  },
};

function account(
  accountId: string,
  overrides: Partial<ModelProviderAccountRuntime> = {},
): ModelProviderAccountRuntime {
  return {
    accountId,
    credentialState: "signed-in",
    credentialHomeKey: accountId,
    enabled: true,
    label: accountId,
    legacyWorkerAuthenticated: false,
    modelAvailability: "available",
    position: 0,
    weeklyUsageUsedPercent: null,
    ...overrides,
  };
}

function fixture(accounts: ModelProviderAccountRuntime[]) {
  return {
    ownerId: "owner-one",
    repository: {
      listModelProviderAccountRuntimes: vi.fn(async () => accounts),
    } as unknown as ServerRepository,
    workerId: "brand-new-worker",
  };
}

describe("account-scoped provider routing", () => {
  it.each([100, 100.01])(
    "ignores an old account cooldown only above 100 credits (%s)",
    async (balance) => {
      const input = fixture([
        account("primary", {
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: String(balance),
          },
        }),
      ]);
      const routing = createModelRoutingRuntime({
        ...input,
        applicationOwnerId: () => input.ownerId,
        repository: {
          ...input.repository,
          getModelRuntimes: vi.fn(async () => [runtime]),
        },
        openRouterRuntimeCatalogs: { hydrate: vi.fn(async () => false) },
        routeCooldowns: new Map([["account-cooldown", Date.now() + 60_000]]),
        runtimeCooldownKey: () => "account-cooldown",
      } as unknown as ModelRoutingRuntimeDependencies);
      try {
        const resolved = routing.availableModelRuntimes(
          { workerId: input.workerId },
          runtime.model.id,
        );
        if (balance > 100)
          await expect(resolved).resolves.toMatchObject([
            { provider: { accountId: "primary" } },
          ]);
        else await expect(resolved).rejects.toThrow("cooling down");
      } finally {
        routing.close();
      }
    },
  );

  it("publishes changed canonical credits without repeatedly invalidating identical balances", async () => {
    const publish = vi.fn();
    const record = vi.fn(async () => true);
    const current: ModelRuntime = {
      ...runtime,
      provider: { ...runtime.provider, accountId: "current" },
    };
    const routing = createModelRoutingRuntime({
      applicationOwnerId: () => "owner",
      publishLiveInvalidation: publish,
      repository: { recordModelProviderAccountCredits: record },
      app: { log: { warn: vi.fn() } },
    } as unknown as ModelRoutingRuntimeDependencies);
    const activity = agentActivitySchema.parse({
      id: "balance",
      status: "completed",
      type: "rateLimit",
      limitId: "codex",
      limitName: null,
      planType: null,
      reachedType: null,
      primary: null,
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: "200" },
    });
    if (activity.type !== "rateLimit")
      throw new Error("Expected rate-limit activity");
    const execution = { workerId: "worker", chatId: "chat" } as Parameters<
      typeof routing.recordRuntimeRateLimitActivity
    >[1];
    try {
      await routing.recordRuntimeRateLimitActivity(
        current,
        execution,
        "attempt",
        activity,
      );
      expect(canAutomaticallySwitchProviderAccount(current)).toBe(false);
      expect(publish).toHaveBeenCalledExactlyOnceWith("settings");
      await routing.recordRuntimeRateLimitActivity(
        current,
        execution,
        "attempt",
        activity,
      );
      await routing.recordRuntimeRateLimitActivity(
        current,
        execution,
        "attempt",
        {
          ...activity,
          limitId: "reviews",
          credits: { ...activity.credits!, balance: "9999" },
        },
      );
      expect(publish).toHaveBeenCalledOnce();
      expect(current.provider.credits?.balance).toBe("200");
      expect(record).toHaveBeenCalledTimes(2);
      await routing.recordRuntimeRateLimitActivity(
        current,
        execution,
        "attempt",
        {
          ...activity,
          credits: { hasCredits: false, unlimited: false, balance: "0" },
        },
      );
      expect(publish).toHaveBeenCalledTimes(2);
      expect(canAutomaticallySwitchProviderAccount(current)).toBe(true);
    } finally {
      routing.close();
    }
  });

  it("updates live credits before a failover decision and preserves omitted balances", () => {
    const current: ModelRuntime = {
      ...runtime,
      provider: { ...runtime.provider },
    };
    const credits = { hasCredits: true, unlimited: false, balance: "101" };
    expect(updateRuntimeAccountCredits(current, credits)).toBe(true);
    expect(canAutomaticallySwitchProviderAccount(current)).toBe(false);
    expect(updateRuntimeAccountCredits(current, { ...credits })).toBe(false);
    expect(updateRuntimeAccountCredits(current, null)).toBe(false);
    expect(canAutomaticallySwitchProviderAccount(current)).toBe(false);
    expect(
      updateRuntimeAccountCredits(current, { ...credits, balance: "100" }),
    ).toBe(true);
    expect(canAutomaticallySwitchProviderAccount(current)).toBe(true);
  });
  it.each([99, 100, 100.01, 1000])(
    "uses credit balance %s at the weekly reserve boundary",
    async (balance) => {
      const input = fixture([
        account("preferred", {
          weeklyUsageUsedPercent: 100,
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: String(balance),
          },
        }),
        account("backup", { position: 1, weeklyUsageUsedPercent: 0 }),
      ]);
      const result = await resolveAccountProviderRuntimes({
        ...input,
        runtime,
        preferredAccountId: "preferred",
      });
      expect(result.runtimes[0]?.provider.accountId).toBe(
        balance > 100 ? "preferred" : "backup",
      );
      expect(canAutomaticallySwitchProviderAccount(result.runtimes[0]!)).toBe(
        balance <= 100,
      );
    },
  );

  it("does not use credits from a disabled, signed-out, or non-ChatGPT account", async () => {
    const credits = { hasCredits: true, unlimited: false, balance: "2000" };
    const input = fixture([
      account("disabled", { enabled: false, credits }),
      account("signed-out", { credentialState: "signed-out", credits }),
      account("grok", { credits, weeklyUsageUsedPercent: 100 }),
    ]);
    expect(
      (
        await resolveAccountProviderRuntimes({
          ...input,
          runtime: {
            ...runtime,
            provider: { ...runtime.provider, kind: "grok" },
          },
        })
      ).runtimes,
    ).toEqual([]);
  });
  it("uses persisted account position as fallback priority", async () => {
    const input = fixture([
      account("backup", { position: 1 }),
      account("primary", { position: 0 }),
    ]);
    const result = await resolveAccountProviderRuntimes({ ...input, runtime });

    expect(result.runtimes.map(({ provider }) => provider.accountId)).toEqual([
      "primary",
      "backup",
    ]);
  });

  it("routes an endpoint-encrypted account on a worker with no local sign-in", async () => {
    const input = fixture([
      account("primary", { position: 0 }),
      account("preferred", { position: 1 }),
    ]);
    const result = await resolveAccountProviderRuntimes({
      ...input,
      preferredAccountId: "preferred",
      runtime,
    });
    expect(result.runtimes.map(({ provider }) => provider.accountId)).toEqual([
      "preferred",
      "primary",
    ]);
    expect(result.runtimes[0]?.provider.credentialHomeKey).toBe("preferred");
  });

  it("uses global quota and reports an unmigrated offline account", async () => {
    const input = fixture([
      account("exhausted", { weeklyUsageUsedPercent: 100 }),
      account("legacy", {
        credentialState: "migration-needed",
        legacyWorkerAuthenticated: false,
        position: 1,
      }),
    ]);
    const result = await resolveAccountProviderRuntimes({ ...input, runtime });
    expect(result.runtimes).toEqual([]);
    expect(result.unavailable.join(" ")).toContain("no weekly usage left");
    expect(result.unavailable.join(" ")).toContain(
      "reconnect its original worker",
    );
  });

  it("retains legacy fallback only on the worker that owns the credential", async () => {
    const input = fixture([
      account("legacy", {
        credentialState: "migration-needed",
        legacyWorkerAuthenticated: true,
      }),
    ]);
    const result = await resolveAccountProviderRuntimes({ ...input, runtime });
    expect(result.runtimes[0]?.provider.accountId).toBe("legacy");
  });
});
