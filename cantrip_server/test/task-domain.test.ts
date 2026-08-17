import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  chatListSchema,
  chatSummarySchema,
  taskCreateResultSchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import { taskDetailSchema } from "@cantrip/protocol/tasks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-task-domain-"),
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
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return workerId === "task-worker";
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
    throw new Error(`Unexpected Task foundation command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "task-worker",
    name: "Task Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.147.0",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "task-worker",
    repositoryId: "task-domain",
    nameWithOwner: "ArcaneArts/TaskDomain",
    url: "https://github.com/ArcaneArts/TaskDomain",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "task-worker",
    {
      path: path.join(dataDirectory, "repository"),
      displayPath: "ArcaneArts/TaskDomain",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  app = await buildApp({ config, database, logger: false, workerBridge });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("Task domain foundation", () => {
  it("atomically creates a Task-backed Chat without changing ordinary Chats", async () => {
    const createdResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      payload: { title: "Plan a large feature" },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = taskCreateResultSchema.parse(createdResponse.json());
    expect(created.chat).toMatchObject({
      experience: "task",
      title: "Plan a large feature",
    });
    expect(created.task).toMatchObject({
      chatId: created.chat.id,
      state: "draft",
      rowVersion: 1,
      briefMarkdown: "",
    });

    const task = taskDetailSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/tasks/${created.chat.id}`,
        })
      ).json(),
    );
    expect(task.chatId).toBe(created.chat.id);

    const ordinaryResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chats`,
      payload: { title: "Ordinary agent" },
    });
    expect(ordinaryResponse.statusCode).toBe(201);
    const ordinary = chatSummarySchema.parse(ordinaryResponse.json());
    expect(ordinary.experience).toBe("agent");
    expect(
      (await app.inject({ method: "GET", url: `/api/tasks/${ordinary.id}` }))
        .statusCode,
    ).toBe(404);

    const chats = chatListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/chats`,
        })
      ).json(),
    );
    expect(chats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.chat.id, experience: "task" }),
        expect.objectContaining({ id: ordinary.id, experience: "agent" }),
      ]),
    );
    expect(
      await database.repository.tasks.get("other-owner", created.chat.id),
    ).toBeNull();
  });

  it("uses optimistic revisions for draft updates", async () => {
    const created = await database.repository.createTask(
      LOCAL_USER_ID,
      projectId,
      { title: "Revision safety", worktreeMode: "agent-managed" },
    );
    expect(created).not.toBeNull();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created!.chat.id}/draft`,
      payload: {
        rowVersion: created!.task.rowVersion,
        briefMarkdown: "A durable implementation brief",
        draftAttachmentIds: ["attachment-one"],
      },
    });
    expect(response.statusCode).toBe(200);
    const updated = taskDetailSchema.parse(response.json());
    expect(updated).toMatchObject({
      rowVersion: 2,
      briefMarkdown: "A durable implementation brief",
      draftAttachmentIds: ["attachment-one"],
    });

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created!.chat.id}/draft`,
      payload: { rowVersion: 1, briefMarkdown: "Stale overwrite" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "stale-version" });
    expect(
      await database.repository.tasks.get(LOCAL_USER_ID, created!.chat.id),
    ).toMatchObject({ briefMarkdown: "A durable implementation brief" });
  });

  it("starts one idempotent planning round with a stable input snapshot", async () => {
    const created = await database.repository.createTask(
      LOCAL_USER_ID,
      projectId,
      { title: "Idempotent planning", worktreeMode: "agent-managed" },
    );
    const drafted = await database.repository.tasks.updateDraft(
      LOCAL_USER_ID,
      created!.chat.id,
      {
        rowVersion: created!.task.rowVersion,
        briefMarkdown: "Plan this once even if the request is retried.",
      },
    );
    const input = {
      operationId: "task-operation-one",
      kind: "initial-plan" as const,
      rowVersion: drafted!.rowVersion,
    };
    const started = await database.repository.tasks.beginOperation(
      LOCAL_USER_ID,
      created!.chat.id,
      input,
    );
    expect(started).toMatchObject({
      idempotent: false,
      task: {
        state: "planning",
        activeOperationId: input.operationId,
        planningRound: 1,
      },
      round: {
        id: input.operationId,
        ordinal: 1,
        status: "running",
        inputBriefMarkdown: "Plan this once even if the request is retried.",
      },
    });

    const retried = await database.repository.tasks.beginOperation(
      LOCAL_USER_ID,
      created!.chat.id,
      input,
    );
    expect(retried).toMatchObject({
      idempotent: true,
      round: { id: input.operationId },
    });
    expect(
      await database.repository.tasks.listRounds(
        LOCAL_USER_ID,
        created!.chat.id,
      ),
    ).toHaveLength(1);
  });
});
