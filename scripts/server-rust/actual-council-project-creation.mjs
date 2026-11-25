import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eventually } from "./full-worker.mjs";

function output(plan, callId) {
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
  const taskRun = target.reply({ text: taskAnswer });
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

  const chat = output(retry, "council-project-creation-first-call-0");
  const task = output(retry, "council-project-creation-first-call-1");
  assert.deepEqual(output(done, "council-project-creation-retry-call-0"), chat);
  assert.deepEqual(output(done, "council-project-creation-retry-call-1"), task);
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
  const completed = await eventually(
    () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
        task.taskId,
      ),
    (value) =>
      assert.equal(value.state, "complete", JSON.stringify(target.failures)),
    60_000,
  );
  assert.equal(completed.briefMarkdown, taskBrief);
  assert.equal(completed.modelConfiguration.modelId, targetProfileId);
  assert.equal(taskRun.request.completed, true);
  assert.ok(JSON.stringify(await read(task.taskId)).includes(taskAnswer));

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
  assert.deepEqual(model.failures, []);
  assert.deepEqual(target.failures, []);
  await idle();

  result.councilProjectCreation = { chat, task };
  result.steps.push(
    "Council used the normal app grant path, retried two protected creations, received a result from the new project Agent chat, and ran one Task on the assigned project worker.",
  );
}
