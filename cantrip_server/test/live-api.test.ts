import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appLiveServerMessageSchema,
  chatMessageOpaqueSummarySchema,
  codexMcpOauthStartResultSchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import type {
  AppLiveServerMessage,
  WorkerNotification,
} from "@cantrip/protocol";
import {
  encryptedWorkflowAutomationTriggerCreateSchema,
  encryptedWorkflowDefinitionCreateSchema,
  workflowAutomationTriggerWireSchema,
  workflowDefinitionWireDetailSchema,
  workflowTriggerDeliveryWireResultSchema,
} from "@cantrip/protocol/workflows";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { DEFAULT_MODEL_ROUTE_ID, LOCAL_USER_ID } from "../src/db/repository.js";
import type {
  WorkerCommandBus,
  WorkerNotificationListener,
} from "../src/workers/bridge.js";

import { opaquePolicyCreate } from "./policy-encryption-fixture.js";
import {
  protectedChatFields,
  protectedProjectFields,
  protectedTerminalFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(path.join(tmpdir(), "cantrip-live-api-"));
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
const liveTestHeartbeat = {
  workerId: "live-test-worker",
  name: "Live Test Worker",
  platform: "darwin",
  architecture: "arm64",
  codexVersion: "0.146.1",
  codexRuntime: unprobedCodexRuntimeReport,
  code: {
    available: false as const,
    version: null,
    upstreamRevision: null,
    patchset: 0,
    transport: "web-proxy" as const,
    maxSessions: 1,
    reason: "Not needed by the live API test.",
  },
  remoteSurfaces: {
    browser: false,
    desktop: false,
    transports: ["websocket" as const],
    maxSessions: 1,
  },
  startedAt: new Date().toISOString(),
};
const preauthorized = {
  filesystem: "read-only" as const,
  network: "none" as const,
  approvalMode: "preauthorized" as const,
  skills: [],
  mcpServers: [],
  nativeSubagents: false,
};
const opaqueWorkflowContent = () => ({
  formatVersion: 1 as const,
  keyRevision: 1,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: randomBytes(12).toString("base64url"),
    ciphertext: randomBytes(32).toString("base64url"),
  },
});
let oauthStatusReads = 0;
let chatSyncReads = 0;
let workerNotificationListener: WorkerNotificationListener | null = null;
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return workerId === liveTestHeartbeat.workerId;
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
  subscribeNotifications(workerId, listener) {
    if (workerId !== liveTestHeartbeat.workerId) {
      throw new Error(
        `Unexpected worker notification subscription ${workerId}.`,
      );
    }
    workerNotificationListener = listener;
    return () => {
      if (workerNotificationListener === listener) {
        workerNotificationListener = null;
      }
    };
  },
  async request(_workerId, command) {
    switch (command.type) {
      case "customization.mcp.oauth.start":
        return {
          server: command.server,
          authorizationUrl: `https://auth.example.test/${command.server}`,
          status: "pending",
        };
      case "customization.mcp.oauth.status":
        oauthStatusReads += 1;
        return { server: command.server, status: "succeeded", error: null };
      case "customization.skill.configure":
        return { path: command.path, effectiveEnabled: command.enabled };
      case "chat.sync":
        chatSyncReads += 1;
        return {
          threadId: command.threadId,
          status: "idle",
          turns: [],
        };
      case "worktree.observation.configure":
        return { accepted: true };
      case "workflow.trigger.prepare.protected":
        return {
          status: "accepted",
          protectedRunInput: opaqueWorkflowContent(),
        };
      default:
        throw new Error(`Unexpected worker command ${command.type}.`);
    }
  },
};

let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
let chatId: string;
let worktreeId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  await database.repository.recordWorker(LOCAL_USER_ID, liveTestHeartbeat);
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "live-test-worker",
    ...protectedProjectFields(),
    repositoryBlindIndex: "A".repeat(43),
    repositoryId: "live-test-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "live-test-worker",
    {
      path: path.join(dataDirectory, "repository"),
      displayPath: "ArcaneArts/Cantrip",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  const primaryWorktree = (
    await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
  ).find((worktree) => worktree.isPrimary);
  if (!primaryWorktree)
    throw new Error("Could not create the live test worktree.");
  worktreeId = primaryWorktree.id;
  const chat = await database.repository.createChat(LOCAL_USER_ID, projectId, {
    ...protectedChatFields(),
    worktreeMode: "agent-managed",
  });
  if (!chat) throw new Error("Could not create the live test chat.");
  chatId = chat.id;
  app = await buildApp({ config, database, logger: false, workerBridge });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("application live WebSocket", () => {
  it("rejects missing and untrusted Origins", async () => {
    for (const headers of [{}, { origin: "https://attacker.example" }]) {
      let resolveClose: ((code: number) => void) | null = null;
      const closePromise = new Promise<number>((resolve) => {
        resolveClose = resolve;
      });
      const socket = await app.injectWS(
        "/api/live",
        { headers },
        {
          onInit(client) {
            client.once("close", (code) => resolveClose?.(code));
          },
        },
      );
      expect(await closePromise).toBe(1008);
      socket.terminate();
    }
  });

  it("authorizes current-user, project, and chat scopes by ownership", async () => {
    const messages: AppLiveServerMessage[] = [];
    let clientSocket: WebSocket | null = null;
    const socket = await app.injectWS(
      "/api/live",
      { headers: { origin: config.appOrigins[0] } },
      {
        onInit(client) {
          clientSocket = client;
          client.on("message", (data) => {
            messages.push(
              appLiveServerMessageSchema.parse(JSON.parse(data.toString())),
            );
          });
        },
      },
    );
    if (!clientSocket) throw new Error("Live test socket did not initialize.");

    clientSocket.send(
      JSON.stringify({
        type: "initialize",
        protocolVersion: 1,
        client: { id: "api-test", name: "API test", version: "1" },
        resume: null,
      }),
    );
    await vi.waitFor(() =>
      expect(messages.at(-1)).toMatchObject({ type: "ready" }),
    );

    clientSocket.send(
      JSON.stringify({
        type: "subscribe",
        requestId: "owned-scopes",
        scopes: [
          { kind: "current-user" },
          { kind: "project", projectId },
          { kind: "chat", chatId },
        ],
      }),
    );
    await vi.waitFor(() =>
      expect(messages.at(-1)).toMatchObject({
        type: "subscribed",
        requestId: "owned-scopes",
      }),
    );

    const workerSocket = await app.injectWS(
      `/api/internal/workers/connect?workerId=${liveTestHeartbeat.workerId}`,
      { headers: { authorization: `Bearer ${config.workerToken}` } },
    );
    await vi.waitFor(() => expect(workerNotificationListener).not.toBeNull());

    const codeGraphStatus = {
      projectId,
      worktreeId,
      state: "syncing" as const,
      lastIndexedAt: null,
      lastSuccessfulSyncAt: null,
      fileCount: 10,
      nodeCount: 20,
      edgeCount: 30,
      pendingChanges: 2,
      statusMessage: "Synchronizing",
      job: null,
    };
    const codeGraphNotification: WorkerNotification = {
      type: "codegraph.status.observed",
      status: codeGraphStatus,
    };
    const codeGraphEventStart = messages.length;
    const notificationListener = workerNotificationListener;
    if (!notificationListener) {
      throw new Error("Worker notification listener did not initialize.");
    }
    await notificationListener(codeGraphNotification);
    await vi.waitFor(() =>
      expect(
        messages
          .slice(codeGraphEventStart)
          .find(
            (message) =>
              message.type === "event" &&
              message.resource === "codegraph-status" &&
              message.entityId === worktreeId,
          ),
      ).toMatchObject({
        type: "event",
        action: "updated",
        scope: { kind: "project", projectId },
        payload: codeGraphStatus,
        revision: expect.any(Number),
      }),
    );

    const duplicateEventStart = messages.length;
    await notificationListener(codeGraphNotification);
    await notificationListener({
      type: "codegraph.status.observed",
      status: { ...codeGraphStatus, worktreeId: "unowned-worktree" },
    });
    expect(
      messages
        .slice(duplicateEventStart)
        .filter(
          (message) =>
            message.type === "event" && message.resource === "codegraph-status",
        ),
    ).toEqual([]);

    const originalContextRead =
      database.repository.getProjectWorktreeContext.bind(database.repository);
    let releaseOlderContextRead: (() => void) | null = null;
    const olderContextReadGate = new Promise<void>((resolve) => {
      releaseOlderContextRead = resolve;
    });
    let contextReadCount = 0;
    const contextRead = vi
      .spyOn(database.repository, "getProjectWorktreeContext")
      .mockImplementation(
        async (ownerId, candidateProjectId, candidateWorktreeId) => {
          contextReadCount += 1;
          if (contextReadCount === 1) await olderContextReadGate;
          return originalContextRead(
            ownerId,
            candidateProjectId,
            candidateWorktreeId,
          );
        },
      );
    const reorderedEventStart = messages.length;
    try {
      const olderNotification = notificationListener({
        ...codeGraphNotification,
        status: { ...codeGraphStatus, pendingChanges: 3 },
      });
      await vi.waitFor(() => expect(contextReadCount).toBe(1));
      await notificationListener({
        ...codeGraphNotification,
        status: { ...codeGraphStatus, pendingChanges: 0 },
      });
      releaseOlderContextRead?.();
      await olderNotification;
      await vi.waitFor(() =>
        expect(
          messages
            .slice(reorderedEventStart)
            .filter(
              (message) =>
                message.type === "event" &&
                message.resource === "codegraph-status",
            ),
        ).toMatchObject([{ payload: { pendingChanges: 0 } }]),
      );
    } finally {
      releaseOlderContextRead?.();
      contextRead.mockRestore();
    }

    const chatContext = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    );
    if (!chatContext) throw new Error("Could not resolve the live test chat.");
    await database.repository.updateChatRuntime(
      chatId,
      chatContext.workerId,
      chatContext.worktreeId,
      "thread-live-observed",
      DEFAULT_MODEL_ROUTE_ID,
    );
    const syncReadStart = chatSyncReads;
    await notificationListener({
      type: "chat.thread.changed",
      threadId: "thread-live-observed",
      revision: 20,
      changes: ["turn"],
    });
    await notificationListener({
      type: "chat.thread.changed",
      threadId: "thread-live-observed",
      revision: 20,
      changes: ["turn"],
    });
    await notificationListener({
      type: "chat.thread.changed",
      threadId: "thread-live-observed",
      revision: 19,
      changes: ["turn"],
    });
    await notificationListener({
      type: "chat.thread.changed",
      threadId: "unowned-thread",
      revision: 21,
      changes: ["turn"],
    });
    await vi.waitFor(() => expect(chatSyncReads).toBe(syncReadStart + 1));

    const threadResourceEventStart = messages.length;
    await notificationListener({
      type: "chat.thread.changed",
      threadId: "thread-live-observed",
      revision: 21,
      changes: ["goal", "queue", "plan"],
    });
    await vi.waitFor(() => expect(chatSyncReads).toBe(syncReadStart + 2));
    await vi.waitFor(() =>
      expect(
        messages
          .slice(threadResourceEventStart)
          .filter(
            (message) =>
              message.type === "event" &&
              ["chat-goal", "chat-queue", "chat-plan"].includes(
                message.resource,
              ),
          )
          .map((message) => (message.type === "event" ? message.resource : "")),
      ).toEqual(["chat-goal", "chat-queue", "chat-plan"]),
    );

    for (const [requestId, scope] of [
      ["missing-project", { kind: "project", projectId: "missing-project" }],
      ["missing-chat", { kind: "chat", chatId: "missing-chat" }],
      ["missing-workflow-run", { kind: "workflow-run", runId: "missing-run" }],
    ] as const) {
      clientSocket.send(
        JSON.stringify({
          type: "subscribe",
          requestId,
          scopes: [scope],
        }),
      );
      await vi.waitFor(() =>
        expect(messages.at(-1)).toMatchObject({
          type: "error",
          requestId,
          code: "unauthorized-scope",
        }),
      );
    }

    const eventStart = messages.length;
    expect(
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/terminals`,
        payload: protectedTerminalFields(),
      }),
    ).toMatchObject({ statusCode: 201 });
    await vi.waitFor(() =>
      expect(
        messages
          .slice(eventStart)
          .some(
            (message) =>
              message.type === "event" &&
              message.resource === "terminal" &&
              message.scope.kind === "project" &&
              message.scope.projectId === projectId,
          ),
      ).toBe(true),
    );
    expect(
      messages
        .slice(eventStart)
        .some(
          (message) =>
            message.type === "event" &&
            message.resource === "project-tab-layout" &&
            message.scope.kind === "project" &&
            message.scope.projectId === projectId,
        ),
    ).toBe(true);

    const workerEventStart = messages.length;
    expect(
      await app.inject({
        method: "POST",
        url: "/api/internal/workers/heartbeat",
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: liveTestHeartbeat,
      }),
    ).toMatchObject({ statusCode: 202 });
    await vi.waitFor(() =>
      expect(
        messages
          .slice(workerEventStart)
          .some(
            (message) =>
              message.type === "event" &&
              message.resource === "worker" &&
              message.scope.kind === "current-user",
          ),
      ).toBe(true),
    );

    const policyEventStart = messages.length;
    const policyResponse = await app.inject({
      method: "POST",
      url: "/api/policies",
      payload: opaquePolicyCreate("live-policy"),
    });
    expect(policyResponse.statusCode).toBe(201);
    await vi.waitFor(() =>
      expect(
        messages
          .slice(policyEventStart)
          .some(
            (message) =>
              message.type === "event" &&
              message.resource === "policy" &&
              message.scope.kind === "current-user",
          ),
      ).toBe(true),
    );

    const messageEventStart = messages.length;
    const protectedMessage = {
      id: randomUUID(),
      classification: {
        role: "system" as const,
        mode: "default" as const,
        attachmentIds: [],
      },
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
      reasoningEffort: null,
      idempotencyKey: "live-api-message",
    };
    const messageResponse = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      payload: protectedMessage,
    });
    expect(messageResponse.statusCode).toBe(201);
    const persistedMessage = chatMessageOpaqueSummarySchema.parse(
      messageResponse.json(),
    );
    await vi.waitFor(() =>
      expect(
        messages
          .slice(messageEventStart)
          .find(
            (message) =>
              message.type === "event" &&
              message.resource === "chat-message" &&
              message.entityId === persistedMessage.id,
          ),
      ).toMatchObject({
        type: "event",
        scope: { kind: "chat", chatId },
        payload: persistedMessage,
        revision: persistedMessage.sequence,
      }),
    );

    const workflowEventStart = messages.length;
    const workflowRevisionId = randomUUID();
    const workflowResponse = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: encryptedWorkflowDefinitionCreateSchema.parse({
        id: randomUUID(),
        scope: "project",
        projectId,
        source: "manual",
        trustState: "trusted",
        slugBlindIndex: randomBytes(32).toString("base64url"),
        content: {
          protectedSlug: opaqueWorkflowContent(),
          protectedName: opaqueWorkflowContent(),
          protectedDescription: opaqueWorkflowContent(),
          protectedProvenance: opaqueWorkflowContent(),
        },
        revision: {
          id: workflowRevisionId,
          source: "manual",
          trustState: "trusted",
          contentBlindIndex: randomBytes(32).toString("base64url"),
          content: {
            protectedProvenance: opaqueWorkflowContent(),
            protectedContentHash: opaqueWorkflowContent(),
            protectedDefinition: opaqueWorkflowContent(),
          },
          manifest: {
            version: 1,
            nodes: [
              {
                id: randomUUID(),
                type: "agent",
                mutationMode: "read-only",
                modelRouteId: null,
                permissionProfileId: null,
              },
            ],
            edges: [],
          },
        },
      }),
    });
    expect(workflowResponse.statusCode).toBe(201);
    const workflow = workflowDefinitionWireDetailSchema.parse(
      workflowResponse.json(),
    );
    await vi.waitFor(() =>
      expect(
        messages
          .slice(workflowEventStart)
          .some(
            (message) =>
              message.type === "event" &&
              message.resource === "workflow-definition" &&
              message.entityId === workflow.workflow.id &&
              message.scope.kind === "current-user",
          ),
      ).toBe(true),
    );

    const triggerEventStart = messages.length;
    const triggerResponse = await app.inject({
      method: "POST",
      url: "/api/workflow-triggers",
      payload: encryptedWorkflowAutomationTriggerCreateSchema.parse({
        id: randomUUID(),
        workflowRevisionId,
        projectId,
        type: "api",
        enabled: true,
        permissionManifest: preauthorized,
        selectedModelRouteId: null,
        selectedPermissionProfileId: null,
        protectedName: opaqueWorkflowContent(),
        protectedConfiguration: opaqueWorkflowContent(),
        protectedInput: opaqueWorkflowContent(),
        publicConfiguration: { type: "api", minimumIntervalSeconds: 60 },
        credentialHash: null,
      }),
    });
    expect(triggerResponse.statusCode).toBe(201);
    const trigger = workflowAutomationTriggerWireSchema.parse(
      triggerResponse.json(),
    );
    await vi.waitFor(() =>
      expect(
        messages
          .slice(triggerEventStart)
          .some(
            (message) =>
              message.type === "event" &&
              message.resource === "workflow-trigger" &&
              message.entityId === trigger.id &&
              message.scope.kind === "project" &&
              message.scope.projectId === projectId,
          ),
      ).toBe(true),
    );

    const deliveryEventStart = messages.length;
    const deliveryResponse = await app.inject({
      method: "POST",
      url: `/api/workflow-triggers/${trigger.id}/deliver`,
      payload: {
        idempotencyKey: "live-trigger-delivery",
        protectedPayload: opaqueWorkflowContent(),
      },
    });
    expect(deliveryResponse.statusCode).toBe(201);
    expect(
      workflowTriggerDeliveryWireResultSchema.parse(deliveryResponse.json())
        .delivery.status,
    ).toBe("accepted");
    await vi.waitFor(() =>
      expect(
        messages
          .slice(deliveryEventStart)
          .some(
            (message) =>
              message.type === "event" &&
              message.resource === "workflow-trigger" &&
              message.entityId === trigger.id,
          ),
      ).toBe(true),
    );

    const customizationEventStart = messages.length;
    const oauthStart = codexMcpOauthStartResultSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${chatId}/customizations/mcp-oauth`,
          payload: { server: "docs" },
        })
      ).json(),
    );
    expect(oauthStart.status).toBe("pending");
    await vi.waitFor(
      () =>
        expect(
          messages
            .slice(customizationEventStart)
            .find(
              (message) =>
                message.type === "event" &&
                message.resource === "customization" &&
                message.entityId === "mcp-oauth" &&
                message.payload?.status === "succeeded",
            ),
        ).toMatchObject({
          type: "event",
          scope: { kind: "chat", chatId },
          payload: { server: "docs", status: "succeeded", error: null },
        }),
      { timeout: 2_500 },
    );
    expect(oauthStatusReads).toBe(1);

    const health = (
      await app.inject({ method: "GET", url: "/api/health" })
    ).json();
    expect(health.live).toMatchObject({
      acceptedConnectionCount: 1,
      connectionCount: 1,
      protocolViolationCount: 0,
      queuePressureCount: 0,
      slowConsumerClosureCount: 0,
    });
    expect(health.live.publicationCount).toBeGreaterThan(0);
    expect(health.live.deliveredEventCount).toBeGreaterThan(0);

    workerSocket.terminate();
    socket.terminate();
  });
});
