import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import {
  projectAutomationDispatchResultSchema,
  projectAutomationListSchema,
  projectAutomationSchema,
} from "@cantrip/protocol/automations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-project-automation-api-"),
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
const conditionRequests: Extract<
  WorkerCommand,
  { type: "automation.condition.evaluate" }
>[] = [];
let conditionAllowed = true;
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected() {
    return false;
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
    if (command.type === "automation.condition.evaluate") {
      conditionRequests.push(command);
      return {
        allowed: conditionAllowed,
        detail: conditionAllowed ? "Condition passed." : "Condition blocked.",
      };
    }
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let chatId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker({
    workerId: "automation-worker",
    name: "Automation Worker",
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
    workerId: "automation-worker",
    repositoryId: "automation-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "automation-worker",
    {
      path: path.join(dataDirectory, "repository"),
      displayPath: "ArcaneArts/Cantrip",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  const chat = await database.repository.createChat(LOCAL_USER_ID, projectId, {
    title: "Scheduled work",
    worktreeMode: "agent-managed",
  });
  if (!chat) throw new Error("Could not create automation target chat.");
  chatId = chat.id;
  await database.repository.setChatAutomationPaused(
    LOCAL_USER_ID,
    chatId,
    true,
  );
  app = await buildApp({ config, database, logger: false, workerBridge });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("project automation API", () => {
  let automationId = "";

  it("persists schedules and exposes them only to the target worker", async () => {
    const startsAt = new Date(Date.now() + 10_000).toISOString();
    const createdResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/automations`,
      payload: {
        name: "Project review",
        chatId,
        prompt: "Review the project and summarize its current state.",
        schedule: {
          kind: "interval",
          every: 5,
          unit: "minute",
          startsAt,
        },
        condition: { type: "open-issues", minimum: 1 },
        enabled: true,
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = projectAutomationSchema.parse(createdResponse.json());
    automationId = created.id;
    expect(created.nextRunAt).toBe(startsAt);
    expect(created.chatTitle).toBe("Scheduled work");
    expect(created.condition).toEqual({ type: "open-issues", minimum: 1 });

    const workerResponse = await app.inject({
      method: "GET",
      url: "/api/internal/workers/automations?workerId=automation-worker",
      headers: { authorization: "Bearer test-worker-token" },
    });
    expect(workerResponse.statusCode).toBe(200);
    expect(projectAutomationListSchema.parse(workerResponse.json())).toEqual([
      created,
    ]);

    const otherWorkerResponse = await app.inject({
      method: "GET",
      url: "/api/internal/workers/automations?workerId=other-worker",
      headers: { authorization: "Bearer test-worker-token" },
    });
    expect(otherWorkerResponse.statusCode).toBe(404);
    expect(otherWorkerResponse.json()).toEqual({ error: "Worker not found." });
  });

  it("claims a due occurrence once and queues its prompt durably", async () => {
    const listed = projectAutomationListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/automations`,
        })
      ).json(),
    );
    const automation = listed[0]!;
    const dispatch = () =>
      app.inject({
        method: "POST",
        url: `/api/internal/workers/automations/${automation.id}/dispatch?workerId=automation-worker`,
        headers: { authorization: "Bearer test-worker-token" },
        payload: {
          revision: automation.revision,
          scheduledFor: automation.nextRunAt,
        },
      });

    const first = await dispatch();
    expect(first.statusCode).toBe(202);
    expect(
      projectAutomationDispatchResultSchema.parse(first.json()),
    ).toMatchObject({ accepted: true, status: "queued" });
    const queued = await database.repository.listQueuedPrompts(
      LOCAL_USER_ID,
      chatId,
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toBe(
      "Review the project and summarize its current state.",
    );
    expect(conditionRequests).toContainEqual({
      type: "automation.condition.evaluate",
      condition: { type: "open-issues", minimum: 1 },
      cwd: path.join(dataDirectory, "repository"),
      repository: "ArcaneArts/Cantrip",
    });

    const duplicate = await dispatch();
    expect(duplicate.statusCode).toBe(200);
    expect(
      projectAutomationDispatchResultSchema.parse(duplicate.json()),
    ).toMatchObject({ accepted: false, status: "skipped" });
    expect(
      await database.repository.listQueuedPrompts(LOCAL_USER_ID, chatId),
    ).toHaveLength(1);
  });

  it("advances a due occurrence without queuing when its condition is false", async () => {
    conditionAllowed = false;
    const startsAt = new Date(Date.now() + 10_000).toISOString();
    const createdResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/automations`,
      payload: {
        name: "Conditional review",
        chatId,
        prompt: "This prompt should be skipped.",
        schedule: {
          kind: "interval",
          every: 1,
          unit: "hour",
          startsAt,
        },
        condition: { type: "script", script: "exit 1" },
        enabled: true,
      },
    });
    const automation = projectAutomationSchema.parse(createdResponse.json());
    const dispatched = await app.inject({
      method: "POST",
      url: `/api/internal/workers/automations/${automation.id}/dispatch?workerId=automation-worker`,
      headers: { authorization: "Bearer test-worker-token" },
      payload: {
        revision: automation.revision,
        scheduledFor: automation.nextRunAt,
      },
    });

    expect(dispatched.statusCode).toBe(202);
    expect(
      projectAutomationDispatchResultSchema.parse(dispatched.json()),
    ).toMatchObject({ accepted: true, status: "skipped" });
    expect(
      await database.repository.listQueuedPrompts(LOCAL_USER_ID, chatId),
    ).toHaveLength(1);
    const skipped = projectAutomationListSchema
      .parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/automations`,
          })
        ).json(),
      )
      .find(({ id }) => id === automation.id);
    expect(skipped?.lastStatus).toBe("skipped");

    conditionAllowed = true;
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/automations/${automation.id}`,
        })
      ).statusCode,
    ).toBe(204);
  });

  it("pauses, edits, and deletes an automation", async () => {
    const updatedResponse = await app.inject({
      method: "PATCH",
      url: `/api/automations/${automationId}`,
      payload: { name: "Paused review", enabled: false },
    });
    expect(updatedResponse.statusCode).toBe(200);
    const updated = projectAutomationSchema.parse(updatedResponse.json());
    expect(updated.name).toBe("Paused review");
    expect(updated.enabled).toBe(false);
    expect(updated.nextRunAt).toBeNull();

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/automations/${automationId}`,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      projectAutomationListSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/automations`,
          })
        ).json(),
      ),
    ).toEqual([]);
  });
});
