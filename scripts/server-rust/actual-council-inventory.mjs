import assert from "node:assert/strict";
import path from "node:path";
import { fixtureCodex } from "../worker-rust/deferred-receipt-smoke-cases.mjs";
import { actualCouncilProjectMessages } from "./actual-council-project-messages.mjs";
import { verifyCouncilAccountInventory } from "./actual-council-account-inventory.mjs";
import { projectSteeringText } from "./actual-council-project-steering.mjs";
import { eventually, launchActualWorker } from "./full-worker.mjs";

export async function actualCouncilInventory({
  page,
  fixture,
  root,
  cliBinary,
  accountMetadata,
  projectMessages,
  projectApprovals,
  steeredApprovals,
  projectCreation,
  projectControls,
  projectSteering,
  projectSteeringRace,
  projectReplyWithoutHistory,
  chatId,
  workerId,
  model,
  tools,
  submit,
  readChat,
  result,
}) {
  const remote = "actual-council-project-worker";
  const projectTitle = "Private remote Council project 🌲";
  const chatTitle = "Private remote Agent chat 🍄";
  const taskTitle = "Private remote Task 🌙";
  const steerRaceMarker = projectSteeringRace
    ? path.join(root, "project-steer-race")
    : undefined;
  const codexProxy = steerRaceMarker
    ? await fixtureCodex(root, process.env.CANTRIP_CODEX_BIN, {
        scenario: "council-steer-completion",
        marker: steerRaceMarker,
        input: `Message from Cantrip agent ${JSON.stringify((await readChat()).title)} (chat ${chatId}). This is another agent, not the human user.\n\n${projectSteeringText}`,
      })
    : undefined;
  const lease = await page.evaluate(
    async (workerId) =>
      (await import("/src/lib/api/workers.ts")).createWorkerEnrollmentCode({
        label: workerId,
      }),
    remote,
  );
  const worker = launchActualWorker(
    fixture.workerFixture ?? fixture,
    path.join(root, fixture.kind, "council-inventory-worker"),
    {
      workerId: remote,
      cliBinary,
      enrollmentCode: lease.code,
      environment: codexProxy ? { CANTRIP_CODEX_BIN: codexProxy } : undefined,
    },
  );
  try {
    await worker.ready();
    if (fixture.workerFixture) await fixture.assertRemoteWorker(remote);
    const targets = await page.evaluate(
      async ({ workerId, remote, projectTitle }) => {
        const local = await window.folderCrypto.createManagedFolderProject({
          name: "Private local Council project",
          workerId,
        });
        const distant = await window.folderCrypto.createManagedFolderProject({
          name: projectTitle,
          workerId: remote,
        });
        return { local, distant };
      },
      { workerId, remote, projectTitle },
    );
    for (const project of [targets.local, targets.distant]) {
      await eventually(
        () =>
          page.evaluate(
            (id) => window.folderApi.getProjectFolderSetupJob(id),
            project.id,
          ),
        (job) => assert.equal(job.state, "succeeded"),
        60_000,
      );
    }
    const ids = await page.evaluate(
      async ({ project, chatTitle, taskTitle }) => {
        const chat = await (
          await import("/src/lib/api/chats.ts")
        ).createChat(project, chatTitle);
        const task = await (
          await import("/src/lib/api/tasks.ts")
        ).createTask(project, taskTitle);
        return { chat: chat.id, task: task.chat.id };
      },
      { project: targets.distant.id, chatTitle, taskTitle },
    );
    const localId = targets.local.id;
    const projectId = targets.distant.id;
    assert.ok(localId && projectId);
    const wanted = { projectId, workerId: remote };
    const idle = () =>
      eventually(readChat, (chat) => assert.equal(chat.status, "idle"), 60_000);
    await idle();
    const tool = tools.find(
      ({ name }) =>
        name === "council_inventory" || name.endsWith("__council_inventory"),
    );
    const terminal = tools.find(
      ({ name }) => name === "exec_command" || name.endsWith("__exec_command"),
    );
    assert.ok(
      tool && terminal,
      "Council can use inventory and its normal worker shell",
    );
    const call = (key, tool, args) =>
      model.reply({
        responseId: `council-inventory-${key}`,
        calls: [{ ...tool, arguments: args }],
      });
    call("first", tool, { section: "projects", limit: 1 });
    const next = call("next", tool, {
      section: "projects",
      limit: 1,
      cursor: 1,
    });
    const chats = call("chats", tool, { section: "chats", projectId });
    const tasks = call("tasks", tool, { section: "tasks", projectId });
    const cli = call("cli", terminal, {
      cmd: [
        "set -e",
        "cantrip --json council inventory projects",
        `cantrip --json council inventory chats ${projectId}`,
        `cantrip --json council inventory tasks ${projectId}`,
      ].join("\n"),
      max_output_tokens: 4000,
    });
    const final = model.reply({
      text: "I found the projects and the remote chat and Task.",
    });
    assert.equal(
      (
        await submit(
          "Find the projects and find the remote chat and Task on the other worker.",
        )
      ).status,
      "queued",
    );
    await eventually(
      () => final.entered,
      (entered) => assert.ok(entered, JSON.stringify(model.failures)),
      60_000,
    );
    const output = (plan, key) => {
      const item = plan.request.input.input.find(
        ({ type, call_id }) =>
          type === "function_call_output" &&
          call_id === `council-inventory-${key}-call-0`,
      );
      assert.ok(item, `Codex received inventory for ${key}`);
      return typeof item.output === "string"
        ? item.output
        : item.output.map(({ text }) => text).join("\n");
    };
    const body = (text) => {
      const prefix = "\nOutput:\n";
      const offset = text.indexOf(prefix);
      assert.notEqual(offset, -1, text);
      return text.slice(offset + prefix.length).trim();
    };
    const first = JSON.parse(body(output(next, "first"))).data;
    const second = JSON.parse(body(output(chats, "next"))).data;
    assert.equal(first.nextCursor, 1);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      [first.entries[0].id, second.entries[0].id].sort(),
      [localId, projectId].sort(),
    );
    assert.deepEqual(
      [first.entries[0], second.entries[0]].find(({ id }) => id === projectId),
      {
        ...wanted,
        id: projectId,
        kind: "project",
        status: "ready",
        title: projectTitle,
        permissionProfileId: null,
      },
    );
    const discoveredChats = JSON.parse(body(output(tasks, "chats"))).data;
    const discoveredTasks = JSON.parse(body(output(cli, "tasks"))).data;
    assert.ok(
      discoveredChats.entries.some(
        (entry) =>
          entry.id === ids.chat &&
          entry.title === chatTitle &&
          entry.workerId === remote,
      ),
    );
    assert.ok(
      discoveredTasks.entries.some(
        (entry) =>
          entry.id === ids.task &&
          entry.title === taskTitle &&
          entry.workerId === remote,
      ),
    );
    const shell = output(final, "cli");
    assert.match(shell, /Process exited with code 0/u);
    const rows = body(shell)
      .split(/\n(?=\{)/u)
      .map((result) => JSON.parse(result).data);
    assert.deepEqual(rows, [
      { ...second, entries: [...first.entries, ...second.entries] },
      discoveredChats,
      discoveredTasks,
    ]);
    await idle();
    assert.deepEqual(model.failures, []);
    result.councilInventory = {
      chatId,
      workerId,
      remoteWorkerId: remote,
      projectId,
      projectChatId: ids.chat,
      taskId: ids.task,
    };
    result.steps.push(
      "Council discovered a project, chat, and Task on another worker through managed MCP and the installed CLI",
    );
    if (accountMetadata) {
      await verifyCouncilAccountInventory({
        page,
        root,
        chatId,
        workerId,
        remoteWorkerId: remote,
        model,
        tool,
        terminal,
        submit,
        idle,
        result,
      });
    }
    if (projectMessages) {
      await actualCouncilProjectMessages({
        page,
        model,
        tools,
        submit,
        readChat,
        result,
        projectId,
        councilId: chatId,
        targetChatId: ids.chat,
        targetWorkerId: remote,
        workerId,
        projectApprovals,
        steeredApprovals,
        projectCreation,
        projectControls,
        projectSteering,
        steerRaceMarker,
        historyFault: projectReplyWithoutHistory ? fixture : undefined,
      });
    }
  } finally {
    result.workerStops.push(await worker.close());
    result.workerDiagnostics.push(worker.diagnostics());
  }
}
