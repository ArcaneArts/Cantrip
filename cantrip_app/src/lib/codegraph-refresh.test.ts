import { describe, expect, it } from "vitest";

import {
  codeGraphChatRefreshIntervalMs,
  codeGraphSettingsRefreshIntervalMs,
} from "./codegraph-refresh";

describe("CodeGraph refresh intervals", () => {
  it("disables polling while live events are available", () => {
    expect(codeGraphChatRefreshIntervalMs(undefined, true, true)).toBe(false);
    expect(codeGraphSettingsRefreshIntervalMs(undefined, true)).toBe(false);
  });

  it("retains the existing degraded-mode refresh cadence", () => {
    expect(codeGraphChatRefreshIntervalMs(undefined, false, true)).toBe(500);
    expect(codeGraphChatRefreshIntervalMs(undefined, false, false)).toBe(false);
    expect(
      codeGraphSettingsRefreshIntervalMs(
        {
          projectId: "00000000-0000-4000-8000-000000000001",
          worktreeId: "primary",
          state: "indexing",
          lastIndexedAt: null,
          lastSuccessfulSyncAt: null,
          fileCount: 0,
          nodeCount: 0,
          edgeCount: 0,
          pendingChanges: 0,
          statusMessage: null,
          job: null,
        },
        false,
      ),
    ).toBe(1_500);
    expect(codeGraphSettingsRefreshIntervalMs(undefined, false)).toBe(15_000);
  });
});
