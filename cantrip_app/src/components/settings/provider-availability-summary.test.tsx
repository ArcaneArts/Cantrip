import {
  modelProviderAccountSummarySchema,
  type ModelProviderAccountSummary,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderAvailabilitySummary } from "./provider-availability-summary";

function account(
  id: string,
  balance: string | null,
  overrides: Partial<ModelProviderAccountSummary> = {},
) {
  return modelProviderAccountSummarySchema.parse({
    id,
    providerId: "chatgpt",
    label: id,
    planType: "pro",
    position: 0,
    enabled: true,
    credentialState: "signed-in",
    weeklyUsageUsedPercent: 0,
    credits: { hasCredits: true, unlimited: false, balance },
    workerBindings: [],
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    ...overrides,
  });
}

describe("provider availability summary", () => {
  it("shows cumulative credits below the percentage without counting banked resets as credits", () => {
    const markup = renderToStaticMarkup(
      <ProviderAvailabilitySummary
        accounts={[
          account("MPM", "58036.04", { weeklyUsageUsedPercent: 65 }),
          account("Arcane", "62496.88"),
        ]}
        availableResetCredits={
          new Map([
            ["MPM", 2],
            ["Arcane", 2],
          ])
        }
        kind="chatgpt"
      />,
    );

    expect(markup).toContain("Total maximum 7-day available");
    expect(markup).toContain("Across 2 signed-in accounts");
    expect(markup).toContain("Includes 4 banked resets");
    expect(markup).toMatch(/535%<\/p><p[^>]*>120,532\.92 credits<\/p>/u);
  });

  it.each([
    ["missing balance", null],
    ["invalid balance", "invalid"],
  ])("labels a partial total when an account has a %s", (_, balance) => {
    const markup = renderToStaticMarkup(
      <ProviderAvailabilitySummary
        accounts={[account("known", "250"), account("unknown", balance)]}
        kind="chatgpt"
      />,
    );
    expect(markup).toContain("250 credits reported (1/2 accounts)");
  });

  it("shows zero and excludes disabled and signed-out account balances", () => {
    const markup = renderToStaticMarkup(
      <ProviderAvailabilitySummary
        accounts={[
          account("empty", "0"),
          account("disabled", "1000", { enabled: false }),
          account("signed-out", "2000", { credentialState: "signed-out" }),
        ]}
        kind="chatgpt"
      />,
    );
    expect(markup).toContain("Across 1 signed-in account");
    expect(markup).toContain("0 credits");
    expect(markup).not.toContain("reported");
  });

  it.each([
    [
      "unavailable",
      { hasCredits: false, unlimited: false, balance: null },
      "Credits unavailable",
    ],
    [
      "unlimited",
      { hasCredits: true, unlimited: true, balance: null },
      "Unlimited credits",
    ],
  ])("preserves the %s credit state", (_, credits, expected) => {
    const markup = renderToStaticMarkup(
      <ProviderAvailabilitySummary
        accounts={[account("one", null, { credits })]}
        kind="chatgpt"
      />,
    );
    expect(markup).toContain(expected);
  });

  it("keeps non-ChatGPT summaries free of ChatGPT credits and banked resets", () => {
    const markup = renderToStaticMarkup(
      <ProviderAvailabilitySummary
        accounts={[account("grok", "1000")]}
        availableResetCredits={new Map([["grok", 2]])}
        kind="grok"
      />,
    );
    expect(markup).toContain("Total 7-day available");
    expect(markup).toContain("100%");
    expect(markup).not.toContain("credits");
    expect(markup).not.toContain("banked");
  });

  it("does not invent a percentage when weekly usage is unavailable", () => {
    expect(
      renderToStaticMarkup(
        <ProviderAvailabilitySummary
          accounts={[
            account("unknown", "1000", { weeklyUsageUsedPercent: null }),
          ]}
          kind="chatgpt"
        />,
      ),
    ).toBe("");
  });
});
