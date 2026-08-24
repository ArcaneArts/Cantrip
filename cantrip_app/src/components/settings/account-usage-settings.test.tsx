import {
  accountResourceUsageHistorySchema,
  accountResourceUsageSchema,
  type AccountResourceUsage,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accountUsageHistoryWindow } from "./account-usage-display";
import { AccountUsageSettings } from "./account-usage-settings";

const NOW = new Date("2026-08-23T12:00:00.000Z");

function usageFixture(
  status: AccountResourceUsage["measurement"]["status"] = "current",
) {
  return accountResourceUsageSchema.parse({
    measurement: {
      basisVersion: "postgres-logical-v1",
      measuredAt: "2026-08-23T11:58:00.000Z",
      reconciledAt: "2026-08-23T11:57:00.000Z",
      status,
    },
    storage: {
      server: {
        accuracy: status === "current" ? "logical-reconciled" : status,
        logicalBytes: "9223372036854775808",
        rowCount: "42",
        categories: [
          {
            category: "conversations",
            logicalBytes: "6144",
            rowCount: "12",
          },
        ],
      },
      workerManaged: {
        accuracy: "server-known-estimate",
        attachmentSources: { logicalBytes: "2048", objectCount: "2" },
        readyReplicas: { logicalBytes: "1024", objectCount: "1" },
        logicalBytes: "3072",
      },
    },
    bandwidth: {
      accuracy: "metered",
      measuredAt: "2026-08-23T11:59:00.000Z",
      periodStart: "2026-08-23T00:00:00.000Z",
      periodEnd: "2026-08-24T00:00:00.000Z",
      ingressBytes: "4096",
      egressBytes: "8192",
      operationCount: "7",
      breakdown: [
        {
          channel: "http",
          direction: "ingress",
          bytes: "4096",
          operationCount: "3",
        },
        {
          channel: "client-live-websocket",
          direction: "egress",
          bytes: "8192",
          operationCount: "4",
        },
      ],
    },
    limits: null,
    enforcement: "disabled",
  });
}

function setHistoryData(queryClient: QueryClient) {
  const window = accountUsageHistoryWindow("30d", NOW);
  queryClient.setQueryData(
    ["account-resource-usage-history", "storage", window],
    accountResourceUsageHistorySchema.parse({
      metric: "storage",
      resolution: "day",
      from: window.from,
      to: window.to,
      status: "current",
      series: [],
      limits: null,
      enforcement: "disabled",
    }),
  );
  queryClient.setQueryData(
    ["account-resource-usage-history", "bandwidth", window],
    accountResourceUsageHistorySchema.parse({
      metric: "bandwidth",
      resolution: "day",
      from: window.from,
      to: window.to,
      status: "current",
      series: [],
      limits: null,
      enforcement: "disabled",
    }),
  );
}

function setQueryError(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  message: string,
) {
  const query = queryClient.getQueryCache().build(queryClient, {
    queryKey,
    queryFn: async () => undefined,
    retry: false,
  });
  query.setState({
    ...query.state,
    error: new Error(message),
    errorUpdatedAt: NOW.getTime(),
    fetchFailureCount: 1,
    fetchFailureReason: new Error(message),
    fetchStatus: "idle",
    status: "error",
  });
}

function renderUsage(prepare?: (queryClient: QueryClient) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  prepare?.(queryClient);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AccountUsageSettings />
    </QueryClientProvider>,
  );
}

describe("account usage settings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  it("renders a dedicated loading state", () => {
    expect(renderUsage()).toContain("Loading account usage…");
  });

  it("renders exact current totals, breakdowns, and empty history", () => {
    const markup = renderUsage((queryClient) => {
      queryClient.setQueryData(["account-resource-usage"], usageFixture());
      setHistoryData(queryClient);
    });

    expect(markup).toContain("Account usage");
    expect(markup).toContain("8 EiB");
    expect(markup).toContain("Worker-managed attachments");
    expect(markup).toContain("HTTP API");
    expect(markup).toContain("Client live updates");
    expect(markup).toContain("Usage limits are not enforced");
    expect(
      markup.match(/No measured activity in this range yet\./gu),
    ).toHaveLength(2);
  });

  it("warns when the storage reconciliation is stale", () => {
    const markup = renderUsage((queryClient) => {
      queryClient.setQueryData(
        ["account-resource-usage"],
        usageFixture("stale"),
      );
      setHistoryData(queryClient);
    });

    expect(markup).toContain("Storage measurement is stale");
    expect(markup).toContain("older than two hours");
  });

  it("renders a retryable current-usage error", () => {
    const markup = renderUsage((queryClient) =>
      setQueryError(
        queryClient,
        ["account-resource-usage"],
        "Usage service is unavailable",
      ),
    );

    expect(markup).toContain("Account usage unavailable");
    expect(markup).toContain("Usage service is unavailable");
    expect(markup).toContain("Retry");
  });

  it("keeps current usage visible when one history query fails", () => {
    const markup = renderUsage((queryClient) => {
      queryClient.setQueryData(["account-resource-usage"], usageFixture());
      setHistoryData(queryClient);
      const window = accountUsageHistoryWindow("30d", NOW);
      setQueryError(
        queryClient,
        ["account-resource-usage-history", "storage", window],
        "Storage history is unavailable",
      );
    });

    expect(markup).toContain("Logical server storage");
    expect(markup).toContain("Partial history");
    expect(markup).toContain("Storage history is unavailable");
  });
});
