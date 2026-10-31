import assert from "node:assert/strict";
import { nativeCommandContinuationSchema } from "../../packages/protocol/dist/index.js";
import { literal, stamp } from "./project-target-state.mjs";
import { runContinuationCases } from "./native-logical-continuation-cases.mjs";
import { runLogicalCompletionCases } from "./native-logical-completion-cases.mjs";
import { runLogicalOutcomeCases } from "./native-logical-outcome-cases.mjs";
import { runTurnObservationCases } from "./native-turn-observation-cases.mjs";
import { runLogicalQueueCases } from "./native-logical-queue-cases.mjs";
export async function runLogicalCases(h) {
  const { reset, seed, observe, snapshot, command } = h;
  const session = {
    ...command().session,
    threadId: "thread",
    runtimeGeneration: "runtime",
    connectionId: "connection",
  };
  async function start({
    dispatch = true,
    origin = "gui",
    intent = {},
    beforeAdmission,
    operationId = "logical-root",
    queueClaim,
  } = {}) {
    await reset();
    await seed("DELETE FROM chat_messages WHERE id='logical-message'");
    await seed(
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('logical-runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
    );
    if (beforeAdmission) await beforeAdmission();
    const admitted = await observe(
      "logical input fixture admission",
      command({
        session,
        origin,
        intent,
        operationId,
        ...(queueClaim ? { queueClaim } : {}),
      }),
      { options: { clientMessageId: "logical-message" } },
    );
    if (dispatch)
      await observe(
        "logical input fixture dispatch",
        (i) => ({
          workerId: "alpha",
          operationId,
          operationGeneration: admitted[i].receipt.operationGeneration,
          payloadDigest: "a".repeat(64),
          session,
        }),
        { op: "native-command-dispatch", status: "dispatched" },
      );
    const continuation = (i, extra = {}) =>
      nativeCommandContinuationSchema.parse({
        workerId: "alpha",
        rootOperationId: operationId,
        previousOperationId: operationId,
        previousOperationGeneration: admitted[i].receipt.operationGeneration,
        operationId: "logical-next",
        payloadDigest: "b".repeat(64),
        protectedPayload: command().protectedPayload,
        session,
        reason: "capacity",
        failure: {
          kind: "native-terminal",
          nativeTurnId: "turn-one",
          runtimeGeneration: "runtime",
        },
        ...extra,
      });
    const key = (i, extra = {}) => ({
      worker: "alpha",
      chat: "chat",
      operation: operationId,
      generation: admitted[i].receipt.operationGeneration,
      ...extra,
    });
    return { admitted, continuation, key, operationId };
  }
  const next = (name, input, options = {}) =>
    observe(name, input, { op: "native-command-logical-continue", ...options });
  const raw = (action, name, input, options = {}) =>
    observe(name, input, {
      op: "native-command-logical-" + action,
      shape: "raw",
      ...options,
    });
  async function unchanged(name, action) {
    const before = await snapshot("before " + name);
    const result = await action();
    assert.deepEqual(await snapshot("logical unchanged " + name), before);
    return result;
  }
  const helpers = { ...h, start, session, next, raw, unchanged };
  await runContinuationCases(helpers);
  await runLogicalCompletionCases(helpers);
  await runLogicalQueueCases(helpers);
  await runLogicalOutcomeCases(helpers);
  await runTurnObservationCases(helpers);
}
