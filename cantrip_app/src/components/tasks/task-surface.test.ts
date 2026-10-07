import { describe, expect, it } from "vitest";
import type { TaskDetail } from "@cantrip/protocol";

import appStyles from "../../index.css?raw";
import {
  TASK_DRAFT_FOOTER_CLASS_NAME,
  TASK_DRAFT_OPTIONS_CLASS_NAME,
  taskAutosaveLabel,
  taskDraftSignature,
  taskDraftEditable,
  taskSurfaceMode,
} from "./task-surface";

const baseTask = {
  chatId: "chat-one",
  planGoalEnabled: false,
  priority: 0,
  requestedTaskWorkerId: null,
  continuityFamily: null,
  lastTaskWorkerId: null,
  dispatch: null,
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
  completedAt: null,
  lastError: null,
  schedulerRevision: 1,
  rowVersion: 1,
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};

describe("Task draft presentation", () => {
  it("keeps failed drafts editable but protects started operations and review plans", () => {
    expect(
      taskDraftEditable({
        ...baseTask,
        state: "failed",
        stableStateBeforeFailure: "draft",
      }),
    ).toBe(true);
    expect(
      taskDraftEditable({
        ...baseTask,
        state: "failed",
        stableStateBeforeFailure: "review",
      }),
    ).toBe(false);
    expect(taskDraftEditable({ ...baseTask, state: "planning" })).toBe(false);
    expect(
      taskDraftEditable({
        ...baseTask,
        dispatch: { state: "running" } as TaskDetail["dispatch"],
      }),
    ).toBe(false);
  });
  it("lets the Pro Mode shell show through the footer without extra blur", () => {
    expect(TASK_DRAFT_FOOTER_CLASS_NAME.split(" ")).toContain(
      "cantrip-task-draft-footer",
    );
    const rule = appStyles.match(
      /\.pro-mode \.cantrip-task-draft-footer\s*\{([^}]+)\}/,
    )?.[1];
    expect(rule).toContain("background-color: transparent;");
    expect(rule).toContain("-webkit-backdrop-filter: none;");
    expect(rule).toContain("backdrop-filter: none;");
  });

  it("retains the footer background and blur in standard mode", () => {
    const classes = TASK_DRAFT_FOOTER_CLASS_NAME.split(" ");
    expect(classes).toContain("bg-background/95");
    expect(classes).toContain("backdrop-blur");
  });

  it("keeps mobile primary actions compact and moves options below them", () => {
    expect(TASK_DRAFT_FOOTER_CLASS_NAME).toContain("px-3");
    expect(TASK_DRAFT_FOOTER_CLASS_NAME).toContain("sm:px-6");
    expect(TASK_DRAFT_OPTIONS_CLASS_NAME).toContain("order-last");
    expect(TASK_DRAFT_OPTIONS_CLASS_NAME).toContain("sm:contents");
  });

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
    expect(taskDraftSignature("Brief", ["a"], false, 0, null)).not.toBe(
      taskDraftSignature("Brief", ["a"], false, 1, null),
    );
    expect(taskDraftSignature("Brief", ["a"], false, 0, null)).not.toBe(
      taskDraftSignature(
        "Brief",
        ["a"],
        false,
        0,
        "00000000-0000-4000-8000-000000000001",
      ),
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
