import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { decryptChatMessageProtectedContent } from "../../packages/crypto/dist/index.js";
import {
  managedQueueReadSchema,
  managedQueueSnapshotSchema,
  nativeCommandAdmissionSchema,
  nativeCommandDispatchSchema,
  nativeCommandEventSchema,
  nativeCommandReceiptSchema,
  nativeCommandSettlementSchema,
} from "../../packages/protocol/dist/index.js";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../../cantrip_worker/src/native-command-content.ts";
import { GuiHistoryPeer } from "./gui-history-cases.mjs";

export async function verifyAutonomousGoal({
  expectThread,
  expectSuccess,
  start,
  stop,
  available,
  untilProvider,
  directory,
  root,
  oracle,
  workerId,
  generation,
  modelCalls,
  attach,
  provider,
}) {
  const session = {
    contextKind: "project",
    chatId: randomUUID(),
    computerUseEnabled: false,
    projectId: randomUUID(),
    worktreeId: randomUUID(),
    rootKind: "folder-root",
    scratchRootId: null,
  };
  const permissionProfileId = ":read-only";
  await start();
  const { threadId } = await expectThread({
    session,
    provider,
    permissionProfileId,
  });
  const enter = {
    chatId: session.chatId,
    threadId,
    session,
    provider,
    permissionProfileId,
  };
  const operationId = "gui-goal:" + randomUUID();
  const goalText = "Complete the authorized project Goal fixture.";
  const answers = [
    "The authorized project Goal made progress.",
    "The authorized project Goal is complete.",
  ];
  const cycles = answers.map(() => ({
    dispatch: Promise.withResolvers(),
    terminal: Promise.withResolvers(),
  }));
  const steps = [];
  const messages = [];
  const attempts = new Map();
  const stamp = new Date().toISOString();
  const claim = {
    id: randomUUID(),
    chatId: session.chatId,
    promptId: randomUUID(),
    promptRevision: 2,
    awaitingGoal: true,
    status: "dispatched",
    createdAt: stamp,
    operationId,
    nativeTurnId: null,
  };
  let history;
  let next = 0;
  let settled = 0;

  const queue = (input) => {
    const request = managedQueueReadSchema.parse(input);
    assert.equal(request.workerId, workerId);
    assert.equal(request.session.threadId, threadId);
    assert.equal(request.session.chatId, session.chatId);
    assert.equal(request.session.projectId, session.projectId);
    assert.equal(request.session.placementId, session.worktreeId);
    assert.equal(
      request.session.connectionId,
      "queue-owner:" + request.session.runtimeGeneration,
    );
    assert.ok(
      claim.goalEpoch,
      "The setter receipt must settle before queue read.",
    );
    steps.push("queue");
    return managedQueueSnapshotSchema.parse({
      revision: 2,
      paused: false,
      items: [],
      claims: [claim],
    });
  };
  const answer = (body) => {
    if (next === 1) return answers[0];
    if (
      body.input.some(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === "complete-project-goal",
      )
    )
      return answers[1];
    const tool = body.tools
      .flatMap((tool) => tool.tools ?? [tool])
      .find(
        ({ name }) => name === "update_goal" || name?.endsWith("__update_goal"),
      );
    assert.ok(tool, "The active Goal must expose native completion.");
    return {
      name: tool.name,
      call_id: "complete-project-goal",
      arguments: JSON.stringify({ status: "complete" }),
    };
  };
  const attachCurrent = () => attach({ queue, commands, history, answer });
  async function commands(phase, body, response, send) {
    assert.equal(body.workerId, workerId);
    const unseal = async (direction, envelope, digest) => {
      const context = {
        chatId: session.chatId,
        operationId: body.operationId,
        direction,
      };
      const value = await openNativeCommandContent({
        service: oracle,
        context,
        envelope,
      });
      assert.equal(
        (
          await protectNativeCommandContent({
            service: oracle,
            context,
            content: value,
          })
        ).digest,
        digest,
      );
      return value;
    };
    if (phase === "admit") {
      const request = nativeCommandAdmissionSchema.parse(body);
      assert.equal(request.session.threadId, threadId);
      assert.equal(request.intent.workerGeneration, generation());
      const frame = await unseal(
        "request",
        request.protectedPayload,
        request.payloadDigest,
      );
      const autonomous = request.origin === "autonomous";
      let execution = null;
      let ordinal;
      if (autonomous) {
        ordinal = next++;
        assert.ok(
          cycles[ordinal],
          "The completed Goal must stop requesting turns.",
        );
        assert.equal(
          settled,
          ordinal,
          "A new Goal cycle overtook its previous receipt.",
        );
        assert.deepEqual(steps.slice(-1), ["queue"]);
        assert.equal(request.method, "turn/start");
        assert.equal(
          request.intent.autonomousAttempt.goalEpoch,
          claim.goalEpoch,
        );
        const { runnerGeneration, attemptId, turnId } =
          request.intent.autonomousAttempt;
        assert.equal(
          request.operationId,
          "native:" + runnerGeneration + ":" + attemptId,
        );
        assert.equal(
          request.session.connectionId,
          "autonomous:" + runnerGeneration,
        );
        assert.equal(request.intent.expectedTurnId, turnId);
        assert.deepEqual(
          request.goalQueueHandoff,
          ordinal === 0
            ? {
                claimId: claim.id,
                operationId,
                operationGeneration: claim.operationGeneration,
                goalEpoch: claim.goalEpoch,
              }
            : undefined,
        );
        assert.equal(frame.method, "turn/start");
        assert.deepEqual(frame.params, { threadId });
        assert.equal(frame.nativeAttempt.threadId, threadId);
        assert.equal(frame.nativeAttempt.turnId, turnId);
        steps.push("admit " + ordinal);
        execution = {
          ...session,
          workerId,
          threadId,
          executionLaneId: randomUUID(),
          cwd: root,
          experience: "agent",
          status: "running",
          automationPaused: false,
          isPrimary: true,
          modelId: "gpt-5",
          reasoningEffort: null,
          modelRouteId: "fixture-route",
          providerAccountId: null,
          permissionProfileId,
          modelConfiguration: { modelId: "gpt-5" },
          planMode: "default",
          worktreeMode: "agent-managed",
          worktreePolicy: "direct",
        };
      } else {
        assert.equal(request.operationId, operationId);
        assert.equal(request.method, "thread/goal/set");
        assert.equal(frame.params.objective, goalText);
        steps.push("setter");
      }
      const receipt = nativeCommandReceiptSchema.parse({
        operationId: request.operationId,
        operationGeneration: randomUUID(),
        chatId: session.chatId,
        activationGeneration: autonomous ? randomUUID() : null,
        executionLaneId: execution?.executionLaneId ?? null,
        startsExecution: autonomous,
        status: "accepted",
        method: request.method,
        payloadDigest: request.payloadDigest,
        rejectionCode: null,
        threadId,
        createdAt: stamp,
        updatedAt: stamp,
      });
      attempts.set(request.operationId, {
        request,
        receipt,
        execution,
        ordinal,
      });
      if (autonomous && !history) {
        history = new GuiHistoryPeer({
          fields: {
            chatId: session.chatId,
            policyProjectId: session.projectId,
            worktreeId: session.worktreeId,
            protectedPrompt: { id: "not-a-gui-input" },
          },
          receipt,
          workerId,
          stamp,
          oracle,
        });
        attachCurrent();
      }
      send({ receipt, execution, computerUseAuthority: null });
      return;
    }
    const state = attempts.get(body.operationId);
    assert.ok(state);
    const { receipt, request, execution, ordinal } = state;
    assert.equal(body.operationGeneration, receipt.operationGeneration);
    if (phase === "dispatch") {
      const input = nativeCommandDispatchSchema.parse(body);
      assert.equal(input.workerGeneration, generation());
      assert.deepEqual(input.session, request.session);
      assert.equal(input.payloadDigest, receipt.payloadDigest);
      receipt.status = "dispatched";
      if (receipt.startsExecution) {
        steps.push("dispatch " + ordinal);
        cycles[ordinal].dispatch.resolve(() =>
          send({ receipt, execution, computerUseAuthority: null }),
        );
        return;
      }
      send({ receipt, execution, computerUseAuthority: null });
      return;
    }
    if (phase === "events") {
      const { event } = nativeCommandEventSchema.parse(body);
      assert.ok(
        answers.every((answer) => !JSON.stringify(event).includes(answer)),
      );
      messages.push(event);
      send({ applied: true });
      return;
    }
    assert.equal(phase, "receipt");
    const result = nativeCommandSettlementSchema.parse(body);
    if (!receipt.startsExecution) {
      assert.equal(result.status, "applied");
      const snapshot = await unseal(
        "result",
        result.protectedResult,
        result.resultDigest,
      );
      claim.goalEpoch = snapshot.goalEpoch;
      claim.operationGeneration = receipt.operationGeneration;
      steps.push("setter committed");
    } else if (!result.executionComplete) {
      assert.equal(result.status, "uncertain");
      assert.deepEqual(
        await unseal("result", result.protectedResult, result.resultDigest),
        { accepted: true },
      );
      steps.push("accepted " + ordinal);
    } else {
      assert.equal(result.status, "applied");
      assert.equal(
        result.reconciliation.nativeTurnId,
        request.intent.expectedTurnId,
      );
      assert.equal(
        result.reconciliation.runtimeGeneration,
        request.session.runtimeGeneration,
      );
      assert.equal(result.reconciliation.terminalStatus, "completed");
      assert.equal(result.executionStatus, "idle");
      const terminal = await unseal(
        "terminal-result",
        result.terminalResult.protectedResult,
        result.terminalResult.resultDigest,
      );
      assert.equal(terminal.text, answers[ordinal]);
      assert.equal(terminal.threadId, threadId);
      assert.equal(terminal.turnId, request.intent.expectedTurnId);
      if (ordinal === 0 && !state.firstTerminal) {
        state.firstTerminal = result;
        response.destroy();
        return;
      }
      if (ordinal === 0) assert.deepEqual(result, state.firstTerminal);
      cycles[ordinal].terminal.resolve({
        terminal,
        acknowledge: () => {
          assert.equal(settled++, ordinal);
          steps.push("completed " + ordinal);
          if (ordinal === 0) {
            claim.status = "consumed";
            claim.goalOperationId = body.operationId;
            claim.goalOperationGeneration = body.operationGeneration;
          }
          receipt.status = result.status;
          send({ receipt });
        },
      });
      return;
    }
    receipt.status = result.status;
    send({ receipt });
  }
  attachCurrent();
  try {
    const before = modelCalls();
    const first = untilProvider();
    const launch = expectSuccess({
      ...enter,
      type: "chat.goal.create",
      operationId,
      objective: goalText,
      tokenBudget: 5000,
    });
    const advance = async (ordinal, pending) => {
      const dispatch = await available(
        Promise.race([
          cycles[ordinal].dispatch.promise,
          pending.then(() =>
            assert.fail("Inference reached the provider before Core dispatch."),
          ),
        ]),
      );
      dispatch();
      return pending;
    };
    assert.equal(modelCalls(), before);
    (await advance(0, first)).finish();
    const firstResult = await available(cycles[0].terminal.promise);
    assert.equal(modelCalls(), before + 1);
    assert.equal(next, 1);
    const second = untilProvider();
    firstResult.acknowledge();
    const end = await advance(1, second);
    const final = untilProvider();
    end.finish();
    (await final).finish();
    const secondResult = await available(cycles[1].terminal.promise);
    secondResult.acknowledge();
    const launched = await launch;
    assert.equal(launched.goal.threadId, threadId);
    const observation = await expectSuccess({
      ...enter,
      type: "chat.goal.get",
    });
    assert.equal(observation.goal.status, "complete");
    assert.equal(modelCalls(), before + 3);
    assert.notEqual(firstResult.terminal.turnId, secondResult.terminal.turnId);
    for (const [ordinal, { terminal }] of [
      firstResult,
      secondResult,
    ].entries()) {
      const assistant = messages.find(
        (event) =>
          event.type === "agent.protected-message" &&
          !event.telemetry.streaming &&
          event.telemetry.turnId === terminal.turnId,
      );
      assert.ok(assistant);
      const { key, keyRevision } = oracle.componentKey("chat-content");
      const content = await decryptChatMessageProtectedContent({
        ownerId: oracle.ownerId(),
        keyRevision,
        componentKey: key,
        messageId: assistant.message.id,
        publicClassification: assistant.message.classification,
        encrypted: assistant.message.protectedContent,
      });
      assert.equal(content.content[0].text, answers[ordinal]);
      assert.ok(
        [...history.identities.values()].some(
          (entry) =>
            entry.messageId === assistant.message.id &&
            entry.identity.turnId === terminal.turnId,
        ),
      );
      const signal = AbortSignal.timeout(5000);
      for (;;) {
        try {
          await history.verifyLocalSource(directory, terminal.turnId);
          break;
        } catch (error) {
          if (error.code !== "ERR_ASSERTION" || signal.aborted) throw error;
          await delay(20, undefined, { signal });
        }
      }
    }
    assert.deepEqual(steps, [
      "setter",
      "setter committed",
      "queue",
      "admit 0",
      "dispatch 0",
      "accepted 0",
      "completed 0",
      "queue",
      "admit 1",
      "dispatch 1",
      "accepted 1",
      "completed 1",
    ]);
    await stop();
  } finally {
    attach();
  }
  console.log(
    "Ran two managed autonomous Project Goal turns through Core dispatch, protected output, canonical History and an exact retried terminal receipt.",
  );
}
