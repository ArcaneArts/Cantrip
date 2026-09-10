import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type HTTPMethods } from "fastify";
import {
  unprobedCodexRuntimeReport,
  type NativeCommandReceipt,
} from "@cantrip/protocol";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import { createApplicationOwnerContext } from "../src/app/http/owner-context.js";
import { installComputerUseAgentRoutes } from "../src/app/routes/computer-use-agent.js";
import { installInternalNativeQueueRoutes } from "../src/app/routes/internal-native-queue.js";
import { installInternalNativeCommandRoutes } from "../src/app/routes/internal-native-commands.js";
import { installInternalNativeHistoryRoutes } from "../src/app/routes/internal-native-history.js";
import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

/** Real route authentication, admission, dispatch, event persistence and settlement.
 * Only live UI publication and the unrelated server prompt queue are inert. */
export async function createNativeCommandWorkerFixture(options: {
  cwd: string;
  modelBaseUrl: string;
  modelName?: string;
  computerUse?: boolean;
  providerName?: string;
  dispatchNextQueuedPrompt?: (chatId: string) => Promise<void>;
  publishChatInvalidation?: (chatId: string, resource: "chat-queue") => void;
}) {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-native-worker-authority-"),
  );
  const workerId = randomUUID();
  const serverId = randomUUID();
  const token = randomUUID();
  const config: ServerConfig = {
    agentModel: options.modelName ?? "gpt-5",
    agentModelProvider: "ollama",
    appOrigins: ["http://127.0.0.1:5173"],
    authMode: "none",
    bootstrapMode: "pnpm-dev",
    dataDirectory,
    deploymentMode: "local",
    host: "127.0.0.1",
    ollamaBaseUrl: options.modelBaseUrl,
    port: 4310,
    workerToken: token,
  };
  const database = await connectDatabase(config);
  const repository = database.repository;
  const app = Fastify();
  try {
    await repository.ensureLocalIdentity();
    await repository.ensureDefaultModelConfiguration(
      LOCAL_USER_ID,
      config.agentModel,
      options.modelBaseUrl,
    );
    const provider = await repository.createModelProvider(LOCAL_USER_ID, {
      name: options.providerName ?? "Native worker fixture provider",
      kind: "openai-compatible",
      baseUrl: options.modelBaseUrl,
    });
    const modelProfile = await repository.createModelProfile(LOCAL_USER_ID, {
      name: "Native worker fixture model",
      routes: [
        {
          providerId: provider.id,
          modelName: config.agentModel,
          enabled: true,
        },
      ],
    });
    if (!modelProfile)
      throw new Error("Could not create fixture model profile.");
    await repository.updateSettings(LOCAL_USER_ID, {
      defaultModelId: modelProfile.id,
      ...(options.computerUse
        ? { computerUseEnabled: true, defaultPermissionProfileId: ":yolo" }
        : {}),
    });
    const modelRuntime = await repository.getModelRuntime(
      LOCAL_USER_ID,
      modelProfile.id,
    );
    if (!modelRuntime)
      throw new Error("Could not resolve fixture model route.");
    await repository.recordWorker(LOCAL_USER_ID, {
      workerId,
      name: "Native command worker fixture",
      platform: "darwin",
      architecture: "arm64",
      codexVersion: "0.153.4",
      codexRuntime: unprobedCodexRuntimeReport,
      remoteSurfaces: {
        browser: false,
        transports: ["websocket"],
        maxSessions: 1,
      },
      startedAt: new Date().toISOString(),
    });
    const project = await repository.createGithubProject(LOCAL_USER_ID, {
      workerId,
      ...protectedProjectFields(),
      repositoryBlindIndex: "R".repeat(43),
      repositoryId: randomUUID(),
      nameWithOwner: "ArcaneArts/Cantrip",
      url: "https://github.com/ArcaneArts/Cantrip",
    });
    await repository.completeGithubProjectSetup(
      LOCAL_USER_ID,
      project.id,
      workerId,
      {
        path: options.cwd,
        displayPath: "Native command fixture",
        reused: false,
        updated: false,
        warning: null,
      },
    );
    const chat = await repository.createChat(LOCAL_USER_ID, project.id, {
      ...protectedChatFields(),
      worktreeMode: "agent-managed",
    });
    if (!chat) throw new Error("Could not create fixture chat.");
    const boot = await repository.startChatExecutionLane(
      LOCAL_USER_ID,
      chat.id,
      "user",
      "Fixture native session",
    );
    if (!boot?.executionLaneId)
      throw new Error("Could not create fixture execution lane.");
    await repository.finishChatExecutionLane(
      chat.id,
      boot.executionLaneId,
      "idle",
    );
    const context = await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chat.id,
    );
    if (!context || context.contextKind !== "project")
      throw new Error("Missing fixture project placement.");
    const ownerContext = createApplicationOwnerContext(config.authMode);
    installInternalNativeCommandRoutes(app, {
      config,
      serverId,
      repository,
      runAsOwner: ownerContext.runAsOwner,
      dispatchNextQueuedPrompt:
        options.dispatchNextQueuedPrompt ?? (async () => {}),
      live: {
        publishEncryptedChatMessage: () => {},
        publishTaskMessage: () => {},
        publishChatSummary: () => {},
        publishChatTurnBoundary: () => {},
        publishChatInvalidation: () => {},
      },
    });
    installInternalNativeQueueRoutes(app, {
      config,
      repository,
      runAsOwner: ownerContext.runAsOwner,
      dispatchNextQueuedPrompt:
        options.dispatchNextQueuedPrompt ?? (async () => {}),
      publishChatInvalidation: options.publishChatInvalidation ?? (() => {}),
    });
    installInternalNativeHistoryRoutes(app, {
      config,
      repository,
      runAsOwner: ownerContext.runAsOwner,
    });
    installComputerUseAgentRoutes(app, {
      config,
      serverId,
      repository,
      runAsOwner: ownerContext.runAsOwner,
    });
    await app.ready();
    const phases: Array<{
      phase: string;
      body: Record<string, any>;
      status: number;
      code: string | null;
    }> = [];
    const receipts = new Map<string, NativeCommandReceipt>();
    const nativeFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = await request.text();
      const response = await app.inject({
        method: request.method as HTTPMethods,
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers.entries()),
        ...(body ? { payload: body } : {}),
      });
      const result = response.json();
      phases.push({
        phase: url.pathname.split("/").at(-1) ?? "unknown",
        body: body ? JSON.parse(body) : {},
        status: response.statusCode,
        code: typeof result?.code === "string" ? result.code : null,
      });
      if (result?.receipt)
        receipts.set(result.receipt.operationId, result.receipt);
      return new Response(response.body, {
        status: response.statusCode,
        headers: {
          "content-type": String(
            response.headers["content-type"] ?? "application/json",
          ),
        },
      });
    };
    return {
      ownerId: LOCAL_USER_ID,
      workerId,
      serverId,
      token,
      chatId: chat.id,
      projectId: project.id,
      project,
      placementId: context.worktreeId,
      worktreeId: context.worktreeId,
      cwd: context.cwd,
      context,
      modelRuntime,
      serverUrl: "http://native-authority.test",
      database,
      repository,
      app,
      phases,
      receipts,
      inject: app.inject.bind(app),
      fetch: nativeFetch,
      async bindThread(threadId: string) {
        await repository.updateChatRuntime(
          chat.id,
          workerId,
          context.worktreeId,
          threadId,
          modelRuntime.routeId,
          "ready",
          null,
        );
        return repository.getChatExecutionContext(LOCAL_USER_ID, chat.id);
      },
      async close() {
        await app.close();
        await database.close();
        await rm(dataDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await app.close();
    await database.close();
    await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }
}
