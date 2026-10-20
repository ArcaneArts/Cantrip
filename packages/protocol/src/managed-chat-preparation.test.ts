import { expect, it } from "vitest";
import { managedChatPreparationSchema } from "./managed-chat-preparation.js";

const receipt = {
  chatId: "chat",
  workerId: "worker",
  terminalId: "4e143baa-88c8-43bb-a960-0e5f94df6a36",
  generation: "4e143baa-88c8-43bb-a960-0e5f94df6a36",
  failedPhase: null,
  updatedAt: "2026-10-20T18:00:00Z",
};
it.each(["pending", "thread", "console", "ready", "failed", "needs-model"])(
  "accepts the %s preparation state",
  (phase) => {
    expect(
      managedChatPreparationSchema.parse({ ...receipt, phase }).phase,
    ).toBe(phase);
  },
);
it("rejects unknown preparation states", () => {
  expect(
    managedChatPreparationSchema.safeParse({ ...receipt, phase: "unknown" })
      .success,
  ).toBe(false);
});
