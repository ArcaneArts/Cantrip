import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  decryptPrivateDisplayLabel,
  decryptTaskProtectedContent,
} from "../../packages/crypto/dist/index.js";
import { taskProtectedClassificationSchema } from "../../packages/protocol/dist/index.js";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";

export async function verifyManagedMcpTasks({
  call,
  eventually,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  taskKey,
  startWorker,
  stopWorker,
  serverDiagnostics,
}) {
  const { profile, model } = await createModel("Managed MCP Task fixture");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
    autoNameTasks: false,
  });
  const { chatUrl, chatId, projectUrl } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Managed MCP Task caller",
  });
  const pauseUrl = `${projectUrl}/tasks/pause`;
  async function pauseTasks(paused) {
    const { rowVersion } = await call("GET", pauseUrl, 200);
    const state = await call("PATCH", pauseUrl, paused ? 200 : 202, {
      paused,
      rowVersion,
    });
    assert.equal(state.paused, paused);
  }
  await pauseTasks(true);
  const tools = (request) =>
    modelFunctions([
      ...request.input.tools,
      ...request.input.input
        .filter((item) => item.type === "tool_search_output")
        .flatMap((item) => item.tools),
    ]);
  async function invoke(name, args, error) {
    model.reply({ toolSearch: { query: name } });
    const invocation = model.reply({ hold: true });
    const answer = model.reply({ text: `Finished the ${name} fixture.` });
    try {
      await call(
        "POST",
        chatUrl + "/turns",
        202,
        await encryptedTurn(`Call ${name} once.`, profile.id),
      );
      await eventually(
        () => invocation.request,
        (request) => assert.ok(request, "The Codex tool search must finish."),
      );
      const tool = tools(invocation.request).find(
        ({ name: found }) => found === name || found.endsWith("__" + name),
      );
      assert.ok(tool, `Codex can discover ${name} in the managed attachment.`);
      invocation.calls = [{ ...tool, arguments: args }];
      invocation.release();
      await eventually(
        () => answer.request,
        (request) => assert.equal(request?.completed, true),
      );
      const raw = answer.request.input.input
        .filter((item) => item.type === "function_call_output")
        .at(-1)?.output;
      const output =
        typeof raw === "string" ? raw : raw?.map(({ text }) => text).join("\n");
      assert.ok(output, JSON.stringify(answer.request.input.input));
      await eventually(
        () => call("GET", projectUrl + "/chats", 200),
        (chats) =>
          assert.equal(
            chats.find((chat) => chat.id === chatId)?.status,
            "idle",
          ),
      );
      if (error) {
        assert.match(output, error);
        return;
      }
      const boundary = "\nOutput:\n";
      assert.ok(output.includes(boundary), output);
      return JSON.parse(
        output.slice(output.indexOf(boundary) + boundary.length),
      );
    } finally {
      invocation.release();
    }
  }

  const read = await invoke("task_list", {});
  assert.deepEqual(read.data.tasks, []);
  const title = "Private delegated Task title 🌲";
  const description = "Private delegated Task brief 🧭";
  const operationId = randomUUID();
  const create = { title, description, operationId };
  const created = await invoke("task_create", create);
  const { taskId } = created.data;
  assert.equal(created.data.operationId, operationId);
  assert.equal(created.mutated, true);
  assert.equal(created.data.tasks[0].title, title);
  assert.equal(created.data.tasks[0].configuration.modelId, profile.id);
  assert.equal((await invoke("task_create", create)).data.taskId, taskId);
  const listed = await invoke("task_list", {});
  assert.deepEqual(
    listed.data.tasks.map(({ id }) => id),
    [taskId],
  );
  assert.equal(listed.data.tasks[0].title, title);
  const missing = randomUUID();
  const status = await invoke("task_status", {
    taskIds: [taskId, missing, taskId, missing],
  });
  assert.deepEqual(
    status.data.tasks.map(({ id }) => id),
    [taskId],
  );
  assert.deepEqual(status.data.missingTaskIds, [missing]);
  const timeout = await invoke("task_wait", {
    taskIds: [taskId],
    timeoutMs: 50,
  });
  assert.equal(timeout.data.satisfied, false);
  assert.equal(timeout.data.timedOut, true);
  await invoke("task_wait", { taskIds: [chatId] }, /cannot wait for itself/u);

  const taskUrl = `/api/tasks/${taskId}`;
  const queued = await call("GET", taskUrl, 200);
  assert.equal(queued.dispatch.state, "queued");
  assert.equal(queued.planGoalEnabled, false);
  const publicClassification = Object.fromEntries(
    Object.keys(taskProtectedClassificationSchema.shape).map((field) => [
      field,
      queued[field],
    ]),
  );
  const opened = await decryptTaskProtectedContent({
    ownerId,
    chatId: taskId,
    keyRevision,
    componentKey: taskKey,
    encrypted: queued.protectedContent,
    publicClassification,
  });
  assert.equal(opened.briefMarkdown, description);
  const chats = await call("GET", projectUrl + "/chats", 200);
  const task = chats.find(({ id }) => id === taskId);
  assert.equal(
    await decryptPrivateDisplayLabel({
      ownerId,
      recordKind: "chat",
      rowId: taskId,
      keyRevision,
      componentKey: labelKey,
      opaque: task.titleProtection,
    }),
    title,
  );
  for (const marker of [title, description]) {
    assert.ok(!JSON.stringify({ queued, task }).includes(marker));
    assert.ok(!serverDiagnostics().includes(marker));
  }

  const child = model.reply({ text: "The delegated fixture completed." });
  await pauseTasks(false);
  await eventually(
    () => call("GET", taskUrl, 200),
    (task) => assert.equal(task.state, "complete"),
    35_000,
  );
  assert.equal(child.request?.completed, true);
  assert.deepEqual(await stopWorker(), { code: 0, signal: null });
  await startWorker();
  const completed = await invoke("task_wait", {
    taskIds: [taskId, missing],
    mode: "any",
    timeoutMs: 50,
  });
  assert.deepEqual(completed.data.finishedTaskIds, [taskId]);
  assert.equal(completed.data.tasks[0].title, title);
  assert.equal(completed.data.satisfied, true);
  assert.equal(completed.data.timedOut, false);
  assert.deepEqual(model.failures, []);
  console.log(
    JSON.stringify({
      suite: "native-managed-mcp-tasks",
      passed: true,
      nativeTools: true,
      encryptedIdempotentCreation: true,
      scopedStatusAndWait: true,
      completedDelegatedTaskAfterWorkerRestart: true,
    }),
  );
}
