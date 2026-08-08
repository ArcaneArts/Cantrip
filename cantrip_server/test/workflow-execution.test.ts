import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  agentInteractionRequestListSchema,
  type WorkerCommand,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import {
  workflowDefinitionDetailSchema,
  workflowRunDetailSchema,
  workflowRunEventPageSchema,
} from "@cantrip/protocol/workflows";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { DEFAULT_MODEL_ROUTE_ID, LOCAL_USER_ID } from "../src/db/repository.js";
import type {
  WorkerCommandBus,
  WorkerRequestOptions,
} from "../src/workers/bridge.js";
import { WorkerUnavailableError } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-workflow-execution-"),
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
const deliveredAt = "2026-08-08T17:00:00.000Z";

type ExecutionMode = "disconnect" | "failure" | "interaction" | "success";

let connected = true;
let mode: ExecutionMode = "success";
let heldInteraction: (() => void) | null = null;
let heldEvent: WorkerRequestOptions["onEvent"] | undefined;
const executionCommands: Array<
  Extract<WorkerCommand, { type: "workflow.node.execute" }>
> = [];

function resultFor(
  command: Extract<WorkerCommand, { type: "workflow.node.execute" }>,
) {
  return {
    threadId: `thread-${command.attemptId}`,
    turnId: `turn-${command.attemptId}`,
    text: '{"approved":true}',
    structuredResult: { approved: true },
    measuredUsage: {
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
      totalTokens: 14,
      durationMs: 250,
      estimatedCostUsd: null,
      costAvailable: false,
    },
    status: "completed" as const,
  };
}

const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {
    connected = false;
    heldInteraction?.();
    heldInteraction = null;
  },
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
  async request(_workerId, command, options) {
    if (!connected) throw new WorkerUnavailableError("Worker disconnected.");
    if (command.type === "workflow.node.execute") {
      executionCommands.push(command);
      if (mode === "disconnect") {
        await options?.onEvent?.({
          type: "workflow.node.activity",
          attemptId: command.attemptId,
          activity: {
            type: "usage",
            id: `usage-${command.attemptId}`,
            status: "completed",
            total: {
              totalTokens: 8,
              inputTokens: 6,
              cachedInputTokens: 1,
              cacheWriteInputTokens: 0,
              outputTokens: 2,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 8,
              inputTokens: 6,
              cachedInputTokens: 1,
              cacheWriteInputTokens: 0,
              outputTokens: 2,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 10_000,
            contextUsedPercent: 0.1,
            correlation: {
              sourceMethod: "thread/tokenUsage/updated",
              diagnosticId: null,
              threadId: `thread-${command.attemptId}`,
              turnId: `turn-${command.attemptId}`,
              itemId: null,
            },
          },
        });
        connected = false;
        throw new WorkerUnavailableError("Worker disconnected.");
      }
      if (mode === "failure") {
        mode = "success";
        throw new Error("Codex turn failed at a durable boundary.");
      }
      await options?.onEvent?.({
        type: "workflow.node.activity",
        attemptId: command.attemptId,
        activity: {
          type: "reasoning",
          id: `reasoning-${command.attemptId}`,
          status: "completed",
          summary: ["Inspected the workflow input."],
          correlation: {
            sourceMethod: "item/completed",
            diagnosticId: null,
            threadId: `thread-${command.attemptId}`,
            turnId: `turn-${command.attemptId}`,
            itemId: `reasoning-${command.attemptId}`,
          },
        },
      });
      if (mode === "interaction") {
        heldEvent = options?.onEvent;
        await options?.onEvent?.({
          type: "workflow.node.interaction.requested",
          attemptId: command.attemptId,
          request: {
            requestKey: `request-${command.attemptId}`,
            threadId: `thread-${command.attemptId}`,
            turnId: `turn-${command.attemptId}`,
            itemId: `item-${command.attemptId}`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            payload: {
              kind: "fileChange",
              startedAtMs: Date.now(),
              reason: "Confirm the generated patch.",
              grantRoot: null,
            },
          },
        });
        await new Promise<void>((resolve) => {
          heldInteraction = resolve;
        });
        mode = "success";
      }
      return resultFor(command);
    }
    if (command.type === "agent.interaction.respond") {
      const active = executionCommands.at(-1)!;
      await heldEvent?.({
        type: "workflow.node.interaction.cleared",
        attemptId: active.attemptId,
        requestKey: command.requestKey,
      });
      heldInteraction?.();
      heldInteraction = null;
      return { accepted: true };
    }
    if (command.type === "agent.interaction.cancel") {
      heldInteraction?.();
      heldInteraction = null;
      return { accepted: true };
    }
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
let revisionId: string;

async function createRun(idempotencyKey: string) {
  return app.inject({
    method: "POST",
    url: "/api/workflow-runs",
    payload: {
      workflowRevisionId: revisionId,
      projectId,
      structuredInput: { target: "src" },
      budget: { maxAttemptsPerNode: 2, maxNodeDurationMs: 60_000 },
      permissionManifest: { filesystem: "read-only" },
      selectedModelRouteId: DEFAULT_MODEL_ROUTE_ID,
      selectedPermissionProfileId: null,
      trigger: {
        type: "manual",
        actorType: "user",
        actorId: LOCAL_USER_ID,
        deliveredAt,
        metadata: { test: true },
      },
      idempotencyKey,
    },
  });
}

async function runDetail(runId: string) {
  return workflowRunDetailSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: `/api/workflow-runs/${runId}`,
      })
    ).json(),
  );
}

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker({
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
    repositoryId: "workflow-execution-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "test-worker",
    {
      path: projectPath,
      displayPath: "ArcaneArts/Cantrip",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  app = await buildApp({ config, database, logger: false, workerBridge });
  const definition = workflowDefinitionDetailSchema.parse(
    (
      await app.inject({
        method: "POST",
        url: "/api/workflows",
        payload: {
          scope: "project",
          projectId,
          slug: "single-agent-execution",
          name: "Single agent execution",
          trustState: "trusted",
          revision: {
            graph: {
              version: 1,
              nodes: [
                {
                  key: "inspect",
                  type: "agent",
                  name: "Inspect",
                  configuration: {
                    prompt: "Inspect the requested target.",
                    developerInstructions: "Return the requested JSON only.",
                  },
                  outputSchema: {
                    type: "object",
                    properties: { approved: { type: "boolean" } },
                    required: ["approved"],
                  },
                },
              ],
            },
            trustState: "trusted",
          },
        },
      })
    ).json(),
  );
  revisionId = definition.revision!.id;
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("single-agent workflow execution", () => {
  it("persists worker progress, attribution, structured result, and usage", async () => {
    mode = "success";
    const before = executionCommands.length;
    const response = await createRun("execute-success");
    expect(response.statusCode).toBe(201);
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    const detail = await runDetail(runId);
    expect(executionCommands).toHaveLength(before + 1);
    expect(executionCommands.at(-1)).toMatchObject({
      type: "workflow.node.execute",
      workflowRunId: runId,
      cwd: projectPath,
      mutationMode: "read-only",
      prompt: expect.stringContaining('"target":"src"'),
    });
    expect(detail).toMatchObject({
      run: {
        status: "completed",
        structuredResult: { approved: true },
        measuredUsage: { totalTokens: 14, durationMs: 250 },
      },
      nodes: [
        {
          status: "completed",
          structuredResult: { approved: true },
          codexThreadId: expect.stringMatching(/^thread-/u),
          codexTurnId: expect.stringMatching(/^turn-/u),
        },
      ],
      attempts: [
        {
          attempt: 1,
          status: "completed",
          measuredUsage: { totalTokens: 14 },
        },
      ],
    });
    const events = workflowRunEventPageSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflow-runs/${runId}/events`,
        })
      ).json(),
    );
    expect(events.events.map(({ type }) => type)).toEqual([
      "run.created",
      "node.attempt.started",
      "workflow.node.activity",
      "node.attempt.completed",
    ]);

    const replay = await createRun("execute-success");
    expect(replay.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executionCommands).toHaveLength(before + 1);
  });

  it("retries terminal failures within the persisted attempt budget", async () => {
    mode = "failure";
    const before = executionCommands.length;
    const response = await createRun("execute-retry");
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    const detail = await runDetail(runId);
    expect(executionCommands).toHaveLength(before + 2);
    expect(
      detail.attempts.map(({ attempt, status }) => ({ attempt, status })),
    ).toEqual([
      { attempt: 1, status: "failed" },
      { attempt: 2, status: "completed" },
    ]);
  });

  it("routes durable workflow interactions back to the active runtime", async () => {
    mode = "interaction";
    const response = await createRun("execute-interaction");
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("waiting");
    });
    const executionsWhileWaiting = executionCommands.length;
    expect((await createRun("execute-interaction")).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executionCommands).toHaveLength(executionsWhileWaiting);
    const requests = agentInteractionRequestListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/api/agent-requests?status=pending",
        })
      ).json(),
    );
    const request = requests.find(
      ({ provenance }) => provenance.workflowRunId === runId,
    );
    expect(request).toMatchObject({
      status: "pending",
      provenance: { chatId: null, workflowRunId: runId },
    });
    const resolution = await app.inject({
      method: "POST",
      url: `/api/agent-requests/${request!.id}/respond`,
      payload: {
        response: { kind: "fileChange", decision: "accept" },
        idempotencyKey: "approve-workflow-change",
      },
    });
    expect(resolution.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
  });

  it("orphans a disconnected worker attempt without automatic duplication", async () => {
    mode = "disconnect";
    connected = true;
    const before = executionCommands.length;
    const response = await createRun("execute-disconnect");
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("recovering");
    });
    expect(await runDetail(runId)).toMatchObject({
      run: {
        recoveryState: "blocked",
        errorCode: "worker-disconnected",
        measuredUsage: { totalTokens: 8 },
      },
      nodes: [
        {
          status: "recovering",
          codexThreadId: expect.stringMatching(/^thread-/u),
        },
      ],
      attempts: [{ status: "orphaned", measuredUsage: { totalTokens: 8 } }],
    });
    connected = true;
    await createRun("execute-disconnect");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executionCommands).toHaveLength(before + 1);
  });

  it("orphans in-flight attempts during restart recovery", async () => {
    connected = false;
    mode = "success";
    const response = await createRun("execute-restart");
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("queued");
    });
    const candidate =
      await database.repository.workflowRuns.getSingleAgentCandidate(
        LOCAL_USER_ID,
        runId,
      );
    const source = await database.repository.getProjectSource(
      LOCAL_USER_ID,
      projectId,
    );
    expect(candidate).not.toBeNull();
    expect(source).not.toBeNull();
    const lease =
      await database.repository.workflowRuns.claimSingleAgentAttempt(
        LOCAL_USER_ID,
        candidate!,
        {
          cwd: source!.cwd,
          modelRouteId: DEFAULT_MODEL_ROUTE_ID,
          permissionProfileId: null,
          workerId: source!.workerId,
          worktreeId: source!.worktreeId,
        },
      );
    expect(lease).not.toBeNull();
    expect((await runDetail(runId)).run.status).toBe("running");

    await app.close();
    database = await connectDatabase(config);
    app = await buildApp({ config, database, logger: false, workerBridge });
    expect(await runDetail(runId)).toMatchObject({
      run: {
        status: "recovering",
        recoveryState: "blocked",
        errorCode: "server-restarted",
      },
      nodes: [{ status: "recovering" }],
      attempts: [{ status: "orphaned" }],
    });
    connected = true;
  });
});
