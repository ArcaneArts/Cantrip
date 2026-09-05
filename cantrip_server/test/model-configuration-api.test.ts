import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  unprobedCodexRuntimeReport,
  workerCommandSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { computerUsePreviewAuthority } from "../src/app/routes/computer-use-preview.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-model-configuration-api-"),
);
const config: ServerConfig = {
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  appOrigins: ["http://127.0.0.1:5173"],
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  dataDirectory,
  deploymentMode: "local",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  workerToken: "model-configuration-api-worker-token",
};

let connected = true;
let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof buildApp>>;
let observedTurn: Extract<WorkerCommand, { type: "chat.turn" }> | null = null;

const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected() {
    return connected;
  },
  sendSurfaceFrame() {
    return false;
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames() {
    return () => undefined;
  },
  async request(_workerId, command) {
    if (command.type === "code.prepareAgentTurn") {
      return { prepared: true, sessions: [] };
    }
    if (command.type === "code.agentTurnState") {
      return { notifiedSessions: 0, refreshed: [], conflicts: [] };
    }
    if (command.type === "computer-use.preview.revoke") {
      return { closed: true };
    }
    if (command.type === "chat.turn") {
      observedTurn = command;
      throw new Error("Stop after capturing the routed turn.");
    }
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureLocalIdentity();
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  app = await buildApp({ config, database, logger: false, workerBridge });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("atomic model configuration API", () => {
  it("acquires standalone CUA authority with the actual durable generation and chat default", async () => {
    const workerId = "standalone-authority-worker";
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId,
      name: "Standalone authority fixture",
      platform: "darwin",
      architecture: "arm64",
      codexVersion: "0.149.0",
      codexRuntime: unprobedCodexRuntimeReport,
      standaloneChat: {
        protocolVersion: 1,
        scratch: {
          provision: true,
          resolve: true,
          archive: true,
          restore: true,
          remove: true,
          reconcile: true,
          routingHandles: true,
        },
        files: {
          list: true,
          read: true,
          write: true,
          remove: true,
          download: true,
          archive: true,
          networkShare: true,
        },
      },
      remoteSurfaces: {
        browser: false,
        transports: ["websocket"],
        maxSessions: 1,
      },
      startedAt: new Date().toISOString(),
    });
    await database.repository.updateSettings(LOCAL_USER_ID, {
      defaultPermissionProfileId: ":read-only",
      defaultChatPermissionProfileId: ":workspace",
    });
    const created = await database.repository.createStandaloneChat(
      LOCAL_USER_ID,
      protectedChatFields(),
      () => true,
    );
    const job = await database.repository.standaloneChatRootJobs.claimNext();
    expect(job?.job.id).toBe(created.provisionJob.id);
    await database.repository.standaloneChatRootJobs.completeProvision(
      job!.job.id,
      job!.commandId,
      {
        status: "ready",
        jobId: job!.job.id,
        attempt: job!.job.attempt,
        rootId: job!.job.rootId,
        chatId: created.chat.id,
        path: `ctrr_${"a".repeat(43)}`,
        displayPath: "Fixture scratch",
        reused: false,
      },
    );
    await database.repository.setChatPermissionProfile(
      LOCAL_USER_ID,
      created.chat.id,
      ":yolo",
    );
    await database.repository.setChatPermissionProfile(
      LOCAL_USER_ID,
      created.chat.id,
      null,
    );
    const before = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      created.chat.id,
    );
    expect(before?.computerUseAuthorityGeneration).toBeGreaterThan(1);
    const acquired = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      created.chat.id,
      "user",
      "CUA authority fixture",
    );
    expect(acquired).toMatchObject({
      contextKind: "standalone",
      computerUseAuthorityGeneration: before!.computerUseAuthorityGeneration,
      defaultPermissionProfileId: ":workspace",
      permissionProfileId: null,
    });
    expect(
      computerUsePreviewAuthority({
        ownerId: LOCAL_USER_ID,
        serverId: await database.repository.getOrCreateServerId(),
        context: acquired!,
      }),
    ).toMatchObject({
      workerId,
      chatId: created.chat.id,
      projectId: null,
      contextKind: "standalone",
      placementId: job!.job.rootId,
      generation: before!.computerUseAuthorityGeneration,
      profile: {
        selectedId: ":workspace",
        effectiveId: ":workspace",
        forcedByWorktreePolicy: false,
        usesDefault: true,
      },
    });
    await database.repository.finishChatExecutionLane(
      created.chat.id,
      acquired!.executionLaneId!,
      "idle",
    );
  });

  it("validates route pairs and carries the resolved child runtime to the worker", async () => {
    const workerId = "model-configuration-worker";
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId,
      name: "Model configuration worker",
      platform: "darwin",
      architecture: "arm64",
      codexVersion: "0.149.0",
      codexRuntime: {
        ...unprobedCodexRuntimeReport,
        nativeSubagents: {
          available: true,
          protocolVersion: 1,
          reason: null,
        },
      },
      managedFolders: {
        create: true,
        attachExisting: true,
        convertToGithub: true,
        remove: true,
      },
      remoteSurfaces: {
        browser: false,
        transports: ["websocket"],
        maxSessions: 1,
      },
      startedAt: new Date().toISOString(),
    });
    const createdProject = await database.repository.createManagedFolderProject(
      LOCAL_USER_ID,
      { workerId, ...protectedProjectFields() },
    );
    const setup = await database.repository.projectFolderSetupJobs.claimNext();
    if (!setup) throw new Error("Could not claim the folder setup job.");
    await database.repository.projectFolderSetupJobs.complete(
      setup.job.id,
      setup.commandId,
      {
        status: "ready",
        jobId: setup.job.id,
        attempt: setup.job.attempt,
        path: path.join(dataDirectory, "repository"),
        displayPath: "Model configuration",
        reused: false,
      },
    );
    const chat = await database.repository.createChat(
      LOCAL_USER_ID,
      createdProject.project.id,
      { ...protectedChatFields(), worktreeMode: "agent-managed" },
    );
    if (!chat) throw new Error("Could not create the test chat.");

    const providerA = await database.repository.createModelProvider(
      LOCAL_USER_ID,
      {
        name: "Provider A",
        kind: "openai-compatible",
        baseUrl: "https://provider-a.example.test/v1",
      },
    );
    const providerB = await database.repository.createModelProvider(
      LOCAL_USER_ID,
      {
        name: "Provider B",
        kind: "openai-compatible",
        baseUrl: "https://provider-b.example.test/v1",
      },
    );
    const root = await database.repository.createModelProfile(LOCAL_USER_ID, {
      name: "Root model",
      routes: [
        {
          providerId: providerA.id,
          modelName: "root-native",
          enabled: true,
        },
      ],
    });
    const child = await database.repository.createModelProfile(LOCAL_USER_ID, {
      name: "Child model",
      routes: [
        {
          providerId: providerA.id,
          modelName: "child-native",
          enabled: true,
        },
      ],
    });
    const incompatibleChild = await database.repository.createModelProfile(
      LOCAL_USER_ID,
      {
        name: "Incompatible child",
        routes: [
          {
            providerId: providerB.id,
            modelName: "other-child-native",
            enabled: true,
          },
        ],
      },
    );
    if (!root || !child || !incompatibleChild) {
      throw new Error("Could not create model profiles.");
    }

    const chatReasoningOptions = await app.inject({
      method: "GET",
      url: `/api/chats/${chat.id}/reasoning?modelId=${encodeURIComponent(root.id)}`,
    });
    expect(chatReasoningOptions.statusCode, chatReasoningOptions.body).toBe(
      200,
    );
    expect(chatReasoningOptions.json()).toMatchObject({
      modelId: root.id,
      options: [],
    });

    const settingsReasoningOptions = await app.inject({
      method: "GET",
      url: `/api/settings/models/${encodeURIComponent(root.id)}/reasoning`,
    });
    expect(
      settingsReasoningOptions.statusCode,
      settingsReasoningOptions.body,
    ).toBe(200);
    expect(settingsReasoningOptions.json()).toMatchObject({
      modelId: root.id,
      options: [],
    });

    const inherited = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/model-configuration`,
      payload: {
        modelId: root.id,
        reasoningEffort: null,
        customSubagentModel: false,
        subagentModelId: incompatibleChild.id,
        subagentReasoningEffort: "high",
      },
    });
    expect(inherited.statusCode, inherited.body).toBe(200);
    expect(inherited.json()).toMatchObject({
      customSubagentModel: false,
      subagentModelId: incompatibleChild.id,
      subagentReasoningEffort: "high",
    });

    const valid = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/model-configuration`,
      payload: {
        modelId: root.id,
        reasoningEffort: null,
        customSubagentModel: true,
        subagentModelId: child.id,
        subagentReasoningEffort: null,
      },
    });
    expect(valid.statusCode, valid.body).toBe(200);

    const legacyReasoning = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/reasoning`,
      payload: { reasoningEffort: null },
    });
    expect(legacyReasoning.statusCode, legacyReasoning.body).toBe(200);
    await expect(
      database.repository.getChatModelConfiguration(LOCAL_USER_ID, chat.id),
    ).resolves.toMatchObject({
      customSubagentModel: true,
      subagentModelId: child.id,
    });

    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/model-configuration`,
      payload: {
        modelId: root.id,
        reasoningEffort: null,
        customSubagentModel: true,
        subagentModelId: incompatibleChild.id,
        subagentReasoningEffort: null,
      },
    });
    expect(invalid.statusCode, invalid.body).toBe(409);
    expect(invalid.json()).toMatchObject({
      code: "provider-route-incompatible",
      field: "subagentModelId",
      retryable: false,
    });

    const invalidDefault = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: {
        defaultModelId: root.id,
        defaultReasoningEffort: null,
        defaultCustomSubagentModel: true,
        defaultSubagentModelId: incompatibleChild.id,
        defaultSubagentReasoningEffort: null,
      },
    });
    expect(invalidDefault.statusCode, invalidDefault.body).toBe(409);
    expect(invalidDefault.json()).toMatchObject({
      code: "provider-route-incompatible",
      field: "subagentModelId",
    });

    const unsupportedReasoning = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/model-configuration`,
      payload: {
        modelId: root.id,
        reasoningEffort: "high",
        customSubagentModel: false,
        subagentModelId: child.id,
        subagentReasoningEffort: null,
      },
    });
    expect(unsupportedReasoning.statusCode, unsupportedReasoning.body).toBe(
      409,
    );
    expect(unsupportedReasoning.json()).toMatchObject({
      code: "root-reasoning-unsupported",
      field: "reasoningEffort",
    });

    connected = false;
    const offline = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/model-configuration`,
      payload: {
        modelId: root.id,
        reasoningEffort: null,
        customSubagentModel: true,
        subagentModelId: child.id,
        subagentReasoningEffort: null,
      },
    });
    expect(offline.statusCode, offline.body).toBe(503);
    expect(offline.json()).toMatchObject({
      code: "worker-offline",
      retryable: true,
    });
    connected = true;

    await database.repository.updateSettings(LOCAL_USER_ID, {
      defaultPermissionProfileId: ":read-only",
    });
    for (const selectedProfile of [":yolo", null]) {
      observedTurn = null;
      await database.repository.setChatPermissionProfile(
        LOCAL_USER_ID,
        chat.id,
        selectedProfile,
      );
      const beforeDispatch = await database.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chat.id,
      );
      expect(beforeDispatch?.computerUseAuthorityGeneration).toBeGreaterThan(1);
      const protectedContent = {
        formatVersion: 1 as const,
        keyRevision: 1,
        envelope: {
          version: 1 as const,
          algorithm: "AES-256-GCM" as const,
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      };
      const message = {
        id: randomUUID(),
        classification: {
          role: "user" as const,
          mode: "default" as const,
          attachmentIds: [] as string[],
        },
        protectedContent,
        reasoningEffort: null,
        idempotencyKey: `custom-subagent-turn:${selectedProfile}`,
      };
      const turn = await app.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/turns`,
        payload: {
          message,
          modelId: root.id,
          queuedPrompt: {
            id: randomUUID(),
            classification: {
              mode: "default",
              attachmentIds: [],
            },
            protectedContent,
            modelId: root.id,
            reasoningEffort: null,
            customSubagentModel: true,
            subagentModelId: child.id,
            subagentReasoningEffort: null,
            worktreeId: null,
            frozen: false,
            idempotencyKey: `custom-subagent-turn:${selectedProfile}`,
            pendingMessage: message,
          },
        },
      });
      expect(turn.statusCode, turn.body).toBe(202);
      await expect.poll(() => observedTurn).not.toBeNull();
      expect(observedTurn?.subagentDefaults).toMatchObject({
        model: { id: child.id, name: "child-native" },
        provider: { id: providerA.id },
      });
      expect(observedTurn?.subagentProtocolVersion).toBe(1);
      expect(observedTurn?.computerUseAuthority).toEqual({
        ownerId: LOCAL_USER_ID,
        serverId: await database.repository.getOrCreateServerId(),
        workerId,
        chatId: chat.id,
        projectId: createdProject.project.id,
        contextKind: "project",
        placementId: beforeDispatch!.worktreeId,
        executionLaneId: observedTurn!.executionLaneId,
        generation: beforeDispatch!.computerUseAuthorityGeneration,
        profile: {
          selectedId: selectedProfile ?? ":read-only",
          effectiveId: selectedProfile ?? ":read-only",
          forcedByWorktreePolicy: false,
          usesDefault: selectedProfile === null,
        },
      });
      expect(
        workerCommandSchema.parse(JSON.parse(JSON.stringify(observedTurn))),
      ).toMatchObject({
        computerUseAuthority: observedTurn!.computerUseAuthority,
      });
      await expect
        .poll(
          async () =>
            (
              await database.repository.getChatExecutionContext(
                LOCAL_USER_ID,
                chat.id,
              )
            )?.status,
        )
        .toBe("failed");
    }
  });
});
