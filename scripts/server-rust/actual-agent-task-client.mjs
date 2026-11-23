// Existing browser -> Rust/Source -> unchanged full worker -> actual native MCP Task tools.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function actualAgentTaskClient({
  page,
  fixture,
  projectId,
  workerId,
  startWorker,
  stopWorker,
  result,
  requests,
  model,
  chat,
  configuration,
  readMessages,
  idle,
  reply,
}) {
  const toolNames = [];
  function collect(tools, namespace) {
    for (const tool of tools ?? []) {
      if (tool.type === "namespace") collect(tool.tools, tool.name);
      else if (tool.type === "function")
        toolNames.push({
          name: tool.name,
          ...(namespace ? { namespace } : {}),
        });
    }
  }
  collect(reply.request.input.tools);
  result.mcpTaskProbe = {
    actualBrowser: true,
    fullWorker: true,
    actualNativeExecutable: true,
    toolNames,
    calls: [],
    plaintextTaskCreateReached: false,
  };
  const byTool = (name) => {
    const selected = toolNames.find(
      (t) => t.name === name || t.name.endsWith("__" + name),
    );
    assert.ok(selected, "The actual native model request advertises " + name);
    return selected;
  };
  async function invoke(name, arguments_, label) {
    const plan = model.reply({
      calls: [{ ...byTool(name), arguments: arguments_ }],
    });
    const finalText = "Private native MCP Task probe response " + label;
    const final = model.reply({ text: finalText });
    const turn = await page.evaluate(
      async ({ chatId, configuration, label }) =>
        (await import("/src/lib/api/chats.ts")).startTurn(
          chatId,
          "Use the actual Cantrip Task tool once: " + label,
          configuration,
        ),
      { chatId: chat.id, configuration, label },
    );
    assert.equal(turn.status, "queued");
    assert.equal(turn.prompt.chatId, chat.id);
    assert.equal(
      turn.prompt.text,
      "Use the actual Cantrip Task tool once: " + label,
    );
    assert.equal(typeof turn.prompt.id, "string");
    await eventually(readMessages, (messages) =>
      assert.ok(JSON.stringify(messages).includes(finalText)),
    );
    await idle();
    assert.equal(plan.request.completed, true);
    assert.equal(final.request.completed, true);
    const outputs = final.request.input.input.filter(
      (i) => i.type === "function_call_output",
    );
    assert.ok(
      outputs.length > 0,
      "The actual native runtime returns a function-call result",
    );
    const observation = { name, arguments: arguments_, outputs };
    result.mcpTaskProbe.calls.push(observation);
    const rawOutput = outputs.at(-1).output;
    if (typeof rawOutput !== "string")
      assert.ok(
        Array.isArray(rawOutput) &&
          rawOutput.every(
            (v) => v.type === "input_text" && typeof v.text === "string",
          ),
        "Actual native tool output is string or text content",
      );
    const output =
      typeof rawOutput === "string"
        ? rawOutput
        : rawOutput.map((v) => v.text).join("\n");
    const marker = "\nOutput:\n",
      i = output.indexOf(marker);
    assert.ok(
      i >= 0,
      "Actual MCP result includes the native output boundary: " + output,
    );
    observation.rawPayload = output.slice(i + marker.length);
    let value;
    try {
      value = JSON.parse(observation.rawPayload);
    } catch (error) {
      throw new Error(
        "Native " +
          name +
          " did not return successful Task JSON: " +
          observation.rawPayload,
        { cause: error },
      );
    }
    observation.value = value;
    assert.ok(value.data, "Actual worker returns structured Task data");
    return value;
  }
  const empty = await invoke("task_list", {}, "empty list");
  assert.deepEqual(empty.data.tasks, []);
  assert.equal(empty.summary, "Read 0 project Task statuses.");
  await page.evaluate(
    async ({ workerId, projectId }) => {
      const workers = await import("/src/lib/api/worker-wire.ts");
      await (
        await import("/src/lib/task-worker-encryption.ts")
      ).ensureTaskWorkerEncryption({
        worker: (await workers.getWorkers()).find(
          (w) => w.workerId === workerId,
        ),
      });
      const api = await import("/src/lib/api/tasks.ts"),
        state = await api.getProjectTaskPauseState(projectId);
      const paused = await api.setProjectTaskPauseState(projectId, {
        paused: true,
        rowVersion: state.rowVersion,
      });
      if (!paused.paused)
        throw new Error(
          "Actual project Task scheduling pause was not persisted",
        );
    },
    { workerId, projectId },
  );
  const operationId = "eeeeeeee-eeee-4eee-8eee-000000000120";
  const description = "Private full native MCP child description 🍄";
  const title = "Private native MCP child title 🌲";
  const created = await invoke(
    "task_create",
    { description, title, operationId },
    "create encrypted queued Task",
  );
  result.mcpTaskProbe.plaintextTaskCreateReached = true;
  const taskId = created.data.taskId;
  assert.equal(typeof taskId, "string");
  assert.equal(created.data.operationId, operationId);
  assert.equal(created.mutated, true);
  assert.equal(created.data.tasks.length, 1);
  assert.equal(created.data.tasks[0].id, taskId);
  assert.equal(created.data.tasks[0].title, title);
  assert.equal(
    created.data.tasks[0].configuration.modelId,
    configuration.modelId,
  );
  const creationReplay = await invoke(
    "task_create",
    { description, title, operationId },
    "repeat the exact creation operation",
  );
  assert.equal(creationReplay.data.taskId, taskId);
  assert.equal(creationReplay.data.tasks.length, 1);
  const listed = await invoke("task_list", {}, "read the queued child");
  assert.deepEqual(
    listed.data.tasks.map((t) => t.id),
    [taskId],
  );
  assert.equal(listed.data.tasks[0].title, title);
  const missing = "eeeeeeee-eeee-4eee-8eee-000000000121";
  const status = await invoke(
    "task_status",
    { taskIds: [taskId, missing, taskId, missing] },
    "read and deduplicate exact Task IDs",
  );
  assert.deepEqual(
    status.data.tasks.map((t) => t.id),
    [taskId],
  );
  assert.deepEqual(status.data.missingTaskIds, [missing]);
  const waited = await invoke(
    "task_wait",
    { taskIds: [taskId], mode: "all", timeoutMs: 50 },
    "bounded wait while project scheduling remains paused",
  );
  assert.equal(waited.data.satisfied, false);
  assert.equal(waited.data.timedOut, true);
  assert.deepEqual(waited.data.finishedTaskIds, []);
  const stored = await page.evaluate(
    async (taskId) => (await import("/src/lib/api/tasks.ts")).getTask(taskId),
    taskId,
  );
  assert.equal(stored.briefMarkdown, description);
  assert.equal(stored.planGoalEnabled, false);
  assert.equal(stored.dispatch.state, "queued");
  const persistedChats = await page.evaluate(
    async (projectId) =>
      (await import("/src/lib/api/chats.ts")).getChats(projectId),
    projectId,
  );
  assert.equal(persistedChats.filter((c) => c.id === taskId).length, 1);
  result.mcpTaskProbe.child = {
    taskId,
    operationId,
    description,
    title,
    modelInherited: true,
    goalModeOff: true,
    queuedWhileProjectPaused: true,
    singleTaskAfterReplay: true,
    plaintextDecryptedByExistingBrowser: true,
  };
  const childAnswer =
    "Private native MCP delegated Task actual execution result 🌙";
  const childReply = model.reply({ text: childAnswer });
  await page.evaluate(async (projectId) => {
    const api = await import("/src/lib/api/tasks.ts"),
      state = await api.getProjectTaskPauseState(projectId);
    const resumed = await api.setProjectTaskPauseState(projectId, {
      paused: false,
      rowVersion: state.rowVersion,
    });
    if (resumed.paused)
      throw new Error("Actual project Task scheduler remains paused");
  }, projectId);
  const completed = await eventually(
    () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
        taskId,
      ),
    (t) => assert.equal(t.state, "complete"),
  );
  assert.equal(completed.planGoalEnabled, false);
  assert.equal(completed.briefMarkdown, description);
  assert.equal(completed.activeOperationId, null);
  assert.equal(childReply.entered, true);
  assert.equal(childReply.request.completed, true);
  const childMessages = await page.evaluate(
    async (id) => (await import("/src/lib/api/chats.ts")).getMessages(id),
    taskId,
  );
  assert.ok(
    JSON.stringify(childMessages).includes(childAnswer),
    "Browser decrypts the actual delegated Task native response",
  );
  const finished = await invoke(
    "task_wait",
    { taskIds: [taskId], mode: "all", timeoutMs: 50 },
    "wait after actual delegated child completion",
  );
  assert.equal(finished.data.satisfied, true);
  assert.equal(finished.data.timedOut, false);
  assert.deepEqual(finished.data.finishedTaskIds, [taskId]);
  const modelPostsBeforeRestart = model.requests.filter(
    (r) => r.method === "POST",
  ).length;
  result.mcpTaskProbe.childExecutionBeforeRestart = {
    completed: true,
    goalModeOff: true,
    browserDecryptedActualNativeAnswer: true,
    completedWaitSatisfied: true,
    modelPosts: modelPostsBeforeRestart,
  };
  await stopWorker();
  const port = Number(new URL(fixture.server.origin).port);
  await fixture.close();
  await fixture.start({ port });
  assert.equal(
    (
      await page.evaluate(
        async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
        taskId,
      )
    ).state,
    "complete",
  );
  assert.deepEqual(
    await page.evaluate(
      async (id) => (await import("/src/lib/api/chats.ts")).getMessages(id),
      taskId,
    ),
    childMessages,
  );
  await startWorker();
  assert.deepEqual(
    await page.evaluate(
      async (id) => (await import("/src/lib/api/chats.ts")).getMessages(id),
      taskId,
    ),
    childMessages,
  );
  assert.equal(
    model.requests.filter((r) => r.method === "POST").length,
    modelPostsBeforeRestart,
    "Restart does not repeat completed delegated Task inference",
  );
  for (const marker of [description, title, childAnswer]) {
    assert.equal(
      JSON.stringify(requests).includes(marker),
      false,
      "Private delegated Task text is absent from browser-server HTTP requests",
    );
    assert.equal(
      fixture.server.diagnostics().includes(marker),
      false,
      "Private delegated Task text is absent from server diagnostics",
    );
  }
  result.mcpTaskProbe.childExecution = {
    completed: true,
    goalModeOff: true,
    browserDecryptedActualNativeAnswer: true,
    completedWaitSatisfied: true,
    serverAndWorkerRestartRetained: true,
    noDuplicateModelInferenceAfterRestart: true,
    exactTranscriptRetained: true,
    modelPosts: modelPostsBeforeRestart,
  };
  assert.deepEqual(model.failures, []);
  result.steps.push(
    "the bundled native runtime creates and replays an encrypted Task through full worker MCP, resumes it through the real scheduler, decrypts its native answer and retains exact history through server/worker restart",
  );
}
