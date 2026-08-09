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

type ExecutionMode =
  | "disconnect"
  | "failure"
  | "hold-failure"
  | "hold-success"
  | "interaction"
  | "map-sibling-failure"
  | "map-terminal-failure"
  | "parallel"
  | "parallel-hold"
  | "pipeline-terminal-failure"
  | "sibling-failure"
  | "success"
  | "token-budget"
  | "terminal-failure";

let connected = true;
let mode: ExecutionMode = "success";
let heldInteraction: (() => void) | null = null;
let heldExecution: (() => void) | null = null;
let heldEvent: WorkerRequestOptions["onEvent"] | undefined;
let parallelInFlight = 0;
let parallelPeak = 0;
let parallelWaiters: Array<() => void> = [];
let parallelBarrierReleased = false;
const heldParallelExecutions = new Map<string, () => void>();
let awaitAlphaFailure: Promise<void> | null = null;
let triggerAlphaFailure: (() => void) | null = null;
let releaseLateSibling: (() => void) | null = null;
const executionCommands: Array<
  Extract<WorkerCommand, { type: "workflow.node.execute" }>
> = [];
const interruptCommands: Array<
  Extract<WorkerCommand, { type: "workflow.node.interrupt" }>
> = [];

function resultFor(
  command: Extract<WorkerCommand, { type: "workflow.node.execute" }>,
) {
  const inputMarker = "Structured workflow input (JSON):\n";
  const inputOffset = command.prompt.lastIndexOf(inputMarker);
  const structuredInput =
    inputOffset === -1
      ? null
      : (JSON.parse(
          command.prompt.slice(inputOffset + inputMarker.length),
        ) as Record<string, unknown>);
  const structuredResult = command.prompt.includes("Map collection item")
    ? { mapped: structuredInput?.item }
    : command.prompt.includes("Pipeline inspect step")
      ? { inspected: structuredInput?.item }
      : command.prompt.includes("Pipeline summarize step")
        ? { summary: structuredInput?.inspected }
        : command.prompt.includes("Repeat until stable")
          ? {
              progress: Number(structuredInput?.progress ?? 0) + 1,
              done: Number(structuredInput?.progress ?? 0) + 1 >= 3,
            }
          : command.prompt.includes("Repeat without progress")
            ? { progress: "same", done: false }
            : command.prompt.includes("Repeat through iteration limit")
              ? {
                  progress: Number(structuredInput?.progress ?? 0) + 1,
                  done: false,
                }
              : command.prompt.includes("Repeat through duration limit")
                ? { progress: 1, done: true }
                : command.prompt.includes("Reduce mapped collection")
                  ? { summary: "mapped" }
                  : command.prompt.includes("Alpha branch")
                    ? { finding: "alpha" }
                    : command.prompt.includes("Beta branch")
                      ? { finding: "beta" }
                      : command.prompt.includes("Gamma branch")
                        ? { finding: "gamma" }
                        : command.prompt.includes("Synthesize branches")
                          ? { summary: "combined" }
                          : command.prompt.includes("Collect nested findings")
                            ? { payload: { findings: [{ finding: "nested" }] } }
                            : command.prompt.includes(
                                  "Synthesize selected findings",
                                )
                              ? { summary: "selected" }
                              : command.prompt.includes("Verify failing")
                                ? { passed: false }
                                : command.prompt.includes("Verify passing")
                                  ? { passed: true }
                                  : { approved: true };
  const costAvailable = command.prompt.includes("Costed analysis");
  return {
    threadId:
      command.prompt.includes("Repeat ") && command.threadId
        ? command.threadId
        : `thread-${command.attemptId}`,
    turnId: `turn-${command.attemptId}`,
    text: JSON.stringify(structuredResult),
    structuredResult,
    measuredUsage: {
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
      totalTokens: 14,
      durationMs: 250,
      estimatedCostUsd: costAvailable ? 0.6 : null,
      costAvailable,
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
    heldExecution?.();
    heldExecution = null;
    for (const release of heldParallelExecutions.values()) release();
    heldParallelExecutions.clear();
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
      if (mode === "token-budget") {
        const released = new Promise<void>((resolve) => {
          heldExecution = resolve;
        });
        await options?.onEvent?.({
          type: "workflow.node.activity",
          attemptId: command.attemptId,
          activity: {
            type: "usage",
            id: `budget-usage-${command.attemptId}`,
            status: "completed",
            total: {
              totalTokens: 14,
              inputTokens: 10,
              cachedInputTokens: 2,
              cacheWriteInputTokens: 0,
              outputTokens: 4,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 14,
              inputTokens: 10,
              cachedInputTokens: 2,
              cacheWriteInputTokens: 0,
              outputTokens: 4,
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
        await released;
        heldExecution = null;
        mode = "success";
        return resultFor(command);
      }
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
        await options?.onEvent?.({
          type: "workflow.node.activity",
          attemptId: command.attemptId,
          activity: {
            type: "usage",
            id: `failed-usage-${command.attemptId}`,
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
        mode = "success";
        throw new Error("Codex turn failed at a durable boundary.");
      }
      if (mode === "terminal-failure") {
        throw new Error("Codex turn failed at a durable boundary.");
      }
      if (
        mode === "map-terminal-failure" &&
        command.prompt.includes("Map collection item") &&
        command.prompt.includes('"item":"bad"')
      ) {
        throw new Error("The selected map item failed.");
      }
      if (
        mode === "pipeline-terminal-failure" &&
        command.prompt.includes("Pipeline summarize step") &&
        command.prompt.includes('"inspected":"bad"')
      ) {
        throw new Error("The selected pipeline step failed.");
      }
      if (
        (mode === "sibling-failure" &&
          command.prompt.includes("Alpha branch")) ||
        (mode === "map-sibling-failure" &&
          command.prompt.includes('"item":"bad"'))
      ) {
        await awaitAlphaFailure;
        throw new Error("Alpha failed while its sibling was active.");
      }
      if (
        (mode === "sibling-failure" &&
          command.prompt.includes("Beta branch")) ||
        (mode === "map-sibling-failure" &&
          command.prompt.includes('"item":"late"'))
      ) {
        await options?.onEvent?.({
          type: "workflow.node.activity",
          attemptId: command.attemptId,
          activity: {
            type: "reasoning",
            id: `late-start-${command.attemptId}`,
            status: "completed",
            summary: ["The late sibling started."],
            correlation: {
              sourceMethod: "item/completed",
              diagnosticId: null,
              threadId: `thread-${command.attemptId}`,
              turnId: `turn-${command.attemptId}`,
              itemId: `late-start-${command.attemptId}`,
            },
          },
        });
        triggerAlphaFailure?.();
        triggerAlphaFailure = null;
        await new Promise<void>((resolve) => {
          releaseLateSibling = resolve;
        });
        await options?.onEvent?.({
          type: "workflow.node.activity",
          attemptId: command.attemptId,
          activity: {
            type: "usage",
            id: `late-usage-${command.attemptId}`,
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
      if (
        mode === "parallel" &&
        (command.prompt.includes("Alpha branch") ||
          command.prompt.includes("Beta branch") ||
          command.prompt.includes("Gamma branch") ||
          command.prompt.includes("Map collection item") ||
          command.prompt.includes("Pipeline inspect step"))
      ) {
        parallelInFlight += 1;
        parallelPeak = Math.max(parallelPeak, parallelInFlight);
        if (!parallelBarrierReleased) {
          await new Promise<void>((resolve) => {
            parallelWaiters.push(resolve);
            if (parallelWaiters.length === 2) {
              parallelBarrierReleased = true;
              const waiters = parallelWaiters;
              parallelWaiters = [];
              for (const release of waiters) release();
            }
          });
        }
        parallelInFlight -= 1;
      }
      if (
        mode === "parallel-hold" &&
        (command.prompt.includes("Alpha branch") ||
          command.prompt.includes("Beta branch") ||
          command.prompt.includes("Map collection item"))
      ) {
        await new Promise<void>((resolve) => {
          heldParallelExecutions.set(command.attemptId, resolve);
        });
        heldParallelExecutions.delete(command.attemptId);
      }
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
      if (mode === "hold-success") {
        await new Promise<void>((resolve) => {
          heldExecution = resolve;
        });
        heldExecution = null;
        mode = "success";
      }
      if (mode === "hold-failure") {
        await new Promise<void>((resolve) => {
          heldExecution = resolve;
        });
        heldExecution = null;
        mode = "success";
        throw new Error("Codex turn failed after the run was paused.");
      }
      return resultFor(command);
    }
    if (command.type === "workflow.node.interrupt") {
      interruptCommands.push(command);
      heldExecution?.();
      heldParallelExecutions.get(command.attemptId)?.();
      releaseLateSibling?.();
      releaseLateSibling = null;
      return { interrupted: true };
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
  return createRunForRevision(revisionId, idempotencyKey);
}

async function createRunForRevision(
  workflowRevisionId: string,
  idempotencyKey: string,
  budget: Record<string, unknown> = {},
  structuredInput: Record<string, unknown> = { target: "src" },
) {
  return app.inject({
    method: "POST",
    url: "/api/workflow-runs",
    payload: {
      workflowRevisionId,
      projectId,
      structuredInput,
      budget: {
        maxAttemptsPerNode: 2,
        maxNodeDurationMs: 60_000,
        ...budget,
      },
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

async function createWorkflowRevision(
  slug: string,
  nodes: unknown[],
  edges: unknown[] = [],
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/workflows",
    payload: {
      scope: "project",
      projectId,
      slug,
      name: slug,
      trustState: "trusted",
      revision: {
        graph: { version: 1, nodes, edges },
        trustState: "trusted",
      },
    },
  });
  expect(response.statusCode).toBe(201);
  return workflowDefinitionDetailSchema.parse(response.json()).revision!.id;
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

  it("runs independent roots in parallel and durably reduces their mapped results", async () => {
    const staticRevision = await createWorkflowRevision(
      "parallel-static-dag",
      [
        {
          key: "alpha",
          type: "agent",
          name: "Alpha",
          configuration: { prompt: "Alpha branch." },
          outputSchema: { type: "object" },
        },
        {
          key: "beta",
          type: "agent",
          name: "Beta",
          configuration: { prompt: "Beta branch." },
          outputSchema: { type: "object" },
        },
        {
          key: "gamma",
          type: "agent",
          name: "Gamma",
          configuration: { prompt: "Gamma branch." },
          outputSchema: { type: "object" },
        },
        {
          key: "synthesize",
          type: "reduce",
          name: "Synthesize",
          configuration: { prompt: "Synthesize branches." },
          outputSchema: { type: "object" },
        },
      ],
      [
        { from: "alpha", to: "synthesize" },
        { from: "beta", to: "synthesize" },
        { from: "gamma", to: "synthesize" },
      ],
    );
    connected = true;
    mode = "parallel";
    parallelInFlight = 0;
    parallelPeak = 0;
    parallelWaiters = [];
    parallelBarrierReleased = false;
    const before = executionCommands.length;
    const response = await createRunForRevision(
      staticRevision,
      "execute-parallel-static-dag",
      { maxParallelism: 2 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    mode = "success";
    const commands = executionCommands.slice(before);
    expect(commands).toHaveLength(4);
    expect(
      commands
        .slice(0, 3)
        .map(({ prompt }) => prompt.split("\n", 1)[0])
        .sort(),
    ).toEqual(["Alpha branch.", "Beta branch.", "Gamma branch."]);
    expect(commands[3]?.prompt).toContain("Synthesize branches.");
    expect(commands[3]?.prompt).toContain('"alpha":{"finding":"alpha"}');
    expect(commands[3]?.prompt).toContain('"beta":{"finding":"beta"}');
    expect(commands[3]?.prompt).toContain('"gamma":{"finding":"gamma"}');
    expect(parallelPeak).toBe(2);
    expect(await runDetail(runId)).toMatchObject({
      run: {
        status: "completed",
        structuredResult: { summary: "combined" },
        measuredUsage: { totalTokens: 56, durationMs: 1_000 },
      },
      nodes: [
        { nodeKey: "alpha", status: "completed" },
        { nodeKey: "beta", status: "completed" },
        { nodeKey: "gamma", status: "completed" },
        {
          nodeKey: "synthesize",
          status: "completed",
          structuredInput: {
            alpha: { finding: "alpha" },
            beta: { finding: "beta" },
            gamma: { finding: "gamma" },
          },
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
    expect(events.events.map(({ sequence }) => sequence)).toEqual(
      events.events.map((_, index) => index),
    );
    expect(
      events.events.filter(({ type }) => type === "node.attempt.completed"),
    ).toHaveLength(4);
  });

  it("serializes terminal state aggregation for parallel sink nodes", async () => {
    const revision = await createWorkflowRevision("parallel-sinks", [
      {
        key: "alpha",
        type: "agent",
        name: "Alpha",
        configuration: { prompt: "Alpha branch." },
      },
      {
        key: "beta",
        type: "agent",
        name: "Beta",
        configuration: { prompt: "Beta branch." },
      },
    ]);
    mode = "parallel";
    parallelInFlight = 0;
    parallelPeak = 0;
    parallelWaiters = [];
    parallelBarrierReleased = false;
    const response = await createRunForRevision(
      revision,
      "execute-parallel-sinks",
      { maxParallelism: 2 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    mode = "success";
    expect((await runDetail(runId)).run.structuredResult).toEqual({
      alpha: { finding: "alpha" },
      beta: { finding: "beta" },
    });
    expect(parallelPeak).toBe(2);
  });

  it("interrupts a live turn as soon as reported usage exhausts the run token budget", async () => {
    connected = true;
    mode = "token-budget";
    const executionsBefore = executionCommands.length;
    const interruptsBefore = interruptCommands.length;
    const response = await createRunForRevision(
      revisionId,
      "execute-live-token-budget",
      { maxTokens: 13 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    expect(await runDetail(runId)).toMatchObject({
      run: {
        errorCode: "workflow-token-budget-exceeded",
        measuredUsage: { totalTokens: 14 },
      },
      nodes: [{ status: "cancelled" }],
      attempts: [
        {
          status: "interrupted",
          errorCode: "workflow-token-budget-exceeded",
        },
      ],
    });
    expect(executionCommands).toHaveLength(executionsBefore + 1);
    expect(interruptCommands).toHaveLength(interruptsBefore + 1);
  });

  it("stops before the next node when the run token budget is exhausted", async () => {
    const revision = await createWorkflowRevision(
      "run-token-budget",
      [
        {
          key: "alpha",
          type: "agent",
          name: "Alpha",
          configuration: { prompt: "Alpha branch." },
        },
        {
          key: "beta",
          type: "agent",
          name: "Beta",
          configuration: { prompt: "Beta branch." },
        },
      ],
      [{ from: "alpha", to: "beta" }],
    );
    connected = true;
    mode = "success";
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-run-token-budget",
      { maxTokens: 14 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    expect(await runDetail(runId)).toMatchObject({
      run: {
        status: "failed",
        errorCode: "workflow-token-budget-exceeded",
        measuredUsage: { totalTokens: 14 },
      },
      nodes: [
        { nodeKey: "alpha", status: "completed" },
        { nodeKey: "beta", status: "cancelled" },
      ],
      attempts: [{ status: "completed" }],
    });
    expect(executionCommands).toHaveLength(before + 1);
    const events = workflowRunEventPageSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflow-runs/${runId}/events`,
        })
      ).json(),
    );
    expect(events.events.at(-1)).toMatchObject({
      type: "run.budget.exceeded",
      payload: {
        code: "workflow-token-budget-exceeded",
        kind: "tokens",
        limit: 14,
        observed: 14,
      },
    });
    const beta = (await runDetail(runId)).nodes.find(
      ({ nodeKey }) => nodeKey === "beta",
    )!;
    const retry = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/nodes/${beta.id}/retry`,
      payload: { idempotencyKey: "retry-token-budget" },
    });
    expect(retry.statusCode).toBe(409);
    expect(executionCommands).toHaveLength(before + 1);
  });

  it("interrupts active siblings when a completed branch exceeds the run budget", async () => {
    const revision = await createWorkflowRevision("parallel-run-budget", [
      {
        key: "alpha",
        type: "agent",
        name: "Alpha",
        configuration: { prompt: "Alpha branch." },
      },
      {
        key: "beta",
        type: "agent",
        name: "Beta",
        configuration: { prompt: "Beta branch." },
      },
    ]);
    connected = true;
    mode = "parallel-hold";
    heldParallelExecutions.clear();
    const executionsBefore = executionCommands.length;
    const interruptsBefore = interruptCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-parallel-run-budget",
      { maxParallelism: 2, maxTokens: 13 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(() => {
      expect(heldParallelExecutions.size).toBe(2);
    });
    heldParallelExecutions.values().next().value?.();
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    await vi.waitFor(() => {
      expect(heldParallelExecutions.size).toBe(0);
    });
    mode = "success";
    const detail = await runDetail(runId);
    expect(detail.run).toMatchObject({
      status: "failed",
      errorCode: "workflow-token-budget-exceeded",
    });
    expect(detail.nodes.map(({ status }) => status).sort()).toEqual([
      "cancelled",
      "completed",
    ]);
    expect(detail.attempts.map(({ status }) => status).sort()).toEqual([
      "completed",
      "interrupted",
    ]);
    expect(executionCommands).toHaveLength(executionsBefore + 2);
    expect(interruptCommands).toHaveLength(interruptsBefore + 1);
  });

  it("enforces available estimated cost and fails closed when a cost cap cannot be measured", async () => {
    const costedRevision = await createWorkflowRevision(
      "run-cost-budget",
      [
        {
          key: "first",
          type: "agent",
          name: "First",
          configuration: { prompt: "Costed analysis first." },
        },
        {
          key: "second",
          type: "agent",
          name: "Second",
          configuration: { prompt: "Costed analysis second." },
        },
      ],
      [{ from: "first", to: "second" }],
    );
    connected = true;
    mode = "success";
    const costedBefore = executionCommands.length;
    const costedResponse = await createRunForRevision(
      costedRevision,
      "execute-run-cost-budget",
      { maxEstimatedCostUsd: 0.6 },
    );
    const costedRunId = workflowRunDetailSchema.parse(costedResponse.json()).run
      .id;
    await vi.waitFor(async () => {
      expect((await runDetail(costedRunId)).run.status).toBe("failed");
    });
    expect((await runDetail(costedRunId)).run).toMatchObject({
      errorCode: "workflow-cost-budget-exceeded",
      measuredUsage: {
        estimatedCostUsd: 0.6,
        costAvailable: true,
      },
    });
    expect(executionCommands).toHaveLength(costedBefore + 1);

    const unavailableRevision = await createWorkflowRevision(
      "run-cost-budget-unavailable",
      [
        {
          key: "first",
          type: "agent",
          name: "First",
          configuration: { prompt: "Alpha branch." },
        },
        {
          key: "second",
          type: "agent",
          name: "Second",
          configuration: { prompt: "Beta branch." },
        },
      ],
      [{ from: "first", to: "second" }],
    );
    const unavailableBefore = executionCommands.length;
    const unavailableResponse = await createRunForRevision(
      unavailableRevision,
      "execute-run-cost-budget-unavailable",
      { maxEstimatedCostUsd: 1 },
    );
    const unavailableRunId = workflowRunDetailSchema.parse(
      unavailableResponse.json(),
    ).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(unavailableRunId)).run.status).toBe("failed");
    });
    expect((await runDetail(unavailableRunId)).run).toMatchObject({
      errorCode: "workflow-cost-budget-unavailable",
      measuredUsage: {
        estimatedCostUsd: null,
        costAvailable: false,
      },
    });
    expect(executionCommands).toHaveLength(unavailableBefore + 1);
  });

  it("caps worker turns by the remaining run elapsed-time budget", async () => {
    const revision = await createWorkflowRevision(
      "run-duration-budget",
      [
        {
          key: "alpha",
          type: "agent",
          name: "Alpha",
          configuration: { prompt: "Alpha branch." },
        },
        {
          key: "beta",
          type: "agent",
          name: "Beta",
          configuration: { prompt: "Beta branch." },
        },
      ],
      [{ from: "alpha", to: "beta" }],
    );
    connected = true;
    mode = "hold-success";
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-run-duration-budget",
      { maxDurationMs: 1_000, maxNodeDurationMs: 60_000 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(() => expect(heldExecution).not.toBeNull());
    expect(executionCommands[before]!.timeoutMs).toBeGreaterThan(0);
    expect(executionCommands[before]!.timeoutMs).toBeLessThanOrEqual(1_000);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    heldExecution?.();
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    expect((await runDetail(runId)).run).toMatchObject({
      errorCode: "workflow-duration-budget-exceeded",
    });
    expect(executionCommands).toHaveLength(before + 1);
  });

  it("cancels and interrupts every active parallel node", async () => {
    const parallelRevision = await createWorkflowRevision(
      "cancel-parallel-dag",
      [
        {
          key: "alpha",
          type: "agent",
          name: "Alpha",
          configuration: { prompt: "Alpha branch." },
        },
        {
          key: "beta",
          type: "agent",
          name: "Beta",
          configuration: { prompt: "Beta branch." },
        },
      ],
    );
    connected = true;
    mode = "parallel-hold";
    heldParallelExecutions.clear();
    const interruptsBefore = interruptCommands.length;
    const response = await createRunForRevision(
      parallelRevision,
      "execute-cancel-parallel",
      { maxParallelism: 2 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      const detail = await runDetail(runId);
      expect(detail.attempts).toHaveLength(2);
      expect(
        detail.attempts.every(({ codexThreadId }) => codexThreadId !== null),
      ).toBe(true);
    });
    const active = await runDetail(runId);
    const cancellation = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/cancel`,
      payload: {
        reason: "Cancel every branch.",
        idempotencyKey: "cancel-parallel-once",
      },
    });
    expect(cancellation.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("cancelled");
    });
    mode = "success";
    expect(await runDetail(runId)).toMatchObject({
      run: { status: "cancelled" },
      nodes: [{ status: "cancelled" }, { status: "cancelled" }],
      attempts: [{ status: "interrupted" }, { status: "interrupted" }],
    });
    const interrupts = interruptCommands.slice(interruptsBefore);
    expect(interrupts).toHaveLength(2);
    expect(new Set(interrupts.map(({ attemptId }) => attemptId))).toEqual(
      new Set(active.attempts.map(({ id }) => id)),
    );
  });

  it("selects a reduce collection before rendering and persisting its attempt input", async () => {
    const reduceRevision = await createWorkflowRevision(
      "reduce-selected-collection",
      [
        {
          key: "collect",
          type: "agent",
          name: "Collect",
          configuration: { prompt: "Collect nested findings." },
        },
        {
          key: "synthesize",
          type: "reduce",
          name: "Synthesize",
          configuration: {
            prompt: "Synthesize selected findings.",
            collectionPath: "/payload/findings",
          },
        },
      ],
      [{ from: "collect", to: "synthesize" }],
    );
    mode = "success";
    const before = executionCommands.length;
    const response = await createRunForRevision(
      reduceRevision,
      "execute-reduce-selection",
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    const reducer = executionCommands.slice(before)[1]!;
    expect(reducer.prompt).toContain('[{"finding":"nested"}]');
    expect(reducer.prompt).not.toContain('"payload"');
    expect(await runDetail(runId)).toMatchObject({
      run: { structuredResult: { summary: "selected" } },
      attempts: [{}, { structuredInput: [{ finding: "nested" }] }],
    });
  });

  it("selects one deterministic condition branch and cascades skipped dependencies", async () => {
    const revision = await createWorkflowRevision(
      "condition-selected-branch",
      [
        {
          key: "route",
          type: "condition",
          name: "Route",
          configuration: {},
        },
        {
          key: "matched",
          type: "agent",
          name: "Matched",
          configuration: { prompt: "Run matched branch." },
        },
        {
          key: "fallback",
          type: "agent",
          name: "Fallback",
          configuration: { prompt: "Run fallback branch." },
        },
      ],
      [
        {
          from: "route",
          to: "matched",
          condition: {
            path: "/target",
            operator: "equals",
            value: "src",
          },
        },
        { from: "route", to: "fallback" },
      ],
    );
    mode = "success";
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-condition-selected",
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    expect(
      executionCommands
        .slice(before)
        .map(({ prompt }) => prompt.split("\n", 1)[0]),
    ).toEqual(["Run matched branch."]);
    expect(await runDetail(runId)).toMatchObject({
      nodes: [
        { nodeKey: "route", status: "completed" },
        { nodeKey: "matched", status: "completed" },
        { nodeKey: "fallback", status: "skipped" },
      ],
      dependencies: [{ status: "satisfied" }, { status: "skipped" }],
      attempts: [{ status: "completed" }],
    });
    const events = workflowRunEventPageSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflow-runs/${runId}/events`,
        })
      ).json(),
    );
    expect(events.events.map(({ type }) => type)).toContain(
      "node.condition.completed",
    );
  });

  it("completes a non-required unmatched condition without dispatching skipped branches", async () => {
    const revision = await createWorkflowRevision(
      "condition-no-match-allowed",
      [
        {
          key: "route",
          type: "condition",
          name: "Route",
          configuration: { requireMatch: false },
        },
        {
          key: "first",
          type: "agent",
          name: "First",
          configuration: { prompt: "Never first." },
        },
        {
          key: "second",
          type: "agent",
          name: "Second",
          configuration: { prompt: "Never second." },
        },
      ],
      [
        {
          from: "route",
          to: "first",
          condition: { path: "/target", operator: "equals", value: "other" },
        },
        {
          from: "route",
          to: "second",
          condition: { path: "/target", operator: "equals", value: "another" },
        },
      ],
    );
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-condition-no-match-allowed",
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    expect(executionCommands).toHaveLength(before);
    expect((await runDetail(runId)).nodes).toMatchObject([
      { nodeKey: "route", status: "completed" },
      { nodeKey: "first", status: "skipped" },
      { nodeKey: "second", status: "skipped" },
    ]);
  });

  it("fails a required condition when no branch matches", async () => {
    const revision = await createWorkflowRevision(
      "condition-no-match-required",
      [
        {
          key: "route",
          type: "condition",
          name: "Route",
          configuration: {},
        },
        {
          key: "first",
          type: "agent",
          name: "First",
          configuration: { prompt: "Never required first." },
        },
        {
          key: "second",
          type: "agent",
          name: "Second",
          configuration: { prompt: "Never required second." },
        },
      ],
      [
        {
          from: "route",
          to: "first",
          condition: { path: "/target", operator: "equals", value: "other" },
        },
        {
          from: "route",
          to: "second",
          condition: { path: "/target", operator: "equals", value: "another" },
        },
      ],
    );
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-condition-no-match-required",
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    expect(executionCommands).toHaveLength(before);
    expect(await runDetail(runId)).toMatchObject({
      run: { status: "failed", errorCode: "condition-no-match" },
      nodes: [
        { nodeKey: "route", status: "failed" },
        { nodeKey: "first", status: "skipped" },
        { nodeKey: "second", status: "skipped" },
      ],
      dependencies: [{ status: "failed" }, { status: "failed" }],
      attempts: [],
    });
  });

  it("waits durably at a gate and resumes after an idempotent approval", async () => {
    const revision = await createWorkflowRevision(
      "gate-approval",
      [
        {
          key: "approval",
          type: "gate",
          name: "Approval",
          configuration: { prompt: "Approve the next stage?" },
        },
        {
          key: "continue",
          type: "agent",
          name: "Continue",
          configuration: { prompt: "Continue after approval." },
        },
      ],
      [{ from: "approval", to: "continue" }],
    );
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-gate-approval",
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("waiting");
    });
    const waiting = await runDetail(runId);
    expect(waiting).toMatchObject({
      run: { pauseReason: "Approve the next stage?" },
      nodes: [
        { nodeKey: "approval", status: "waiting-for-approval" },
        { nodeKey: "continue", status: "blocked" },
      ],
      gates: [{ status: "pending", gateKey: "approval" }],
      attempts: [],
    });
    expect(executionCommands).toHaveLength(before);
    const payload = {
      decision: "approved",
      reason: "Reviewed.",
      idempotencyKey: "approve-gate-once",
    };
    const decisions = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: "POST",
          url: `/api/workflow-runs/${runId}/gates/${waiting.gates[0]!.id}/decision`,
          payload,
        }),
      ),
    );
    expect(decisions.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    expect(await runDetail(runId)).toMatchObject({
      run: { pauseReason: null },
      nodes: [
        { nodeKey: "approval", status: "completed" },
        { nodeKey: "continue", status: "completed" },
      ],
      gates: [
        {
          status: "approved",
          decision: "approved",
          decisionReason: "Reviewed.",
        },
      ],
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/gates/${waiting.gates[0]!.id}/decision`,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    const drift = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/gates/${waiting.gates[0]!.id}/decision`,
      payload: { ...payload, decision: "denied" },
    });
    expect(drift.statusCode).toBe(409);
    expect(executionCommands).toHaveLength(before + 1);
    const events = workflowRunEventPageSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflow-runs/${runId}/events`,
        })
      ).json(),
    );
    const eventTypes = events.events.map(({ type }) => type);
    expect(
      eventTypes.filter((type) => type === "node.gate.approved"),
    ).toHaveLength(1);
    expect(eventTypes.indexOf("node.gate.requested")).toBeLessThan(
      eventTypes.indexOf("node.gate.approved"),
    );
    expect(eventTypes.indexOf("node.gate.approved")).toBeLessThan(
      eventTypes.indexOf("node.attempt.started"),
    );
    expect(events.events.map(({ sequence }) => sequence)).toEqual(
      events.events.map((_, index) => index),
    );
  });

  it("applies gate denial and expiry policies without starting Codex attempts", async () => {
    const deniedRevision = await createWorkflowRevision(
      "gate-denial-skip",
      [
        {
          key: "approval",
          type: "gate",
          name: "Approval",
          configuration: {
            prompt: "Approve optional work?",
            denialPolicy: "skip-downstream",
          },
        },
        {
          key: "optional",
          type: "agent",
          name: "Optional",
          configuration: { prompt: "Never optional." },
        },
      ],
      [{ from: "approval", to: "optional" }],
    );
    const before = executionCommands.length;
    const deniedResponse = await createRunForRevision(
      deniedRevision,
      "execute-gate-denial-skip",
    );
    const deniedRunId = workflowRunDetailSchema.parse(deniedResponse.json()).run
      .id;
    await vi.waitFor(async () => {
      expect((await runDetail(deniedRunId)).run.status).toBe("waiting");
    });
    const deniedWaiting = await runDetail(deniedRunId);
    const denial = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${deniedRunId}/gates/${deniedWaiting.gates[0]!.id}/decision`,
      payload: {
        decision: "denied",
        reason: "Not needed.",
        idempotencyKey: "deny-gate-once",
      },
    });
    expect(denial.statusCode).toBe(200);
    expect(workflowRunDetailSchema.parse(denial.json())).toMatchObject({
      run: { status: "completed" },
      nodes: [{ status: "skipped" }, { status: "skipped" }],
      gates: [{ status: "denied", decision: "denied" }],
      attempts: [],
    });

    const expiredRevision = await createWorkflowRevision(
      "gate-expiry-fails",
      [
        {
          key: "approval",
          type: "gate",
          name: "Approval",
          configuration: {
            prompt: "Approve quickly?",
            expiresAfterMs: 1_000,
          },
        },
        {
          key: "later",
          type: "agent",
          name: "Later",
          configuration: { prompt: "Never after expiry." },
        },
      ],
      [{ from: "approval", to: "later" }],
    );
    const expiredResponse = await createRunForRevision(
      expiredRevision,
      "execute-gate-expiry",
    );
    const expiredRunId = workflowRunDetailSchema.parse(expiredResponse.json())
      .run.id;
    await vi.waitFor(
      async () => {
        expect((await runDetail(expiredRunId)).run.status).toBe("failed");
      },
      { timeout: 3_000 },
    );
    expect(await runDetail(expiredRunId)).toMatchObject({
      run: { errorCode: "gate-expired" },
      nodes: [{ status: "failed" }, { status: "skipped" }],
      gates: [{ status: "expired", decision: null }],
      attempts: [],
    });
    expect(executionCommands).toHaveLength(before);
  });

  it("cancels a pending gate and rejects a later decision", async () => {
    const revision = await createWorkflowRevision("gate-cancellation", [
      {
        key: "approval",
        type: "gate",
        name: "Approval",
        configuration: { prompt: "Approve cancellable work?" },
      },
    ]);
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-gate-cancellation",
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("waiting");
    });
    const waiting = await runDetail(runId);
    const cancellation = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/cancel`,
      payload: {
        reason: "The gated work is no longer needed.",
        idempotencyKey: "cancel-pending-gate",
      },
    });
    expect(cancellation.statusCode).toBe(200);
    expect(workflowRunDetailSchema.parse(cancellation.json())).toMatchObject({
      run: { status: "cancelled", pauseReason: null, pausedAt: null },
      nodes: [{ status: "cancelled" }],
      gates: [{ status: "cancelled", decision: null }],
      attempts: [],
    });
    const lateDecision = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/gates/${waiting.gates[0]!.id}/decision`,
      payload: {
        decision: "approved",
        reason: null,
        idempotencyKey: "approve-cancelled-gate",
      },
    });
    expect(lateDecision.statusCode).toBe(409);
    expect(executionCommands).toHaveLength(before);
  });

  it("terminalizes sibling gates when one gate fails the run", async () => {
    const revision = await createWorkflowRevision("parallel-gate-failure", [
      {
        key: "first-approval",
        type: "gate",
        name: "First approval",
        configuration: { prompt: "Approve the first branch?" },
      },
      {
        key: "second-approval",
        type: "gate",
        name: "Second approval",
        configuration: { prompt: "Approve the second branch?" },
      },
    ]);
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-parallel-gate-failure",
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).gates).toHaveLength(2);
    });
    const waiting = await runDetail(runId);
    const denials = await Promise.all(
      waiting.gates.map((gate) =>
        app.inject({
          method: "POST",
          url: `/api/workflow-runs/${runId}/gates/${gate.id}/decision`,
          payload: {
            decision: "denied",
            reason: "Stop the whole run.",
            idempotencyKey: `deny-parallel-gate-${gate.gateKey}`,
          },
        }),
      ),
    );
    expect(denials.map(({ statusCode }) => statusCode).sort()).toEqual([
      200, 409,
    ]);
    const terminal = await runDetail(runId);
    expect(terminal.run).toMatchObject({
      status: "failed",
      errorCode: "gate-denied",
      pauseReason: null,
      pausedAt: null,
    });
    expect(terminal.nodes.map(({ status }) => status).sort()).toEqual([
      "cancelled",
      "failed",
    ]);
    expect(terminal.gates.map(({ status }) => status).sort()).toEqual([
      "cancelled",
      "denied",
    ]);
    expect(executionCommands).toHaveLength(before);
  });

  it("does not let a late parallel worker event revive a failed run", async () => {
    const revision = await createWorkflowRevision("parallel-terminal-race", [
      {
        key: "alpha",
        type: "agent",
        name: "Alpha",
        configuration: { prompt: "Alpha branch.", automaticRetries: 0 },
      },
      {
        key: "beta",
        type: "agent",
        name: "Beta",
        configuration: { prompt: "Beta branch." },
      },
    ]);
    mode = "sibling-failure";
    awaitAlphaFailure = new Promise<void>((resolve) => {
      triggerAlphaFailure = resolve;
    });
    releaseLateSibling = null;
    const response = await createRunForRevision(
      revision,
      "execute-parallel-terminal-race",
      { maxParallelism: 2 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
      expect(releaseLateSibling).not.toBeNull();
    });
    releaseLateSibling!();
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeKey: "beta", status: "completed" }),
        ]),
      );
    });
    mode = "success";
    awaitAlphaFailure = null;
    expect((await runDetail(runId)).run.status).toBe("failed");
  });

  it("applies verification pass and fail policies to structured results", async () => {
    const failingRevision = await createWorkflowRevision(
      "verification-fails-run",
      [
        {
          key: "verify",
          type: "verify",
          name: "Verify",
          configuration: {
            prompt: "Verify failing.",
            passCondition: {
              path: "/passed",
              operator: "equals",
              value: true,
            },
          },
        },
      ],
    );
    mode = "success";
    const failing = await createRunForRevision(
      failingRevision,
      "execute-verification-failure",
    );
    const failingRunId = workflowRunDetailSchema.parse(failing.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(failingRunId)).run.status).toBe("failed");
    });
    expect(await runDetail(failingRunId)).toMatchObject({
      run: { errorCode: "verification-failed" },
      nodes: [{ status: "failed", attemptCount: 2 }],
      attempts: [
        { status: "failed", errorCode: "verification-failed" },
        { status: "failed", errorCode: "verification-failed" },
      ],
    });

    const continuingRevision = await createWorkflowRevision(
      "verification-continues",
      [
        {
          key: "verify",
          type: "verify",
          name: "Verify",
          configuration: {
            prompt: "Verify failing.",
            passCondition: {
              path: "/passed",
              operator: "equals",
              value: true,
            },
            failurePolicy: "continue",
          },
        },
      ],
    );
    const continuing = await createRunForRevision(
      continuingRevision,
      "execute-verification-continue",
    );
    const continuingRunId = workflowRunDetailSchema.parse(continuing.json()).run
      .id;
    await vi.waitFor(async () => {
      expect((await runDetail(continuingRunId)).run.status).toBe("completed");
    });
    expect((await runDetail(continuingRunId)).run.structuredResult).toEqual({
      passed: false,
    });
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

  it("maps array items with bounded concurrency and feeds the ordered aggregate to reduce", async () => {
    const revision = await createWorkflowRevision(
      "map-array-reduce",
      [
        {
          key: "map_items",
          type: "map",
          name: "Map items",
          configuration: {
            prompt: "Map collection item.",
            collectionPath: "/values",
            itemInputKey: "item",
            maxConcurrency: 2,
            failurePolicy: "fail-fast",
          },
          outputSchema: { type: "object" },
        },
        {
          key: "reduce_items",
          type: "reduce",
          name: "Reduce items",
          configuration: {
            prompt: "Reduce mapped collection.",
            collectionPath: "",
            emptyCollection: "fail",
          },
          outputSchema: { type: "object" },
        },
      ],
      [{ from: "map_items", to: "reduce_items" }],
    );
    mode = "parallel";
    parallelInFlight = 0;
    parallelPeak = 0;
    parallelWaiters = [];
    parallelBarrierReleased = false;
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-map-array-reduce",
      { maxParallelism: 2, maxNodes: 10 },
      { values: ["one", "two", "three"] },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    mode = "success";
    const detail = await runDetail(runId);
    const commands = executionCommands.slice(before);
    expect(commands).toHaveLength(4);
    expect(parallelPeak).toBe(2);
    expect(commands.at(-1)?.prompt).toContain(
      '[{"mapped":"one"},{"mapped":"two"},{"mapped":"three"}]',
    );
    expect(detail).toMatchObject({
      run: { status: "completed", structuredResult: { summary: "mapped" } },
      nodes: [
        {
          nodeKey: "map_items",
          status: "completed",
          structuredResult: [
            { mapped: "one" },
            { mapped: "two" },
            { mapped: "three" },
          ],
        },
        {
          nodeKey: "reduce_items",
          status: "completed",
          structuredInput: [
            { mapped: "one" },
            { mapped: "two" },
            { mapped: "three" },
          ],
        },
      ],
    });
    expect(
      detail.items.map(({ itemKey, position, status }) => ({
        itemKey,
        position,
        status,
      })),
    ).toEqual([
      { itemKey: "0", position: 0, status: "completed" },
      { itemKey: "1", position: 1, status: "completed" },
      { itemKey: "2", position: 2, status: "completed" },
    ]);
    expect(
      detail.attempts.filter(({ runNodeItemId }) => runNodeItemId),
    ).toHaveLength(3);
  });

  it("orders object keys deterministically and completes empty collections without worker turns", async () => {
    const objectRevision = await createWorkflowRevision("map-object-order", [
      {
        key: "map_items",
        type: "map",
        name: "Map items",
        configuration: {
          prompt: "Map collection item.",
          collectionPath: "/values",
          itemInputKey: "item",
          maxConcurrency: 1,
          failurePolicy: "fail-fast",
        },
      },
    ]);
    mode = "success";
    const objectResponse = await createRunForRevision(
      objectRevision,
      "execute-map-object-order",
      { maxNodes: 10 },
      { values: { zeta: 3, alpha: 1, middle: 2 } },
    );
    const objectRunId = workflowRunDetailSchema.parse(objectResponse.json()).run
      .id;
    await vi.waitFor(async () => {
      expect((await runDetail(objectRunId)).run.status).toBe("completed");
    });
    const objectDetail = await runDetail(objectRunId);
    expect(objectDetail.items.map(({ itemKey }) => itemKey)).toEqual([
      "alpha",
      "middle",
      "zeta",
    ]);
    expect(objectDetail.run.structuredResult).toEqual({
      alpha: { mapped: 1 },
      middle: { mapped: 2 },
      zeta: { mapped: 3 },
    });

    const emptyRevision = await createWorkflowRevision("map-empty", [
      {
        key: "map_items",
        type: "map",
        name: "Map items",
        configuration: {
          prompt: "Map collection item.",
          collectionPath: "/values",
          itemInputKey: "item",
          maxConcurrency: 1,
          failurePolicy: "fail-fast",
        },
      },
    ]);
    const before = executionCommands.length;
    const emptyResponse = await createRunForRevision(
      emptyRevision,
      "execute-map-empty",
      { maxNodes: 10 },
      { values: [] },
    );
    const emptyRunId = workflowRunDetailSchema.parse(emptyResponse.json()).run
      .id;
    await vi.waitFor(async () => {
      expect((await runDetail(emptyRunId)).run.status).toBe("completed");
    });
    expect(await runDetail(emptyRunId)).toMatchObject({
      run: { status: "completed", structuredResult: [] },
      nodes: [{ status: "completed", structuredResult: [] }],
      items: [],
      attempts: [],
    });
    expect(executionCommands).toHaveLength(before);

    const boundedResponse = await createRunForRevision(
      objectRevision,
      "execute-map-node-budget",
      { maxNodes: 2 },
      { values: ["one", "two"] },
    );
    const boundedRunId = workflowRunDetailSchema.parse(boundedResponse.json())
      .run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(boundedRunId)).run.status).toBe("failed");
    });
    expect(await runDetail(boundedRunId)).toMatchObject({
      run: {
        status: "failed",
        errorCode: "unsupported-workflow-shape",
        errorMessage: expect.stringContaining("node budget"),
      },
      items: [],
      attempts: [],
    });
    expect(executionCommands).toHaveLength(before);
  });

  it("continues map execution with explicit outcome envelopes after an item failure", async () => {
    const revision = await createWorkflowRevision("map-continue-failure", [
      {
        key: "map_items",
        type: "map",
        name: "Map items",
        configuration: {
          prompt: "Map collection item.",
          collectionPath: "/values",
          itemInputKey: "item",
          maxConcurrency: 1,
          failurePolicy: "continue",
          automaticRetries: 0,
        },
      },
    ]);
    mode = "map-terminal-failure";
    const response = await createRunForRevision(
      revision,
      "execute-map-continue-failure",
      { maxNodes: 10 },
      { values: ["ok", "bad", "after"] },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    mode = "success";
    const detail = await runDetail(runId);
    expect(detail.items.map(({ status }) => status)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
    expect(detail.run.structuredResult).toEqual([
      { status: "completed", result: { mapped: "ok" } },
      {
        status: "failed",
        error: {
          code: "node-execution-failed",
          message: "The selected map item failed.",
        },
      },
      { status: "completed", result: { mapped: "after" } },
    ]);
  });

  it("fails fast before dispatching later map items", async () => {
    const revision = await createWorkflowRevision(
      "map-fail-fast",
      [
        {
          key: "map_items",
          type: "map",
          name: "Map items",
          configuration: {
            prompt: "Map collection item.",
            collectionPath: "/values",
            itemInputKey: "item",
            maxConcurrency: 1,
            failurePolicy: "fail-fast",
            automaticRetries: 0,
          },
        },
        {
          key: "after",
          type: "agent",
          name: "After",
          configuration: { prompt: "Must not execute after map failure." },
        },
      ],
      [{ from: "map_items", to: "after" }],
    );
    mode = "map-terminal-failure";
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-map-fail-fast",
      { maxNodes: 10 },
      { values: ["bad", "never"] },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    mode = "success";
    const detail = await runDetail(runId);
    expect(executionCommands).toHaveLength(before + 1);
    expect(detail.nodes.map(({ status }) => status)).toEqual([
      "failed",
      "skipped",
    ]);
    expect(detail.items.map(({ status }) => status)).toEqual([
      "failed",
      "skipped",
    ]);

    const retry = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/nodes/${detail.nodes[0]!.id}/retry`,
      payload: {
        reason: "Retry the failed item, then continue the collection.",
        idempotencyKey: "retry-map-fail-fast",
      },
    });
    expect(retry.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    expect(
      (await runDetail(runId)).items.map(({ attemptCount, status }) => ({
        attemptCount,
        status,
      })),
    ).toEqual([
      { attemptCount: 2, status: "completed" },
      { attemptCount: 1, status: "completed" },
    ]);
  });

  it("does not let a late in-flight map item revive a failed parent", async () => {
    const revision = await createWorkflowRevision("map-terminal-race", [
      {
        key: "map_items",
        type: "map",
        name: "Map items",
        configuration: {
          prompt: "Map collection item.",
          collectionPath: "/values",
          itemInputKey: "item",
          maxConcurrency: 2,
          failurePolicy: "fail-fast",
          automaticRetries: 0,
        },
      },
    ]);
    mode = "map-sibling-failure";
    const interruptsBefore = interruptCommands.length;
    awaitAlphaFailure = new Promise<void>((resolve) => {
      triggerAlphaFailure = resolve;
    });
    releaseLateSibling = null;
    const response = await createRunForRevision(
      revision,
      "execute-map-terminal-race",
      { maxParallelism: 2, maxNodes: 10 },
      { values: ["bad", "late"] },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      const detail = await runDetail(runId);
      expect(detail.run.status).toBe("failed");
      expect(detail.nodes[0]?.status).toBe("failed");
    });
    await vi.waitFor(async () => {
      expect(
        (await runDetail(runId)).items.map(({ status }) => status),
      ).toEqual(["failed", "completed"]);
    });
    mode = "success";
    awaitAlphaFailure = null;
    const terminal = await runDetail(runId);
    expect(terminal.run.status).toBe("failed");
    expect(terminal.nodes[0]?.status).toBe("failed");
    expect(interruptCommands).toHaveLength(interruptsBefore + 1);
  });

  it("retries only the failed map item within its own attempt budget", async () => {
    const revision = await createWorkflowRevision("map-item-retry", [
      {
        key: "map_items",
        type: "map",
        name: "Map items",
        configuration: {
          prompt: "Map collection item.",
          collectionPath: "/values",
          itemInputKey: "item",
          maxConcurrency: 1,
          failurePolicy: "fail-fast",
          automaticRetries: 1,
        },
      },
    ]);
    mode = "failure";
    const response = await createRunForRevision(
      revision,
      "execute-map-item-retry",
      { maxAttemptsPerNode: 2, maxNodes: 10 },
      { values: ["first", "second"] },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    const detail = await runDetail(runId);
    const attemptsByItem = new Map<string, number[]>();
    for (const attempt of detail.attempts) {
      const attempts = attemptsByItem.get(attempt.runNodeItemId!) ?? [];
      attempts.push(attempt.attempt);
      attemptsByItem.set(attempt.runNodeItemId!, attempts);
    }
    expect(
      detail.items.map(({ attemptCount, status }) => ({
        attemptCount,
        status,
      })),
    ).toEqual([
      { attemptCount: 2, status: "completed" },
      { attemptCount: 1, status: "completed" },
    ]);
    expect([...attemptsByItem.values()]).toEqual([[1, 2], [1]]);
  });

  it("executes ordered pipeline steps per item with bounded collection concurrency", async () => {
    const revision = await createWorkflowRevision("pipeline-ordered", [
      {
        key: "pipeline_items",
        type: "pipeline",
        name: "Pipeline items",
        configuration: {
          collectionPath: "/values",
          itemInputKey: "item",
          maxConcurrency: 2,
          failurePolicy: "fail-fast",
          steps: [
            {
              key: "inspect",
              name: "Inspect",
              prompt: "Pipeline inspect step.",
              outputSchema: { type: "object" },
            },
            {
              key: "summarize",
              name: "Summarize",
              prompt: "Pipeline summarize step.",
              outputSchema: { type: "object" },
            },
          ],
        },
      },
    ]);
    mode = "parallel";
    parallelInFlight = 0;
    parallelPeak = 0;
    parallelWaiters = [];
    parallelBarrierReleased = false;
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-pipeline-ordered",
      { maxParallelism: 2, maxNodes: 20 },
      { values: ["one", "two", "three"] },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    mode = "success";
    const detail = await runDetail(runId);
    const commands = executionCommands.slice(before);
    expect(commands).toHaveLength(6);
    expect(parallelPeak).toBe(2);
    expect(
      commands
        .filter(({ prompt }) => prompt.includes("Pipeline summarize step"))
        .map(({ prompt }) => prompt.match(/"inspected":"([^"]+)"/u)?.[1])
        .sort(),
    ).toEqual(["one", "three", "two"]);
    expect(detail.run.structuredResult).toEqual([
      { summary: "one" },
      { summary: "two" },
      { summary: "three" },
    ]);
    expect(
      detail.items.map(({ attemptCount, executionState, status }) => ({
        attemptCount,
        completedSteps:
          executionState.kind === "pipeline"
            ? executionState.completedSteps.map(({ key }) => key)
            : [],
        currentStepPosition:
          executionState.kind === "pipeline"
            ? executionState.currentStepPosition
            : -1,
        status,
      })),
    ).toEqual([
      {
        attemptCount: 2,
        completedSteps: ["inspect", "summarize"],
        currentStepPosition: 2,
        status: "completed",
      },
      {
        attemptCount: 2,
        completedSteps: ["inspect", "summarize"],
        currentStepPosition: 2,
        status: "completed",
      },
      {
        attemptCount: 2,
        completedSteps: ["inspect", "summarize"],
        currentStepPosition: 2,
        status: "completed",
      },
    ]);
    expect(
      detail.attempts.map(({ executionUnitKey }) => executionUnitKey).sort(),
    ).toEqual([
      "inspect",
      "inspect",
      "inspect",
      "summarize",
      "summarize",
      "summarize",
    ]);

    const emptyBefore = executionCommands.length;
    const emptyResponse = await createRunForRevision(
      revision,
      "execute-pipeline-empty",
      { maxNodes: 20 },
      { values: [] },
    );
    const emptyRunId = workflowRunDetailSchema.parse(emptyResponse.json()).run
      .id;
    await vi.waitFor(async () => {
      expect((await runDetail(emptyRunId)).run.status).toBe("completed");
    });
    expect(await runDetail(emptyRunId)).toMatchObject({
      run: { structuredResult: [] },
      items: [],
      attempts: [],
    });
    expect(executionCommands).toHaveLength(emptyBefore);

    const boundedResponse = await createRunForRevision(
      revision,
      "execute-pipeline-node-budget",
      { maxNodes: 4 },
      { values: ["one", "two"] },
    );
    const boundedRunId = workflowRunDetailSchema.parse(boundedResponse.json())
      .run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(boundedRunId)).run.status).toBe("failed");
    });
    expect((await runDetail(boundedRunId)).run).toMatchObject({
      errorCode: "unsupported-workflow-shape",
      errorMessage: expect.stringContaining("node budget"),
    });
    expect(executionCommands).toHaveLength(emptyBefore);
  });

  it("continues other pipeline items with a durable failed-step envelope", async () => {
    const revision = await createWorkflowRevision("pipeline-continue", [
      {
        key: "pipeline_items",
        type: "pipeline",
        name: "Pipeline items",
        configuration: {
          collectionPath: "/values",
          itemInputKey: "item",
          maxConcurrency: 1,
          failurePolicy: "continue",
          steps: [
            {
              key: "inspect",
              name: "Inspect",
              prompt: "Pipeline inspect step.",
              outputSchema: { type: "object" },
            },
            {
              key: "summarize",
              name: "Summarize",
              prompt: "Pipeline summarize step.",
              automaticRetries: 0,
              outputSchema: { type: "object" },
            },
          ],
        },
      },
    ]);
    mode = "pipeline-terminal-failure";
    const response = await createRunForRevision(
      revision,
      "execute-pipeline-continue",
      { maxNodes: 20 },
      { values: ["ok", "bad", "after"] },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    mode = "success";
    const detail = await runDetail(runId);
    expect(detail.items.map(({ status }) => status)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
    expect(detail.run.structuredResult).toEqual([
      { status: "completed", result: { summary: "ok" } },
      {
        status: "failed",
        error: {
          code: "node-execution-failed",
          message: "The selected pipeline step failed.",
        },
      },
      { status: "completed", result: { summary: "after" } },
    ]);
    const failedState = detail.items[1]!.executionState;
    expect(failedState).toMatchObject({
      kind: "pipeline",
      currentStepPosition: 1,
      currentStepAttemptCount: 1,
      completedSteps: [
        { key: "inspect", structuredResult: { inspected: "bad" } },
      ],
    });
  });

  it("fails a pipeline fast and resumes from the failed step on operator retry", async () => {
    const revision = await createWorkflowRevision("pipeline-fail-fast", [
      {
        key: "pipeline_items",
        type: "pipeline",
        name: "Pipeline items",
        configuration: {
          collectionPath: "/values",
          itemInputKey: "item",
          maxConcurrency: 1,
          failurePolicy: "fail-fast",
          steps: [
            {
              key: "inspect",
              name: "Inspect",
              prompt: "Pipeline inspect step.",
              outputSchema: { type: "object" },
            },
            {
              key: "summarize",
              name: "Summarize",
              prompt: "Pipeline summarize step.",
              automaticRetries: 0,
              outputSchema: { type: "object" },
            },
          ],
        },
      },
    ]);
    mode = "pipeline-terminal-failure";
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-pipeline-fail-fast",
      { maxAttemptsPerNode: 2, maxNodes: 10 },
      { values: ["bad", "later"] },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    const failed = await runDetail(runId);
    expect(executionCommands).toHaveLength(before + 2);
    expect(failed.items.map(({ status }) => status)).toEqual([
      "failed",
      "skipped",
    ]);
    expect(failed.items[0]!.executionState).toMatchObject({
      kind: "pipeline",
      currentStepPosition: 1,
      completedSteps: [{ key: "inspect" }],
    });

    mode = "success";
    const retry = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/nodes/${failed.nodes[0]!.id}/retry`,
      payload: {
        reason: "Resume the failed pipeline step.",
        idempotencyKey: "retry-pipeline-fail-fast",
      },
    });
    expect(retry.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    const completed = await runDetail(runId);
    expect(completed.run.structuredResult).toEqual([
      { summary: "bad" },
      { summary: "later" },
    ]);
    expect(
      completed.attempts.map(({ executionUnitKey, status }) => ({
        executionUnitKey,
        status,
      })),
    ).toEqual([
      { executionUnitKey: "inspect", status: "completed" },
      { executionUnitKey: "summarize", status: "failed" },
      { executionUnitKey: "summarize", status: "completed" },
      { executionUnitKey: "inspect", status: "completed" },
      { executionUnitKey: "summarize", status: "completed" },
    ]);
  });

  it("retries a failed pipeline step without replaying completed steps", async () => {
    const revision = await createWorkflowRevision("pipeline-step-retry", [
      {
        key: "pipeline_items",
        type: "pipeline",
        name: "Pipeline items",
        configuration: {
          collectionPath: "/values",
          itemInputKey: "item",
          maxConcurrency: 1,
          failurePolicy: "fail-fast",
          steps: [
            {
              key: "inspect",
              name: "Inspect",
              prompt: "Pipeline inspect step.",
              automaticRetries: 1,
              outputSchema: { type: "object" },
            },
            {
              key: "summarize",
              name: "Summarize",
              prompt: "Pipeline summarize step.",
              outputSchema: { type: "object" },
            },
          ],
        },
      },
    ]);
    mode = "failure";
    const response = await createRunForRevision(
      revision,
      "execute-pipeline-step-retry",
      { maxAttemptsPerNode: 2, maxNodes: 10 },
      { values: ["retry"] },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    const detail = await runDetail(runId);
    expect(
      detail.attempts.map(({ executionUnitKey, status }) => ({
        executionUnitKey,
        status,
      })),
    ).toEqual([
      { executionUnitKey: "inspect", status: "failed" },
      { executionUnitKey: "inspect", status: "completed" },
      { executionUnitKey: "summarize", status: "completed" },
    ]);
    expect(detail.items[0]).toMatchObject({
      attemptCount: 3,
      measuredUsage: { totalTokens: 36 },
      status: "completed",
      structuredResult: { summary: "retry" },
      executionState: {
        kind: "pipeline",
        currentStepPosition: 2,
        completedSteps: [{ key: "inspect" }, { key: "summarize" }],
      },
    });
  });

  it("recovers at a persisted pipeline step boundary after restart", async () => {
    const revision = await createWorkflowRevision("pipeline-restart", [
      {
        key: "pipeline_items",
        type: "pipeline",
        name: "Pipeline items",
        configuration: {
          collectionPath: "/values",
          itemInputKey: "item",
          maxConcurrency: 1,
          failurePolicy: "fail-fast",
          steps: [
            {
              key: "inspect",
              name: "Inspect",
              prompt: "Pipeline inspect step.",
              outputSchema: { type: "object" },
            },
            {
              key: "summarize",
              name: "Summarize",
              prompt: "Pipeline summarize step.",
              automaticRetries: 0,
              outputSchema: { type: "object" },
            },
          ],
        },
      },
    ]);
    connected = false;
    mode = "success";
    const response = await createRunForRevision(
      revision,
      "execute-pipeline-restart",
      { maxAttemptsPerNode: 2, maxNodes: 10 },
      { values: ["survive"] },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).items).toHaveLength(1);
    });
    const source = await database.repository.getProjectSource(
      LOCAL_USER_ID,
      projectId,
    );
    const firstCandidate =
      (await database.repository.workflowRuns.getReadyAgentCandidates(
        LOCAL_USER_ID,
        runId,
      ))![0]!;
    const firstLease = await database.repository.workflowRuns.claimAgentAttempt(
      LOCAL_USER_ID,
      firstCandidate,
      {
        cwd: source!.cwd,
        modelRouteId: DEFAULT_MODEL_ROUTE_ID,
        permissionProfileId: null,
        workerId: source!.workerId,
        worktreeId: source!.worktreeId,
      },
    );
    await database.repository.workflowRuns.completeAgentAttempt(
      LOCAL_USER_ID,
      firstLease!,
      {
        measuredUsage: {
          inputTokens: 10,
          outputTokens: 4,
          cachedInputTokens: 2,
          totalTokens: 14,
          durationMs: 250,
          estimatedCostUsd: null,
          costAvailable: false,
        },
        structuredResult: { inspected: "survive" },
        text: "inspected",
        threadId: `thread-${firstLease!.attemptId}`,
        turnId: `turn-${firstLease!.attemptId}`,
      },
    );
    const secondCandidate =
      (await database.repository.workflowRuns.getReadyAgentCandidates(
        LOCAL_USER_ID,
        runId,
      ))![0]!;
    expect(secondCandidate.pipeline?.step.key).toBe("summarize");
    await database.repository.workflowRuns.claimAgentAttempt(
      LOCAL_USER_ID,
      secondCandidate,
      {
        cwd: source!.cwd,
        modelRouteId: DEFAULT_MODEL_ROUTE_ID,
        permissionProfileId: null,
        workerId: source!.workerId,
        worktreeId: source!.worktreeId,
      },
    );

    await app.close();
    database = await connectDatabase(config);
    app = await buildApp({ config, database, logger: false, workerBridge });
    const recovering = await runDetail(runId);
    expect(recovering).toMatchObject({
      run: { status: "recovering", recoveryState: "blocked" },
      nodes: [{ status: "recovering" }],
      items: [
        {
          status: "recovering",
          executionState: {
            kind: "pipeline",
            currentStepPosition: 1,
            currentStepAttemptCount: 1,
            completedSteps: [{ key: "inspect" }],
          },
        },
      ],
      attempts: [
        { executionUnitKey: "inspect", status: "completed" },
        { executionUnitKey: "summarize", status: "orphaned" },
      ],
    });
    connected = true;
    const retry = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/nodes/${recovering.nodes[0]!.id}/retry`,
      payload: {
        reason: "Resume the persisted pipeline step.",
        idempotencyKey: "retry-pipeline-after-restart",
      },
    });
    expect(retry.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    expect((await runDetail(runId)).run.structuredResult).toEqual([
      { summary: "survive" },
    ]);
  });

  it("repeats through durable iterations until the success predicate matches", async () => {
    const revision = await createWorkflowRevision("repeat-until-success", [
      {
        key: "repeat_until_stable",
        type: "repeatUntil",
        name: "Repeat until stable",
        configuration: {
          prompt: "Repeat until stable.",
          successCondition: {
            path: "/done",
            operator: "equals",
            value: true,
          },
          progressPath: "/progress",
          maxUnchangedIterations: 2,
          maxIterations: 5,
          maxDurationMs: 60_000,
        },
        outputSchema: { type: "object" },
      },
    ]);
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-repeat-until-success",
      { maxNodes: 10 },
      { progress: 0 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    const detail = await runDetail(runId);
    const commands = executionCommands.slice(before);
    const firstThreadId = `thread-${commands[0]!.attemptId}`;
    expect(commands.map(({ threadId }) => threadId)).toEqual([
      null,
      firstThreadId,
      firstThreadId,
    ]);
    expect(detail.run.structuredResult).toEqual({ progress: 3, done: true });
    expect(detail.nodes[0]).toMatchObject({
      attemptCount: 3,
      measuredUsage: { totalTokens: 42 },
      status: "completed",
      dependencyState: {
        repeatUntil: {
          kind: "repeatUntil",
          currentIteration: 4,
          currentIterationAttemptCount: 0,
          unchangedIterations: 0,
          logicalNodeCount: 3,
          completedIterations: [
            { iteration: 1, progressValue: 1 },
            { iteration: 2, progressValue: 2 },
            { iteration: 3, progressValue: 3 },
          ],
        },
      },
    });
    expect(
      detail.attempts.map(({ attempt, executionUnitKey, status }) => ({
        attempt,
        executionUnitKey,
        status,
      })),
    ).toEqual([
      { attempt: 1, executionUnitKey: "iteration-1", status: "completed" },
      { attempt: 2, executionUnitKey: "iteration-2", status: "completed" },
      { attempt: 3, executionUnitKey: "iteration-3", status: "completed" },
    ]);
  });

  it("stops a repeat-until node when progress remains unchanged", async () => {
    const revision = await createWorkflowRevision("repeat-no-progress", [
      {
        key: "repeat_without_progress",
        type: "repeatUntil",
        name: "Repeat without progress",
        configuration: {
          prompt: "Repeat without progress.",
          successCondition: {
            path: "/done",
            operator: "equals",
            value: true,
          },
          progressPath: "/progress",
          maxUnchangedIterations: 1,
          maxIterations: 5,
          maxDurationMs: 60_000,
        },
      },
    ]);
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-repeat-no-progress",
      { maxNodes: 10 },
      { progress: "start" },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    const detail = await runDetail(runId);
    expect(executionCommands).toHaveLength(before + 2);
    expect(detail.run).toMatchObject({
      errorCode: "repeat-no-progress",
      errorMessage: expect.stringContaining("unchanged-progress"),
    });
    expect(detail.nodes[0]).toMatchObject({
      status: "failed",
      dependencyState: {
        repeatUntil: {
          currentIteration: 3,
          unchangedIterations: 1,
          logicalNodeCount: 2,
          completedIterations: [{ iteration: 1 }, { iteration: 2 }],
        },
      },
    });
    const retry = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/nodes/${detail.nodes[0]!.id}/retry`,
      payload: {
        reason: "Try past the configured no-progress ceiling.",
        idempotencyKey: "retry-repeat-no-progress",
      },
    });
    expect(retry.statusCode).toBe(409);
  });

  it("fails explicitly when a repeat-until progress path is missing", async () => {
    const revision = await createWorkflowRevision("repeat-missing-progress", [
      {
        key: "repeat_missing_progress",
        type: "repeatUntil",
        name: "Repeat missing progress",
        configuration: {
          prompt: "Return a result without repeat progress.",
          successCondition: {
            path: "/done",
            operator: "equals",
            value: true,
          },
          progressPath: "/progress",
          maxUnchangedIterations: 1,
          maxIterations: 2,
          maxDurationMs: 60_000,
        },
      },
    ]);
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-repeat-missing-progress",
      { maxNodes: 5 },
      { progress: 0 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    const detail = await runDetail(runId);
    expect(executionCommands).toHaveLength(before + 1);
    expect(detail.run).toMatchObject({
      errorCode: "repeat-progress-missing",
      errorMessage: expect.stringContaining("/progress"),
    });
    expect(detail.nodes[0]?.dependencyState).toMatchObject({
      repeatUntil: {
        currentIteration: 1,
        currentIterationAttemptCount: 1,
        completedIterations: [],
      },
    });
  });

  it("enforces repeat-until iteration and workflow-node ceilings", async () => {
    const revision = await createWorkflowRevision("repeat-iteration-limit", [
      {
        key: "repeat_through_limit",
        type: "repeatUntil",
        name: "Repeat through limit",
        configuration: {
          prompt: "Repeat through iteration limit.",
          successCondition: {
            path: "/done",
            operator: "equals",
            value: true,
          },
          progressPath: "/progress",
          maxUnchangedIterations: 2,
          maxIterations: 2,
          maxDurationMs: 60_000,
        },
      },
    ]);
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-repeat-iteration-limit",
      { maxNodes: 10 },
      { progress: 0 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    expect((await runDetail(runId)).run).toMatchObject({
      errorCode: "repeat-iteration-limit",
    });
    expect(executionCommands).toHaveLength(before + 2);

    const boundedBefore = executionCommands.length;
    const boundedResponse = await createRunForRevision(
      revision,
      "execute-repeat-node-budget",
      { maxNodes: 2 },
      { progress: 0 },
    );
    const boundedRunId = workflowRunDetailSchema.parse(boundedResponse.json())
      .run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(boundedRunId)).run.status).toBe("failed");
    });
    expect((await runDetail(boundedRunId)).run).toMatchObject({
      errorCode: "workflow-node-budget-exceeded",
    });
    expect(executionCommands).toHaveLength(boundedBefore + 1);
  });

  it("retries within one repeat-until iteration without losing usage", async () => {
    const revision = await createWorkflowRevision("repeat-iteration-retry", [
      {
        key: "repeat_until_stable",
        type: "repeatUntil",
        name: "Repeat until stable",
        configuration: {
          prompt: "Repeat until stable.",
          automaticRetries: 1,
          successCondition: {
            path: "/done",
            operator: "equals",
            value: true,
          },
          progressPath: "/progress",
          maxUnchangedIterations: 2,
          maxIterations: 5,
          maxDurationMs: 60_000,
        },
      },
    ]);
    mode = "failure";
    const response = await createRunForRevision(
      revision,
      "execute-repeat-iteration-retry",
      { maxAttemptsPerNode: 2, maxNodes: 10 },
      { progress: 0 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    const detail = await runDetail(runId);
    expect(detail.nodes[0]).toMatchObject({
      attemptCount: 4,
      measuredUsage: { totalTokens: 50 },
      dependencyState: {
        repeatUntil: {
          currentIteration: 4,
          currentIterationAttemptCount: 0,
          completedIterations: [
            { iteration: 1 },
            { iteration: 2 },
            { iteration: 3 },
          ],
        },
      },
    });
    expect(
      detail.attempts.map(({ executionUnitKey, status }) => ({
        executionUnitKey,
        status,
      })),
    ).toEqual([
      { executionUnitKey: "iteration-1", status: "failed" },
      { executionUnitKey: "iteration-1", status: "completed" },
      { executionUnitKey: "iteration-2", status: "completed" },
      { executionUnitKey: "iteration-3", status: "completed" },
    ]);
  });

  it("recovers the current repeat-until iteration without replaying its ledger", async () => {
    const revision = await createWorkflowRevision("repeat-restart", [
      {
        key: "repeat_until_stable",
        type: "repeatUntil",
        name: "Repeat until stable",
        configuration: {
          prompt: "Repeat until stable.",
          automaticRetries: 0,
          successCondition: {
            path: "/done",
            operator: "equals",
            value: true,
          },
          progressPath: "/progress",
          maxUnchangedIterations: 2,
          maxIterations: 5,
          maxDurationMs: 60_000,
        },
      },
    ]);
    connected = false;
    mode = "success";
    const response = await createRunForRevision(
      revision,
      "execute-repeat-restart",
      { maxAttemptsPerNode: 2, maxNodes: 10 },
      { progress: 0 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).nodes[0]?.dependencyState).toMatchObject({
        repeatUntil: { currentIteration: 1 },
      });
    });
    const source = await database.repository.getProjectSource(
      LOCAL_USER_ID,
      projectId,
    );
    const firstCandidate =
      (await database.repository.workflowRuns.getReadyAgentCandidates(
        LOCAL_USER_ID,
        runId,
      ))![0]!;
    const firstLease = await database.repository.workflowRuns.claimAgentAttempt(
      LOCAL_USER_ID,
      firstCandidate,
      {
        cwd: source!.cwd,
        modelRouteId: DEFAULT_MODEL_ROUTE_ID,
        permissionProfileId: null,
        workerId: source!.workerId,
        worktreeId: source!.worktreeId,
      },
    );
    await database.repository.workflowRuns.completeAgentAttempt(
      LOCAL_USER_ID,
      firstLease!,
      {
        measuredUsage: {
          inputTokens: 10,
          outputTokens: 4,
          cachedInputTokens: 2,
          totalTokens: 14,
          durationMs: 250,
          estimatedCostUsd: null,
          costAvailable: false,
        },
        structuredResult: { progress: 1, done: false },
        text: "continue",
        threadId: `thread-${firstLease!.attemptId}`,
        turnId: `turn-${firstLease!.attemptId}`,
      },
    );
    const secondCandidate =
      (await database.repository.workflowRuns.getReadyAgentCandidates(
        LOCAL_USER_ID,
        runId,
      ))![0]!;
    expect(secondCandidate.repeatUntil?.state.currentIteration).toBe(2);
    await database.repository.workflowRuns.claimAgentAttempt(
      LOCAL_USER_ID,
      secondCandidate,
      {
        cwd: source!.cwd,
        modelRouteId: DEFAULT_MODEL_ROUTE_ID,
        permissionProfileId: null,
        workerId: source!.workerId,
        worktreeId: source!.worktreeId,
      },
    );

    await app.close();
    database = await connectDatabase(config);
    app = await buildApp({ config, database, logger: false, workerBridge });
    const recovering = await runDetail(runId);
    expect(recovering).toMatchObject({
      run: { status: "recovering", recoveryState: "blocked" },
      nodes: [
        {
          status: "recovering",
          dependencyState: {
            repeatUntil: {
              currentIteration: 2,
              currentIterationAttemptCount: 1,
              completedIterations: [
                { iteration: 1, structuredResult: { progress: 1 } },
              ],
            },
          },
        },
      ],
      attempts: [
        { executionUnitKey: "iteration-1", status: "completed" },
        { executionUnitKey: "iteration-2", status: "orphaned" },
      ],
    });
    connected = true;
    const retry = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/nodes/${recovering.nodes[0]!.id}/retry`,
      payload: {
        reason: "Resume the durable repeat iteration.",
        idempotencyKey: "retry-repeat-after-restart",
      },
    });
    expect(retry.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    const completed = await runDetail(runId);
    expect(completed.run.structuredResult).toEqual({
      progress: 3,
      done: true,
    });
    expect(completed.nodes[0]?.dependencyState).toMatchObject({
      repeatUntil: {
        currentIteration: 4,
        completedIterations: [
          { iteration: 1 },
          { iteration: 2 },
          { iteration: 3 },
        ],
      },
    });
  });

  it("enforces the repeat-until duration ceiling at a completed turn boundary", async () => {
    const revision = await createWorkflowRevision("repeat-duration-limit", [
      {
        key: "repeat_through_duration",
        type: "repeatUntil",
        name: "Repeat through duration",
        configuration: {
          prompt: "Repeat through duration limit.",
          successCondition: {
            path: "/done",
            operator: "equals",
            value: true,
          },
          progressPath: "/progress",
          maxUnchangedIterations: 2,
          maxIterations: 5,
          maxDurationMs: 1_000,
        },
      },
    ]);
    mode = "hold-success";
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-repeat-duration-limit",
      { maxNodes: 10 },
      { progress: 0 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(() => expect(heldExecution).not.toBeNull());
    expect(executionCommands[before]!.timeoutMs).toBeGreaterThan(0);
    expect(executionCommands[before]!.timeoutMs).toBeLessThanOrEqual(1_000);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    heldExecution?.();
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    expect((await runDetail(runId)).run).toMatchObject({
      errorCode: "repeat-duration-limit",
    });
  });

  it("cancels every active and pending map item and interrupts each live turn", async () => {
    const revision = await createWorkflowRevision("map-cancel", [
      {
        key: "map_items",
        type: "map",
        name: "Map items",
        configuration: {
          prompt: "Map collection item.",
          collectionPath: "/values",
          itemInputKey: "item",
          maxConcurrency: 2,
          failurePolicy: "fail-fast",
        },
      },
    ]);
    connected = true;
    mode = "parallel-hold";
    const interruptsBefore = interruptCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-map-cancel",
      { maxParallelism: 2, maxNodes: 10 },
      { values: ["one", "two", "three"] },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect(
        (await runDetail(runId)).items.filter(
          ({ status }) => status === "running",
        ),
      ).toHaveLength(2);
    });
    const cancellation = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/cancel`,
      payload: {
        reason: "Cancel the collection.",
        idempotencyKey: "cancel-map-once",
      },
    });
    expect(cancellation.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("cancelled");
    });
    mode = "success";
    const detail = await runDetail(runId);
    expect(detail.items.map(({ status }) => status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(detail.attempts.map(({ status }) => status)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    expect(interruptCommands).toHaveLength(interruptsBefore + 2);
  });

  it("recovers an orphaned map item after restart without re-expanding the collection", async () => {
    const revision = await createWorkflowRevision("map-restart-recovery", [
      {
        key: "map_items",
        type: "map",
        name: "Map items",
        configuration: {
          prompt: "Map collection item.",
          collectionPath: "/values",
          itemInputKey: "item",
          maxConcurrency: 1,
          failurePolicy: "fail-fast",
          automaticRetries: 0,
        },
      },
    ]);
    connected = false;
    mode = "success";
    const response = await createRunForRevision(
      revision,
      "execute-map-restart-recovery",
      { maxAttemptsPerNode: 2, maxNodes: 10 },
      { values: ["survive"] },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).items).toHaveLength(1);
    });
    const candidates =
      await database.repository.workflowRuns.getReadyAgentCandidates(
        LOCAL_USER_ID,
        runId,
      );
    const source = await database.repository.getProjectSource(
      LOCAL_USER_ID,
      projectId,
    );
    const lease = await database.repository.workflowRuns.claimAgentAttempt(
      LOCAL_USER_ID,
      candidates![0]!,
      {
        cwd: source!.cwd,
        modelRouteId: DEFAULT_MODEL_ROUTE_ID,
        permissionProfileId: null,
        workerId: source!.workerId,
        worktreeId: source!.worktreeId,
      },
    );
    expect(lease?.candidate.item).not.toBeNull();

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
      items: [{ status: "recovering", attemptCount: 1 }],
      attempts: [{ status: "orphaned", runNodeItemId: expect.any(String) }],
    });

    connected = true;
    const recovering = await runDetail(runId);
    const retry = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/nodes/${recovering.nodes[0]!.id}/retry`,
      payload: {
        reason: "Resume the durable collection item.",
        idempotencyKey: "retry-map-after-restart",
      },
    });
    expect(retry.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    const completed = await runDetail(runId);
    expect(completed.items).toHaveLength(1);
    expect(completed.items[0]).toMatchObject({
      status: "completed",
      attemptCount: 2,
      structuredResult: { mapped: "survive" },
    });
    expect(
      completed.attempts.map(({ attempt, status }) => ({
        attempt,
        status,
      })),
    ).toEqual([
      { attempt: 1, status: "orphaned" },
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

  it("pauses at a durable turn boundary, survives restart, and resumes without duplicate work", async () => {
    const revision = await createWorkflowRevision(
      "pause-resume-boundary",
      [
        {
          key: "alpha",
          type: "agent",
          name: "Alpha",
          configuration: { prompt: "Alpha branch." },
          outputSchema: { type: "object" },
        },
        {
          key: "beta",
          type: "agent",
          name: "Beta",
          configuration: { prompt: "Beta branch." },
          outputSchema: { type: "object" },
        },
      ],
      [{ from: "alpha", to: "beta" }],
    );
    connected = true;
    mode = "hold-success";
    const executionsBefore = executionCommands.length;
    const interruptsBefore = interruptCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-pause-resume-boundary",
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(() => expect(heldExecution).not.toBeNull());

    const pausePayload = {
      reason: "Pause before the dependent node starts.",
      idempotencyKey: "pause-boundary-once",
    };
    const pause = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/pause`,
      payload: pausePayload,
    });
    expect(pause.statusCode).toBe(200);
    expect(workflowRunDetailSchema.parse(pause.json())).toMatchObject({
      run: {
        status: "paused",
        pauseReason: pausePayload.reason,
        pausedAt: expect.any(String),
      },
      nodes: [
        { nodeKey: "alpha", status: "running" },
        { nodeKey: "beta", status: "blocked" },
      ],
      attempts: [{ status: "running" }],
    });
    expect(interruptCommands).toHaveLength(interruptsBefore);

    const pauseReplay = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/pause`,
      payload: pausePayload,
    });
    expect(pauseReplay.statusCode).toBe(200);
    const pauseDrift = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/pause`,
      payload: { ...pausePayload, reason: "A different pause reason." },
    });
    expect(pauseDrift.statusCode).toBe(409);

    heldExecution?.();
    await vi.waitFor(async () => {
      expect(await runDetail(runId)).toMatchObject({
        run: { status: "paused", pauseReason: pausePayload.reason },
        nodes: [
          { nodeKey: "alpha", status: "completed" },
          { nodeKey: "beta", status: "ready" },
        ],
        attempts: [{ status: "completed" }],
      });
    });
    expect(executionCommands).toHaveLength(executionsBefore + 1);
    expect(interruptCommands).toHaveLength(interruptsBefore);

    await app.close();
    connected = true;
    database = await connectDatabase(config);
    app = await buildApp({ config, database, logger: false, workerBridge });
    expect(await runDetail(runId)).toMatchObject({
      run: { status: "paused", pauseReason: pausePayload.reason },
      nodes: [
        { nodeKey: "alpha", status: "completed" },
        { nodeKey: "beta", status: "ready" },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executionCommands).toHaveLength(executionsBefore + 1);

    const resumePayload = {
      reason: "Continue from the persisted boundary.",
      idempotencyKey: "resume-boundary-once",
    };
    const resume = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/resume`,
      payload: resumePayload,
    });
    expect(resume.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    expect(executionCommands).toHaveLength(executionsBefore + 2);
    expect(interruptCommands).toHaveLength(interruptsBefore);

    const resumeReplay = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/resume`,
      payload: resumePayload,
    });
    expect(resumeReplay.statusCode).toBe(200);
    const resumeDrift = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/resume`,
      payload: { ...resumePayload, reason: "A different resume reason." },
    });
    expect(resumeDrift.statusCode).toBe(409);
    expect(executionCommands).toHaveLength(executionsBefore + 2);

    const events = workflowRunEventPageSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflow-runs/${runId}/events`,
        })
      ).json(),
    );
    const eventTypes = events.events.map(({ type }) => type);
    expect(eventTypes.filter((type) => type === "run.paused")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "run.resumed")).toHaveLength(1);
    expect(eventTypes.indexOf("run.paused")).toBeLessThan(
      eventTypes.indexOf("run.resumed"),
    );
  });

  it("defers an automatic retry that becomes ready while paused", async () => {
    connected = true;
    mode = "hold-failure";
    const executionsBefore = executionCommands.length;
    const response = await createRun("execute-pause-deferred-retry");
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(() => expect(heldExecution).not.toBeNull());

    const pause = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/pause`,
      payload: {
        reason: "Inspect the failed attempt before retrying.",
        idempotencyKey: "pause-retry-once",
      },
    });
    expect(pause.statusCode).toBe(200);
    heldExecution?.();
    await vi.waitFor(async () => {
      expect(await runDetail(runId)).toMatchObject({
        run: {
          status: "paused",
          pauseReason: "Inspect the failed attempt before retrying.",
        },
        nodes: [{ status: "ready", attemptCount: 1 }],
        attempts: [{ status: "failed" }],
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executionCommands).toHaveLength(executionsBefore + 1);

    const resume = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/resume`,
      payload: {
        reason: "Retry now.",
        idempotencyKey: "resume-retry-once",
      },
    });
    expect(resume.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    expect(await runDetail(runId)).toMatchObject({
      nodes: [{ status: "completed", attemptCount: 2 }],
      attempts: [{ status: "failed" }, { status: "completed" }],
    });
    expect(executionCommands).toHaveLength(executionsBefore + 2);
  });

  it("defers map and pipeline item retries while paused", async () => {
    const cases = [
      {
        primitive: "map",
        node: {
          key: "map_items",
          type: "map",
          name: "Map items",
          configuration: {
            prompt: "Map collection item.",
            collectionPath: "/values",
            itemInputKey: "item",
            maxConcurrency: 1,
            failurePolicy: "fail-fast",
            automaticRetries: 1,
          },
        },
      },
      {
        primitive: "pipeline",
        node: {
          key: "pipeline_items",
          type: "pipeline",
          name: "Pipeline items",
          configuration: {
            collectionPath: "/values",
            itemInputKey: "item",
            maxConcurrency: 1,
            failurePolicy: "fail-fast",
            steps: [
              {
                key: "inspect",
                name: "Inspect",
                prompt: "Pipeline inspect step.",
                automaticRetries: 1,
              },
            ],
          },
        },
      },
    ] as const;

    for (const { node, primitive } of cases) {
      const revision = await createWorkflowRevision(
        `pause-${primitive}-retry`,
        [node],
      );
      connected = true;
      mode = "hold-failure";
      const executionsBefore = executionCommands.length;
      const response = await createRunForRevision(
        revision,
        `execute-pause-${primitive}-retry`,
        {},
        { values: ["only"] },
      );
      const runId = workflowRunDetailSchema.parse(response.json()).run.id;
      await vi.waitFor(() => expect(heldExecution).not.toBeNull());
      const pause = await app.inject({
        method: "POST",
        url: `/api/workflow-runs/${runId}/pause`,
        payload: {
          reason: `Inspect the ${primitive} failure before retrying.`,
          idempotencyKey: `pause-${primitive}-retry-once`,
        },
      });
      expect(pause.statusCode).toBe(200);
      heldExecution?.();
      await vi.waitFor(async () => {
        expect(await runDetail(runId)).toMatchObject({
          run: { status: "paused" },
          nodes: [{ status: "running" }],
          items: [{ status: "ready", attemptCount: 1 }],
          attempts: [{ status: "failed" }],
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(executionCommands).toHaveLength(executionsBefore + 1);

      const resume = await app.inject({
        method: "POST",
        url: `/api/workflow-runs/${runId}/resume`,
        payload: { idempotencyKey: `resume-${primitive}-retry-once` },
      });
      expect(resume.statusCode).toBe(200);
      await vi.waitFor(async () => {
        expect((await runDetail(runId)).run.status).toBe("completed");
      });
      expect(await runDetail(runId)).toMatchObject({
        items: [{ status: "completed", attemptCount: 2 }],
        attempts: [{ status: "failed" }, { status: "completed" }],
      });
      expect(executionCommands).toHaveLength(executionsBefore + 2);
    }
  });

  it("holds the next repeat-until iteration at a paused boundary", async () => {
    const revision = await createWorkflowRevision("pause-repeat-until", [
      {
        key: "repeat_until_stable",
        type: "repeatUntil",
        name: "Repeat until stable",
        configuration: {
          prompt: "Repeat until stable.",
          successCondition: {
            path: "/done",
            operator: "equals",
            value: true,
          },
          progressPath: "/progress",
          maxUnchangedIterations: 2,
          maxIterations: 5,
          maxDurationMs: 60_000,
        },
      },
    ]);
    connected = true;
    mode = "hold-success";
    const executionsBefore = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-pause-repeat-until",
      { maxNodes: 10 },
      { progress: 0 },
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(() => expect(heldExecution).not.toBeNull());
    const pause = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/pause`,
      payload: {
        reason: "Review the first iteration result.",
        idempotencyKey: "pause-repeat-once",
      },
    });
    expect(pause.statusCode).toBe(200);
    heldExecution?.();
    await vi.waitFor(async () => {
      expect(await runDetail(runId)).toMatchObject({
        run: { status: "paused" },
        nodes: [
          {
            status: "ready",
            dependencyState: {
              repeatUntil: {
                currentIteration: 2,
                completedIterations: [{ iteration: 1 }],
              },
            },
          },
        ],
        attempts: [{ status: "completed" }],
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executionCommands).toHaveLength(executionsBefore + 1);

    const resume = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/resume`,
      payload: { idempotencyKey: "resume-repeat-once" },
    });
    expect(resume.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    expect(executionCommands).toHaveLength(executionsBefore + 3);
  });

  it("records a gate decision while paused without dispatching downstream work", async () => {
    const revision = await createWorkflowRevision(
      "pause-gate-decision",
      [
        {
          key: "approval",
          type: "gate",
          name: "Approval",
          configuration: { prompt: "Approve while paused?" },
        },
        {
          key: "continue",
          type: "agent",
          name: "Continue",
          configuration: { prompt: "Continue after paused approval." },
        },
      ],
      [{ from: "approval", to: "continue" }],
    );
    connected = true;
    mode = "success";
    const executionsBefore = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-pause-gate-decision",
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("waiting");
    });
    const gateId = (await runDetail(runId)).gates[0]!.id;
    const pause = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/pause`,
      payload: {
        reason: "Hold downstream work after the decision.",
        idempotencyKey: "pause-gate-once",
      },
    });
    expect(pause.statusCode).toBe(200);

    const decision = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/gates/${gateId}/decision`,
      payload: {
        decision: "approved",
        reason: "Approval is safe to record now.",
        idempotencyKey: "approve-paused-gate-once",
      },
    });
    expect(decision.statusCode).toBe(200);
    expect(workflowRunDetailSchema.parse(decision.json())).toMatchObject({
      run: {
        status: "paused",
        pauseReason: "Hold downstream work after the decision.",
      },
      nodes: [
        { nodeKey: "approval", status: "completed" },
        { nodeKey: "continue", status: "ready" },
      ],
      gates: [{ status: "approved" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executionCommands).toHaveLength(executionsBefore);

    const resume = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/resume`,
      payload: { idempotencyKey: "resume-gate-once" },
    });
    expect(resume.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    expect(executionCommands).toHaveLength(executionsBefore + 1);
  });

  it("persists live cancellation, interrupts once, and lets cancellation win completion races", async () => {
    connected = true;
    mode = "hold-success";
    const executionsBefore = executionCommands.length;
    const interruptsBefore = interruptCommands.length;
    const response = await createRun("execute-cancel-live");
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).nodes[0]?.codexThreadId).toMatch(
        /^thread-/u,
      );
    });
    const active = await runDetail(runId);
    const attempt = active.attempts[0]!;
    const node = active.nodes[0]!;
    const payload = {
      reason: "The operator cancelled this run.",
      idempotencyKey: "cancel-live-once",
    };
    const cancellation = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/cancel`,
      payload,
    });
    expect(cancellation.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("cancelled");
    });
    expect(await runDetail(runId)).toMatchObject({
      run: {
        status: "cancelled",
        cancelReason: payload.reason,
        structuredResult: null,
        errorCode: "cancelled-by-user",
      },
      nodes: [{ status: "cancelled", structuredResult: null }],
      attempts: [{ status: "interrupted", structuredResult: null }],
    });
    expect(executionCommands).toHaveLength(executionsBefore + 1);
    expect(interruptCommands).toHaveLength(interruptsBefore + 1);
    expect(interruptCommands.at(-1)).toMatchObject({
      workflowRunId: runId,
      runNodeId: node.id,
      attemptId: attempt.id,
      threadId: attempt.codexThreadId,
    });

    const replay = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/cancel`,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(interruptCommands).toHaveLength(interruptsBefore + 1);
    const drift = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/cancel`,
      payload: { ...payload, reason: "A different reason." },
    });
    expect(drift.statusCode).toBe(409);

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
      "run.cancelled",
      "node.attempt.interrupted",
    ]);
  });

  it("cancels queued runs without dispatching worker work", async () => {
    connected = false;
    mode = "success";
    const before = executionCommands.length;
    const response = await createRun("execute-cancel-queued");
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    const payload = {
      reason: "No longer needed.",
      idempotencyKey: "cancel-queued-once",
    };
    const cancellation = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/cancel`,
      payload,
    });
    expect(cancellation.statusCode).toBe(200);
    expect(workflowRunDetailSchema.parse(cancellation.json())).toMatchObject({
      run: { status: "cancelled", cancelReason: payload.reason },
      nodes: [{ status: "cancelled" }],
      attempts: [],
    });
    connected = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executionCommands).toHaveLength(before);
  });

  it("requires explicit idempotent retry for an orphaned attempt", async () => {
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

    mode = "success";
    const recovering = await runDetail(runId);
    const payload = {
      reason: "The worker is connected again.",
      idempotencyKey: "retry-orphan-once",
    };
    const retry = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/nodes/${recovering.nodes[0]!.id}/retry`,
      payload,
    });
    expect(retry.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    expect(executionCommands).toHaveLength(before + 2);
    expect(
      (await runDetail(runId)).attempts.map(({ attempt, status }) => ({
        attempt,
        status,
      })),
    ).toEqual([
      { attempt: 1, status: "orphaned" },
      { attempt: 2, status: "completed" },
    ]);

    const replay = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/nodes/${recovering.nodes[0]!.id}/retry`,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executionCommands).toHaveLength(before + 2);
    const drift = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/nodes/${recovering.nodes[0]!.id}/retry`,
      payload: { ...payload, reason: "A different reason." },
    });
    expect(drift.statusCode).toBe(409);
  });

  it("rejects retries after the node attempt budget is exhausted", async () => {
    connected = true;
    mode = "terminal-failure";
    const response = await createRun("execute-exhausted");
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    const detail = await runDetail(runId);
    expect(detail.attempts).toHaveLength(2);
    const retry = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/nodes/${detail.nodes[0]!.id}/retry`,
      payload: {
        reason: null,
        idempotencyKey: "retry-exhausted",
      },
    });
    expect(retry.statusCode).toBe(409);
    mode = "success";
  });

  it("reopens skipped downstream nodes after an explicit failed-node retry", async () => {
    const retryRevision = await createWorkflowRevision(
      "retry-static-chain",
      [
        {
          key: "first",
          type: "agent",
          name: "First",
          configuration: {
            prompt: "Recoverable root.",
            automaticRetries: 0,
          },
        },
        {
          key: "second",
          type: "agent",
          name: "Second",
          configuration: { prompt: "Continue recovered chain." },
        },
      ],
      [{ from: "first", to: "second" }],
    );
    mode = "terminal-failure";
    const response = await createRunForRevision(
      retryRevision,
      "execute-retry-static-chain",
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("failed");
    });
    const failed = await runDetail(runId);
    expect(failed.nodes).toMatchObject([
      { nodeKey: "first", status: "failed" },
      { nodeKey: "second", status: "skipped" },
    ]);

    mode = "success";
    const retry = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/nodes/${failed.nodes[0]!.id}/retry`,
      payload: {
        reason: "Retry the recovered worker.",
        idempotencyKey: "retry-static-chain-once",
      },
    });
    expect(retry.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
    expect(await runDetail(runId)).toMatchObject({
      run: { status: "completed", structuredResult: { approved: true } },
      nodes: [
        { nodeKey: "first", status: "completed", attemptCount: 2 },
        { nodeKey: "second", status: "completed", attemptCount: 1 },
      ],
    });
  });

  it("preserves a pending approval gate across a server restart", async () => {
    connected = true;
    mode = "success";
    const revision = await createWorkflowRevision(
      "gate-restart",
      [
        {
          key: "approval",
          type: "gate",
          name: "Approval",
          configuration: { prompt: "Approve after restart?" },
        },
        {
          key: "continue",
          type: "agent",
          name: "Continue",
          configuration: { prompt: "Continue after restarted approval." },
        },
      ],
      [{ from: "approval", to: "continue" }],
    );
    const before = executionCommands.length;
    const response = await createRunForRevision(
      revision,
      "execute-gate-restart",
    );
    const runId = workflowRunDetailSchema.parse(response.json()).run.id;
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("waiting");
    });
    const gateId = (await runDetail(runId)).gates[0]!.id;

    await app.close();
    connected = true;
    database = await connectDatabase(config);
    app = await buildApp({ config, database, logger: false, workerBridge });
    expect(await runDetail(runId)).toMatchObject({
      run: { status: "waiting", pauseReason: "Approve after restart?" },
      nodes: [
        { nodeKey: "approval", status: "waiting-for-approval" },
        { nodeKey: "continue", status: "blocked" },
      ],
      gates: [{ id: gateId, status: "pending" }],
      attempts: [],
    });

    const decision = await app.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/gates/${gateId}/decision`,
      payload: {
        decision: "approved",
        reason: "State survived restart.",
        idempotencyKey: "approve-restarted-gate",
      },
    });
    expect(decision.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect((await runDetail(runId)).run.status).toBe("completed");
    });
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
    const candidates =
      await database.repository.workflowRuns.getReadyAgentCandidates(
        LOCAL_USER_ID,
        runId,
      );
    const candidate = candidates?.[0];
    const source = await database.repository.getProjectSource(
      LOCAL_USER_ID,
      projectId,
    );
    expect(candidate).not.toBeNull();
    expect(source).not.toBeNull();
    const lease = await database.repository.workflowRuns.claimAgentAttempt(
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
