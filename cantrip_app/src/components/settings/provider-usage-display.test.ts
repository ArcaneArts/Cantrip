import type { ModelProviderAccountSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  providerWeeklyAvailability,
  providerWeeklyRemainingPercent,
} from "./provider-usage-display";

function account(
  id: string,
  usedPercent: number | null,
  overrides: Partial<ModelProviderAccountSummary> = {},
): ModelProviderAccountSummary {
  return {
    id,
    providerId: "provider-1",
    label: id,
    email: null,
    planType: "pro",
    position: 0,
    enabled: true,
    credentialState: "signed-in",
    weeklyUsageUsedPercent: usedPercent,
    weeklyUsageResetsAt: null,
    authLastSyncedAt: null,
    workerBindings: [],
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("provider weekly availability", () => {
  it("converts used capacity into remaining capacity", () => {
    expect(providerWeeklyRemainingPercent(95)).toBe(5);
    expect(providerWeeklyRemainingPercent(0)).toBe(100);
    expect(providerWeeklyRemainingPercent(100)).toBe(0);
  });

  it("adds remaining capacity across every reported signed-in account", () => {
    expect(
      providerWeeklyAvailability([
        account("one", 0),
        account("two", 0),
        account("three", 0),
      ]),
    ).toEqual({
      availablePercent: 300,
      reportedAccountCount: 3,
      signedInAccountCount: 3,
    });
    expect(
      providerWeeklyAvailability([
        account("one", 25),
        account("two", 50),
        account("three", 100),
      ])?.availablePercent,
    ).toBe(125);
  });

  it("excludes disabled, signed-out, and unreported accounts", () => {
    expect(
      providerWeeklyAvailability([
        account("known", 20),
        account("unknown", null),
        account("disabled", 0, { enabled: false }),
        account("signed-out", 0, { credentialState: "signed-out" }),
      ]),
    ).toEqual({
      availablePercent: 80,
      reportedAccountCount: 1,
      signedInAccountCount: 2,
    });
  });
});
