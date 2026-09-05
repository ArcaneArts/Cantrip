import { describe, expect, it } from "vitest";
import { agentActivitySchema } from "./agent-activity.js";
import {
  computerUseActivityEventSchema,
  workerEventSchema,
} from "./worker-events.js";

const operationId = "4822bfb8-0f60-4de4-a8e4-335c4099d61f";
const preview = () => ({
  id: operationId,
  type: "computerUse",
  status: "completed",
  source: "user-preview",
  operation: "observation.snapshot",
  operationId,
  requestId: null,
  binding: {
    chatId: "chat",
    taskId: null,
    workerId: "worker",
    threadId: null,
    turnId: null,
    sessionId: "session",
  },
  target: { targetId: "window", targetGeneration: 2 },
  cursor: null,
  observation: {
    revision: 1,
    image: {
      mediaType: "image/png",
      width: 320,
      height: 200,
      byteCount: 1000,
      sha256: "a".repeat(64),
      cursorIncluded: true,
    },
  },
  outcome: "completed",
  errorCode: null,
  durationMs: 10.5,
  startedAtMs: 1000,
  updatedAtMs: 1011,
  completedAtMs: 1011,
});
const child = () => ({
  ...preview(),
  source: "agent-mcp",
  binding: {
    ...preview().binding,
    threadId: "child",
    turnId: "child-turn",
    taskId: "task",
  },
  correlation: {
    sourceMethod: "cantrip_cua.snapshot",
    diagnosticId: null,
    itemId: null,
    threadId: "child",
    turnId: "child-turn",
  },
  agentScope: {
    agentThreadId: "child",
    rootThreadId: "root",
    parentThreadId: "root",
    rootTurnId: "root-turn",
    agentPath: ["root", "child"],
    nickname: null,
    role: null,
    depth: 1,
    isRoot: false,
  },
});
const encrypted = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};
const wrapper = (task = false) => ({
  type: "computer-use.activity",
  operationId,
  event: {
    type: task ? "agent.protected-task-message" : "agent.protected-message",
    message: {
      id: operationId,
      classification: { role: "assistant", mode: "default", attachmentIds: [] },
      protectedContent: encrypted,
      idempotencyKey: operationId,
    },
    telemetry: { kind: "activity", activityType: "computerUse", turnId: null },
  },
});

describe("protected computer-use activity", () => {
  it("retains an idle preview actor without inventing an agent turn", () => {
    expect(agentActivitySchema.parse(preview())).toEqual(preview());
    expect(
      agentActivitySchema.parse({
        ...preview(),
        operation: "preview.stop",
        binding: { ...preview().binding, sessionId: null },
        target: null,
        observation: null,
      }).type,
    ).toBe("computerUse");
  });
  it("retains actual child execution scope and correlation", () => {
    expect(agentActivitySchema.parse(child())).toEqual(child());
  });
  it.each([
    [
      "preview thread",
      () => ({
        ...preview(),
        binding: { ...preview().binding, threadId: "invented" },
      }),
    ],
    [
      "preview agent scope",
      () => ({ ...preview(), agentScope: child().agentScope }),
    ],
    ["agent without scope", () => ({ ...preview(), source: "agent-mcp" })],
    [
      "wrong child scope",
      () => ({
        ...child(),
        agentScope: { ...child().agentScope, agentThreadId: "foreign" },
      }),
    ],
    [
      "wrong turn correlation",
      () => ({
        ...child(),
        correlation: { ...child().correlation, turnId: "foreign" },
      }),
    ],
    ["inconsistent outcome", () => ({ ...preview(), outcome: "cancelled" })],
    ["reversed timing", () => ({ ...preview(), completedAtMs: 999 })],
    ["unbounded duration", () => ({ ...preview(), durationMs: Infinity })],
    [
      "image pixels",
      () => ({
        ...preview(),
        observation: { ...preview().observation, pixels: "private" },
      }),
    ],
    [
      "target title",
      () => ({
        ...preview(),
        target: { ...preview().target, title: "private" },
      }),
    ],
    ["script", () => ({ ...preview(), script: "private" })],
    [
      "oversized native error",
      () => ({ ...preview(), errorCode: "x".repeat(257) }),
    ],
  ] as const)("rejects %s", (_name, create) => {
    expect(agentActivitySchema.safeParse(create()).success).toBe(false);
  });
  it.each(["failed", "declined", "cancelled"] as const)(
    "records %s independently of the native request lifetime",
    (outcome) => {
      expect(
        agentActivitySchema.parse({
          ...preview(),
          outcome,
          status: outcome === "cancelled" ? "failed" : outcome,
          errorCode: outcome,
          observation: null,
        }).status,
      ).toBe(outcome === "cancelled" ? "failed" : outcome);
    },
  );
  it.each([false, true])(
    "relays existing protected messages (task=%s)",
    (task) => {
      expect(computerUseActivityEventSchema.parse(wrapper(task)).type).toBe(
        "computer-use.activity",
      );
      expect(workerEventSchema.parse(wrapper(task)).type).toBe(
        "computer-use.activity",
      );
    },
  );
  it.each([
    { turnId: "invented" },
    { agentRuntime: { agentThreadId: "invented" } },
    { title: "Private window" },
    { cursorLabel: "Private cursor" },
    { pixels: "private" },
    { script: "private" },
    { activityType: "command" },
  ])(
    "rejects native/private claims in plaintext preview telemetry: %j",
    (change) => {
      const value = wrapper();
      expect(
        computerUseActivityEventSchema.safeParse({
          ...value,
          event: {
            ...value.event,
            telemetry: { ...value.event.telemetry, ...change },
          },
        }).success,
      ).toBe(false);
    },
  );
});
