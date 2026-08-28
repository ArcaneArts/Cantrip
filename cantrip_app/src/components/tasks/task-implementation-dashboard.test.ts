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
    expect(TASK_IMPLEMENTATION_CONTENT_CLASS_NAME).not.toContain("mx-auto");
    expect(TASK_IMPLEMENTATION_CONTENT_CLASS_NAME).not.toContain("max-w-");
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
});
