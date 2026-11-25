import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  councilAgentLink,
  councilLinkedWorkLink,
  councilProjectResultLink,
} from "../../packages/protocol/dist/index.js";

import { eventually } from "./full-worker.mjs";
import { actualCouncilTaskStarts } from "./actual-council-task-starts.mjs";

export function projectToolOutput(plan, callId) {
  const item = plan.request.input.input.find(
    ({ type, call_id }) =>
      type === "function_call_output" && call_id === callId,
  );
  assert.ok(item, `Missing creation tool output ${callId}`);
  const text =
    typeof item.output === "string"
      ? item.output
      : item.output.map(({ text }) => text).join("\n");
  const parts = text.split("\nOutput:\n");
  assert.equal(parts.length, 2, text);
  const { data } = JSON.parse(parts[1]);
  assert.ok(data, text);
  return data;
}

export async function actualCouncilProjectCreation({
  page,
  model,
  target,
  tools,
  submit,
  idle,
  sender,
  councilId,
  projectId,
  workerId,
  targetWorkerId,
  targetProfileId,
  result,
}) {
  const tool = (name) => {
    const found = tools.find(
      (entry) => entry.name === name || entry.name.endsWith("__" + name),
    );
    assert.ok(found, `Missing tool ${name}`);
    return found;
  };
  const chatTool = tool("council_project_chat_create");
  const taskTool = tool("council_project_task_create");
  const send = tool("council_project_send");
  const chatTitle = "New private project agent 🌲";
  const taskTitle = "New private Council Task 🍄";
  const taskBrief =
    "Run a harmless Council-created Task on this project's worker.";
  const chatArgs = { projectId, operationId: randomUUID(), title: chatTitle };
  const taskArgs = {
    projectId,
    operationId: randomUUID(),
    title: taskTitle,
    description: taskBrief,
  };

  const openCouncil = async () => {
    await page.goto(new URL("/", page.url()).href);
    await page
      .getByRole("button", { name: /switch cantrip mode/iu })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Cantrip Council" }).click();
    await page
      .getByRole("navigation", { name: "Council agents" })
      .getByRole("button", { name: new RegExp(sender, "u") })
      .click();
  };
  await openCouncil();
  await eventually(
    () =>
      page.evaluate(async () =>
        (await import("/src/lib/api/worker-wire.ts")).getWorkers(),
      ),
    (workers) => {
      for (const id of [workerId, targetWorkerId]) {
        const worker = workers.find((value) => value.workerId === id);
        assert.ok(
          worker?.encryption.grants.some(
            ({ component }) => component === "task-content",
          ),
        );
        assert.ok(
          worker?.encryption.grants.some(
            ({ component }) => component === "private-surface-metadata",
          ),
        );
      }
    },
    30_000,
  );

  const proposals = (key) =>
    model.reply({
      responseId: "council-project-creation-" + key,
      calls: [
        { ...chatTool, arguments: chatArgs },
        { ...taskTool, arguments: taskArgs },
      ],
    });
  proposals("first");
  const retry = proposals("retry");
  const done = model.reply({ text: "I created the project chat and Task." });
  const taskAnswer = "The Council-created Task finished on the project worker.";
  const taskRun = target.reply({ text: taskAnswer, hold: true });
  assert.equal(
    (
      await submit(
        "Create a new project Agent chat and start a Task. Retry both creation calls.",
      )
    ).status,
    "queued",
  );
  await eventually(
    () => done.request?.completed,
    (complete) => assert.equal(complete, true),
    60_000,
  );

  const chat = projectToolOutput(
    retry,
    "council-project-creation-first-call-0",
  );
  const task = projectToolOutput(
    retry,
    "council-project-creation-first-call-1",
  );
  assert.deepEqual(
    projectToolOutput(done, "council-project-creation-retry-call-0"),
    chat,
  );
  assert.deepEqual(
    projectToolOutput(done, "council-project-creation-retry-call-1"),
    task,
  );
  assert.equal(chat.workerId, targetWorkerId);
  assert.equal(task.workerId, targetWorkerId);
  assert.equal(task.started, true);

  const read = (id) =>
    page.evaluate(
      async (chatId) =>
        (await import("/src/lib/api/chats.ts")).getMessages(chatId),
      id,
    );
  const chats = await page.evaluate(
    async (id) => (await import("/src/lib/api/chats.ts")).getChats(id),
    projectId,
  );
  assert.deepEqual(
    chats.filter(({ title }) => title === chatTitle).map(({ id }) => id),
    [chat.chatId],
  );
  assert.deepEqual(
    chats.filter(({ title }) => title === taskTitle).map(({ id }) => id),
    [task.taskId],
  );
  const readTask = (id) =>
    page.evaluate(
      async (chatId) => (await import("/src/lib/api/tasks.ts")).getTask(chatId),
      id,
    );
  await idle();
  await eventually(
    () => taskRun.entered,
    (entered) => assert.ok(entered, JSON.stringify(target.failures)),
    60_000,
  );
  const resultTurn = model.reply({ text: "I received the Task result." });
  taskRun.release();
  const completed = await eventually(
    () => readTask(task.taskId),
    (value) =>
      assert.equal(value.state, "complete", JSON.stringify(target.failures)),
    60_000,
  );
  assert.equal(completed.briefMarkdown, taskBrief);
  assert.deepEqual(completed.councilOrigin, {
    agentId: councilId,
    title: sender,
  });
  assert.equal(completed.modelConfiguration.modelId, targetProfileId);
  assert.equal(taskRun.request.completed, true);
  assert.ok(JSON.stringify(await read(task.taskId)).includes(taskAnswer));
  await eventually(
    () => resultTurn.request?.completed,
    (complete) => assert.equal(complete, true, JSON.stringify(model.failures)),
    60_000,
  );
  assert.ok(
    JSON.stringify(resultTurn.request.input.input).includes(taskAnswer),
  );
  const taskResults = async () =>
    (await read(councilId)).flatMap(({ content }) =>
      content.flatMap(({ councilProjectResult }) =>
        councilProjectResult?.targetKind === "task"
          ? [councilProjectResult]
          : [],
      ),
    );
  const [taskResult] = await eventually(
    taskResults,
    (results) => assert.equal(results.length, 1),
    60_000,
  );
  assert.equal(taskResult.chatId, task.taskId);
  assert.equal(taskResult.status, "completed");
  assert.equal(taskResult.threadId, completed.dispatch.codexThreadId);
  assert.equal(taskResult.turnId, completed.dispatch.turnId);
  assert.ok(
    (await read(task.taskId)).some(
      ({ id, role }) => id === taskResult.inputMessageId && role === "user",
    ),
  );

  await idle();
  const chatBrief = "Send a brief to the Agent chat Council just created.";
  const chatAnswer =
    "The new project Agent chat received and answered the brief.";
  model.reply({
    calls: [
      {
        ...send,
        arguments: {
          projectId,
          chatId: chat.chatId,
          operationId: randomUUID(),
          message: chatBrief,
        },
      },
    ],
  });
  model.reply({ text: "I sent the brief to the new chat." });
  const callback = model.reply({ text: "I received the new chat's result." });
  const chatRun = target.reply({ text: chatAnswer });
  assert.equal(
    (await submit("Send work to the new project Agent chat.")).status,
    "queued",
  );
  await eventually(
    () => callback.request?.completed,
    (complete) => assert.equal(complete, true, JSON.stringify(model.failures)),
    60_000,
  );
  assert.ok(JSON.stringify(chatRun.request.input.input).includes(chatBrief));
  assert.ok(JSON.stringify(callback.request.input.input).includes(chatAnswer));

  await idle();
  model.reply({
    responseId: "council-project-draft",
    calls: [
      {
        ...taskTool,
        arguments: {
          ...taskArgs,
          title: "Task started independently",
          description: "The human will start this draft separately.",
          start: false,
          operationId: randomUUID(),
        },
      },
    ],
  });
  const draftTurn = model.reply({ text: "I saved a Task draft." });
  await submit("Save a Task draft for me to start myself.");
  await eventually(
    () => draftTurn.request?.completed,
    (complete) => assert.equal(complete, true),
    60_000,
  );
  const draft = projectToolOutput(draftTurn, "council-project-draft-call-0");
  assert.equal(draft.started, false);
  const draftTask = await readTask(draft.taskId);
  assert.equal(draftTask.state, "draft");
  await idle();
  const sourceInferences = model.requests.filter(
    ({ method }) => method === "POST",
  ).length;
  const independentlyStarted = target.reply({
    text: "The independently queued Task finished.",
  });
  const input = { rowVersion: draftTask.rowVersion, operationId: randomUUID() };
  await page.evaluate(
    async ({ id, input }) =>
      (await import("/src/lib/api/tasks.ts")).startTaskDirectly(id, input),
    { id: draft.taskId, input },
  );
  const independent = await eventually(
    () => readTask(draft.taskId),
    (value) => assert.equal(value.state, "complete"),
    60_000,
  );
  assert.equal(independent.councilOrigin, undefined);
  assert.equal(independentlyStarted.request.completed, true);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.deepEqual(await taskResults(), [taskResult]);
  assert.equal(
    model.requests.filter(({ method }) => method === "POST").length,
    sourceInferences,
  );

  const conversation = page.locator('[data-slot="council-conversation"]');
  const taskLink = conversation.locator(
    `[data-slot="council-project-result"][href="${councilProjectResultLink(taskResult)}"]`,
  );
  await taskLink.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(
    await conversation
      .getByText(taskAnswer, { exact: true })
      .filter({ visible: true })
      .count(),
    0,
  );
  await taskLink.click();
  try {
    await page
      .getByRole("region", { name: "Task prompt" })
      .getByText(taskBrief, { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });
  } catch (error) {
    result.councilTaskLinkDiagnostic = {
      url: page.url(),
      taskId: task.taskId,
      content: (await page.locator("body").innerText()).slice(-4_000),
    };
    throw error;
  }
  const attributedBy = page.getByRole("link", {
    name: `Sent via ${sender}`,
    exact: true,
  });
  await attributedBy.waitFor({ state: "visible" });
  assert.equal(
    await attributedBy.getAttribute("href"),
    councilAgentLink(councilId),
  );
  await attributedBy.click();
  await page.getByRole("heading", { name: sender, exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Delegated work", exact: true })
    .click();
  const linked = page.getByRole("dialog", { name: "Delegated work" });
  const linkedTask = linked.getByRole("link", {
    name: new RegExp(taskTitle, "u"),
  });
  assert.equal(
    await linkedTask.getAttribute("href"),
    councilLinkedWorkLink({
      projectId,
      chatId: task.taskId,
      messageId: null,
      targetKind: "task",
    }),
  );
  const linkedChat = linked.getByRole("link", {
    name: new RegExp(chatTitle, "u"),
  });
  assert.equal(
    new URL(await linkedChat.getAttribute("href"), page.url()).searchParams.get(
      "projectChat",
    ),
    chat.chatId,
  );
  assert.equal(await linkedTask.count(), 1);
  assert.equal(await linkedChat.count(), 1);
  await linked.getByRole("button", { name: "Close" }).click();
  assert.deepEqual(model.failures, []);
  assert.deepEqual(target.failures, []);
  await idle();

  result.councilProjectCreation = { chat, task };
  result.councilProjectTaskResult = {
    source: taskResult,
    independentTaskId: draft.taskId,
  };
  result.steps.push(
    "The exact delegated Task result woke Council once and linked to the original Task input. A Council-created draft dispatched by the human did not wake Council.",
  );
  result.steps.push(
    "Council used the normal app grant path, retried two protected creations, received a result from the new project Agent chat, and ran one Task on the assigned project worker.",
  );
  result.steps.push(
    "The Task linked back to the originating Council agent and the compact delegated work view linked to the Task and project Agent chat.",
  );
  await actualCouncilTaskStarts({
    page,
    model,
    target,
    tool: tool("council_project_task_start"),
    projectId,
    submit,
    idle,
    readTask,
    taskResults,
    result,
  });
}
