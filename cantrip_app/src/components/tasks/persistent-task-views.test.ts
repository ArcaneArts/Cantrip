import type { ChatSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  MAX_RETAINED_TASK_VIEWS,
  retainTaskSurfaceTabs,
  type ActiveTaskView,
} from "./persistent-task-views";

function task(id: string): ActiveTaskView {
  return {
    chat: {
      id,
      projectId: "project-one",
      title: id,
      experience: "task",
      position: 0,
      status: "idle",
      activeWorkerId: null,
      activeWorktreeId: "primary",
      placementRevision: 1,
      worktreeMode: "agent-managed",
      modelId: "gpt-5.6-sol",
      reasoningEffort: null,
      permissionProfileId: null,
      planMode: "default",
      hasPendingPlanQuestion: false,
      hasUnreadCompletion: false,
      automationPaused: false,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    } satisfies ChatSummary,
  };
}

describe("persistent Task views", () => {
  it("retains local Task surfaces while updating the active summary", () => {
    const first = task("one");
    const updated = {
      ...first,
      chat: { ...first.chat, status: "running" as const },
    };
    expect(retainTaskSurfaceTabs([first, task("two")], updated)).toEqual([
      expect.objectContaining({ chat: expect.objectContaining({ id: "two" }) }),
      updated,
    ]);
  });

  it("bounds retained surfaces", () => {
    const retained = Array.from(
      { length: MAX_RETAINED_TASK_VIEWS },
      (_, index) => task(String(index)),
    );
    expect(retainTaskSurfaceTabs(retained, task("new"))).toHaveLength(
      MAX_RETAINED_TASK_VIEWS,
    );
    expect(retainTaskSurfaceTabs(retained, task("new")).at(-1)?.chat.id).toBe(
      "new",
    );
  });
});
