import type { AgentActivity } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  isObservedTestCommand,
  ModelBehaviorTracker,
} from "../src/analytics/model-behavior.js";

function baseActivity(
  activity: Omit<AgentActivity, "id" | "status"> &
    Partial<Pick<AgentActivity, "id" | "status">>,
): AgentActivity {
  return {
    id: activity.id ?? "activity-1",
    status: activity.status ?? "completed",
    ...activity,
  } as AgentActivity;
}

describe("model behavior telemetry", () => {
  it("deduplicates streamed tool updates and records objective outcomes", () => {
    const tracker = new ModelBehaviorTracker();
    const started = new Date("2026-08-16T10:00:00Z");
    tracker.observeActivity(
      baseActivity({
        id: "test-1",
        status: "running",
        type: "command",
        command: "pnpm test",
        cwd: "/repo",
        exitCode: null,
        output: null,
      }),
      started,
    );
    tracker.observeActivity(
      baseActivity({
        id: "test-1",
        type: "command",
        command: "pnpm test",
        cwd: "/repo",
        exitCode: 0,
        output: null,
      }),
    );
    tracker.observeActivity(
      baseActivity({
        id: "tool-2",
        type: "mcpToolCall",
        server: "example",
        tool: "read",
        error: "invalid arguments",
        durationMs: 2,
      }),
    );
    tracker.observeActivity(
      baseActivity({
        id: "files-1",
        type: "fileChange",
        changes: [
          { path: "a.ts", kind: "update" },
          { path: "b.ts", kind: "add" },
        ],
      }),
    );
    tracker.observeActivity(
      baseActivity({ id: "compact-1", type: "contextCompaction" }),
    );
    tracker.markApproval("approval-1");
    tracker.markApproval("approval-1");
    tracker.markVisibleResponse(true);

    expect(tracker.snapshot()).toMatchObject({
      firstActivityAt: started,
      finalAnswerAppeared: true,
      toolCallCount: 2,
      invalidToolCallCount: 1,
      compactionCount: 1,
      approvalRequestCount: 1,
      filesChangedCount: 2,
      testCommandCount: 1,
      testPassCount: 1,
      testFailureCount: 0,
    });
  });

  it("keeps the most recent usage counters without persisting content", () => {
    const tracker = new ModelBehaviorTracker();
    tracker.observeActivity(
      baseActivity({
        type: "usage",
        total: {
          totalTokens: 200,
          inputTokens: 150,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 3,
          outputTokens: 50,
          reasoningOutputTokens: 20,
        },
        last: {
          totalTokens: 100,
          inputTokens: 70,
          cachedInputTokens: 10,
          cacheWriteInputTokens: 2,
          outputTokens: 30,
          reasoningOutputTokens: 12,
        },
        modelContextWindow: 128_000,
        contextUsedPercent: 12.5,
      }),
    );

    expect(tracker.snapshot()).toMatchObject({
      inputTokens: 70,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 2,
      outputTokens: 30,
      reasoningOutputTokens: 12,
      modelContextWindow: 128_000,
      contextUsedPercent: 12.5,
    });

    tracker.observeUsage({
      inputTokens: 80,
      cachedInputTokens: 12,
      cacheWriteInputTokens: 4,
      outputTokens: 35,
      reasoningOutputTokens: 14,
      modelContextWindow: 256_000,
      contextUsedPercent: 6.25,
    });
    expect(tracker.snapshot()).toMatchObject({
      inputTokens: 80,
      cachedInputTokens: 12,
      cacheWriteInputTokens: 4,
      outputTokens: 35,
      reasoningOutputTokens: 14,
      modelContextWindow: 256_000,
      contextUsedPercent: 6.25,
    });
  });

  it("recognizes common test runners without treating builds as tests", () => {
    expect(isObservedTestCommand("pnpm --filter @cantrip/server test")).toBe(
      true,
    );
    expect(isObservedTestCommand("cargo test --workspace")).toBe(true);
    expect(isObservedTestCommand("./gradlew test")).toBe(true);
    expect(isObservedTestCommand("pnpm build")).toBe(false);
  });
});
