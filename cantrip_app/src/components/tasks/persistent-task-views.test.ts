import type { ChatSummary } from "@cantrip/protocol";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_RETAINED_TASK_VIEWS,
  PersistentTaskViews,
  retainTaskSurfaceTabs,
  type ActiveTaskView,
} from "./persistent-task-views";
import { TaskSurface } from "./task-surface";

vi.mock("./task-surface", () => ({ TaskSurface: () => null }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
  it("keeps retained surfaces mounted but only enables the visible active Task", async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    const render = (activeTask: ActiveTaskView, visible = true) =>
      createElement(PersistentTaskViews, {
        activeTask,
        visible,
        onRename: vi.fn(),
        settings: undefined,
      });
    const surfaces = () =>
      renderer!.root.findAllByType(TaskSurface).map((surface) => ({
        id: surface.props.chat.id,
        visible: surface.props.visible,
      }));
    try {
      const first = task("one");
      const second = task("two");
      await act(async () => {
        renderer = TestRenderer.create(render(first));
      });
      await act(async () => renderer!.update(render(second)));
      expect(surfaces()).toEqual([
        { id: "one", visible: false },
        { id: "two", visible: true },
      ]);
      await act(async () => renderer!.update(render(second, false)));
      expect(surfaces().every((surface) => !surface.visible)).toBe(true);
      await act(async () => renderer!.update(render(first)));
      expect(surfaces()).toEqual([
        { id: "two", visible: false },
        { id: "one", visible: true },
      ]);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });

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
