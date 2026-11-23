import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  taskGoalCycleSuspensionSourceSchema,
  workerChatTurnOutcomeNotificationSchema,
} from "@cantrip/protocol";
import { TaskGoalOutcomeDelivery } from "./task-goal-outcome-delivery.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("retains the exact encrypted cycle result across delivery shutdown and waits for its actual commit", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-goal-cycle-outcome-"),
  );
  directories.push(directory);
  const scope = {
    serverId: randomUUID(),
    ownerId: "owner",
    workerId: "worker",
  };
  const cycle = {
    cycleId: randomUUID(),
    goalEpoch: "epoch",
    scopeId: "scope",
    gateAttemptId: "attempt",
    runnerGeneration: "runner",
    modelRouteId: "route",
    providerAccountId: null,
    orderEpoch: 0,
  };
  const source = taskGoalCycleSuspensionSourceSchema.parse({
    kind: "goal-cycle",
    sourceKey: "e".repeat(64),
    threadId: "thread",
    turnId: "turn",
    cycle,
    operationId: "native-inference:thread:turn:scope:attempt",
    workerGeneration: randomUUID(),
    runtimeGeneration: randomUUID(),
    publication: {
      id: randomUUID(),
      idempotencyKey: "assistant:goal-cycle:fixture",
    },
    parent: {
      kind: "goal",
      operationId: randomUUID(),
      chatId: "chat",
      clientMessageId: "message",
      workerId: scope.workerId,
      worktreeId: "tree",
      executionLaneId: "lane",
      executionLaneActivatedAt: new Date().toISOString(),
      providerId: "provider",
      modelRouteId: "route",
      providerAccountId: null,
      dispatch: {
        cycleId: cycle.cycleId,
        operationId: randomUUID(),
        leaseOwner: "owner",
        fencingToken: 1,
      },
    },
  });
  const notification = workerChatTurnOutcomeNotificationSchema.parse({
    type: "chat.turn.outcome",
    chatId: "chat",
    clientMessageId: "message",
    executionLaneId: "lane",
    contextKind: "project",
    scratchRootId: null,
    worktreeId: "tree",
    outcome: {
      ok: true,
      result: {
        threadId: "thread",
        turnId: "turn",
        status: "completed",
        text: "",
        structuredResult: { ciphertext: "OPAQUE_ENCRYPTED_RESULT" },
      },
    },
  });
  let entered!: () => void;
  const sending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = new TaskGoalOutcomeDelivery({
    directory,
    scope: () => scope,
    onError: vi.fn(),
    send: (_record, signal) =>
      new Promise((_resolve, reject) => {
        entered();
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  let committed = false;
  const append = first
    .append(notification, scope, "goal-cycle", source)
    .then(() => {
      committed = true;
    });
  void append.catch(() => {});
  await sending;
  const records = path.join(
    directory,
    "task-goal-outcomes",
    createHash("sha256")
      .update(JSON.stringify([scope.serverId, scope.ownerId, scope.workerId]))
      .digest("hex"),
  );
  const [filename] = await readdir(records);
  const bytes = await readFile(path.join(records, filename!), "utf8");
  expect(committed).toBe(false);
  first.close();
  await expect(append).rejects.toThrow();
  expect(await readFile(path.join(records, filename!), "utf8")).toBe(bytes);
  const delivered: unknown[] = [];
  const next = new TaskGoalOutcomeDelivery({
    directory,
    scope: () => scope,
    onError: vi.fn(),
    send: async (record) => {
      delivered.push(record);
    },
  });
  try {
    next.wake();
    await vi.waitFor(async () => {
      expect(await readdir(records)).toHaveLength(0);
    });
    expect(delivered).toEqual([JSON.parse(bytes)]);
    expect(
      JSON.parse(bytes).notification.taskInferenceInputOperationId,
    ).toBeUndefined();
    expect(JSON.parse(bytes).goalCycleSource).toEqual(source);
  } finally {
    next.close();
  }
});
