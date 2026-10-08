import type {
  ChatSummary,
  TaskDetail,
  TaskGoalSnapshot,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "@/lib/api";

import {
  TASK_IMPLEMENTATION_CONTENT_CLASS_NAME,
  TaskImplementationDashboard,
  resumeTaskImplementation,
  stopTaskImplementation,
  taskImplementationCanResume,
  taskImplementationPlacementLabel,
  taskImplementationShowsLiveActivity,
  taskImplementationStatusLabel,
} from "./task-implementation-dashboard";

const task = {
  state: "implementing",
  planGoalEnabled: true,
} as TaskDetail;
const goal = {
  status: "active",
} as TaskGoalSnapshot;

describe("Task implementation dashboard presentation", () => {
  it("allows explicit Resume for retained implementation Goals, but not failed planning or completed Goals", () => {
    const failed = {
      ...task,
      state: "failed",
      lastError: { code: "implementation-runtime-failed" },
    } as TaskDetail;
    expect(taskImplementationCanResume(failed, goal)).toBe(true);
    expect(
      taskImplementationCanResume(failed, { ...goal, status: "complete" }),
    ).toBe(false);
    expect(
      taskImplementationCanResume({ ...failed, planGoalEnabled: false }, goal),
    ).toBe(false);
    expect(
      taskImplementationCanResume(
        { ...failed, lastError: { code: "planning-failed" } } as TaskDetail,
        goal,
      ),
    ).toBe(false);
  });
  it("shows a deferred launch as queued instead of still starting", () => {
    expect(
      taskImplementationStatusLabel(
        {
          ...task,
          dispatch: { state: "queued" } as TaskDetail["dispatch"],
        },
        null,
      ),
    ).toBe("Queued");
  });
  it("uses the full Task surface width without centered gutters", () => {
    expect(TASK_IMPLEMENTATION_CONTENT_CLASS_NAME).toContain("w-full");
    expect(TASK_IMPLEMENTATION_CONTENT_CLASS_NAME).toContain("min-w-0");
    expect(TASK_IMPLEMENTATION_CONTENT_CLASS_NAME).toContain("max-w-full");
    expect(TASK_IMPLEMENTATION_CONTENT_CLASS_NAME).not.toContain("mx-auto");
  });

  it("removes narrow-pane gutters regardless of the application viewport", () => {
    const classes = TASK_IMPLEMENTATION_CONTENT_CLASS_NAME.split(" ");
    expect(classes).toContain("px-0");
    expect(classes).toContain("@min-[40rem]/task-implementation:px-8");
    expect(
      classes.some((className) => /^(sm|md|lg|xl):px-/.test(className)),
    ).toBe(false);
  });

  it("labels managed folder placement without Git terminology", () => {
    expect(
      taskImplementationPlacementLabel({
        kind: "folder",
        workerId: "worker",
        rootId: "root",
        displayPath: "folders/root",
      }),
    ).toBe("Direct folder");
  });

  it("prioritizes durable Task lifecycle states over stale Goal labels", () => {
    expect(taskImplementationStatusLabel(task, goal)).toBe("Running");
    expect(
      taskImplementationStatusLabel({ ...task, state: "paused" }, goal),
    ).toBe("Paused");
    expect(
      taskImplementationStatusLabel(
        { ...task, state: "blocked" },
        { ...goal, status: "usageLimited" },
      ),
    ).toBe("Usage limited");
    expect(
      taskImplementationStatusLabel({ ...task, state: "failed" }, goal),
    ).toBe("Failed");
    expect(
      taskImplementationStatusLabel({ ...task, state: "complete" }, goal),
    ).toBe("Complete");
  });

  it("shows live activity only while the Task Goal is running", () => {
    expect(taskImplementationShowsLiveActivity(task, goal)).toBe(true);
    expect(
      taskImplementationShowsLiveActivity({ ...task, state: "complete" }, goal),
    ).toBe(false);
    expect(
      taskImplementationShowsLiveActivity(task, {
        ...goal,
        status: "paused",
      }),
    ).toBe(false);
    expect(taskImplementationShowsLiveActivity(task, null)).toBe(false);
  });

  it("shows direct Task activity without requiring a Goal", () => {
    const directTask = { ...task, planGoalEnabled: false };
    expect(taskImplementationStatusLabel(directTask, null, true)).toBe(
      "Running",
    );
    expect(taskImplementationShowsLiveActivity(directTask, null, true)).toBe(
      true,
    );
    expect(
      taskImplementationShowsLiveActivity(
        { ...directTask, state: "complete" },
        null,
        false,
      ),
    ).toBe(false);
  });

  it("does not label a failed Task chat as still starting", () => {
    expect(taskImplementationStatusLabel(task, null, false, true)).toBe(
      "Failed",
    );
  });

  it.each([false, true])(
    "shows a stopped Task as paused and resumable with planGoalEnabled=%s",
    (planGoalEnabled) => {
      const stoppedTask = { ...task, planGoalEnabled };
      const currentGoal = planGoalEnabled ? goal : null;
      expect(
        taskImplementationStatusLabel(
          stoppedTask,
          currentGoal,
          true,
          false,
          false,
          true,
        ),
      ).toBe("Paused");
      expect(
        taskImplementationShowsLiveActivity(
          stoppedTask,
          currentGoal,
          true,
          true,
        ),
      ).toBe(false);
      expect(taskImplementationCanResume(stoppedTask, currentGoal, true)).toBe(
        true,
      );
      expect(taskImplementationCanResume(stoppedTask, currentGoal, false)).toBe(
        false,
      );
    },
  );

  it("does not mask completion or real execution failures with a stale pause flag", () => {
    expect(
      taskImplementationStatusLabel(
        { ...task, state: "complete" },
        goal,
        false,
        false,
        false,
        true,
      ),
    ).toBe("Complete");
    expect(
      taskImplementationCanResume({ ...task, state: "complete" }, goal, true),
    ).toBe(false);
    expect(
      taskImplementationStatusLabel(task, goal, false, true, false, true),
    ).toBe("Failed");
    expect(
      taskImplementationStatusLabel(
        { ...task, state: "failed" },
        goal,
        false,
        false,
        false,
        true,
      ),
    ).toBe("Failed");
  });

  it("renders Resume instead of Stop for a stopped direct Task even while its resident turn is running", () => {
    const client = new QueryClient();
    const currentChat = {
      id: "stopped-task",
      projectId: "project",
      status: "running",
      automationPaused: true,
    } as ChatSummary;
    client.setQueryData(["agent-requests", currentChat.id, "pending"], []);
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TaskImplementationDashboard, {
          chat: currentChat,
          initialTask: {
            ...task,
            planGoalEnabled: false,
            briefMarkdown: "Task brief",
          },
        }),
      ),
    );
    client.clear();
    expect(markup).toContain(">Paused<");
    expect(markup).toContain("Resume</button>");
    expect(markup).not.toContain("Stop</button>");
    expect(markup).not.toContain("Failed");
  });

  it("labels approval-blocked execution rather than claiming it is running", () => {
    expect(taskImplementationStatusLabel(task, goal, true, false, true)).toBe(
      "Needs approval",
    );
    expect(
      taskImplementationStatusLabel(
        { ...task, planGoalEnabled: false },
        null,
        true,
        false,
        true,
      ),
    ).toBe("Needs approval");
    expect(
      taskImplementationStatusLabel(
        { ...task, state: "complete" },
        goal,
        false,
        false,
        true,
      ),
    ).toBe("Complete");
    expect(taskImplementationStatusLabel(task, goal, false, true, true)).toBe(
      "Failed",
    );
  });
});

describe("Task execution controls", () => {
  afterEach(() => vi.restoreAllMocks());

  it("restarts a retained active Goal only when Resume is explicitly requested on an unpaused failed Task", async () => {
    const pause = vi.spyOn(api, "setChatPaused");
    const updateGoal = vi
      .spyOn(api, "updateChatGoal")
      .mockResolvedValue({ goal: null });
    await resumeTaskImplementation("task-chat", false, goal);
    expect(pause).not.toHaveBeenCalled();
    expect(updateGoal).toHaveBeenCalledExactlyOnceWith("task-chat", {
      status: "active",
    });
  });

  it("stops at a resumable boundary without interrupting or cancelling the encrypted operation", async () => {
    const pause = vi
      .spyOn(api, "setChatPaused")
      .mockResolvedValue({ paused: true });
    const interrupt = vi.spyOn(api, "interruptChat");
    const updateGoal = vi.spyOn(api, "updateChatGoal");
    await stopTaskImplementation("task-chat");
    expect(pause).toHaveBeenCalledExactlyOnceWith("task-chat", true);
    expect(interrupt).not.toHaveBeenCalled();
    expect(updateGoal).not.toHaveBeenCalled();
  });

  it("propagates pause errors without falling back to a destructive interruption", async () => {
    const error = new Error("The worker could not pause at a safe boundary");
    vi.spyOn(api, "setChatPaused").mockRejectedValue(error);
    const interrupt = vi.spyOn(api, "interruptChat");
    await expect(stopTaskImplementation("task-chat")).rejects.toBe(error);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("resumes a stopped direct Task's existing turn without requiring a Goal", async () => {
    const pause = vi
      .spyOn(api, "setChatPaused")
      .mockResolvedValue({ paused: false });
    const updateGoal = vi.spyOn(api, "updateChatGoal");
    await resumeTaskImplementation("task-chat", true, null);
    expect(pause).toHaveBeenCalledExactlyOnceWith("task-chat", false);
    expect(updateGoal).not.toHaveBeenCalled();
  });

  it.each(["paused", "blocked"] as const)(
    "reactivates an independently %s Goal on Resume",
    async (status) => {
      const pause = vi.spyOn(api, "setChatPaused");
      const updateGoal = vi
        .spyOn(api, "updateChatGoal")
        .mockResolvedValue({ goal: null });
      await resumeTaskImplementation("task-chat", false, { ...goal, status });
      expect(pause).not.toHaveBeenCalled();
      expect(updateGoal).toHaveBeenCalledExactlyOnceWith("task-chat", {
        status: "active",
      });
    },
  );

  it("leaves a stopped active Goal intact when unpausing its resident turn", async () => {
    vi.spyOn(api, "setChatPaused").mockResolvedValue({ paused: false });
    const updateGoal = vi.spyOn(api, "updateChatGoal");
    await resumeTaskImplementation("task-chat", true, goal);
    expect(updateGoal).not.toHaveBeenCalled();
  });

  it("does not reactivate a Goal if resuming the worker fails", async () => {
    const error = new Error("Worker offline");
    vi.spyOn(api, "setChatPaused").mockRejectedValue(error);
    const updateGoal = vi.spyOn(api, "updateChatGoal");
    await expect(
      resumeTaskImplementation("task-chat", true, {
        ...goal,
        status: "paused",
      }),
    ).rejects.toBe(error);
    expect(updateGoal).not.toHaveBeenCalled();
  });
});
