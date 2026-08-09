import { describe, expect, it } from "vitest";

import {
  parseWorkflowInput,
  workflowDuration,
  workflowRunActions,
} from "./workflow-center";

describe("workflow center", () => {
  it("accepts only structured object input", () => {
    expect(parseWorkflowInput('{"issue": 42}')).toEqual({ issue: 42 });
    expect(() => parseWorkflowInput("[]")).toThrow(
      "Workflow input must be a JSON object.",
    );
    expect(() => parseWorkflowInput("null")).toThrow(
      "Workflow input must be a JSON object.",
    );
  });

  it("reports stable run durations", () => {
    expect(
      workflowDuration("2026-08-08T12:00:00.000Z", "2026-08-08T12:00:45.000Z"),
    ).toBe("45s");
    expect(
      workflowDuration("2026-08-08T12:00:00.000Z", "2026-08-08T14:30:00.000Z"),
    ).toBe("2.5h");
  });

  it("exposes only controls accepted for the current run state", () => {
    expect(workflowRunActions("running")).toEqual({
      canCancel: true,
      canPause: true,
      canResume: false,
    });
    expect(workflowRunActions("paused")).toEqual({
      canCancel: true,
      canPause: false,
      canResume: true,
    });
    expect(workflowRunActions("completed")).toEqual({
      canCancel: false,
      canPause: false,
      canResume: false,
    });
  });
});
