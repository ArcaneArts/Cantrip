import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { modelOutput } from "./actual-council-mcp-setup.mjs";
import { projectToolOutput } from "./actual-council-project-creation.mjs";
import {
  launchTaskBrief,
  prepareLaunchProjects,
} from "./council-launch-projects.mjs";
import {
  discoveredValue,
  prepareCouncilMcpFixture,
} from "./council-mcp-fixture.mjs";
import { eventually } from "./full-worker.mjs";
import { modelFunctions, taskModelProvider } from "./task-model-provider.mjs";

const operationsTitle = "Release Briefing Operations";
const operationsRole =
  "Coordinate the release, retain decisions, and send a briefing.";
const decision = "For PARCEL-412, deploy after the regional backup completes.";
const routineName = "Release readiness briefing";
const routinePrompt =
  "Prepare the release readiness briefing using the project chat, Task, old decision, and release canary.";
const projectPrompt =
  "Verify the remote project readiness with the harmless approval command.";
const projectAnswer = "The approved remote project checklist passed.";
const taskAnswer = "The local migration checklist is ready.";
const handoff = "Release evidence is ready for the primary agent.";
const report = `Briefing ready. ${decision} ${projectAnswer} ${taskAnswer} The ${discoveredValue}.`;
const timeout = 60_000;

function tool(tools, name) {
  const selected = tools.find(
    (item) => item.name === name || item.name.endsWith(`__${name}`),
  );
  assert.ok(selected, `Missing native tool ${name}`);
  return selected;
}

export async function actualCouncilLaunch({
  page,
  mobile,
  appOrigin,
  root,
  fixture,
  workerId,
  cliBinary,
  restartPrimary,
  chatId: primaryId,
  model: primary,
  tools,
  result,
}) {
  const remoteWorkerId = "actual-council-briefing-remote";
  const model = await taskModelProvider({ observeStreams: true });
  const target = await taskModelProvider({ observeStreams: true });
  const app = await page.context().newPage();
  const appOriginUrl = new URL(appOrigin);
  const notificationPreference = (enabled) =>
    app.evaluate(
      async (enabled) =>
        (
          await import("/src/lib/council-notification-preference.ts")
        ).setCouncilNotificationsEnabled(enabled),
      enabled,
    );
  const roster = () =>
    page.evaluate(async () =>
      (await import("/src/lib/api/council.ts")).listCouncilAgents(),
    );
  const chatApi = (method, ...args) =>
    page.evaluate(
      async ({ method, args }) =>
        (await import("/src/lib/api/chats.ts"))[method](...args),
      { method, args },
    );
  const requestInput = (plan) => JSON.stringify(plan.request.input.input);
  const modelSaw = (plan, text) => requestInput(plan).includes(text);
  const observed = (plan) =>
    eventually(
      () => plan.request,
      (request) =>
        assert.ok(
          request,
          JSON.stringify({ council: model.failures, project: target.failures }),
        ),
      timeout,
    );
  const complete = (plan) =>
    eventually(
      () => plan.request?.completed,
      (done) =>
        assert.equal(
          done,
          true,
          JSON.stringify({ council: model.failures, project: target.failures }),
        ),
      timeout,
    );
  const idle = (id) =>
    eventually(
      () =>
        page.evaluate(
          async (id) =>
            (await import("/src/lib/api/council.ts")).getCouncilChat(id),
          id,
        ),
      (chat) => assert.equal(chat.status, "idle"),
      timeout,
    );
  const replyWith = (responseId, tools, name, arguments_, options = {}) =>
    model.reply({
      ...options,
      responseId,
      calls: [{ ...tool(tools, name), arguments: arguments_ }],
    });
  const sendFromApp = async (text) => {
    await app.getByPlaceholder("Message Cantrip…").fill(text);
    await app.getByRole("button", { name: "Send prompt" }).click();
  };
  let heldProject;
  let heldApproval;
  let heldTask;
  let heldTaskTarget;
  try {
    if (!mobile) await app.setViewportSize({ width: 1344, height: 900 });
    await app.goto(appOrigin);
    await app
      .getByRole("button", { name: /switch cantrip mode/iu })
      .first()
      .click();
    await app.getByRole("menuitem", { name: "Cantrip Council" }).click();
    const sidebar = app.getByRole("navigation", { name: "Council agents" });
    await sidebar
      .getByRole("button", { name: /Disposable Operations Agent/u })
      .click();

    await page.evaluate(
      async ({ baseUrl, model }) => {
        const api = await import("/src/lib/api/models.ts");
        const provider = await api.createModelProvider({
          name: "Disposable briefing provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await api.createModelProfile({
          name: "Disposable briefing model",
          routes: [
            { providerId: provider.id, modelName: model, enabled: true },
          ],
        });
        await (
          await import("/src/lib/api/settings.ts")
        ).updateSettings({
          defaultCouncilModelId: profile.id,
        });
      },
      { baseUrl: model.baseUrl, model: model.model },
    );
    primary.reply({
      responseId: "launch-create-agent",
      calls: [
        {
          ...tool(tools, "council_create"),
          arguments: { title: operationsTitle, role: operationsRole },
        },
      ],
    });
    const created = primary.reply({
      text: "I created the release operations agent.",
    });
    await sendFromApp(
      "Create a release operations agent and have it coordinate the briefing.",
    );
    await complete(created);
    await idle(primaryId);
    const { agent } = projectToolOutput(created, "launch-create-agent-call-0");
    const opsId = agent.id;
    await eventually(
      roster,
      (agents) => {
        const ops = agents.find(({ id }) => id === opsId);
        assert.equal(ops?.title, operationsTitle);
        assert.equal(ops.workerId, workerId);
        assert.equal(ops.primary, false);
        assert.equal(ops.scratchStatus, "ready");
      },
      timeout,
    );
    if (mobile) {
      await app.getByRole("button", { name: "Back to Council agents" }).tap();
    }
    await sidebar.getByRole("button", { name: operationsTitle }).click();

    const { configuration, scriptArguments } =
      await prepareCouncilMcpFixture(root);
    await page.evaluate(
      async ({ workerId, configuration }) =>
        (await import("/src/lib/api/mcp.ts")).createGlobalMcpServer(
          configuration,
          workerId,
          "chat",
        ),
      { workerId, configuration },
    );
    const historical = model.reply({
      text: "I recorded the regional backup decision.",
    });
    await sendFromApp(decision);
    await complete(historical);
    assert.ok(
      JSON.stringify(historical.request.input).includes(operationsRole),
    );
    await idle(opsId);
    const original = (await chatApi("getMessages", opsId)).find(({ content }) =>
      content.some(({ text }) => text === decision),
    );
    assert.ok(original?.id);
    const compacted = model.reply({
      text: "Keep a brief summary of the prior release conversation.",
    });
    const compact = app.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/chats/${opsId}/compact`,
    );
    await app.getByPlaceholder("Message Cantrip…").fill("/compact");
    await app.getByRole("option", { name: /\/compact/u }).click();
    assert.deepEqual(await (await compact).json(), { accepted: true });
    await complete(compacted);
    assert.ok(modelSaw(compacted, decision));
    await idle(opsId);
    await restartPrimary();
    await idle(opsId);
    await notificationPreference(false);
    await prepareLaunchProjects({
      page,
      fixture,
      root,
      cliBinary,
      workerId,
      remoteWorkerId,
      target,
      result,
      run: async ({ local, distant, targetChat, taskId, command }) => {
        const capabilities = modelFunctions(historical.request.input.tools);
        replyWith(
          "launch-schedule",
          capabilities,
          "council_automation_create",
          {
            operationId: randomUUID(),
            name: routineName,
            prompt: routinePrompt,
            schedule: {
              kind: "interval",
              every: 1_000_000,
              unit: "minute",
              startsAt: new Date(Date.now() + 8_000).toISOString(),
            },
          },
        );
        const scheduled = model.reply({
          text: "I scheduled the release readiness briefing.",
        });
        const search = replyWith(
          "launch-recall",
          capabilities,
          "council_history_search",
          {
            query: "PARCEL-412",
            mode: "literal",
            limit: 3,
          },
          {
            onlyFor: ({ input }) =>
              JSON.stringify(input).includes(routinePrompt),
          },
        );
        const send = replyWith(
          "launch-send-chat",
          capabilities,
          "council_project_send",
          {
            projectId: distant.id,
            chatId: targetChat,
            operationId: randomUUID(),
            message: projectPrompt,
          },
        );
        heldProject = model.reply({
          hold: true,
          text: "I’m waiting for the remote project evidence.",
        });
        heldApproval = model.reply({
          hold: true,
          text: "I have the project approval request.",
        });
        const requested = target.reply({
          calls: [
            {
              ...command,
              arguments: {
                cmd: "printf council-release-check",
                login: false,
                sandbox_permissions: "require_escalated",
                justification:
                  "Read the release checklist after human approval.",
                max_output_tokens: 1000,
              },
            },
          ],
        });
        const confirmed = target.reply({ text: projectAnswer });
        await sendFromApp(
          "Schedule a release readiness briefing and run it when due.",
        );
        await complete(scheduled);
        const routine = projectToolOutput(scheduled, "launch-schedule-call-0");
        assert.equal(routine.chatId, opsId);
        await observed(search);
        await observed(send);
        const recalled = projectToolOutput(send, "launch-recall-call-0");
        assert.ok(
          recalled.matches.some(({ messageId }) => messageId === original.id),
        );
        await observed(heldProject);
        await observed(requested);
        const [request] = await eventually(
          () =>
            chatApi("getAgentInteractionRequests", {
              councilAgentId: opsId,
              status: "pending",
            }),
          (rows) => assert.equal(rows.length, 1),
          timeout,
        );
        assert.equal(request.provenance.chatId, targetChat);
        assert.equal(request.provenance.workerId, remoteWorkerId);
        assert.equal(request.payload.kind, "commandExecution");
        assert.equal(
          (
            await chatApi("getAgentInteractionRequests", {
              chatId: targetChat,
              status: "pending",
            })
          )[0].id,
          request.id,
        );
        const messages = () => chatApi("getMessages", opsId);
        await eventually(
          messages,
          (items) =>
            assert.ok(
              items.some(({ content }) =>
                content.some(
                  ({ councilProjectRequest }) =>
                    councilProjectRequest?.requestId === request.id,
                ),
              ),
            ),
          timeout,
        );
        heldProject.release();
        await observed(heldApproval);
        assert.ok(
          modelSaw(
            heldApproval,
            "Read the release checklist after human approval.",
          ),
        );
        await app.getByRole("button", { name: "Project requests (1)" }).click();
        const card = app.locator(
          `[data-interaction-request-id="${request.id}"]`,
        );
        const originalLink = await card
          .getByRole("link", { name: "Open in project chat" })
          .getAttribute("href");
        assert.equal(
          new URL(originalLink, appOriginUrl).searchParams.get("request"),
          request.id,
        );

        // A native steer can start the next inference immediately. Stage its
        // fixture response before letting the delegated operation complete.
        const task = replyWith(
          "launch-start-task",
          capabilities,
          "council_project_task_start",
          {
            projectId: local.id,
            taskId,
            operationId: randomUUID(),
          },
        );
        heldTask = model.reply({
          hold: true,
          text: "I’m waiting for the local migration checklist.",
        });
        heldTaskTarget = target.reply({ hold: true, text: taskAnswer });
        const allow = card.getByRole("button", { name: "Allow once" });
        if (mobile) await allow.tap();
        else await allow.click();
        await complete(confirmed);
        assert.ok(modelSaw(confirmed, "council-release-check"));

        const forProject = (items, target, kind) =>
          items.filter(({ content }) =>
            content.some(
              ({ councilProjectResult }) =>
                councilProjectResult?.chatId === target &&
                (councilProjectResult.targetKind ?? "chat") === kind,
            ),
          );
        const projectMessages = await eventually(
          messages,
          (items) => {
            const source = items.find(({ content }) =>
              content.some(
                ({ automation }) => automation?.automationId === routine.id,
              ),
            );
            const entries = forProject(items, targetChat, "chat");
            assert.equal(entries.length, 1);
            assert.ok(source?.executionLaneId);
            assert.equal(entries[0].executionLaneId, source.executionLaneId);
            assert.equal(heldApproval.request.completed, false);
          },
          timeout,
        );
        const [projectMessage] = forProject(
          projectMessages,
          targetChat,
          "chat",
        );

        heldApproval.release();
        await observed(task);
        assert.ok(
          modelSaw(task, projectAnswer),
          "The steered project result reached the active briefing",
        );
        await observed(heldTask);
        const dispatch = projectToolOutput(
          heldTask,
          "launch-start-task-call-0",
        );
        assert.equal(dispatch.taskId, taskId);
        assert.equal(dispatch.kind, "direct");
        await observed(heldTaskTarget);
        assert.ok(modelSaw(heldTaskTarget, launchTaskBrief));
        const script = replyWith(
          "launch-script",
          capabilities,
          "exec_command",
          scriptArguments,
        );
        const peer = replyWith(
          "launch-peer",
          capabilities,
          "council_peer_send",
          {
            recipientAgentId: primaryId,
            operationId: randomUUID(),
            message: handoff,
          },
        );
        const peerReceived = primary.reply({
          text: "I received the release evidence.",
        });
        const notify = replyWith(
          "launch-notify",
          capabilities,
          "council_message_post",
          {
            operationId: randomUUID(),
            text: report,
            notify: true,
          },
          {
            onlyFor: ({ input }) =>
              JSON.stringify(input).includes("launch-peer-call-0"),
          },
        );
        const finished = model.reply({
          text: "The release briefing has been delivered.",
        });
        heldTaskTarget.release();
        await complete(heldTaskTarget);
        const completedTask = await waitForTaskCompletion(
          page,
          taskId,
          dispatch.dispatchId,
        );
        const taskMessages = await eventually(
          messages,
          (items) => {
            const [message] = forProject(items, taskId, "task");
            assert.equal(forProject(items, taskId, "task").length, 1);
            const source = message.content.find(
              ({ councilProjectResult }) => councilProjectResult,
            ).councilProjectResult;
            assert.equal(source.turnId, completedTask.dispatch.turnId);
          },
          timeout,
        );
        assert.equal(heldTask.request.completed, false);
        const [taskMessage] = forProject(taskMessages, taskId, "task");
        heldTask.release();
        await observed(script);
        assert.ok(modelSaw(script, taskAnswer));
        await observed(peer);
        assert.match(
          modelOutput(peer, "launch-script-call-0"),
          /Process exited with code 0/u,
        );
        assert.ok(
          modelOutput(peer, "launch-script-call-0").includes(discoveredValue),
        );
        await complete(peerReceived);
        assert.ok(modelSaw(peerReceived, operationsTitle));
        assert.ok(modelSaw(peerReceived, handoff));
        await complete(finished);
        await observed(notify);
        const notice = projectToolOutput(finished, "launch-notify-call-0");
        await eventually(
          () =>
            app.evaluate(async () =>
              (
                await import("/src/lib/api/council-notifications.ts")
              ).getCouncilPendingNotifications(),
            ),
          (pending) => assert.equal(pending[0]?.id, notice.messageId),
          timeout,
        );
        const toast = app.locator('[data-slot="app-toast"]').filter({
          has: app.locator(`a[href*="message=${notice.messageId}"]`),
        });
        const delivered = app.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname ===
              `/api/council/notifications/${notice.messageId}/claim`,
          { timeout },
        );
        await notificationPreference(true);
        assert.deepEqual(await (await delivered).json(), { claimed: true });
        await toast.waitFor({ timeout: 10_000 });
        assert.ok((await toast.innerText()).includes(report));
        assert.equal(await toast.count(), 1);
        assert.equal(notice.notify, true);
        const visible = await messages();
        assert.equal(
          visible.filter(({ id }) => id === notice.messageId).length,
          1,
        );
        assert.equal(
          visible.find(({ id }) => id === notice.messageId).content[0].text,
          report,
        );
        assert.deepEqual(primary.failures, []);
        assert.deepEqual(
          model.failures,
          [],
          JSON.stringify(
            model.requests
              .filter(
                ({ completed, method }) => !completed && method === "POST",
              )
              .map(({ input }) => ({
                previous: input.previous_response_id,
                last: input.input
                  ?.slice(-5)
                  .map(({ type, role, call_id, content }) => ({
                    type,
                    role,
                    call_id,
                    markers: [
                      operationsTitle,
                      decision,
                      routinePrompt,
                      projectAnswer,
                      taskAnswer,
                      report,
                    ].filter((marker) =>
                      JSON.stringify(content ?? "").includes(marker),
                    ),
                  })),
              })),
          ),
        );
        assert.deepEqual(target.failures, []);
        result.councilLaunch = {
          primaryId,
          mobileTouch: mobile,
          operationsId: opsId,
          workerId,
          remoteWorkerId,
          routineId: routine.id,
          approvedOriginalId: request.id,
          projectResultId: projectMessage.id,
          taskResultId: taskMessage.id,
          recalledMessageId: original.id,
          notificationId: notice.messageId,
        };
        result.steps.push(
          "The prompted operations agent ran a briefing, recalled its decision after native compaction and cold restart, delegated to two project placements, accepted exact project and Task results, used an authenticated MCP script, sent a peer result, and delivered a user notification.",
        );
      },
    });
  } finally {
    heldTaskTarget?.release();
    heldProject?.release();
    heldApproval?.release();
    heldTask?.release();
    await app.close();
    await target.close();
    await model.close();
  }
}

async function waitForTaskCompletion(page, id, dispatchId) {
  return eventually(
    () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
        id,
      ),
    (task) => {
      assert.equal(task.state, "complete");
      assert.equal(task.dispatch.id, dispatchId);
      assert.equal(task.dispatch.status ?? task.dispatch.state, "succeeded");
    },
    timeout,
  );
}
