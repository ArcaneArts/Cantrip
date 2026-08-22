import {
  settingsBundleSchema,
  type ChatMessage,
  type ModelProfileSummary,
  type ModelProviderAccountSummary,
  type ModelProviderSummary,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ContextUsageRing,
  formatQuotaReset,
  latestContextUsage,
  quotaProviderLabel,
  selectedQuotaProvider,
  signedInQuotaAccounts,
} from "./context-usage-ring";

const timestamp = "2026-08-19T12:00:00.000Z";

function usageMessage(
  sequence: number,
  usedTokens: number,
  contextWindowTokens: number | null,
): ChatMessage {
  return {
    id: `message-${sequence}`,
    chatId: "chat-1",
    worktreeId: "worktree-1",
    executionLaneId: null,
    sequence,
    role: "assistant",
    content: [
      {
        type: "activity",
        activity: {
          id: `usage-${sequence}`,
          status: "completed",
          type: "usage",
          total: {
            totalTokens: usedTokens,
            inputTokens: usedTokens,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: usedTokens,
            inputTokens: usedTokens,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: contextWindowTokens,
          contextUsedPercent:
            contextWindowTokens === null
              ? null
              : (usedTokens / contextWindowTokens) * 100,
        },
      },
    ],
    mode: "default",
    reasoningEffort: null,
    modelId: "model-1",
    modelRouteId: "route-1",
    providerId: "chatgpt-1",
    providerName: "ChatGPT",
    providerModelName: "gpt-5",
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    createdAt: timestamp,
  };
}

function account(
  id: string,
  usedPercent: number | null,
  overrides: Partial<ModelProviderAccountSummary> = {},
): ModelProviderAccountSummary {
  return {
    id,
    providerId: "chatgpt-1",
    label: id,
    planType: "pro",
    position: 0,
    enabled: true,
    credentialState: "signed-in",
    weeklyUsageUsedPercent: usedPercent,
    weeklyUsageResetsAt: "2026-08-24T18:00:00.000Z",
    authLastSyncedAt: timestamp,
    workerBindings: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function settings() {
  return settingsBundleSchema.parse({
    preferences: {
      theme: "system",
      highContrast: false,
      proMode: false,
      proModeOpacity: 100,
      sidebarWidth: 288,
      desktopFrameRate: 30,
      desktopStreamQuality: "adaptive",
      defaultModelId: "model-1",
    },
    providers: [
      {
        id: "chatgpt-1",
        name: "ChatGPT",
        kind: "chatgpt",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        hasApiKey: false,
        accounts: [account("one", 75), account("two", 53, { position: 1 })],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "compatible-1",
        name: "Compatible",
        kind: "openai-compatible",
        baseUrl: "https://example.com/v1",
        hasApiKey: true,
        accounts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    models: [
      {
        id: "model-1",
        name: "GPT",
        routingPolicy: "priority",
        routes: [
          {
            id: "route-1",
            providerId: "chatgpt-1",
            providerName: "ChatGPT",
            modelName: "gpt-5",
            enabled: true,
            position: 0,
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });
}

describe("context usage ring", () => {
  it("uses the newest exact context window and current-context token count", () => {
    expect(
      latestContextUsage([
        usageMessage(1, 10_000, 100_000),
        usageMessage(2, 25_000, 100_000),
      ]),
    ).toEqual({
      contextWindowTokens: 100_000,
      remainingPercent: 75,
      remainingTokens: 75_000,
      usedPercent: 25,
      usedTokens: 25_000,
    });
  });

  it("ignores reports without a model context window", () => {
    expect(
      latestContextUsage([
        usageMessage(1, 10_000, 100_000),
        usageMessage(2, 20_000, null),
      ]),
    ).toBeNull();
  });

  it("does not retain stale usage after context compaction", () => {
    const compacted = usageMessage(2, 20_000, 100_000);
    compacted.content = [
      {
        type: "activity",
        activity: {
          id: "compaction-2",
          status: "completed",
          type: "contextCompaction",
        },
      },
    ];
    expect(
      latestContextUsage([usageMessage(1, 10_000, 100_000), compacted]),
    ).toBeNull();
  });

  it("shows account-provider quota only when it is the model's primary route", () => {
    const bundle = settings();
    const model = bundle.models[0] as ModelProfileSummary;
    const chatGpt = bundle.providers[0] as ModelProviderSummary;

    expect(selectedQuotaProvider(model, bundle.providers)).toBe(chatGpt);
    expect(
      selectedQuotaProvider(
        {
          ...model,
          routes: [
            {
              ...model.routes[0]!,
              providerId: "compatible-1",
              position: 0,
            },
            { ...model.routes[0]!, position: 1 },
          ],
        },
        bundle.providers,
      ),
    ).toBeNull();
  });

  it("shows SuperGrok quota for a Grok model's primary route", () => {
    const bundle = settings();
    const grok = {
      ...bundle.providers[0]!,
      id: "grok-1",
      name: "Grok",
      kind: "grok" as const,
      accounts: [
        account("grok-account", 0, {
          providerId: "grok-1",
        }),
      ],
    };
    const model = {
      ...bundle.models[0]!,
      routes: [
        {
          ...bundle.models[0]!.routes[0]!,
          providerId: grok.id,
          providerName: grok.name,
          modelName: "grok-4.6",
        },
      ],
    };

    expect(selectedQuotaProvider(model, [grok])).toBe(grok);
    expect(quotaProviderLabel(grok)).toBe("SuperGrok");
    const markup = renderToStaticMarkup(
      <ContextUsageRing messages={[]} model={model} providers={[grok]} />,
    );
    expect(markup).toContain("100% total 7-day available across 1 account");
  });

  it("orders only enabled signed-in accounts for the detail dialog", () => {
    const provider = settings().providers[0]!;
    provider.accounts.push(
      account("disabled", 10, { enabled: false, position: 2 }),
      account("signed-out", 20, {
        credentialState: "signed-out",
        position: 3,
      }),
    );
    expect(signedInQuotaAccounts(provider).map(({ id }) => id)).toEqual([
      "one",
      "two",
    ]);
  });

  it("renders accessible context and combined account capacity on the ring", () => {
    const bundle = settings();
    const markup = renderToStaticMarkup(
      <ContextUsageRing
        messages={[usageMessage(1, 25_000, 100_000)]}
        model={bundle.models[0]}
        providers={bundle.providers}
      />,
    );

    expect(markup).toContain("75% context left");
    expect(markup).toContain("25,000 of 100,000 tokens used");
    expect(markup).toContain('stroke-dasharray="25 100"');
    expect(markup).toContain("72% total 7-day available across 2 accounts");
    expect(markup).toContain('aria-expanded="false"');
  });

  it("keeps the ring available before the first usage report", () => {
    const markup = renderToStaticMarkup(
      <ContextUsageRing messages={[]} model={undefined} providers={[]} />,
    );
    expect(markup).toContain("Context usage unavailable");
  });

  it("formats reset timestamps and handles missing values", () => {
    expect(formatQuotaReset(null)).toBe("Reset time unavailable");
    expect(formatQuotaReset("not-a-date")).toBe("Reset time unavailable");
    expect(formatQuotaReset("2026-08-24T18:00:00.000Z")).toContain("2026");
  });
});
