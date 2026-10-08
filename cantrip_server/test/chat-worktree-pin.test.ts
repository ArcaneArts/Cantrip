import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { installChatWorktreeAndExecutionLaneRoutes } from "../src/app/routes/chat-worktree-and-execution-lanes.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import {
  protectedChatFields,
  protectedProjectFields,
  protectedTerminalFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-worktree-pin-"),
);
const primaryPath = path.join(dataDirectory, "repository");
const secondaryPath = path.join(dataDirectory, "secondary");
const app = Fastify();
let database: DatabaseConnection;
let projectId: string;
let primaryId: string;
let secondaryId: string;
let consoleGuardId: string;

beforeAll(async () => {
  const config = {
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    appOrigins: [],
    authMode: "none",
    bootstrapMode: "pnpm-dev",
    dataDirectory,
    deploymentMode: "local",
    host: "127.0.0.1",
    port: 4310,
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    workerToken: "fixture",
  } as ServerConfig;
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "pin-worker",
    name: "Pin Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.160.1",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    ...protectedProjectFields(),
    workerId: "pin-worker",
    repositoryBlindIndex: "A".repeat(43),
    repositoryId: "pin-repository",
    nameWithOwner: "fixture/pin",
    url: "https://github.com/fixture/pin",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "pin-worker",
    {
      path: primaryPath,
      displayPath: "fixture/pin",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  const worktree = {
    path: primaryPath,
    head: "1".repeat(40),
    branch: "main",
    detached: false,
    isPrimary: true,
    managed: true,
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    missing: false,
  };
  const worktrees = await database.repository.reconcileProjectWorktrees(
    LOCAL_USER_ID,
    projectId,
    "pin-worker",
    {
      sourcePath: primaryPath,
      primaryPath,
      gitCommonDir: path.join(primaryPath, ".git"),
      managedRoot: path.join(dataDirectory, "worktrees"),
      repositoryFingerprint: "a".repeat(64),
      worktrees: [
        worktree,
        { ...worktree, path: secondaryPath, branch: "side", isPrimary: false },
        {
          ...worktree,
          path: path.join(dataDirectory, "console-guard"),
          branch: "console-guard",
          isPrimary: false,
        },
      ],
    },
  );
  primaryId = worktrees!.find((item) => item.isPrimary)!.id;
  secondaryId = worktrees!.find((item) => item.branch === "side")!.id;
  consoleGuardId = worktrees!.find(
    (item) => item.branch === "console-guard",
  )!.id;
  installChatWorktreeAndExecutionLaneRoutes(app, {
    appendLiveChatMessage: async () => undefined,
    applicationOwnerId: () => LOCAL_USER_ID,
    bridge: { isConnected: () => true, request: vi.fn() },
    repository: database.repository,
    requireProjectWorktrees: async () => undefined,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

async function createChat() {
  const chat = await database.repository.createChat(LOCAL_USER_ID, projectId, {
    ...protectedChatFields(),
    worktreeId: primaryId,
    worktreeMode: "agent-managed",
  });
  return chat!;
}
function update(
  chatId: string,
  worktreeId: string,
  mode: "pinned" | "agent-managed",
) {
  return app.inject({
    method: "PATCH",
    url: `/api/chats/${chatId}/worktree`,
    payload: { worktreeId, mode },
  });
}

describe("worktree pinning against the migrated database schema", () => {
  it("reuses an existing runtime and lane while repeatedly pinning and unpinning Primary with a linked console", async () => {
    const chat = await createChat();
    const consoleTab = await database.repository.getOrCreateChatConsole(
      LOCAL_USER_ID,
      chat.id,
      protectedTerminalFields(),
    );
    await database.repository.setTerminalStatus(consoleTab!.id, "running");
    const initial = await database.repository.listChatExecutionLanes(
      LOCAL_USER_ID,
      chat.id,
    );
    expect(initial).toHaveLength(1);
    expect(initial[0]!.runtimeSessionId).toBeTruthy();
    for (const mode of [
      "pinned",
      "pinned",
      "agent-managed",
      "agent-managed",
      "pinned",
    ] as const) {
      const result = await update(chat.id, primaryId, mode);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({
        activeWorktreeId: primaryId,
        activeWorkerId: "pin-worker",
        worktreeMode: mode,
      });
      const lanes = await database.repository.listChatExecutionLanes(
        LOCAL_USER_ID,
        chat.id,
      );
      expect(lanes).toHaveLength(1);
      expect(lanes[0]).toMatchObject({
        id: initial[0]!.id,
        runtimeSessionId: initial[0]!.runtimeSessionId,
      });
      expect(
        (
          await database.repository.getChatExecutionContext(
            LOCAL_USER_ID,
            chat.id,
          )
        )?.worktreeMode,
      ).toBe(mode);
    }
  });

  it("creates a runtime on a different lane once and reuses it on repeated mode changes", async () => {
    const chat = await createChat();
    const switched = await update(chat.id, secondaryId, "pinned");
    expect(switched.statusCode, switched.body).toBe(200);
    const initial = await database.repository.listChatExecutionLanes(
      LOCAL_USER_ID,
      chat.id,
    );
    const lane = initial.find((item) => item.worktreeId === secondaryId)!;
    expect(lane.runtimeSessionId).toBeTruthy();
    for (const mode of ["agent-managed", "pinned"] as const)
      expect((await update(chat.id, secondaryId, mode)).statusCode).toBe(200);
    const current = await database.repository.listChatExecutionLanes(
      LOCAL_USER_ID,
      chat.id,
    );
    expect(current).toHaveLength(initial.length);
    expect(
      current.find((item) => item.worktreeId === secondaryId)?.runtimeSessionId,
    ).toBe(lane.runtimeSessionId);
  });

  it("retains the explicit linked-console guard when changing lanes", async () => {
    const chat = await createChat();
    const consoleTab = await database.repository.getOrCreateChatConsole(
      LOCAL_USER_ID,
      chat.id,
      protectedTerminalFields(),
    );
    await database.repository.setTerminalStatus(consoleTab!.id, "running");
    const result = await update(chat.id, consoleGuardId, "pinned");
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toBe(
      "Stop the linked Codex console before switching worktrees.",
    );
    expect(
      (
        await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        )
      )?.worktreeId,
    ).toBe(primaryId);
  });

  it("retains the active-turn guard and owner checks", async () => {
    const chat = await createChat();
    await database.repository.setChatStatus(chat.id, "running");
    const result = await update(chat.id, secondaryId, "pinned");
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toBe(
      "Wait for the active chat turn before switching worktrees.",
    );
    await expect(
      database.repository.updateChatWorktree("another-owner", chat.id, {
        worktreeId: primaryId,
        mode: "pinned",
      }),
    ).resolves.toBeNull();
  });

  it("returns a bounded retryable error without exposing SQL or query parameters", async () => {
    const chat = await createChat();
    const spy = vi
      .spyOn(database.repository, "updateChatWorktree")
      .mockRejectedValueOnce(
        new Error(
          'Failed query: insert into "chat_runtime_sessions" params: PRIVATE_QUERY_DATA',
        ),
      );
    try {
      const result = await update(chat.id, primaryId, "pinned");
      expect(result.statusCode).toBe(500);
      expect(result.json()).toEqual({
        error:
          "Could not update the agent worktree. Try again or reload the agent.",
      });
      expect(result.body).not.toContain("PRIVATE_QUERY_DATA");
    } finally {
      spy.mockRestore();
    }
  });
});
