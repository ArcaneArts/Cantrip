import { describe, expect, it } from "vitest";

import type { ModelProviderAccountSummary } from "@cantrip/protocol";

import { providerAccountAuthStatus } from "../src/models/provider-account-status.js";

function account(
  overrides: Partial<ModelProviderAccountSummary> = {},
): ModelProviderAccountSummary {
  return {
    id: "account-one",
    providerId: "provider-one",
    label: "Primary",
    email: null,
    planType: "pro",
    position: 0,
    enabled: true,
    credentialState: "signed-in",
    weeklyUsageUsedPercent: 42,
    weeklyUsageResetsAt: "2026-08-22T12:00:00.000Z",
    authLastSyncedAt: "2026-08-15T12:00:00.000Z",
    workerBindings: [],
    createdAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("global provider account status", () => {
  it("reports protected authentication metadata without worker bindings", () => {
    expect(providerAccountAuthStatus("chatgpt", account())).toMatchObject({
      authenticated: true,
      authMode: "chatgpt",
      email: null,
      planType: "pro",
      weeklyUsage: { usedPercent: 42, resetsAt: 1_787_400_000 },
      loginError: null,
    });
  });

  it("surfaces migration and identity-conflict states safely", () => {
    expect(
      providerAccountAuthStatus(
        "grok",
        account({ credentialState: "migration-needed" }),
      ),
    ).toMatchObject({
      authenticated: false,
      authMode: null,
      loginError: expect.stringContaining("original worker"),
    });
    expect(
      providerAccountAuthStatus(
        "grok",
        account({ credentialState: "conflict" }),
      ).loginError,
    ).toContain("identity conflict");
  });
});
