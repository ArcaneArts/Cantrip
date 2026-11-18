import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  decryptTaskGoalObjective,
  decryptTaskMessageProtectedContent,
  decryptTaskProtectedContent,
} from "../../packages/crypto/dist/index.js";
import { taskGoalWorkerResultSchema } from "../../packages/protocol/dist/tasks.js";

export async function verifyTaskGoalActivation({
  command,
  result,
  ownerId,
  key,
  invoke,
  directory,
  modelCalls,
}) {
  const { goal, task } = result.structuredResult;
  const { chatId, worktreeId, provider } = command;
  const threadId = result.threadId;
  const binding = { ownerId, keyRevision: 2, componentKey: key };
  const openObjective = (snapshot, classification) =>
    decryptTaskGoalObjective({
      ...binding,
      chatId,
      threadId,
      encrypted: snapshot.protectedObjective,
      publicClassification: classification,
    });
  const finalized = await openObjective(goal, goal.classification);
  const openMessage = (message) =>
    decryptTaskMessageProtectedContent({
      ...binding,
      messageId: message.id,
      encrypted: message.protectedContent,
      publicClassification: message.classification,
    });
  const plan = (await openMessage(goal.startMessage)).content[0].text;
  const control = {
    id: randomUUID(),
    idempotencyKey: "goal-start-fixture",
    kind: "start",
  };
  const activation = {
    type: "chat.goal.create",
    chatId,
    threadId,
    provider,
    objective: goal,
    tokenBudget: 5000,
    planMode: "default",
    permissionProfileId: ":workspace",
    taskRuntime: {
      projectId: command.policyProjectId,
      worktreeId,
      rootKind: command.rootKind,
      computerUseEnabled: false,
    },
    taskContext: {
      task,
      automationPaused: false,
      chatStatus: "idle",
      message: control,
    },
  };
  const calls = modelCalls();
  const reply = await invoke(activation);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const started = taskGoalWorkerResultSchema.parse(reply.result);
  assert.ok(
    started.goal,
    JSON.stringify(
      await decryptTaskProtectedContent({
        ...binding,
        chatId,
        encrypted: started.task.protectedContent,
        publicClassification: started.task.classification,
      }),
    ),
  );
  const classification = { chatId, threadId, status: "active" };
  const actual = await openObjective(started.goal, classification);
  assert.equal(started.goal.threadId, threadId);
  assert.equal(started.goal.tokenBudget, activation.tokenBudget);
  assert.equal(started.goal.status, "active");
  assert.equal(started.goal.tokensUsed, 0);
  assert.deepEqual(started.task, task);
  assert.equal(started.message.id, control.id);
  assert.equal(started.message.idempotencyKey, control.idempotencyKey);
  assert.deepEqual((await openMessage(started.message)).content, [
    {
      type: "text",
      phase: "final_answer",
      text: "Begin Task Goal:\n\n" + actual.objective,
    },
  ]);
  const captured = actual.objective.match(
    /implementation plan at (".*?") before making changes/u,
  );
  assert.ok(captured, "The active Goal must reference its full private plan.");
  const filename = JSON.parse(captured[1]);
  const relative = path.relative(directory, filename);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
  );
  const digest = createHash("sha256")
    .update(JSON.stringify([chatId, threadId, plan]))
    .digest("hex");
  assert.equal(path.basename(path.dirname(filename)), "task-goal-" + digest);
  assert.equal(await readFile(filename, "utf8"), plan);
  if (process.platform !== "win32")
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.ok(actual.objective.startsWith(finalized.objective + "\n\n"));
  assert.ok(!JSON.stringify(reply).includes(finalized.objective));

  const retry = await invoke(activation);
  assert.equal(retry.ok, true);
  assert.equal(retry.result.goal.createdAt, started.goal.createdAt);
  assert.equal(retry.result.goal.updatedAt, started.goal.updatedAt);
  assert.deepEqual(
    await openObjective(retry.result.goal, classification),
    actual,
  );

  const rejected = await invoke({
    ...activation,
    objective: {
      ...goal,
      classification: { ...goal.classification, threadId: randomUUID() },
    },
  });
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  assert.equal(rejected.result.goal, null);
  const failed = await decryptTaskProtectedContent({
    ...binding,
    chatId,
    encrypted: rejected.result.task.protectedContent,
    publicClassification: rejected.result.task.classification,
  });
  assert.equal(failed.classification.state, "failed");
  assert.equal(failed.classification.stableStateBeforeFailure, "review");
  assert.equal(
    failed.finalPlanMarkdown,
    plan.split("## Final implementation plan\n\n").at(-1),
  );
  assert.equal(
    modelCalls(),
    calls,
    "Goal authorization alone must not start another model request.",
  );
  console.log(
    "Activated the retained Task Goal with an immutable native plan and encrypted reply.",
  );
}
