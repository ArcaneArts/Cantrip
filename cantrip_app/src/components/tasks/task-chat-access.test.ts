import { describe, expect, it } from "vitest";

import { taskChatIsInspectOnly } from "./task-chat-access";

describe("Task Chat access", () => {
  it("keeps planning states inspect-only", () => {
    expect(taskChatIsInspectOnly(undefined)).toBe(true);
    expect(taskChatIsInspectOnly("draft")).toBe(true);
    expect(taskChatIsInspectOnly("planning")).toBe(true);
    expect(taskChatIsInspectOnly("review")).toBe(true);
    expect(taskChatIsInspectOnly("finalizing")).toBe(true);
    expect(taskChatIsInspectOnly("failed")).toBe(true);
  });

  it("enables normal Chat controls after implementation starts", () => {
    expect(taskChatIsInspectOnly("implementing")).toBe(false);
    expect(taskChatIsInspectOnly("paused")).toBe(false);
    expect(taskChatIsInspectOnly("blocked")).toBe(false);
    expect(taskChatIsInspectOnly("complete")).toBe(false);
  });
});
