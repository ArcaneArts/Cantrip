import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import {
  workflowDefinitionGenerationResultSchema,
  workflowDefinitionListSchema,
} from "@cantrip/protocol/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-workflow-generation-"),
);
const projectPath = path.join(dataDirectory, "project");
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

let connected = true;
let malformed = false;
let generationCommand: Extract<
  WorkerCommand,
  { type: "workflow.definition.generate" }
> | null = null;

const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return connected && workerId === "test-worker";
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
    if (command.type !== "workflow.definition.generate") {
      throw new Error(`Unexpected worker command ${command.type}.`);
    }
    generationCommand = command;
    return {
      threadId: "codex-generation-thread",
      turnId: "codex-generation-turn",
      text: "Generated a workflow preview.",
      structuredResult: {
        slug: "review-change",
        name: "Review change",
        description: "Inspect and verify a change.",
        graphJson: JSON.stringify({
          version: 1,
          nodes: [
            {
              key: "review",
              type: "agent",
              name: "Review",
              configuration: malformed
                ? { prompt: "Review the project.", script: "process.exit(1)" }
                : { prompt: "Review the project." },
            },
          ],
          edges: [],
        }),
        declaredInputsJson: JSON.stringify({ type: "object" }),
        declaredOutputsJson: JSON.stringify({ type: "object" }),
        defaultsJson: "{}",
        permissionRequirementsJson: "{}",
      },
      measuredUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 10,
        totalTokens: 150,
        durationMs: 250,
        estimatedCostUsd: null,
        costAvailable: false,
      },
      status: "completed",
    };
  },
};

let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof buildApp>>;
let chatId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "test-worker",
    name: "Test Worker",
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
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "test-worker",
    ...protectedProjectFields(),
    repositoryId: "workflow-generation-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    project.id,
    "test-worker",
    {
      path: projectPath,
      displayPath: projectPath,
      reused: false,
      updated: false,
      warning: null,
    },
  );
  app = await buildApp({ config, database, logger: false, workerBridge });
  const chat = await database.repository.createChat(LOCAL_USER_ID, project.id, {
    title: "Generation runtime",
    worktreeMode: "agent-managed",
  });
  chatId = chat!.id;
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("workflow generation API", () => {
  it("returns a validated untrusted preview without persisting it", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/workflow-generation`,
      payload: {
        sourceType: "task",
        prompt: "Turn the review process into a reusable workflow.",
        scope: "project",
      },
    });

    expect(response.statusCode).toBe(200);
    const result = workflowDefinitionGenerationResultSchema.parse(
      response.json(),
    );
    expect(result.definition).toMatchObject({
      projectId: expect.any(String),
      slug: "review-change",
      source: "generated",
      trustState: "untrusted",
      revision: {
        source: "generated",
        trustState: "untrusted",
        graph: { nodes: [{ mutationMode: "read-only" }] },
      },
    });
    expect(result.definition.provenance).toMatchObject({
      origin: "generated",
      sourceId: result.generationId,
      reference: `chat:${chatId}`,
    });
    expect(generationCommand).toMatchObject({
      type: "workflow.definition.generate",
      cwd: projectPath,
      timeoutMs: 120_000,
    });
    expect(generationCommand?.developerInstructions).toContain("Never write");

    const workflows = workflowDefinitionListSchema.parse(
      (await app.inject({ method: "GET", url: "/api/workflows" })).json(),
    );
    expect(workflows).toEqual([]);
  });

  it("fails closed when Codex returns a graph outside the constrained schema", async () => {
    malformed = true;
    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/workflow-generation`,
      payload: {
        sourceType: "runbook",
        prompt: "Convert this runbook.",
      },
    });
    malformed = false;

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("valid workflow"),
    });
  });

  it("reports the worker boundary before dispatch", async () => {
    connected = false;
    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/workflow-generation`,
      payload: { sourceType: "task", prompt: "Generate a workflow." },
    });
    connected = true;
    expect(response).toMatchObject({ statusCode: 503 });
  });
});
