import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  ClaudeAccountUsage,
  claudeUsageQueryKey,
} from "./claude-account-usage";

it("renders the remaining subscription percentage as the bar value", () => {
  const client = new QueryClient();
  client.setQueryData(claudeUsageQueryKey("claude", "local-account"), {
    subscriptionType: "pro",
    windows: [
      {
        label: "Current week (all models)",
        usedPercent: 27.5,
        resetText: "Friday at 4pm",
      },
    ],
  });
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ClaudeAccountUsage providerId="claude" accountId="local-account" />
    </QueryClientProvider>,
  );
  expect(markup).toContain("72.5% left");
  expect(markup).toContain('aria-valuenow="72.5"');
  expect(markup).toContain("Resets Friday at 4pm");
});
