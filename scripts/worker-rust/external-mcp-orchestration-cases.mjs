import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taskModelProvider } from "../server-rust/task-model-provider.mjs";

export async function verifyOrchestration({
  client,
  projectId,
  ownerVisit,
  eventually,
  connect,
  setLocalEnabled,
  verifyApp,
  actorLabel = "External orchestration fixture",
}) {
  const provider = await taskModelProvider();
  try {
    const configured = await ownerVisit(
      "POST",
      "/api/settings/providers",
      201,
      {
        name: "External MCP fixture provider",
        id: randomUUID(),
        kind: "openai-compatible",
        baseUrl: provider.baseUrl,
        protectedApiKey: null,
        initialAccount: null,
      },
    );
    const model = await ownerVisit("POST", "/api/settings/models", 201, {
      name: "External MCP fixture model",
      routes: [
        { providerId: configured.id, modelName: provider.model, enabled: true },
      ],
    });
    await ownerVisit("PATCH", "/api/settings", 200, {
      defaultModelId: model.id,
      autoNameChats: false,
    });
    const call = async (name, args) => {
      const reply = await client.callTool({
        name,
        arguments: { projectId, ...args },
      });
      assert.equal(reply.isError, undefined, JSON.stringify(reply.content));
      return reply.structuredContent;
    };
    const conflict = async (name, args) => {
      const reply = await client.callTool({
        name,
        arguments: { projectId, ...args },
      });
      assert.equal(reply.isError, true, JSON.stringify(reply.content));
      assert.match(reply.content[0].text, /operation ID.*different request/iu);
    };
    const appChats = () =>
      ownerVisit("GET", `/api/projects/${projectId}/chats`, 200);
    const create = {
      operationId: randomUUID(),
      title: "External orchestration agent",
    };
    let dropped;
    const lost = await connect(create.operationId, (receipt) => {
      dropped = receipt;
    });
    try {
      const controller = new AbortController();
      const abandoned = lost.callTool(
        { name: "agent_create", arguments: { projectId, ...create } },
        undefined,
        { signal: controller.signal },
      );
      const outcome = abandoned.then(
        (reply) => ({ reply }),
        (error) => ({ error }),
      );
      try {
        await Promise.race([
          eventually(async () => {
            assert.equal((await appChats()).length, 1);
            if (setLocalEnabled) assert.equal(dropped?.transport, "local");
          }),
          outcome.then(({ reply }) => {
            if (reply) throw new Error(JSON.stringify(reply.content));
          }),
        ]);
      } finally {
        controller.abort();
        const result = await outcome;
        assert.ok(result.error, JSON.stringify(result.reply?.content));
      }
    } finally {
      await lost.close();
    }
    setLocalEnabled?.(false);
    let agent;
    try {
      agent = await call("agent_create", create);
      assert.equal(agent.state, "created");
      assert.deepEqual(await call("agent_create", create), agent);
      if (setLocalEnabled) {
        assert.equal(agent.transport, "relay");
        assert.deepEqual(agent, { ...dropped, transport: "relay" });
      }
    } finally {
      setLocalEnabled?.(true);
    }
    await conflict("agent_create", { ...create, title: "Changed title" });
    assert.deepEqual(
      (await appChats()).map(({ id }) => id),
      [agent.chatId],
    );
    const { chatId } = agent;
    assert.equal((await call("agent_read", { chatId })).agent.chatId, chatId);
    const baseline = await call("chat_read", { chatId });
    provider.reply({ text: "The agent received the external message." });
    const input = {
      chatId,
      operationId: randomUUID(),
      message: "Confirm that my message arrived.",
    };
    const receipt = await call("chat_send", input);
    assert.match(receipt.delivery, /^(queued|running)$/u);
    assert.equal(receipt.actor.label, actorLabel);
    assert.deepEqual(await call("chat_send", input), receipt);
    await conflict("chat_send", { ...input, message: "A different message." });
    let cursor = baseline.cursor;
    let answered = false;
    for (let attempt = 0; attempt < 10 && !answered; attempt++) {
      const reply = await call("chat_wait", {
        chatId,
        afterCursor: cursor,
        timeoutMs: 5_000,
      });
      cursor = reply.cursor;
      answered = reply.messages.some(
        ({ role, text }) =>
          role === "assistant" &&
          text.includes("The agent received the external message."),
      );
    }
    assert.equal(answered, true, JSON.stringify(provider.failures));
    const history = await ownerVisit(
      "GET",
      `/api/chats/${chatId}/messages?limit=10`,
      200,
    );
    assert.equal(
      history.messages.filter(({ id }) => id === receipt.messageId).length,
      1,
    );
    provider.reply({ text: "The scheduled task is complete." });
    const taskInput = {
      operationId: randomUUID(),
      title: "External orchestration task",
      description: "Confirm that this task ran.",
    };
    const task = await call("task_create", taskInput);
    assert.deepEqual(await call("task_create", taskInput), task);
    await conflict("task_create", {
      ...taskInput,
      description: "A different task.",
    });
    let completed;
    for (let attempt = 0; attempt < 10; attempt++) {
      completed = await call("task_wait", {
        taskIds: [task.taskId],
        timeoutMs: 5_000,
      });
      if (completed.satisfied) break;
    }
    assert.equal(
      completed.tasks[0].state,
      "complete",
      JSON.stringify(provider.failures),
    );
    assert.equal(
      (await ownerVisit("GET", `/api/tasks/${task.taskId}`, 200)).state,
      "complete",
    );
    const draft = await call("task_create", {
      operationId: randomUUID(),
      title: "External orchestration draft",
      description: "Leave a draft and then start it.",
      start: false,
    });
    assert.equal(draft.task.state, "draft");
    provider.reply({ text: "The draft task has run." });
    const start = { operationId: randomUUID(), taskId: draft.taskId };
    const submitted = await call("task_start", start);
    assert.deepEqual(await call("task_start", start), submitted);
    await eventually(async () => {
      const status = await call("task_status", { taskIds: [draft.taskId] });
      assert.equal(status.tasks[0].state, "complete");
    });
    await verifyApp?.({ projectId, chatId, taskId: task.taskId });
  } finally {
    await provider.close();
  }
}

export async function startAppClient(directory) {
  const root = fileURLToPath(new URL("../../cantrip_app/", import.meta.url));
  const require = createRequire(path.join(root, "package.json"));
  const { createServer } = await import(require.resolve("vite"));
  const { chromium } = await import("playwright-core");
  const endpoint = "/__external_mcp_app_fixture";
  const vite = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    cacheDir: path.join(directory, "vite"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    optimizeDeps: {
      include: [
        "@capacitor/network",
        "@tauri-apps/api/dpi",
        "@tauri-apps/api/webviewWindow",
        "@tauri-apps/api/window",
      ],
    },
    plugins: [
      {
        name: "external-mcp-app-smoke",
        configureServer(server) {
          server.middlewares.use(endpoint, async (_request, response, next) => {
            try {
              const html = await server.transformIndexHtml(
                endpoint,
                "<!doctype html><html><head><title>Cantrip external MCP smoke</title></head><body></body></html>",
              );
              response.setHeader("content-type", "text/html");
              response.end(html);
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
  });
  let browser;
  try {
    await vite.listen();
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CANTRIP_TEST_BROWSER_BINARY || undefined,
    });
    const origin = new URL(vite.resolvedUrls.local[0]).origin;
    return {
      origin,
      async verify(input) {
        const page = await browser.newPage();
        try {
          await page.goto(origin + endpoint);
          const opened = await page.evaluate(
            async ({ serverUrl, password, projectId, chatId, taskId }) => {
              const servers = await import("/src/lib/server-connections.ts");
              const account = await import("/src/lib/api/account.ts");
              const session = await import("/src/lib/client-session.ts");
              const encryption = await import("/src/lib/account-encryption.ts");
              const chats = await import("/src/lib/api/chats.ts");
              const tasks = await import("/src/lib/api/tasks.ts");
              await servers.initializeServerConnections();
              const saved = await servers.saveServerConnection({
                name: "MCP smoke fixture",
                url: serverUrl,
              });
              await servers.selectServerConnection(saved.id);
              const bootstrap = await account.getServerBootstrap();
              const signedIn = await account.login({
                email: "external-mcp-0@example.invalid",
                password,
              });
              session.setClientSession({
                authMode: "accounts",
                serverId: bootstrap.server.id,
                user: signedIn.currentUser,
                csrfToken: signedIn.csrfToken,
                expiresAt: signedIn.expiresAt,
              });
              const access = await encryption.prepareClientEncryption({
                authMode: "accounts",
                identity: {
                  ownerId: signedIn.currentUser.id,
                  serverId: bootstrap.server.id,
                },
                password,
              });
              if (access.status !== "ready")
                throw new Error("Browser encryption could not be opened.");
              const rows = await chats.getChats(projectId);
              const task = await tasks.getTask(taskId);
              const messages = await chats.getMessages(chatId);
              return {
                agentTitle: rows.find(({ id }) => id === chatId)?.title,
                attributed: messages.some(
                  ({ role, content }) =>
                    role === "user" &&
                    content.some(
                      (item) =>
                        item.type === "text" &&
                        item.text.includes("External orchestration fixture"),
                    ),
                ),
                task: {
                  state: task.state,
                  title: rows.find(({ id }) => id === taskId)?.title,
                },
              };
            },
            input,
          );
          assert.deepEqual(opened, {
            agentTitle: "External orchestration agent",
            attributed: true,
            task: { state: "complete", title: "External orchestration task" },
          });
        } finally {
          await page.close();
        }
      },
      async close() {
        await browser.close();
        await vite.close();
      },
    };
  } catch (error) {
    await browser?.close();
    await vite.close();
    throw error;
  }
}
