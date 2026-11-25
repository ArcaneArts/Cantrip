import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eventually } from "./full-worker.mjs";

const timeout = 60_000;
const complete = (plan) =>
  eventually(
    () => plan.request?.completed,
    (done) => assert.equal(done, true),
    timeout,
  );

export async function actualCouncilTaskApprovals({
  page,
  model,
  target,
  submit,
  idle,
  councilId,
  projectId,
  tools,
  targetTools,
  result,
}) {
  const start = tools.find(({ name }) =>
    name.endsWith("council_project_task_start"),
  );
  const command = targetTools.find(({ name }) => name === "exec_command");
  assert.ok(
    start && command,
    "Both workers expose their expected native tools",
  );
  const prompt = "Run a harmless Task approval probe.";
  const marker = "Council-approved-task-output";
  const api = (operation, ...args) =>
    page.evaluate(
      async ({ operation, args }) =>
        (await import("/src/lib/api/chats.ts"))[operation](...args),
      { operation, args },
    );
  const pending = (filter) =>
    api("getAgentInteractionRequests", { ...filter, status: "pending" });
  const create = (title) =>
    page.evaluate(
      async ({ projectId, title, prompt }) => {
        const api = await import("/src/lib/api/tasks.ts");
        const { chat, task } = await api.createTask(projectId, title);
        const draft = await api.updateTaskDraft(chat.id, {
          rowVersion: task.rowVersion,
          briefMarkdown: prompt,
        });
        await (
          await import("/src/lib/api/chats.ts")
        ).updateChatPermissionProfile(chat.id, ":workspace");
        return draft;
      },
      { projectId, title, prompt },
    );
  const requestCommand = (marker) =>
    target.reply({
      calls: [
        {
          ...command,
          arguments: {
            cmd: "printf " + marker,
            login: false,
            sandbox_permissions: "require_escalated",
            justification: prompt,
            max_output_tokens: 300,
          },
        },
      ],
    });

  const task = await create("Existing Task that needs approval");
  const request = requestCommand(marker);
  const finished = target.reply({
    text: "The Task finished after the human answered.",
  });
  model.reply({
    calls: [
      {
        ...start,
        arguments: {
          projectId,
          taskId: task.chatId,
          operationId: randomUUID(),
        },
      },
    ],
  });
  model.reply({ text: "I started the Task that needs approval." });
  const forwarded = model.reply({
    text: "This Task is waiting for your approval.",
  });
  await submit("Start the Task and keep me informed of required approvals.");
  const [original] = await eventually(
    () => pending({ chatId: task.chatId }),
    (items) => assert.equal(items.length, 1, JSON.stringify(target.failures)),
    timeout,
  );
  assert.ok(request.entered);
  assert.equal(original.payload.kind, "commandExecution");
  const [delegated] = await eventually(
    () => pending({ councilAgentId: councilId }),
    (items) => assert.equal(items.length, 1),
    timeout,
  );
  assert.deepEqual(delegated, { ...original, targetKind: "task" });
  await complete(forwarded);
  assert.ok(JSON.stringify(forwarded.request.input.input).includes(prompt));
  assert.ok(
    JSON.stringify(forwarded.request.input.input).includes("&task=true"),
  );
  const council = page.locator('[data-slot="council-conversation"]');
  const link = council.getByRole("link", { name: "Task request" });
  await link.waitFor({ state: "visible" });
  const source = new URL(await link.getAttribute("href"), page.url());
  assert.equal(source.searchParams.get("request"), original.id);
  assert.equal(source.searchParams.get("projectChat"), task.chatId);
  assert.equal(source.searchParams.get("task"), "true");
  assert.equal(await council.getByText(prompt, { exact: true }).count(), 0);

  const sourcePage = await page.context().newPage();
  try {
    await sourcePage.goto(source.href);
    await sourcePage
      .getByRole("region", { name: "Task requests" })
      .locator(`[data-interaction-request-id="${original.id}"]`)
      .waitFor({ state: "visible" });
  } finally {
    await sourcePage.close();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const callback = model.reply({
    text: "Council received the approved Task result.",
  });
  await page.getByRole("button", { name: "Project requests (1)" }).click();
  const panel = page.getByRole("dialog", { name: "Project requests" });
  const card = panel.locator(`[data-interaction-request-id="${original.id}"]`);
  await card.getByRole("link", { name: "Open in Task" }).waitFor();
  const response = page.waitForResponse(
    (reply) =>
      reply.request().method() === "POST" &&
      new URL(reply.url()).pathname ===
        `/api/agent-requests/${original.id}/respond`,
  );
  await card.getByRole("button", { name: "Allow once", exact: true }).click();
  const accepted = await response;
  assert.equal(accepted.status(), 200, await accepted.text());
  assert.equal((await accepted.json()).id, original.id);
  await complete(finished);
  assert.ok(JSON.stringify(finished.request.input.input).includes(marker));
  await complete(callback);
  await panel.getByText("No pending project requests.").waitFor();
  await panel.getByRole("button", { name: "Close" }).click();
  await idle();
  await page.setViewportSize({ width: 1344, height: 900 });

  const independent = await create("Independent Task approval");
  const otherMarker = "Unrelated-task-approval-probe";
  const sourceRequests = model.requests.filter(
    ({ method }) => method === "POST",
  ).length;
  requestCommand(otherMarker);
  const otherFinished = target.reply({
    text: "The independent Task finished.",
  });
  await page.evaluate(
    async ({ id, rowVersion }) =>
      (await import("/src/lib/api/tasks.ts")).startTaskDirectly(id, {
        rowVersion,
        operationId: crypto.randomUUID(),
      }),
    { id: independent.chatId, rowVersion: independent.rowVersion },
  );
  const [other] = await eventually(
    () => pending({ chatId: independent.chatId }),
    (items) => assert.equal(items.length, 1),
    timeout,
  );
  assert.deepEqual(await pending({ councilAgentId: councilId }), []);
  await api("respondToAgentInteractionRequest", other.id, {
    idempotencyKey: randomUUID(),
    response: { kind: "commandExecution", decision: "accept" },
  });
  await complete(otherFinished);
  await eventually(
    () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
        independent.chatId,
      ),
    (task) => assert.equal(task.state, "complete"),
    timeout,
  );
  assert.equal(
    model.requests.filter(({ method }) => method === "POST").length,
    sourceRequests,
  );
  assert.deepEqual(model.failures, []);
  assert.deepEqual(target.failures, []);
  result.councilTaskApproval = {
    requestId: original.id,
    taskId: task.chatId,
    independentRequestId: other.id,
  };
  result.steps.push(
    "Council forwarded the exact Task approval, linked to its Task, and accepted a human answer at mobile width. Independently started Task requests did not wake Council.",
  );
}
