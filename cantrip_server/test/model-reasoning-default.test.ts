import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

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

describe.sequential("remembered model reasoning defaults", () => {
  it("seeds newly selected chats without rewriting existing chats", async () => {
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId: "reasoning-worker",
      name: "Reasoning Worker",
      platform: "darwin",
      architecture: "arm64",
      codexVersion: "0.146.1",
      codexRuntime: unprobedCodexRuntimeReport,
      remoteSurfaces: {
        browser: false,
        transports: ["websocket"],
        maxSessions: 1,
      },
      startedAt: new Date().toISOString(),
    });
    const project = await database.repository.createGithubProject(
      LOCAL_USER_ID,
      {
        workerId: "reasoning-worker",
        repositoryId: "reasoning-repository",
        nameWithOwner: "ArcaneArts/Reasoning",
        url: "https://github.com/ArcaneArts/Reasoning",
      },
    );
    await database.repository.completeGithubProjectSetup(
      LOCAL_USER_ID,
      project.id,
      "reasoning-worker",
      {
        path: path.join(dataDirectory, "repository"),
        displayPath: "ArcaneArts/Reasoning",
        reused: false,
        updated: false,
        warning: null,
      },
    );
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

    const firstChat = await database.repository.createChat(
      LOCAL_USER_ID,
      project.id,
      { title: "First", worktreeMode: "agent-managed" },
    );
    const secondChat = await database.repository.createChat(
      LOCAL_USER_ID,
      project.id,
      { title: "Second", worktreeMode: "agent-managed" },
    );
    if (!firstChat || !secondChat) throw new Error("Could not create chats.");

    await database.repository.setChatModel(LOCAL_USER_ID, firstChat.id, {
      modelId: model.id,
    });
    await database.repository.setChatReasoningEffortAndRememberDefault(
      LOCAL_USER_ID,
      firstChat.id,
      model.id,
      "high",
    );

    expect(
      await database.repository.getModelReasoningDefault(
        LOCAL_USER_ID,
        model.id,
      ),
    ).toBe("high");
    expect(
      (await database.repository.getSettings(LOCAL_USER_ID)).models.find(
        ({ id }) => id === model.id,
      )?.defaultReasoningEffort,
    ).toBe("high");
    expect(
      (
        await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          secondChat.id,
        )
      )?.reasoningEffort,
    ).toBeNull();

    const remembered = await database.repository.getModelReasoningDefault(
      LOCAL_USER_ID,
      model.id,
    );
    await database.repository.setChatModel(
      LOCAL_USER_ID,
      secondChat.id,
      { modelId: model.id },
      remembered,
    );
    await database.repository.setChatReasoningEffortAndRememberDefault(
      LOCAL_USER_ID,
      firstChat.id,
      model.id,
      "low",
    );

    expect(
      (
        await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          secondChat.id,
        )
      )?.reasoningEffort,
    ).toBe("high");
    expect(
      await database.repository.getModelReasoningDefault(
        LOCAL_USER_ID,
        model.id,
      ),
    ).toBe("low");
  });
});
