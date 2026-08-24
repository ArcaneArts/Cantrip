import { describe, expect, it } from "vitest";

import {
  taskAutosaveLabel,
  taskDraftSignature,
  taskSurfaceMode,
} from "./task-surface";

const baseTask = {
  chatId: "chat-one",
  planGoalEnabled: false,
  state: "draft" as const,
  stableStateBeforeFailure: null,
  activeOperationId: null,
  activeOperationKind: null,
  briefMarkdown: "Build Tasks",
  draftAttachmentIds: [],
  planMarkdown: null,
  planAuthorship: "agent" as const,
  currentQuestions: [],
  currentAnswers: [],
  additionalDirection: "",
  finalPlanMarkdown: null,
  goalPrompt: null,
  planningRound: 0,
  implementationStartedAt: null,
  lastError: null,
  rowVersion: 1,
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};

describe("Task draft presentation", () => {
  it("routes durable Task states to the correct surface", () => {
    expect(taskSurfaceMode(baseTask)).toBe("draft");
    expect(taskSurfaceMode({ ...baseTask, state: "planning" })).toBe(
      "activity",
    );
    expect(
      taskSurfaceMode({
        ...baseTask,
        state: "review",
        planMarkdown: "# Plan",
      }),
    ).toBe("review");
    expect(taskSurfaceMode({ ...baseTask, state: "failed" })).toBe("failed");
    expect(
      taskSurfaceMode({
        ...baseTask,
        state: "failed",
        implementationStartedAt: "2026-08-17T01:00:00.000Z",
        finalPlanMarkdown: "# Final plan",
      }),
    ).toBe("implementation");
    expect(
      taskSurfaceMode({
        ...baseTask,
        state: "failed",
        stableStateBeforeFailure: "review",
        planMarkdown: "# Stable plan",
      }),
    ).toBe("review");
    expect(
      taskSurfaceMode({
        ...baseTask,
        state: "implementing",
        finalPlanMarkdown: "# Final plan",
      }),
    ).toBe("implementation");
    expect(taskSurfaceMode({ ...baseTask, state: "paused" })).toBe(
      "implementation",
    );
    expect(taskSurfaceMode({ ...baseTask, state: "complete" })).toBe(
      "implementation",
    );
  });

  it("includes ordered attachments in conflict-safe draft signatures", () => {
    expect(taskDraftSignature("Brief", ["a", "b"])).not.toBe(
      taskDraftSignature("Brief", ["b", "a"]),
    );
    expect(taskDraftSignature("Brief", ["a"])).toBe(
      taskDraftSignature("Brief", ["a"]),
    );
    expect(taskDraftSignature("Brief", ["a"], false)).not.toBe(
      taskDraftSignature("Brief", ["a"], true),
    );
  });

  it("prioritizes conflict and failure states in autosave labels", () => {
    expect(
      taskAutosaveLabel({
        conflict: true,
        dirty: true,
        failed: true,
        saving: true,
      }),
    ).toBe("Save conflict");
    expect(
      taskAutosaveLabel({
        conflict: false,
        dirty: true,
        failed: false,
        saving: true,
      }),
    ).toBe("Saving…");
    expect(
      taskAutosaveLabel({
        conflict: false,
        dirty: false,
        failed: false,
        saving: false,
      }),
    ).toBe("Saved");
  });
});
