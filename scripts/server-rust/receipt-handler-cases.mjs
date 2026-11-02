import assert from "node:assert/strict";
import { command } from "./native-command-admission-cases.mjs";
import { literal, stamp } from "./project-target-state.mjs";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
import {
  nativeCommandDispatchSchema,
  nativeCommandSettlementSchema,
} from "../../packages/protocol/dist/index.js";
export async function runReceiptHandlerCases({
  observe,
  reset,
  seed,
  snapshot,
}) {
  const session = {
    ...command().session,
    threadId: "thread",
    runtimeGeneration: "runtime",
    connectionId: "connection",
  };
  for (const test of [
    {
      name: "ordinary read receipt",
      method: "hooks/list",
      publications: 0,
      dispatch: 0,
    },
    {
      name: "settings receipt invalidates chat",
      method: "thread/settings/update",
      publications: 1,
      dispatch: 0,
    },
    {
      name: "settings rejection still invalidates",
      method: "thread/settings/update",
      status: "rejected",
      publications: 1,
      dispatch: 0,
    },
    {
      name: "active execution receipt does not wake",
      method: "turn/start",
      publications: 0,
      dispatch: 0,
    },
    {
      name: "terminal native input wakes after commit",
      method: "turn/start",
      complete: true,
      publications: 1,
      dispatch: 1,
      replay: true,
    },
    {
      name: "failed execution publishes boundary without idle dispatch",
      method: "turn/start",
      complete: true,
      executionStatus: "failed",
      publications: 1,
      dispatch: 0,
    },
    {
      name: "deferred input is retained without premature queue dispatch",
      method: "turn/start",
      complete: true,
      status: "rejected",
      deferred: true,
      publications: 0,
      dispatch: 0,
      replay: true,
    },
    {
      name: "dispatch failure does not undo the receipt",
      method: "turn/start",
      complete: true,
      dispatchError: true,
      publications: 1,
      dispatch: 1,
    },
    {
      name: "applied Goal clear wakes idle queue",
      method: "thread/goal/clear",
      publications: 0,
      dispatch: 1,
    },
    {
      name: "applied paused Goal set wakes idle queue",
      method: "thread/goal/set",
      intent: { goalStatus: "paused" },
      publications: 0,
      dispatch: 1,
    },
    {
      name: "rejected Goal set does not wake",
      method: "thread/goal/set",
      intent: { goalStatus: "paused" },
      status: "rejected",
      publications: 0,
      dispatch: 0,
    },
  ]) {
    await reset();
    await seed(
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('receipt-runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
    );
    const admitted = await observe(
      "receipt handler admission: " + test.name,
      command({
        origin: "terminal",
        session,
        method: test.method,
        intent: test.intent ?? {},
      }),
    );
    await observe(
      "receipt handler dispatch: " + test.name,
      (i) =>
        nativeCommandDispatchSchema.parse({
          workerId: "alpha",
          operationId: "request",
          operationGeneration: admitted[i].receipt.operationGeneration,
          payloadDigest: "a".repeat(64),
          session,
        }),
      { op: "native-command-dispatch", status: "dispatched" },
    );
    const input = (i) => ({
      input: nativeCommandSettlementSchema.parse({
        workerId: "alpha",
        operationId: "request",
        operationGeneration: admitted[i].receipt.operationGeneration,
        status: test.status ?? "applied",
        resultDigest: test.deferred ? "d".repeat(64) : null,
        protectedResult: test.deferred ? command().protectedPayload : null,
        rejectionCode: test.deferred
          ? "native-settings-pending"
          : test.status === "rejected"
            ? "controlled-worker-rejection"
            : null,
        ...(test.deferred
          ? {
              deferred: {
                reason: "pendingSettings",
                inputConsumed: false,
                threadId: "thread",
                runtimeGeneration: "runtime",
                retainedPrompt: retainedPrompt({
                  payload: command().protectedPayload,
                }),
                attachments: [],
              },
            }
          : {}),
        ...(test.complete
          ? {
              executionComplete: true,
              executionStatus: test.executionStatus ?? "idle",
            }
          : {}),
      }),
      dispatchError: !!test.dispatchError,
    });
    const values = await observe(
      "receipt route component: " + test.name,
      input,
      { op: "native-command-receipt-handler", shape: "raw" },
    );
    for (const value of values) {
      assert.equal(value.status, 200, test.name);
      assert.equal(value.body.receipt.status, test.status ?? "applied");
      assert.equal(
        value.trace.filter((v) => ["boundary", "invalidation"].includes(v.type))
          .length,
        test.publications,
        test.name,
      );
      assert.equal(
        value.trace.filter((v) => v.type === "dispatch").length,
        test.dispatch,
        test.name,
      );
      assert.equal(
        value.trace.filter((v) => v.type === "warning").length,
        Number(!!test.dispatchError),
        test.name,
      );
      for (const dispatch of value.trace.filter((v) => v.type === "dispatch"))
        assert.equal(
          dispatch.committedStatus,
          "applied",
          "Dispatch must read the already committed native receipt",
        );
    }
    await snapshot("receipt effects committed: " + test.name);
    if (test.replay) {
      const replay = await observe(
        "receipt replay still wakes without repeating settlement",
        input,
        { op: "native-command-receipt-handler", shape: "raw" },
      );
      for (const [i, value] of replay.entries())
        assert.deepEqual(value, values[i]);
    }
  }
  await reset();
  for (const input of [
    null,
    {},
    { workerId: "alpha", operationId: "missing" },
  ]) {
    const values = await observe(
      "invalid receipt route input " + JSON.stringify(input),
      { input },
      { op: "native-command-receipt-handler", shape: "raw" },
    );
    for (const value of values)
      assert.deepEqual(value, {
        status: 400,
        body: { code: "invalid-native-command" },
        trace: [],
      });
  }
}
