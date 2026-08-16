import { describe, expect, it, vi } from "vitest";

import type {
  ModelProviderAccountRuntime,
  ModelRuntime,
  ServerRepository,
} from "../src/db/repository.js";
import { resolveAccountProviderRuntimes } from "../src/models/chatgpt-account-routing.js";

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
    apiKey: null,
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

  it("routes a server-owned account on a worker with no local sign-in", async () => {
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
