import assert from "node:assert/strict";
import path from "node:path";
import { eventually, launchActualWorker } from "./full-worker.mjs";
import { modelFunctions } from "./task-model-provider.mjs";

export const launchTaskBrief =
  "Read the local release checklist and report whether the migration is ready.";

export async function prepareLaunchProjects({
  page,
  fixture,
  root,
  cliBinary,
  workerId,
  remoteWorkerId,
  target,
  result,
  run,
}) {
  const enrollment = await page.evaluate(
    async (worker) =>
      (await import("/src/lib/api/workers.ts")).createWorkerEnrollmentCode({
        label: worker,
      }),
    remoteWorkerId,
  );
  const remote = launchActualWorker(
    fixture.workerFixture ?? fixture,
    path.join(root, fixture.kind, "council-launch-project-worker"),
    { workerId: remoteWorkerId, enrollmentCode: enrollment.code, cliBinary },
  );
  try {
    await remote.ready();
    if (fixture.workerFixture) await fixture.assertRemoteWorker(remoteWorkerId);
    const { projects, profileId } = await page.evaluate(
      async ({ workerId, remoteWorkerId, baseUrl, model }) => {
        const api = await import("/src/lib/api/models.ts");
        const provider = await api.createModelProvider({
          name: "Disposable release-project provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await api.createModelProfile({
          name: "Disposable release-project model",
          routes: [
            { providerId: provider.id, modelName: model, enabled: true },
          ],
        });
        await (
          await import("/src/lib/api/settings.ts")
        ).updateSettings({
          defaultModelId: profile.id,
        });
        const { getWorkers } = await import("/src/lib/api/worker-wire.ts");
        const workers = await getWorkers();
        const { ensureChatWorkerEncryption } =
          await import("/src/lib/chat-worker-encryption.ts");
        const projects = [];
        for (const [name, id] of [
          ["Local migration project", workerId],
          ["Remote release project", remoteWorkerId],
        ]) {
          await ensureChatWorkerEncryption({
            worker: workers.find(({ workerId }) => workerId === id),
          });
          projects.push(
            await window.folderCrypto.createManagedFolderProject({
              name,
              workerId: id,
            }),
          );
        }
        return { projects, profileId: profile.id };
      },
      {
        workerId,
        remoteWorkerId,
        baseUrl: target.baseUrl,
        model: target.model,
      },
    );
    for (const project of projects) {
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
    const [local, distant] = projects;
    const initial = target.reply({ text: "The remote release chat is ready." });
    const { targetChat, taskId } = await page.evaluate(
      async ({ localId, remoteId, profileId, brief }) => {
        const chats = await import("/src/lib/api/chats.ts");
        const tasks = await import("/src/lib/api/tasks.ts");
        const targetChat = await chats.createChat(
          remoteId,
          "Remote release agent",
        );
        await chats.updateChatPermissionProfile(targetChat.id, ":workspace");
        const { chat, task } = await tasks.createTask(
          localId,
          "Local migration checklist",
        );
        await tasks.updateTaskDraft(chat.id, {
          rowVersion: task.rowVersion,
          briefMarkdown: brief,
          planGoalEnabled: false,
        });
        await chats.startTurn(
          targetChat.id,
          "Prepare the release project chat.",
          {
            modelId: profileId,
            reasoningEffort: null,
            customSubagentModel: false,
            subagentModelId: null,
            subagentReasoningEffort: null,
          },
        );
        return { targetChat: targetChat.id, taskId: chat.id };
      },
      {
        localId: local.id,
        remoteId: distant.id,
        profileId,
        brief: launchTaskBrief,
      },
    );
    await eventually(
      () => initial.request?.completed,
      (complete) =>
        assert.equal(complete, true, JSON.stringify(target.failures)),
      60_000,
    );
    await eventually(
      () =>
        page.evaluate(
          async ({ projectId, chatId }) =>
            (
              await (await import("/src/lib/api/chats.ts")).getChats(projectId)
            ).find(({ id }) => id === chatId),
          { projectId: distant.id, chatId: targetChat },
        ),
      (chat) => assert.equal(chat?.status, "idle"),
      60_000,
    );
    const command = modelFunctions(initial.request.input.tools).find(
      ({ name }) => name === "exec_command",
    );
    assert.ok(
      command,
      "The remote release chat exposes the native command tool",
    );
    return await run({ local, distant, targetChat, taskId, command });
  } finally {
    result.workerStops.push(await remote.close());
    result.workerDiagnostics.push(remote.diagnostics());
  }
}
