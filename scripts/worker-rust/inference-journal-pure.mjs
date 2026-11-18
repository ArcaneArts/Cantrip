import { createHash } from "node:crypto";
import {
  recoveryIdentity,
  recoveryQueueIdentity,
} from "../../cantrip_worker/src/inference-journal.ts";
import { schemas } from "./inference-journal-contracts.mjs";
export async function pure({ native, same }) {
  for (const value of [
    null,
    {},
    { messageId: "one" },
    {
      commandId: "c",
      commandGeneration: "g",
      threadId: "t",
      turnId: "u",
      autonomousGoal: { goalEpoch: "e" },
    },
    {
      messageId: "m",
      taskInput: {
        operationId: "o",
        queueOrderEpoch: 2,
        dispatch: { cycleId: "cycle", fencingToken: 3 },
      },
    },
    {
      threadId: "t",
      turnId: "u",
      taskGoalCycle: { cycleId: "cycle", goalEpoch: "e", orderEpoch: 7 },
    },
    {
      threadId: "t",
      turnId: "u",
      autonomousGoal: { goalEpoch: "e", orderEpoch: 0 },
    },
    {
      messageId: "\ud800😀",
      taskInput: { kind: "initial", queueOrderEpoch: 2, dispatch: {} },
    },
  ]) {
    same(
      await native({ op: "identity", value }),
      recoveryIdentity(value),
      "canonical recovery identity",
    );
    for (const chat of [null, "chat"])
      same(
        await native({ op: "queue", value, chat }),
        recoveryQueueIdentity(chat, value),
        "logical queue identity",
      );
  }
  for (const input of [
    { worker: "worker", runtime: "runtime", operation: "op" },
    { worker: "😀\ud800", runtime: "\n", operation: "op" },
  ])
    same(
      await native({ op: "key", ...input }),
      createHash("sha256")
        .update(JSON.stringify([input.worker, input.runtime, input.operation]))
        .digest("hex"),
      "journal key bytes",
    );
  for (const [name, schema] of Object.entries(schemas))
    for (const value of [
      null,
      {},
      { version: 1, revision: 0, operations: {} },
      { version: 1, revision: -1, operations: {}, extra: true },
    ]) {
      let expected;
      try {
        expected = { ok: true, value: schema.parse(value) };
      } catch (error) {
        expected = { ok: false, error: error.message };
      }
      same(
        await native({ op: "schema", schema: name, value }, true),
        expected,
        "actual journal schema / Zod messages",
      );
    }
}
