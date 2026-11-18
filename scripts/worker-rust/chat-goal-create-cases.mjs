import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  nativeCommandAdmissionSchema,
  nativeCommandDispatchSchema,
  nativeCommandReceiptSchema,
  nativeCommandSettlementSchema,
} from "../../packages/protocol/dist/index.js";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../../cantrip_worker/src/native-command-content.ts";

export async function verifyChatGoalCreate({
  ensure,
  expectThread,
  expectSuccess,
  withSavedCodex,
  start,
  stop,
  modelCalls,
  attach,
  oracle,
  workerId,
  generation,
  provider,
}) {
  await start();
  const before = modelCalls();
  const create = { type: "chat.goal.create", provider, tokenBudget: 5000 };
  const host = {
    ...create,
    chatId: randomUUID(),
    objective: "Retain a local goal.",
  };
  const local = (await expectSuccess(host)).goal;
  assert.equal(local.objective, host.objective);
  assert.equal(local.tokenBudget, host.tokenBudget);
  assert.equal(local.status, "active");
  assert.equal(
    modelCalls(),
    before,
    "Creating the host Goal must wait for Core input.",
  );
  const localRead = {
    ...host,
    type: "chat.goal.get",
    threadId: local.threadId,
  };

  const session = {
    contextKind: "project",
    chatId: randomUUID(),
    computerUseEnabled: false,
    projectId: randomUUID(),
    worktreeId: randomUUID(),
    rootKind: "folder-root",
    scratchRootId: null,
  };
  const { threadId } = await expectThread({ session, provider });
  const goal = { ...create, chatId: session.chatId, threadId, session };
  const first = {
    ...goal,
    operationId: "gui-goal:" + randomUUID(),
    objective: "Preserve the managed objective.",
  };
  const second = {
    ...goal,
    operationId: "gui-goal:" + randomUUID(),
    objective: "Replace the completed managed objective.",
    tokenBudget: null,
  };
  const set = ({ objective, tokenBudget }) => ({
    method: "thread/goal/set",
    params: { threadId, objective, tokenBudget, status: "active" },
  });
  const expected = new Map([
    [first.operationId, set(first)],
    [
      second.operationId + ":clear",
      { method: "thread/goal/clear", params: { threadId } },
    ],
    [second.operationId, set(second)],
  ]);
  const operations = new Map();
  const phases = [];
  attach(async (phase, body, _response, send) => {
    phases.push([body.operationId, phase]);
    assert.equal(body.workerId, workerId);
    const style = expected.get(body.operationId);
    assert.ok(style, "unexpected Goal operation");
    const crypto = (direction) => ({
      service: oracle,
      context: {
        chatId: session.chatId,
        operationId: body.operationId,
        direction,
      },
    });
    if (phase === "admit") {
      const request = nativeCommandAdmissionSchema.parse(body);
      assert.equal(request.intent.workerGeneration, generation());
      assert.equal(request.origin, "gui");
      assert.equal(request.expectedActivationGeneration, null);
      assert.equal(request.method, style.method);
      assert.equal(request.session.chatId, session.chatId);
      assert.equal(request.session.threadId, threadId);
      assert.equal(request.session.projectId, session.projectId);
      assert.equal(request.session.placementId, session.worktreeId);
      assert.equal(request.intent.goalStatus, style.params.status);
      assert.equal(
        request.intent.resumeAutonomy,
        style.params.status ? true : undefined,
      );
      const content = await openNativeCommandContent({
        ...crypto("request"),
        envelope: request.protectedPayload,
      });
      assert.deepEqual(content, { id: request.operationId, ...style });
      assert.equal(
        (await protectNativeCommandContent({ ...crypto("request"), content }))
          .digest,
        request.payloadDigest,
      );
      const existing = operations.get(request.operationId);
      if (existing) {
        assert.equal(existing.receipt.payloadDigest, request.payloadDigest);
        send({
          receipt: existing.receipt,
          execution: null,
          computerUseAuthority: null,
          replayed: true,
        });
        return;
      }
      const stamp = new Date().toISOString();
      const receipt = nativeCommandReceiptSchema.parse({
        operationId: request.operationId,
        operationGeneration: randomUUID(),
        activationGeneration: null,
        chatId: session.chatId,
        startsExecution: false,
        executionLaneId: null,
        status: "accepted",
        method: request.method,
        payloadDigest: request.payloadDigest,
        rejectionCode: null,
        threadId,
        createdAt: stamp,
        updatedAt: stamp,
      });
      operations.set(request.operationId, {
        session: request.session,
        receipt,
      });
      send({ receipt, execution: null, computerUseAuthority: null });
      return;
    }
    const operation = operations.get(body.operationId);
    const { receipt } = operation;
    assert.equal(body.operationGeneration, receipt.operationGeneration);
    if (phase === "dispatch") {
      const request = nativeCommandDispatchSchema.parse(body);
      assert.equal(receipt.status, "accepted");
      assert.equal(request.workerGeneration, generation());
      assert.equal(request.payloadDigest, receipt.payloadDigest);
      assert.deepEqual(request.session, operation.session);
      receipt.status = "dispatched";
      send({ receipt, execution: null, computerUseAuthority: null });
      return;
    }
    assert.equal(phase, "receipt");
    assert.equal(receipt.status, "dispatched");
    const result = nativeCommandSettlementSchema.parse(body);
    assert.equal(result.status, "applied");
    assert.equal(result.executionComplete, false);
    const content = await openNativeCommandContent({
      ...crypto("result"),
      envelope: result.protectedResult,
    });
    assert.equal(
      (await protectNativeCommandContent({ ...crypto("result"), content }))
        .digest,
      result.resultDigest,
    );
    operation.result = content;
    receipt.status = "applied";
    send({ receipt });
  });
  try {
    const created = await expectSuccess(first);
    assert.equal(created.goal.objective, first.objective);
    assert.equal(created.goal.tokenBudget, first.tokenBudget);
    assert.equal(created.goal.threadId, threadId);
    const firstNative = operations.get(first.operationId).result;
    assert.deepEqual(firstNative.goal, created.goal);
    assert.ok(firstNative.goalEpoch.startsWith(threadId + ":"));
    const duplicate = await ensure(first);
    assert.equal(duplicate.ok, false, JSON.stringify(duplicate));
    assert.match(duplicate.error.message, /cannot be replayed/);

    await stop();
    await withSavedCodex(async (request) => {
      const completed = await request("thread/goal/set", {
        threadId,
        status: "complete",
      });
      assert.equal(completed.goal.status, "complete");
    });
    await start();
    assert.deepEqual(await expectSuccess(localRead), { goal: local });
    const updatedHost = (
      await expectSuccess({
        ...host,
        threadId: local.threadId,
        objective: "Update the retained local goal.",
        tokenBudget: null,
      })
    ).goal;
    assert.equal(updatedHost.threadId, local.threadId);
    assert.equal(updatedHost.createdAt, local.createdAt);
    assert.equal(updatedHost.objective, "Update the retained local goal.");
    assert.equal(updatedHost.tokenBudget, null);
    const replaced = await expectSuccess(second);
    assert.equal(replaced.goal.objective, second.objective);
    assert.equal(replaced.goal.tokenBudget, null);
    assert.equal(replaced.goal.status, "active");
    assert.deepEqual(operations.get(second.operationId + ":clear").result, {
      cleared: true,
    });
    const replacement = operations.get(second.operationId).result;
    assert.deepEqual(replacement.goal, replaced.goal);
    assert.ok(replacement.goalEpoch.startsWith(threadId + ":"));
    assert.notEqual(replacement.goalEpoch, firstNative.goalEpoch);
    assert.deepEqual(phases, [
      [first.operationId, "admit"],
      [first.operationId, "dispatch"],
      [first.operationId, "receipt"],
      [first.operationId, "admit"],
      [second.operationId + ":clear", "admit"],
      [second.operationId + ":clear", "dispatch"],
      [second.operationId + ":clear", "receipt"],
      [second.operationId, "admit"],
      [second.operationId, "dispatch"],
      [second.operationId, "receipt"],
    ]);
    assert.equal(modelCalls(), before);
    await stop();
  } finally {
    attach(undefined);
  }
  console.log(
    "Created and reopened an ordinary host Goal, fenced managed replay, and replaced a completed managed Goal through separate receipts.",
  );
}
