import { describe, expect, it } from "vitest";

import { minimizeWorkflowEventPayload } from "../src/db/workflow-run-transitions.js";

describe("workflow event minimization", () => {
  it("keeps operational metadata without copying semantic content", () => {
    expect(
      minimizeWorkflowEventPayload("node.attempt.failed", {
        code: "protected-worker-failure",
        message: "EVENT_CONTENT_SENTINEL private failure",
        reason: "EVENT_CONTENT_SENTINEL private reason",
        retryScheduled: true,
        nextAttempt: 2,
        textPreview: "EVENT_CONTENT_SENTINEL private output",
      }),
    ).toEqual({
      code: "protected-worker-failure",
      retryScheduled: true,
      nextAttempt: 2,
    });

    expect(
      minimizeWorkflowEventPayload("workflow.node.message", {
        attemptId: "attempt-1",
        eventType: "workflow.node.message",
        event: { message: "EVENT_CONTENT_SENTINEL private worker message" },
      }),
    ).toEqual({
      attemptId: "attempt-1",
      eventType: "workflow.node.message",
    });
  });
});
