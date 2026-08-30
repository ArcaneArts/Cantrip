import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientLogger } from "@/lib/client-log-relay";
import {
  explorerFileIntentContext,
  recordExplorerFileIntent,
  resetExplorerLifecycleTraceForTests,
} from "@/lib/explorer-lifecycle-trace";

vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: { info: vi.fn() },
}));

describe("Explorer lifecycle trace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    resetExplorerLifecycleTraceForTests();
    vi.mocked(clientLogger.info).mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it("correlates later lifecycle events without recording a file path", () => {
    const intent = recordExplorerFileIntent({
      actionKind: "pin-preview",
      explorerId: "explorer-one",
      projectId: "project-one",
      samePath: true,
      transactionId: "transaction-one",
    });
    vi.advanceTimersByTime(125);

    expect(explorerFileIntentContext("explorer-one")).toEqual({
      actionKind: "pin-preview",
      interactionId: intent.interactionId,
      intentAgeMs: 125,
      requestedAtMs: Date.parse("2026-08-30T12:00:00.000Z"),
    });
    expect(clientLogger.info).toHaveBeenCalledWith(
      "Explorer file interaction requested",
      expect.objectContaining({
        explorerId: "explorer-one",
        interactionId: intent.interactionId,
        samePath: true,
        transactionId: "transaction-one",
      }),
    );
    expect(
      JSON.stringify(vi.mocked(clientLogger.info).mock.calls),
    ).not.toContain("private-file");
  });

  it("expires stale interaction correlation", () => {
    recordExplorerFileIntent({
      actionKind: "open-preview",
      explorerId: "explorer-one",
      projectId: "project-one",
    });
    vi.advanceTimersByTime(5 * 60_000 + 1);

    expect(explorerFileIntentContext("explorer-one")).toEqual({});
  });
});
