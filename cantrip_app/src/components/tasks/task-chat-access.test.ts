import { describe, expect, it } from "vitest";

import { taskChatIsInspectOnly } from "./task-chat-access";

describe("Task Chat access", () => {
  it("keeps planning states inspect-only", () => {
    expect(taskChatIsInspectOnly(undefined)).toBe(true);
    for (const state of [
      "draft",
      "planning",
      "review",
      "finalizing",
      "failed",
    ] as const) {
      expect(
        taskChatIsInspectOnly({ state, implementationStartedAt: null }),
      ).toBe(true);
    }
  });

  it("enables normal Chat controls after implementation starts", () => {
    for (const state of [
      "implementing",
      "paused",
      "blocked",
      "complete",
    ] as const) {
      expect(
        taskChatIsInspectOnly({ state, implementationStartedAt: "now" }),
      ).toBe(false);
    }
    expect(
      taskChatIsInspectOnly({
        state: "failed",
        implementationStartedAt: "now",
      }),
    ).toBe(false);
  });
});
