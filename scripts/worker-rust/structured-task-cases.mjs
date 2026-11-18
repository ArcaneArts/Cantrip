import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  decryptTaskGoalObjective,
  decryptTaskMessageProtectedContent,
  decryptTaskProtectedContent,
  openTaskOperationRelayResult,
} from "../../packages/crypto/dist/index.js";
import {
  taskGoalOutcomeDeliverySchema,
  taskInferenceInputDispatchSchema,
} from "../../packages/protocol/dist/index.js";
import {
  taskPlannerOutputJsonSchema,
  taskFinalizerOutputJsonSchema,
} from "../../packages/protocol/dist/tasks.js";
import { executeEncryptedTaskOperation } from "../../cantrip_worker/src/task-operation.ts";
import { taskTurn } from "./direct-task-cases.mjs";

export async function verifyStructuredTasks({
  taskInputs,
  root,
  ownerId,
  serverId,
  workerId,
  key,
  baseUrl,
  invoke,
  start,
  stop,
  untilProvider,
  available,
  attach,
  diagnostics,
  activate,
}) {
  const binding = { ownerId, keyRevision: 2, componentKey: key };
  const privatePlan = "Private structured plan result 🧪";
  const projectId = randomUUID();
  const worktreeId = randomUUID();
  let threadId = null;
  const cases = [
    [
      "initial-plan",
      {
        planMarkdown: privatePlan,
        questions: [
          {
            id: "plan-scope",
            header: "Scope",
            question: "Which scope should be included?",
            options: [
              {
                id: "all",
                label: "All",
                description: "Include each documented case.",
              },
            ],
            recommendedOptionId: "all",
            allowFreeform: true,
            required: true,
          },
        ],
      },
    ],
    ["continue-plan", { planMarkdown: " ", questions: [] }],
    ["finalize", { finalPlanMarkdown: " ", goalPrompt: " " }],
  ];
  await start();
  for (const [kind, output] of cases) {
    const { operation } = taskInputs[kind];
    const { command, receipt } = taskTurn({
      operation,
      workerId,
      baseUrl,
      providerId: "structured-task-fixture",
      projectId,
      worktreeId,
    });
    const order = [];
    const delivered = Promise.withResolvers();
    const answer = JSON.stringify(output);
    const probe = "planner-write-" + randomUUID();
    const toolCall = "readonly-task-probe";
    const sandboxProbe = kind === "initial-plan";
    const toolResult = (body) =>
      body.input.find(
        ({ type, call_id }) =>
          type === "function_call_output" && call_id === toolCall,
      );
    attach({
      answer: sandboxProbe
        ? (body) =>
            toolResult(body)
              ? answer
              : {
                  name: "exec_command",
                  call_id: toolCall,
                  arguments: JSON.stringify({
                    cmd: "mkdir " + probe,
                    workdir: root,
                  }),
                }
        : answer,
      dispatch: (body, send) => {
        const request = taskInferenceInputDispatchSchema.parse(body);
        assert.deepEqual(request.receipt, receipt);
        assert.equal(
          request.phase,
          ["claim", "dispatch", "native"][order.length],
        );
        order.push(request.phase);
        send({
          receipt,
          nativeExecution: request.nativeExecution,
          nativeRuntimeGeneration: request.nativeRuntimeGeneration,
        });
      },
      outcome: (body, send) => {
        const record = taskGoalOutcomeDeliverySchema.parse(body);
        assert.equal(record.serverId, serverId);
        assert.equal(record.inputKind, "round");
        assert.equal(
          record.notification.taskInferenceInputOperationId,
          receipt.operationId,
        );
        send({
          deliveryId: record.deliveryId,
          taskInferenceInputOperationId: receipt.operationId,
          committed: true,
        });
        delivered.resolve(record.notification.outcome);
      },
    });

    const incoming = untilProvider();
    const events = [];
    const running = invoke(
      { ...command, threadId, permissionProfileId: ":yolo" },
      (event) => events.push(event),
    );
    const model = await available(
      Promise.race([
        incoming,
        running.then((reply) => {
          throw new Error(JSON.stringify(reply) + "\n" + diagnostics());
        }),
      ]),
    );
    assert.deepEqual(order, ["claim", "dispatch", "native"]);
    assert.deepEqual(
      model.body.text.format.schema,
      kind === "finalize"
        ? taskFinalizerOutputJsonSchema
        : taskPlannerOutputJsonSchema,
    );
    if (sandboxProbe) {
      assert.ok(model.body.tools.some((tool) => tool.name === "exec_command"));
      const afterProbe = untilProvider();
      model.finish();
      const second = await available(
        Promise.race([
          afterProbe,
          running.then((reply) => {
            throw new Error(JSON.stringify(reply) + "\n" + diagnostics());
          }),
        ]),
      );
      const observed = toolResult(second.body);
      assert.ok(observed, "Codex did not execute the filesystem probe.");
      assert.match(
        JSON.stringify(observed.output),
        /operation not permitted|permission denied|read.only file system/i,
      );
      await assert.rejects(lstat(path.join(root, probe)), { code: "ENOENT" });
      second.finish();
    } else {
      model.finish();
    }
    const reply = await running;
    assert.equal(reply.ok, true, JSON.stringify(reply) + "\n" + diagnostics());
    assert.equal(reply.result.text, "");
    assert.equal(events.length, 0);
    if (threadId) assert.equal(reply.result.threadId, threadId);
    threadId = reply.result.threadId;
    const outcome = await available(delivered.promise);
    assert.deepEqual(outcome, { ok: true, result: reply.result });

    const reference = await executeEncryptedTaskOperation({
      ownerId,
      getComponentKey: () => ({ key: key.slice(), keyRevision: 2 }),
      request: operation,
      run: ({ prompt, outputSchema }) => {
        assert.ok(
          model.body.input.some(
            (item) =>
              item.role === "user" &&
              item.content?.some(({ text }) => text === prompt),
          ),
        );
        assert.deepEqual(outputSchema, model.body.text.format.schema);
        return Promise.resolve({
          threadId,
          turnId: reply.result.turnId,
          status: "completed",
          text: answer,
          structuredResult: output,
        });
      },
    });
    const open = (result) =>
      openTaskOperationRelayResult({
        ...binding,
        request: operation,
        result: result.structuredResult,
      });
    const opened = await open(reply.result);
    assert.deepEqual(opened, await open(reference));
    assert.ok(
      !JSON.stringify({ reply, events, outcome }).includes(privatePlan),
    );

    if (kind === "finalize") {
      const openGoal = async ({ structuredResult: { goal } }) => {
        const objective = await decryptTaskGoalObjective({
          ...binding,
          chatId: operation.chatId,
          threadId,
          encrypted: goal.protectedObjective,
          publicClassification: goal.classification,
        });
        const startMessage = await decryptTaskMessageProtectedContent({
          ...binding,
          messageId: goal.startMessage.id,
          encrypted: goal.startMessage.protectedContent,
          publicClassification: goal.startMessage.classification,
        });
        const failure = await decryptTaskProtectedContent({
          ...binding,
          chatId: operation.chatId,
          encrypted: goal.failureTask.protectedContent,
          publicClassification: goal.failureTask.classification,
        });
        delete failure.lastError.occurredAt;
        delete failure.classification.lastError.occurredAt;
        return { objective, startMessage, failure };
      };
      assert.deepEqual(await openGoal(reply.result), await openGoal(reference));
      await activate?.({ command, result: reply.result });
    }
  }
  await stop();
  attach();
}
