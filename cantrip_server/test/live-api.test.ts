import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appLiveServerMessageSchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import type { AppLiveServerMessage } from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

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

let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
let chatId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(liveTestHeartbeat);
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "live-test-worker",
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
  const chat = await database.repository.createChat(LOCAL_USER_ID, projectId, {
    title: "Live test chat",
    worktreeMode: "agent-managed",
  });
  if (!chat) throw new Error("Could not create the live test chat.");
  chatId = chat.id;
  app = await buildApp({ config, database, logger: false });
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
        payload: { title: "Live event terminal" },
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

    socket.terminate();
  });
});
