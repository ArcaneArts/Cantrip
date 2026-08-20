import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  chatRelocationJobListSchema,
  chatRelocationJobSummarySchema,
  unprobedCodexRuntimeReport,
  type ChatRelocationJobSummary,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-chat-relocation-api-"),
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
    return workerId === "worker-source";
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
  async request() {
    throw new Error("An offline relocation target must not receive commands.");
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let chatId: string;

async function waitForState(
  jobId: string,
  state: ChatRelocationJobSummary["state"],
): Promise<ChatRelocationJobSummary> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await database.repository.chatRelocationJobs.get(
      LOCAL_USER_ID,
      jobId,
    );
    if (job?.state === state) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Relocation ${jobId} did not reach ${state}.`);
}

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureLocalIdentity();
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  for (const [workerId, name] of [
    ["worker-source", "Source"],
    ["worker-target", "Target"],
  ] as const) {
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId,
      name,
      platform: "linux",
      architecture: "x64",
      codexVersion: "0.146.1",
      codexRuntime: unprobedCodexRuntimeReport,
      remoteSurfaces: {
        browser: false,
        desktop: false,
        transports: ["websocket"],
        maxSessions: 1,
      },
      projectReplicas: {
        provision: true,
        synchronize: true,
        remove: true,
        exactRevision: true,
      },
      chatRelocation: true,
      startedAt: new Date().toISOString(),
    });
  }
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "worker-source",
    ...protectedProjectFields(),
    repositoryId: "chat-relocation-api-project",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  for (const workerId of ["worker-source", "worker-target"]) {
    await database.repository.completeGithubProjectSetup(
      LOCAL_USER_ID,
      projectId,
      workerId,
      {
        path: path.join(dataDirectory, workerId),
        displayPath: workerId,
        reused: false,
        updated: false,
        warning: null,
      },
    );
  }
  const worktrees = await database.repository.listProjectWorktrees(
    LOCAL_USER_ID,
    projectId,
  );
  for (const worktree of worktrees) {
    await database.repository.observeProjectWorktree(
      LOCAL_USER_ID,
      projectId,
      worktree.id,
      {
        path: worktree.path,
        head: "a".repeat(40),
        branch: "main",
        detached: false,
        isPrimary: true,
        managed: true,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
        missing: false,
      },
    );
  }
  const source = worktrees.find(
    (worktree) => worktree.workerId === "worker-source",
  )!;
  const chat = await database.repository.createChat(
    LOCAL_USER_ID,
    projectId,
    {
      title: "Move through API",
      worktreeId: source.id,
      worktreeMode: "agent-managed",
    },
    () => true,
    () => true,
  );
  chatId = chat!.id;
  app = await buildApp({ config, database, logger: false, workerBridge });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("chat relocation API", () => {
  it("creates durable offline jobs and exposes retry and cancellation", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/relocations`,
      payload: {
        approved: false,
        idempotencyKey: "api-relocation-invalid",
        target: { kind: "worker", projectId, workerId: "worker-target" },
      },
    });
    expect(invalid.statusCode).toBe(400);

    const createdResponse = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/relocations`,
      payload: {
        approved: true,
        idempotencyKey: "api-relocation-offline",
        target: { kind: "worker", projectId, workerId: "worker-target" },
      },
    });
    expect(createdResponse.statusCode).toBe(202);
    const created = chatRelocationJobSummarySchema.parse(
      createdResponse.json(),
    );
    expect(created.targetPlacement.workerId).toBe("worker-target");

    const blocked = await waitForState(created.id, "blocked");
    expect(blocked.error).toMatchObject({
      code: "worker-offline",
      retryable: true,
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/chat-relocations/${created.id}`,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(chatRelocationJobSummarySchema.parse(getResponse.json()).state).toBe(
      "blocked",
    );

    const listResponse = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/relocations`,
    });
    expect(listResponse.statusCode).toBe(200);
    expect(chatRelocationJobListSchema.parse(listResponse.json())).toHaveLength(
      1,
    );

    const retryResponse = await app.inject({
      method: "POST",
      url: `/api/chat-relocations/${created.id}/retry`,
      payload: { stateRevision: blocked.stateRevision },
    });
    expect(retryResponse.statusCode).toBe(200);
    const retried = chatRelocationJobSummarySchema.parse(retryResponse.json());
    expect(retried.state).toBe("queued");

    const blockedAgain = await waitForState(created.id, "blocked");
    const cancelResponse = await app.inject({
      method: "POST",
      url: `/api/chat-relocations/${created.id}/cancel`,
      payload: { stateRevision: blockedAgain.stateRevision },
    });
    expect(cancelResponse.statusCode).toBe(200);
    expect(
      chatRelocationJobSummarySchema.parse(cancelResponse.json()).state,
    ).toBe("cancelled");

    expect(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
    ).toMatchObject({ workerId: "worker-source" });
  });
});
