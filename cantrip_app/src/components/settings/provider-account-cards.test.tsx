import { modelProviderSummarySchema } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SubscriptionAccountCards } from "./provider-account-cards";

const today = "2026-11-27T12:00:00.000Z";
const provider = modelProviderSummarySchema.parse({
  id: "provider",
  name: "ChatGPT",
  kind: "chatgpt",
  baseUrl: "https://example.test",
  hasApiKey: false,
  createdAt: today,
  updatedAt: today,
  accounts: [
    { id: "main", label: "Main", weeklyUsageUsedPercent: 24 },
    { id: "backup", label: "Backup", weeklyUsageUsedPercent: 50 },
    { id: "unknown", label: "Unknown", weeklyUsageUsedPercent: null },
  ].map((account, position) => ({
    ...account,
    providerId: "provider",
    planType: "pro",
    position,
    enabled: true,
    credentialState: "signed-in",
    weeklyUsageResetsAt: today,
    authLastSyncedAt: today,
    workerBindings: [],
    createdAt: today,
    updatedAt: today,
  })),
});

it("adds all banked resets to current quota and marks incomplete totals as lower bounds", () => {
  const markup = renderToStaticMarkup(
    <SubscriptionAccountCards
      provider={provider}
      availableResetCredits={
        new Map([
          ["main", 2],
          ["unknown", 1],
        ])
      }
      onManage={() => {}}
    />,
  );
  expect(markup).toContain("276%");
  expect(markup).toContain('aria-valuenow="76"');
  expect(markup).toContain(`dateTime="${today}"`);
  expect(markup).toContain('aria-label="Manage Backup"');
  expect(markup).toContain(">≥</span>50%");
  expect(markup).toContain(">≥</span>100%");
});

it("shows the Grok quota and reset date without ChatGPT reset credits", () => {
  const markup = renderToStaticMarkup(
    <SubscriptionAccountCards
      provider={{ ...provider, kind: "grok" }}
      availableResetCredits={new Map([["main", 2]])}
      onManage={() => {}}
    />,
  );
  expect(markup).toContain("76% left");
  expect(markup).toContain("Next reset");
  expect(markup).not.toContain("Resets available");
  expect(markup).not.toContain("276%");
});
