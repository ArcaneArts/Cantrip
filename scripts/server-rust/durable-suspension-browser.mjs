// Existing encrypted browser SDKs against a real server and production worker.
import assert from "node:assert/strict";
import { createPasswordKdfParameters } from "../../packages/crypto/src/index.ts";
import { eventually } from "./full-worker.mjs";

export async function enrollSuspensionBrowser(
  page,
  serverUrl,
  workerId,
  password,
) {
  return page.evaluate(
    async ({ serverUrl, workerId, password, passwordKdf }) => {
      const servers = await import("/src/lib/server-connections.ts");
      const account = await import("/src/lib/api/account.ts");
      await servers.initializeServerConnections();
      const saved = await servers.saveServerConnection({
        name: "Suspension acceptance",
        url: serverUrl,
      });
      await servers.selectServerConnection(saved.id);
      const bootstrap = await account.getServerBootstrap();
      const registered = await account.registerAccount({
        email: "suspension@example.invalid",
        displayName: "Suspension acceptance",
        password,
      });
      (await import("/src/lib/client-session.ts")).setClientSession({
        authMode: "accounts",
        serverId: bootstrap.server.id,
        user: registered.currentUser,
        csrfToken: registered.csrfToken,
        expiresAt: registered.expiresAt,
      });
      const access = await (
        await import("/src/lib/account-encryption.ts")
      ).prepareClientEncryption({
        authMode: "accounts",
        identity: {
          ownerId: registered.currentUser.id,
          serverId: bootstrap.server.id,
        },
        password,
        passwordKdf,
      });
      if (access.status !== "ready")
        throw new Error("Browser encryption: " + access.status);
      const { AppLiveClient, appLiveWebSocketUrl } =
        await import("/src/lib/app-live-client.ts");
      window.suspensionEvents = [];
      window.suspensionLive = new AppLiveClient({
        client: {
          id: "suspension-browser",
          name: "Suspension acceptance",
          version: "1",
        },
        storage: localStorage,
        storageKey: "suspension-browser-resume",
        url: appLiveWebSocketUrl(serverUrl, location.origin),
        onEvent: (event) => window.suspensionEvents.push(event),
        onResync: async () => {},
      });
      window.suspensionLive.retainScope({ kind: "current-user" });
      window.suspensionLive.start();
      return (
        await import("/src/lib/api/workers.ts")
      ).createWorkerEnrollmentCode({
        label: workerId,
        expiresInSeconds: 300,
      });
    },
    {
      serverUrl,
      workerId,
      password,
      passwordKdf: createPasswordKdfParameters({
        memoryKiB: 8192,
        iterations: 1,
      }),
    },
  );
}

export async function prepareSuspensionChat(
  page,
  workerId,
  directory,
  model,
  { maxConcurrentInference, taskOrigin = false } = {},
) {
  await eventually(
    () =>
      page.evaluate(async () =>
        (await import("/src/lib/api/worker-wire.ts")).getWorkers(),
      ),
    (workers) =>
      assert.equal(workers.find((w) => w.workerId === workerId)?.online, true),
  );
  const project = await page.evaluate(
    async ({ workerId, directory }) =>
      (
        await import("/src/lib/project-encryption.ts")
      ).createManagedFolderProject({
        name: "Durable suspension project",
        workerId,
        existingPath: directory,
      }),
    { workerId, directory },
  );
  await eventually(
    () =>
      page.evaluate(
        async (id) =>
          (
            await import("/src/lib/api/project-replicas.ts")
          ).getProjectFolderSetupJob(id),
        project.id,
      ),
    (job) => assert.equal(job.state, "succeeded", JSON.stringify(job)),
  );
  return page.evaluate(
    async ({
      projectId,
      workerId,
      baseUrl,
      nativeModel,
      maxConcurrentInference,
      taskOrigin,
    }) => {
      const models = await import("/src/lib/api/models.ts");
      const provider = await models.createModelProvider({
        name: "Durable suspension provider",
        kind: "openai-compatible",
        baseUrl,
        apiKey: null,
        ...(maxConcurrentInference ? { maxConcurrentInference } : {}),
      });
      const profile = await models.createModelProfile({
        name: "Durable suspension model",
        routes: [
          { providerId: provider.id, modelName: nativeModel, enabled: true },
        ],
      });
      await (
        await import("/src/lib/api/settings.ts")
      ).updateSettings({
        defaultModelId: profile.id,
        defaultWorkerId: workerId,
        defaultChatPermissionProfileId: ":workspace",
        autoNameChats: false,
        autoNameTasks: false,
      });
      const worker = (
        await (await import("/src/lib/api/worker-wire.ts")).getWorkers()
      ).find((w) => w.workerId === workerId);
      await (
        await import("/src/lib/chat-worker-encryption.ts")
      ).ensureChatWorkerEncryption({ worker });
      await (
        await import("/src/lib/private-label-worker-encryption.ts")
      ).ensurePrivateLabelWorkerEncryption({ worker });
      await (
        await import("/src/lib/surface-private-state-worker-encryption.ts")
      ).ensureSurfacePrivateStateWorkerEncryption({ worker });
      let chat, task;
      if (taskOrigin) {
        await (
          await import("/src/lib/task-worker-encryption.ts")
        ).ensureTaskWorkerEncryption({ worker });
        const tasks = await import("/src/lib/api/tasks.ts");
        const created = await tasks.createTask(projectId, "Durable suspension");
        chat = created.chat;
        task = await tasks.updateTaskDraft(chat.id, {
          rowVersion: created.task.rowVersion,
          briefMarkdown: "DURABLE_ORIGINAL_PROMPT",
        });
      } else {
        const create = await (
          await import("/src/lib/api/conversations.ts")
        ).prepareConversationCreation(projectId, "Durable suspension", false);
        chat = await create();
      }
      window.suspensionLive.retainScope({ kind: "project", projectId });
      window.suspensionLive.retainScope({ kind: "chat", chatId: chat.id });
      return {
        chat,
        ...(task ? { task } : {}),
        projectId,
        providerId: provider.id,
        configuration: {
          modelId: profile.id,
          reasoningEffort: null,
          customSubagentModel: false,
          subagentModelId: null,
          subagentReasoningEffort: null,
        },
      };
    },
    {
      projectId: project.id,
      workerId,
      baseUrl: model.baseUrl,
      nativeModel: model.model,
      maxConcurrentInference,
      taskOrigin,
    },
  );
}

export function suspensionChat(page, projectId, chatId) {
  return page.evaluate(
    async ({ projectId, chatId }) =>
      (await (await import("/src/lib/api/chats.ts")).getChats(projectId)).find(
        (c) => c.id === chatId,
      ),
    { projectId, chatId },
  );
}

export async function steerSuspensionChat(page, chatId, configuration, text) {
  return page.evaluate(
    async ({ chatId, configuration, text }) => {
      const queued = await (
        await import("/src/lib/api/chats.ts")
      ).startTurn(chatId, text, configuration);
      if (queued.status !== "queued")
        throw new Error("Steering requires the existing active turn");
      return (await import("/src/lib/api/queue.ts")).steerQueuedPrompt(
        queued.prompt.id,
        queued.prompt.revision,
      );
    },
    { chatId, configuration, text },
  );
}
