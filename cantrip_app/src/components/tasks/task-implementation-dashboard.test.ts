import type { TaskDetail, TaskGoalSnapshot } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  TASK_IMPLEMENTATION_CONTENT_CLASS_NAME,
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
