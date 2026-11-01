// The actual GUI admission helper, real native journal and legacy lane writer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { retainedPrompt, promptId } from "./native-settlement-fixtures.mjs";
import { literal, stamp, otherOwner } from "./project-target-state.mjs";
import { runTurnConfigurationCases } from "./turn-configuration-cases.mjs";
import { runReceiptHandlerCases } from "./receipt-handler-cases.mjs";
import { runProtectInputCases } from "./protect-input-cases.mjs";
import { runTurnPlacementCases } from "./turn-placement-cases.mjs";
import { runTurnBehaviorCases } from "./turn-behavior-cases.mjs";
import { runGuiTelemetryCases } from "./gui-telemetry-cases.mjs";
import { runTurnLiveCases } from "./turn-live-cases.mjs";
import { runTaskDispatchLeaseCases } from "./task-dispatch-lease-cases.mjs";
import { runTurnBootstrapCases } from "./turn-bootstrap-cases.mjs";
import { runTurnExecutionCases } from "./turn-execution-cases.mjs";
import { runAutomaticTitleCases } from "./automatic-title-cases.mjs";
import { runRecoveryCases } from "./recovery-cases.mjs";
import { runNativeHandoffCases } from "./native-handoff-cases.mjs";
import { runAccountFailoverCases } from "./account-failover-cases.mjs";
export async function runGuiAdmissionCases(h) {
  const { observe, reset, snapshot, seed, owner, standalone } = h;
  const protectedInput = retainedPrompt().pendingMessage;
  const acquire = (name, fields = {}, options = {}) =>
    observe(
      name,
      typeof fields === "function"
        ? fields
        : { chat: "chat", protectedInput, ...fields },
      { op: "native-command-gui-acquire", shape: "gui", ...options },
    );
  const context = async () =>
    observe(
      "capture actual GUI placement",
      { chat: "chat" },
      { op: "chat-context", shape: "raw" },
    );
  async function unchanged(name, run) {
    const before = await snapshot("before " + name);
    await run();
    assert.deepEqual(await snapshot("unchanged " + name), before, name);
  }
  await reset();
  const before = await context();
  await runTurnConfigurationCases({ observe, contexts: before });
  await runProtectInputCases({ observe });
  await unchanged("missing endpoint-protected input", () =>
    acquire(
      "unencrypted managed input refused",
      { protectedInput: null },
      { error: true },
    ),
  );
  const initial = await acquire("native GUI admission owns a real lane");
  const expected =
    "gui:" +
    createHash("sha256")
      .update(JSON.stringify([owner, "chat", protectedInput.idempotencyKey]))
      .digest("hex");
  const digest = createHash("sha256")
    .update(JSON.stringify(protectedInput))
    .digest("hex");
  for (const value of initial) {
    assert.equal(value.nativeCommandReceipt.operationId, expected);
    assert.equal(value.nativeCommandReceipt.payloadDigest, digest);
    assert.equal(
      value.nativeCommandReceipt.executionLaneId,
      value.execution.executionLaneId,
    );
  }
  await snapshot("GUI native command lane and generation committed together");
  await unchanged("same GUI submission does not execute twice", () =>
    acquire("GUI native replay is refused", {}, { error: true }),
  );
  await unchanged("changed payload cannot reuse GUI operation identity", () =>
    acquire(
      "GUI payload mismatch",
      {
        protectedInput: {
          ...protectedInput,
          id: "456789ab-1234-4234-8234-000000000003",
        },
      },
      { error: true, code: "operation-id-conflict" },
    ),
  );
  await reset();
  await acquire("GUI preserves explicit actor and purpose", {
    options: {
      acquiringActor: "fixture-actor",
      purpose: "Protected GUI submission",
    },
  });
  const actor = await snapshot("GUI lane actor and purpose are durable");
  for (const state of actor) {
    assert.equal(state.lanes[0].acquiring_actor, "fixture-actor");
    assert.equal(state.lanes[0].purpose, "Protected GUI submission");
  }
  await reset();
  await seed("UPDATE chats SET managed_input_revision=7 WHERE id='chat'");
  const stale = await context();
  await acquire(
    "explicit remembered input revision wins over current context",
    (i) => ({
      chat: "chat",
      context: stale[i],
      protectedInput,
      options: { expectedInputRevision: 6 },
    }),
    { error: true, code: "cancelled-before-admission" },
  );
  const rejected = await snapshot(
    "stale revision retains immutable rejection without a lane",
  );
  for (const state of rejected) {
    assert.equal(state.lanes, null);
    assert.equal(state.commands[0].status, "rejected");
  }
  await reset();
  const old = await context();
  await seed(
    "UPDATE chats SET active_worker_id='beta',active_worktree_id='github-beta-main' WHERE id='chat'",
  );
  await unchanged("placement changed during GUI preparation", () =>
    acquire(
      "stale GUI placement",
      (i) => ({ chat: "chat", context: old[i], protectedInput }),
      { error: true, code: "stale-placement" },
    ),
  );
  await reset();
  await unchanged("foreign GUI principal", () =>
    acquire(
      "foreign GUI owner",
      (i) => ({ chat: "chat", context: before[i], protectedInput }),
      { requestOwner: otherOwner, error: true, code: "chat-not-found" },
    ),
  );
  for (const idempotencyKey of [
    "emoji-🦀",
    "raw-\ud800-\udfff",
    "0",
    "e\u0301",
  ]) {
    await reset();
    await acquire("GUI UTF16 identity " + JSON.stringify(idempotencyKey), {
      protectedInput: { ...protectedInput, idempotencyKey },
    });
    await snapshot("exact GUI digest " + JSON.stringify(idempotencyKey));
  }
  await reset();
  await seed(
    "UPDATE projects SET worktree_policy='required-for-writes' WHERE id='github'",
  );
  await acquire("primary GUI admission inherits read-only permission fence");
  await snapshot("effective GUI permission is captured in native intent");
  for (const chat of ["task", standalone]) {
    await reset();
    const values = await acquire("legacy execution path " + chat, {
      chat,
      protectedInput: null,
    });
    for (const value of values) {
      assert.equal(Object.hasOwn(value, "nativeCommandReceipt"), false);
      assert.ok(value.execution.executionLaneId);
    }
    const states = await snapshot(
      "legacy lane has no invented native receipt " + chat,
    );
    for (const state of states) assert.equal(state.commands, null);
  }
  await reset();
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('queue-model',${literal(owner)},'Queued GUI fixture') ON CONFLICT DO NOTHING`,
  );
  await observe(
    "persist the actual encrypted GUI queue input",
    { action: "create-encrypted", chat: "chat", content: retainedPrompt() },
    { op: "native-command-prompt-run", shape: "raw" },
  );
  const claimId = "explicit-gui-claim";
  const claims = await observe(
    "claim the exact retained GUI input",
    {
      action: "claim-item",
      chat: "chat",
      prompt: promptId,
      revision: 0,
      claimId,
    },
    { op: "native-command-managed-queue-run", shape: "raw" },
  );
  const queued = await acquire(
    "GUI admission binds its exact queue claim",
    (i) => ({
      chat: "chat",
      protectedInput,
      options: {
        managedQueueClaim: {
          id: claims[i].id,
          promptRevision: claims[i].promptRevision,
        },
      },
    }),
  );
  const queueOperation =
    "gui:" +
    createHash("sha256")
      .update(
        JSON.stringify([owner, "chat", protectedInput.idempotencyKey, claimId]),
      )
      .digest("hex");
  for (const value of queued)
    assert.equal(value.nativeCommandReceipt.operationId, queueOperation);
  const queueState = await snapshot(
    "queue claim and real GUI operation share one committed generation",
  );
  for (const [i, value] of queueState.entries()) {
    assert.equal(
      value.claims[0].operation_id,
      queued[i].nativeCommandReceipt.operationId,
    );
    assert.equal(
      value.claims[0].operation_generation,
      queued[i].nativeCommandReceipt.operationGeneration,
    );
    assert.equal(value.queueInputs[0].claim_id, claimId);
  }
  await unchanged("GUI queue claim replay", () =>
    acquire(
      "GUI queue claim replay refuses duplicate input",
      (i) => ({
        chat: "chat",
        protectedInput,
        options: {
          managedQueueClaim: {
            id: claims[i].id,
            promptRevision: claims[i].promptRevision,
          },
        },
      }),
      { error: true },
    ),
  );
  await reset();
  await seed(`UPDATE chats SET updated_at=${literal(stamp)} WHERE id='chat'`);
  const missing = before.map((v) => ({ ...v, chatId: "missing" }));
  await unchanged("missing GUI chat", () =>
    acquire(
      "missing GUI chat",
      (i) => ({ chat: "missing", context: missing[i], protectedInput }),
      { error: true, code: "chat-not-found" },
    ),
  );
  await runReceiptHandlerCases(h);
  await runTurnPlacementCases(h);
  await runTurnBehaviorCases(h);
  await runGuiTelemetryCases(h);
  await runTurnLiveCases(h);
  await runTaskDispatchLeaseCases(h);
  await runTurnBootstrapCases(h);
  await runTurnExecutionCases(h);
  await runAutomaticTitleCases(h);
  await runRecoveryCases(h);
  await runNativeHandoffCases(h);
  await runAccountFailoverCases(h);
}
