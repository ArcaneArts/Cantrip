import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  queuedPromptOpaqueContentSchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-model-reasoning-default-"),
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
  workerToken: "test-worker-token",
};

let database: DatabaseConnection;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureLocalIdentity();
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
});

afterAll(async () => {
  await database?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("durable chat model configuration", () => {
  it("copies account defaults into new chats without rewriting existing chats", async () => {
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId: "reasoning-worker",
      name: "Reasoning Worker",
      platform: "darwin",
      architecture: "arm64",
      codexVersion: "0.146.1",
      codexRuntime: unprobedCodexRuntimeReport,
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
      {
        workerId: "reasoning-worker",
        ...protectedProjectFields(),
      },
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
        displayPath: "Reasoning",
        reused: false,
      },
    );
    const project = createdProject.project;
    const provider = await database.repository.createModelProvider(
      LOCAL_USER_ID,
      {
        name: "Reasoning provider",
        kind: "openai-compatible",
        baseUrl: "https://models.example.test/v1",
      },
    );
    const model = await database.repository.createModelProfile(LOCAL_USER_ID, {
      name: "Reasoning model",
      routes: [
        {
          providerId: provider.id,
          modelName: "reasoning-model",
          enabled: true,
        },
      ],
    });
    if (!model) throw new Error("Could not create reasoning model.");

    await database.repository.updateSettings(LOCAL_USER_ID, {
      defaultModelId: model.id,
      defaultReasoningEffort: "high",
      defaultCustomSubagentModel: true,
      defaultSubagentModelId: model.id,
      defaultSubagentReasoningEffort: "medium",
    });

    const firstChat = await database.repository.createChat(
      LOCAL_USER_ID,
      project.id,
      { ...protectedChatFields(), worktreeMode: "agent-managed" },
    );
    if (!firstChat) throw new Error("Could not create the first chat.");
    expect(firstChat).toMatchObject({
      modelId: model.id,
      reasoningEffort: "high",
      customSubagentModel: true,
      subagentModelId: model.id,
      subagentReasoningEffort: "medium",
    });

    const updatedFirstChat =
      await database.repository.setChatModelConfiguration(
        LOCAL_USER_ID,
        firstChat.id,
        {
          modelId: model.id,
          reasoningEffort: "high",
          customSubagentModel: false,
          subagentModelId: model.id,
          subagentReasoningEffort: "medium",
        },
      );
    expect(updatedFirstChat).toMatchObject({
      modelId: model.id,
      reasoningEffort: "high",
      customSubagentModel: false,
      subagentModelId: model.id,
      subagentReasoningEffort: "medium",
    });
    await expect(
      database.repository.getChatModelConfiguration(
        LOCAL_USER_ID,
        firstChat.id,
      ),
    ).resolves.toEqual({
      modelId: model.id,
      reasoningEffort: "high",
      customSubagentModel: false,
      subagentModelId: model.id,
      subagentReasoningEffort: "medium",
    });

    await database.repository.updateSettings(LOCAL_USER_ID, {
      defaultReasoningEffort: "low",
      defaultCustomSubagentModel: false,
    });

    const secondChat = await database.repository.createChat(
      LOCAL_USER_ID,
      project.id,
      { ...protectedChatFields(), worktreeMode: "agent-managed" },
    );
    if (!secondChat) throw new Error("Could not create the second chat.");
    expect(secondChat).toMatchObject({
      modelId: model.id,
      reasoningEffort: "low",
      customSubagentModel: false,
      subagentModelId: model.id,
      subagentReasoningEffort: "medium",
    });

    const classification = {
      mode: "default" as const,
      attachmentIds: [] as string[],
    };
    const pendingMessage = {
      id: "11111111-1111-4111-8111-111111111111",
      classification: { role: "user" as const, ...classification },
      protectedContent: {
        formatVersion: 1 as const,
        keyRevision: 1,
        envelope: {
          version: 1 as const,
          algorithm: "AES-256-GCM" as const,
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
      reasoningEffort: "low",
      idempotencyKey: "subagent-queue-snapshot",
    };
    const queued = await database.repository.createEncryptedQueuedPrompt(
      LOCAL_USER_ID,
      secondChat.id,
      queuedPromptOpaqueContentSchema.parse({
        id: "22222222-2222-4222-8222-222222222222",
        classification,
        protectedContent: pendingMessage.protectedContent,
        modelId: model.id,
        reasoningEffort: "low",
        customSubagentModel: true,
        subagentModelId: model.id,
        subagentReasoningEffort: "medium",
        worktreeId: null,
        frozen: false,
        idempotencyKey: "subagent-queue-snapshot",
        pendingMessage,
      }),
      [],
    );
    expect(queued).toMatchObject({
      customSubagentModel: true,
      subagentModelId: model.id,
      subagentReasoningEffort: "medium",
    });

    await database.repository.setChatReasoningEffortAndRememberDefault(
      LOCAL_USER_ID,
      firstChat.id,
      model.id,
      "medium",
    );

    expect(
      await database.repository.getModelReasoningDefault(
        LOCAL_USER_ID,
        model.id,
      ),
    ).toBeNull();
    expect(
      (
        await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          firstChat.id,
        )
      )?.modelConfiguration,
    ).toEqual({
      modelId: model.id,
      reasoningEffort: "medium",
      customSubagentModel: false,
      subagentModelId: model.id,
      subagentReasoningEffort: "medium",
    });
    expect(
      (
        await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          secondChat.id,
        )
      )?.reasoningEffort,
    ).toBe("low");
  });
});
