import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  nativeCommandAdmissionSchema,
  nativeCommandDispatchSchema,
  nativeCommandReceiptSchema,
  nativeCommandSettlementSchema,
} from "../../packages/protocol/dist/index.js";
import { createManagedQueueInputCodec } from "../../tests/reference-node-worker/src/managed-queue-input.ts";
import { managedQueueNativeCommand } from "../../tests/reference-node-worker/src/codex/managed-queue-command.ts";
import { openNativeCommandContent } from "../../tests/reference-node-worker/src/native-command-content.ts";
import { GuiHistoryPeer } from "./gui-history-cases.mjs";
import { GuiReceiptPeer } from "./gui-receipt-cases.mjs";

export async function verifyQueuedShell(options) {
  await runQueuedShell(options, "completed");
  await runQueuedShell(options, "interrupted");
  console.log(
    "Queued shell command ran in Codex with exact input, early acknowledgment, scoped Stop, protected terminal retry and saved History.",
  );
}

async function runQueuedShell(
  {
    start,
    stop,
    request,
    expectThread,
    expectSuccess,
    available,
    modelCalls,
    attach,
    workerId,
    generation,
    provider,
    directory,
    root,
    oracle,
    stamp,
  },
  terminalStatus,
) {
  await start();
  const session = {
    contextKind: "project",
    chatId: randomUUID(),
    computerUseEnabled: false,
    projectId: randomUUID(),
    worktreeId: randomUUID(),
    rootKind: "folder-root",
    scratchRootId: null,
  };
  const permissionProfileId = ":yolo";
  const { threadId } = await expectThread({
    session,
    provider,
    permissionProfileId,
  });
  const codec = createManagedQueueInputCodec({
    chatId: session.chatId,
    encryption: oracle,
    defaults: () => ({
      modelId: "gpt-5",
      mode: "default",
      reasoningEffort: null,
    }),
  });
  const entered = "queued-shell-entered-" + terminalStatus;
  const released = "queued-shell-release-" + terminalStatus;
  const contents = "quoted | shell";
  // The bounded fixture makes one local workspace write and waits for the
  // caller to release it after the acknowledgment.
  const program = `printf '%s\\n' '${contents}' > '${entered}'
attempt=0
while test ! -f '${released}' && test "$attempt" -lt 100; do
  attempt=$((attempt + 1))
  sleep 0.1
done
printf '%s\\n' '${contents}'`;
  const { prompt } = await codec.preparePrompt({
    id: randomUUID(),
    request: {
      method: "thread/queue/add",
      params: {
        threadId,
        input: [{ type: "text", text: "!" + program }],
      },
    },
  });
  const expected = await managedQueueNativeCommand({
    opened: await codec.openNativeInput({
      promptId: prompt.id,
      payload: prompt.protectedNativeInput,
      text: "!" + program,
      attachmentIds: [],
    }),
    threadId,
    promptId: prompt.id,
    codexHome: directory,
  });
  assert.equal(expected.method, "thread/shellCommand");
  const queueClaim = { id: randomUUID(), promptRevision: 2 };
  const operationId = "queue:" + queueClaim.id;
  const command = {
    type: "chat.queue.execute",
    chatId: session.chatId,
    threadId,
    session,
    provider,
    permissionProfileId,
    subagentDefaults: null,
    queuedPromptId: prompt.id,
    queueClaim,
    nativeAction: prompt.nativeAction,
    executionMethod: prompt.executionMethod,
    protectedPrompt: prompt.pendingMessage,
    protectedNativeInput: prompt.protectedNativeInput,
  };
  const dispatchRequested = Promise.withResolvers();
  const dispatchGranted = Promise.withResolvers();
  const terminalObserved = Promise.withResolvers();
  const boundTurn = Promise.withResolvers();
  const steps = [];
  let receipt, admitted, execution, history, controls, terminal, turnId;
  const open = (direction, envelope) =>
    openNativeCommandContent({
      service: oracle,
      context: { chatId: session.chatId, operationId, direction },
      envelope,
    });
  const handler = async (phase, body, response, send) => {
    assert.equal(body.workerId, workerId);
    if (body.operationId !== operationId) {
      assert.equal(terminalStatus, "interrupted");
      await controls.applyControl(phase, body, response, send);
      return;
    }
    if (phase === "admit") {
      if (terminal) {
        send({
          receipt,
          replayed: true,
          execution: null,
          computerUseAuthority: null,
        });
        return;
      }
      admitted = nativeCommandAdmissionSchema.parse(body);
      assert.equal(admitted.method, expected.method);
      assert.deepEqual(admitted.queueClaim, queueClaim);
      assert.equal(admitted.expectedActivationGeneration, null);
      assert.equal(admitted.intent.permissionProfileId, permissionProfileId);
      assert.equal(admitted.intent.workerGeneration, generation());
      assert.equal(admitted.session.threadId, threadId);
      assert.deepEqual(await open("request", admitted.protectedPayload), {
        id: operationId,
        method: expected.method,
        params: expected.params,
      });
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
      receipt = nativeCommandReceiptSchema.parse({
        operationId,
        operationGeneration: randomUUID(),
        logicalOperationId: operationId,
        chatId: session.chatId,
        activationGeneration: randomUUID(),
        executionLaneId: execution.executionLaneId,
        startsExecution: true,
        status: "accepted",
        method: expected.method,
        payloadDigest: admitted.payloadDigest,
        rejectionCode: null,
        threadId,
        createdAt: stamp,
        updatedAt: stamp,
      });
      history = new GuiHistoryPeer({
        fields: {
          chatId: session.chatId,
          policyProjectId: session.projectId,
          worktreeId: session.worktreeId,
          protectedPrompt: prompt.pendingMessage,
        },
        receipt,
        workerId,
        stamp,
        oracle,
      });
      attach(handler, history);
      steps.push("admit");
      send({ receipt, execution, computerUseAuthority: null });
      return;
    }
    if (phase === "dispatch") {
      const input = nativeCommandDispatchSchema.parse(body);
      assert.equal(input.operationGeneration, receipt.operationGeneration);
      assert.deepEqual(input.session, admitted.session);
      assert.equal(input.payloadDigest, admitted.payloadDigest);
      assert.equal(input.workerGeneration, generation());
      assert.equal(receipt.status, "accepted");
      steps.push("dispatch");
      dispatchRequested.resolve();
      await dispatchGranted.promise;
      receipt.status = "dispatched";
      send({ receipt, execution, computerUseAuthority: null });
      return;
    }
    assert.equal(phase, "receipt");
    const input = nativeCommandSettlementSchema.parse(body);
    assert.equal(input.operationGeneration, receipt.operationGeneration);
    assert.equal(input.status, "applied");
    if (input.protectedResult) {
      assert.equal(receipt.status, "dispatched");
      const acceptance = await open("result", input.protectedResult);
      assert.deepEqual(acceptance, { result: {} });
      assert.ok(!input.executionComplete);
      steps.push("acknowledge");
      receipt.status = "applied";
    } else if (!input.executionComplete) {
      assert.equal(receipt.status, "applied");
      assert.equal(
        input.reconciliation.runtimeGeneration,
        admitted.session.runtimeGeneration,
      );
      turnId = input.reconciliation.nativeTurnId;
      assert.ok(turnId);
      controls = new GuiReceiptPeer({ permissionProfileId }, receipt, {
        oracle,
        workerGeneration: generation(),
        workerId,
        durable: false,
      });
      controls.session = admitted.session;
      controls.rootAcknowledged = true;
      controls.result = input;
      steps.push("bind turn");
      boundTurn.resolve();
    } else {
      assert.equal(input.reconciliation.nativeTurnId, turnId);
      assert.equal(
        input.reconciliation.runtimeGeneration,
        admitted.session.runtimeGeneration,
      );
      assert.equal(input.reconciliation.terminalStatus, terminalStatus);
      assert.equal(input.executionStatus, "idle");
      if (!terminal) {
        terminal = input;
        // Lose the first acknowledgment to require the same receipt bytes.
        response.destroy();
        return;
      }
      assert.deepEqual(input, terminal);
      const result = await open(
        "terminal-result",
        input.terminalResult.protectedResult,
      );
      if (terminalStatus === "completed") {
        assert.equal(result.turnId, turnId);
        assert.equal(result.threadId, threadId);
        assert.equal(result.status, "completed");
      } else {
        assert.deepEqual(result, { interrupted: true });
      }
      steps.push("complete");
      terminalObserved.resolve();
    }
    send({ receipt });
  };
  attach(handler);
  try {
    const before = modelCalls();
    assert.match(
      (await request({ ...command, permissionProfileId: ":read-only" })).error
        .message,
      /authorized full-access profile/,
    );
    assert.equal(
      (await request({ ...command, queuedPromptId: randomUUID() })).ok,
      false,
    );
    assert.deepEqual(steps, []);
    const replied = expectSuccess(command);
    await available(dispatchRequested.promise);
    await assert.rejects(readFile(path.join(root, entered)), {
      code: "ENOENT",
    });
    dispatchGranted.resolve();
    assert.deepEqual(await replied, {});
    await available(boundTurn.promise);
    const signal = AbortSignal.timeout(5000);
    while (true) {
      try {
        assert.equal(
          await readFile(path.join(root, entered), "utf8"),
          contents + "\n",
        );
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await delay(20, undefined, { signal });
      }
    }
    assert.equal(terminal, undefined);
    assert.deepEqual(steps, ["admit", "dispatch", "acknowledge", "bind turn"]);
    if (terminalStatus === "interrupted") {
      const stopCommand = {
        type: "chat.native-control",
        chatId: session.chatId,
        threadId,
        nativeActivationGeneration: receipt.activationGeneration,
        nativeRuntimeGeneration: admitted.session.runtimeGeneration,
        modelRouteId: admitted.session.modelRouteId,
        providerAccountId: null,
        control: { kind: "interrupt" },
      };
      assert.equal(
        (
          await request({
            ...stopCommand,
            nativeActivationGeneration: randomUUID(),
          })
        ).ok,
        false,
      );
      assert.equal(controls.controls.size, 0);
      assert.deepEqual(await expectSuccess(stopCommand), { interrupted: true });
      assert.equal(controls.controls.size, 1);
    } else {
      await writeFile(path.join(root, released), "");
    }
    await available(terminalObserved.promise);
    assert.equal(modelCalls(), before);
    const replay = await request(command);
    assert.match(replay.error.message, /already has a receipt/);
    assert.deepEqual(steps, [
      "admit",
      "dispatch",
      "acknowledge",
      "bind turn",
      "complete",
    ]);
    await stop();
    const records = await history.verifyLocalSource(directory, turnId);
    if (terminalStatus === "completed")
      assert.ok(
        records.some(
          ({ frame }) =>
            frame.method === "item/completed" &&
            frame.params.turnId === turnId &&
            frame.params.item.type === "commandExecution" &&
            frame.params.item.aggregatedOutput.includes(contents),
        ),
        "The Node journal reader recovers the native shell output.",
      );
  } finally {
    dispatchGranted.resolve();
    await writeFile(path.join(root, released), "");
    attach();
  }
}
