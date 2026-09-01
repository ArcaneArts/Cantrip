import type {
  ModelProviderAccountSummary,
  ProviderQuotaSnapshot,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  providerAccountWeeklyUsage,
  providerRateLimitResetImpact,
  providerWeeklyAvailability,
  providerWeeklyRemainingPercent,
  providerWeeklyUsageFromQuotaSnapshot,
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

  it("normalizes persisted account usage for the provider detail view", () => {
    expect(
      providerAccountWeeklyUsage(
        account("grok", 0, {
          weeklyUsageResetsAt: "2026-08-24T18:00:00.000Z",
        }),
      ),
    ).toEqual({ usedPercent: 0, resetsAt: 1_787_594_400 });
    expect(providerAccountWeeklyUsage(account("missing", null))).toBeNull();
  });

  it("calculates the capacity restored by a banked usage reset", () => {
    const snapshot: ProviderQuotaSnapshot = {
      snapshotId: "quota-1",
      observedAt: "2026-08-16T00:00:00.000Z",
      workerVersion: "1.2.3",
      codexVersion: "codex-cli 0.149.0",
      windows: [
        {
          limitId: "codex",
          limitName: "Codex",
          planType: "pro",
          reachedType: null,
          windowKind: "secondary",
          usedPercent: 97,
          windowDurationMinutes: 10_080,
          resetsAt: 1_787_000_000,
          isWeeklyProjection: true,
          rawPayload: {},
        },
      ],
      rateLimitResetCredits: {
        availableCount: 1,
        credits: null,
      },
    };

    const usage = providerWeeklyUsageFromQuotaSnapshot(snapshot);
    expect(usage).toEqual({ usedPercent: 97, resetsAt: 1_787_000_000 });
    expect(providerRateLimitResetImpact(usage)).toEqual({
      remainingPercent: 3,
      gainPercent: 97,
    });
    expect(providerRateLimitResetImpact(null)).toBeNull();
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
      bankedResetCount: 0,
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
      bankedResetCount: 0,
      reportedAccountCount: 1,
      signedInAccountCount: 2,
    });
  });

  it("treats each banked reset as another full week of capacity", () => {
    expect(
      providerWeeklyAvailability([account("one", 50)], new Map([["one", 2]])),
    ).toEqual({
      availablePercent: 250,
      bankedResetCount: 2,
      reportedAccountCount: 1,
      signedInAccountCount: 1,
    });
    expect(
      providerWeeklyAvailability(
        [account("one", 50), account("two", 25)],
        new Map([
          ["one", 2],
          ["two", 1],
        ]),
      )?.availablePercent,
    ).toBe(425);
  });

  it("includes known banked resets when weekly usage is not reported", () => {
    expect(
      providerWeeklyAvailability(
        [account("unknown", null)],
        new Map([["unknown", 1]]),
      ),
    ).toEqual({
      availablePercent: 100,
      bankedResetCount: 1,
      reportedAccountCount: 0,
      signedInAccountCount: 1,
    });
  });
});
