import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  workflowAutomationTriggerListSchema,
  workflowAutomationTriggerSchema,
  workflowDefinitionDetailSchema,
  workflowRunListSchema,
  workflowTriggerDeliveryResultSchema,
} from "@cantrip/protocol/workflows";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-workflow-trigger-api-"),
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
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

const preauthorized = {
  filesystem: "read-only" as const,
  network: "none" as const,
  approvalMode: "preauthorized" as const,
  skills: [],
  mcpServers: [],
  nativeSubagents: false,
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let workflowId: string;
let revisionId: string;

async function createTrigger(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/workflow-triggers",
    payload: {
      workflowRevisionId: revisionId,
      projectId,
      name: "Automation",
      enabled: true,
      structuredInput: {},
      permissionManifest: preauthorized,
      ...payload,
    },
  });
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
    repositoryId: "workflow-trigger-api",
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
      displayPath: projectPath,
      reused: false,
      updated: false,
      warning: null,
    },
  );
  app = await buildApp({ config, database, logger: false, workerBridge });
  const workflow = workflowDefinitionDetailSchema.parse(
    (
      await app.inject({
        method: "POST",
        url: "/api/workflows",
        payload: {
          scope: "project",
          projectId,
          slug: "preauthorized-gate",
          name: "Preauthorized gate",
          trustState: "trusted",
          revision: {
            graph: {
              version: 1,
              nodes: [
                {
                  key: "gate",
                  type: "gate",
                  name: "Approval gate",
                  configuration: { prompt: "Approve completion." },
                  permissionRequirements: preauthorized,
                },
              ],
              edges: [],
            },
            permissionRequirements: preauthorized,
            trustState: "trusted",
          },
        },
      })
    ).json(),
  );
  workflowId = workflow.workflow.id;
  revisionId = workflow.revision!.id;
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("workflow trigger API", () => {
  it("delivers API triggers idempotently and rate limits new deliveries", async () => {
    const created = workflowAutomationTriggerSchema.parse(
      (
        await createTrigger({
          type: "api",
          configuration: { minimumIntervalSeconds: 60 },
        })
      ).json(),
    );
    const deliveryRequest = () =>
      app.inject({
        method: "POST",
        url: `/api/workflow-triggers/${created.id}/deliver`,
        payload: {
          idempotencyKey: "api-delivery-1",
          structuredInput: { ref: "main" },
        },
      });
    const deliveryResponses = await Promise.all([
      deliveryRequest(),
      deliveryRequest(),
    ]);
    expect(
      deliveryResponses.map(({ statusCode }) => statusCode).sort(),
    ).toEqual([200, 201]);
    const deliveries = deliveryResponses.map((response) =>
      workflowTriggerDeliveryResultSchema.parse(response.json()),
    );
    const first = deliveries.find(({ replayed }) => !replayed)!;
    expect(first).toMatchObject({
      replayed: false,
      delivery: { status: "accepted" },
      run: { run: { trigger: { type: "api", sourceId: created.id } } },
    });
    const replay = deliveries.find(({ replayed }) => replayed)!;
    expect(replay.replayed).toBe(true);
    expect(replay.run.run.id).toBe(first.run.run.id);

    const limited = await app.inject({
      method: "POST",
      url: `/api/workflow-triggers/${created.id}/deliver`,
      payload: { idempotencyKey: "api-delivery-2" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();

    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/workflows/${workflowId}`,
          payload: { trustState: "modified" },
        })
      ).statusCode,
    ).toBe(200);
    const downgraded = await app.inject({
      method: "POST",
      url: `/api/workflow-triggers/${created.id}/deliver`,
      payload: { idempotencyKey: "api-delivery-after-downgrade" },
    });
    expect(downgraded.statusCode).toBe(409);
    expect(downgraded.json()).toMatchObject({
      error: expect.stringContaining("trusted"),
    });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/workflows/${workflowId}`,
          payload: { trustState: "trusted" },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("rejects secret-bearing external inputs before persistence", async () => {
    const triggers = workflowAutomationTriggerListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflow-triggers?projectId=${projectId}&type=api`,
        })
      ).json(),
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/workflow-triggers/${triggers[0]!.id}/deliver`,
      payload: {
        idempotencyKey: "secret-delivery",
        structuredInput: { api_token: "must-not-persist" },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.stringify(response.json())).not.toContain("must-not-persist");
  });

  it("authenticates webhook delivery without returning its credential hash", async () => {
    const token = "webhook-secret-value";
    const created = workflowAutomationTriggerSchema.parse(
      (
        await createTrigger({
          type: "webhook",
          configuration: {
            minimumIntervalSeconds: 1,
            credentialHash: createHash("sha256").update(token).digest("hex"),
          },
        })
      ).json(),
    );
    expect(created).toMatchObject({
      type: "webhook",
      configuration: { credentialConfigured: true },
    });
    expect(JSON.stringify(created)).not.toContain("credentialHash");

    const denied = await app.inject({
      method: "POST",
      url: `/api/workflow-hooks/${created.id}`,
      headers: { "x-cantrip-webhook-token": "wrong" },
      payload: { idempotencyKey: "hook-1" },
    });
    expect(denied.statusCode).toBe(404);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/workflow-hooks/${created.id}`,
      headers: { "x-cantrip-webhook-token": token },
      payload: { idempotencyKey: "hook-1" },
    });
    expect(accepted.statusCode).toBe(201);
    expect(
      workflowTriggerDeliveryResultSchema.parse(accepted.json()).run.run
        .trigger,
    ).toMatchObject({ type: "webhook", sourceId: created.id });
  });

  it("persists offline schedule pause, queue, and catch-up decisions", async () => {
    connected = false;
    const pause = workflowAutomationTriggerSchema.parse(
      (
        await createTrigger({
          name: "Pause offline",
          type: "schedule",
          configuration: {
            intervalSeconds: 60,
            startAt: new Date(Date.now() - 1_000).toISOString(),
            catchUpPolicy: "once",
            offlinePolicy: "pause",
          },
        })
      ).json(),
    );
    const queue = workflowAutomationTriggerSchema.parse(
      (
        await createTrigger({
          name: "Queue offline",
          type: "schedule",
          configuration: {
            intervalSeconds: 60,
            startAt: new Date(Date.now() - 1_000).toISOString(),
            catchUpPolicy: "once",
            offlinePolicy: "queue",
          },
        })
      ).json(),
    );
    const skip = workflowAutomationTriggerSchema.parse(
      (
        await createTrigger({
          name: "Skip overdue",
          type: "schedule",
          configuration: {
            intervalSeconds: 60,
            startAt: new Date(Date.now() - 120_000).toISOString(),
            catchUpPolicy: "skip",
            offlinePolicy: "queue",
          },
        })
      ).json(),
    );

    await vi.waitFor(
      async () => {
        const triggers = workflowAutomationTriggerListSchema.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/workflow-triggers?projectId=${projectId}&type=schedule`,
            })
          ).json(),
        );
        expect(triggers.find(({ id }) => id === pause.id)).toMatchObject({
          lastRunId: null,
          lastError: expect.stringContaining("offline"),
        });
        expect(triggers.find(({ id }) => id === queue.id)?.lastRunId).toEqual(
          expect.any(String),
        );
        expect(triggers.find(({ id }) => id === skip.id)).toMatchObject({
          lastRunId: null,
          lastError: expect.stringContaining("Skipped"),
        });
      },
      { timeout: 4_000 },
    );
    connected = true;
  });

  it("does not duplicate a scheduled run after a server restart", async () => {
    const before = workflowRunListSchema
      .parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/workflow-runs?projectId=${projectId}&limit=100`,
          })
        ).json(),
      )
      .filter(({ trigger }) => trigger.type === "schedule");
    await app.close();
    database = await connectDatabase(config);
    app = await buildApp({ config, database, logger: false, workerBridge });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const after = workflowRunListSchema
      .parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/workflow-runs?projectId=${projectId}&limit=100`,
          })
        ).json(),
      )
      .filter(({ trigger }) => trigger.type === "schedule");
    expect(after.map(({ id }) => id)).toEqual(before.map(({ id }) => id));
  });
});
