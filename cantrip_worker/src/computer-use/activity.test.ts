import { randomUUID } from "node:crypto";
import { agentActivitySchema, type CuaScope } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";
import { computerUseActivity } from "./activity.js";
import { CuaApprovalError } from "./approvals.js";

const scope: CuaScope = {
  ownerId: "owner",
  serverId: "server",
  workerId: "worker",
  chatId: "chat",
  taskId: null,
  threadId: null,
  turnId: null,
};
const input = () => ({
  source: "user-preview" as const,
  operation: "targets.list" as const,
  operationId: randomUUID(),
  requestId: null,
  scope,
  startedAtMs: 10,
  completedAtMs: 25,
});

describe("protected computer-use activity metadata", () => {
  it("records terminal timing and permits only bounded metadata in raw capture", () => {
    const activity = agentActivitySchema.parse(computerUseActivity(input()));
    expect(activity).toMatchObject({
      type: "computerUse",
      status: "completed",
      outcome: "completed",
      durationMs: 15,
      binding: { threadId: null, turnId: null, sessionId: null },
      target: null,
      cursor: null,
      observation: null,
    });
    expect(activity.raw).toMatchObject({ request: null, response: null });
    expect(Object.keys(activity.raw!.metadata).sort()).toEqual([
      "durationMs",
      "errorCode",
      "operation",
      "operationId",
      "outcome",
      "source",
    ]);
    expect(activity.agentScope).toBeUndefined();
  });

  it.each([
    [new CuaApprovalError("denied"), false, "declined", "denied"],
    [new CuaApprovalError("revoked"), false, "cancelled", "revoked"],
    [
      new Error("private script and title"),
      false,
      "failed",
      "operation-failed",
    ],
    [new Error("private late failure"), true, "cancelled", "operation-failed"],
  ] as const)(
    "classifies known outcomes without copying raw error text",
    (error, cancelled, outcome, errorCode) => {
      const activity = computerUseActivity({
        ...input(),
        failed: true,
        error,
        cancelled,
      });
      expect(agentActivitySchema.parse(activity)).toMatchObject({
        outcome,
        errorCode,
        status: outcome === "cancelled" ? "failed" : outcome,
      });
      expect(JSON.stringify(activity)).not.toContain("private");
    },
  );
});
