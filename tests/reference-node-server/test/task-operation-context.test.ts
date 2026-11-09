import { describe, expect, it } from "vitest";

import type { TaskPlanningRound } from "@cantrip/protocol/tasks";

import { findTaskOperationRound } from "../src/db/tasks.js";

function round(
  id: string,
  userMessageId: string,
  executionLaneId = "shared-lane",
): TaskPlanningRound {
  return { id, userMessageId, executionLaneId } as TaskPlanningRound;
}

describe("Task operation context lookup", () => {
  it("prefers the exact user message over a reused execution lane", () => {
    const rounds = [
      round("planning", "planning-message"),
      round("finalization", "finalization-message"),
    ];

    expect(
      findTaskOperationRound(rounds, {
        executionLaneId: "shared-lane",
        userMessageId: "finalization-message",
      })?.id,
    ).toBe("finalization");
  });

  it("uses the newest operation when only a reused lane is available", () => {
    const rounds = [
      round("planning", "planning-message"),
      round("finalization", "finalization-message"),
    ];

    expect(
      findTaskOperationRound(rounds, { executionLaneId: "shared-lane" })?.id,
    ).toBe("finalization");
  });
});
