import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  agentWorktreeToolResultSchema,
  chatSummarySchema,
  chatMessageListSchema,
  codeSessionListSchema,
  codeSessionSummarySchema,
  codeTabSummarySchema,
  explorerSummarySchema,
  gitActionResultSchema,
  gitFileDiffSchema,
  gitHistorySchema,
  projectViewSummarySchema,
  projectWorktreeListSchema,
  projectWorktreeSummarySchema,
  queuedPromptSchema,
  terminalSummarySchema,
  unprobedCodexRuntimeReport,
  worktreeStatusResultSchema,
  type WorkerWorktreeSummary,
  type WorkerCommand,
  type AgentWorktreeToolName,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-worktree-api-"),
);
const primaryPath = path.join(dataDirectory, "repositories", "Cantrip");
const externalPath = path.join(dataDirectory, "external", "review");
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
let activeCreates = 0;
let maximumConcurrentCreates = 0;
const gitActionPaths: string[] = [];
const gitDiffCommands: Array<Extract<WorkerCommand, { type: "git.diff" }>> = [];
const gitHistoryCommands: Array<
  Extract<WorkerCommand, { type: "git.history" }>
> = [];
const chatTurnCommands: Array<Extract<WorkerCommand, { type: "chat.turn" }>> =
  [];
let agentToolInvocation: {
  arguments: Record<string, unknown>;
  tool: AgentWorktreeToolName;
} | null = null;
let workerWorktrees: WorkerWorktreeSummary[] = [
  {
    path: primaryPath,
    head: "1111111111111111111111111111111111111111",
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
];

function inventory() {
  return {
    sourcePath: primaryPath,
    primaryPath,
    gitCommonDir: path.join(primaryPath, ".git"),
    managedRoot: path.join(dataDirectory, "worktrees", "fingerprint"),
    repositoryFingerprint: "a".repeat(64),
    worktrees: workerWorktrees.map((worktree) => ({ ...worktree })),
  };
}

function status(branch = "main") {
  return {
    branch,
    head: "1111111111111111111111111111111111111111",
    upstream: branch === "main" ? "origin/main" : null,
    ahead: 0,
    behind: 0,
    files: [],
    branches: [
      {
        name: branch,
        kind: "local" as const,
        current: true,
        hash: "1111111111111111111111111111111111111111",
        upstream: branch === "main" ? "origin/main" : null,
      },
    ],
  };
}

const workerBridge = {
  attach() {},
  close() {},
  isConnected() {
    return connected;
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
    if (!connected) throw new Error("Worker is offline.");
    switch (command.type) {
      case "worktree.list":
      case "worktree.reconcile":
        return inventory();
      case "worktree.create": {
        activeCreates += 1;
        maximumConcurrentCreates = Math.max(
          maximumConcurrentCreates,
          activeCreates,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        const branch =
          command.mode.type === "detached" ? null : command.mode.branch;
        const worktree: WorkerWorktreeSummary = {
          path: path.join(
            dataDirectory,
            "worktrees",
            `${command.name}-${command.worktreeId}`,
          ),
          head: "2222222222222222222222222222222222222222",
          branch,
          detached: command.mode.type === "detached",
          isPrimary: false,
          managed: true,
          locked: false,
          lockReason: null,
          prunable: false,
          pruneReason: null,
          missing: false,
        };
        workerWorktrees.push(worktree);
        activeCreates -= 1;
        return { worktree, inventory: inventory() };
      }
      case "worktree.lock":
      case "worktree.unlock": {
        const worktree = workerWorktrees.find(
          (item) => item.path === command.worktreePath,
        );
        if (!worktree) throw new Error("Worktree not found.");
        worktree.locked = command.type === "worktree.lock";
        worktree.lockReason =
          command.type === "worktree.lock" ? command.reason : null;
        return { worktree: { ...worktree }, inventory: inventory() };
      }
      case "worktree.remove": {
        const index = workerWorktrees.findIndex(
          (item) => item.path === command.worktreePath,
        );
        if (index < 0) throw new Error("Worktree not found.");
        workerWorktrees.splice(index, 1);
        return { removedPath: command.worktreePath, inventory: inventory() };
      }
      case "worktree.prune":
        return { prunedPaths: [], inventory: inventory() };
      case "worktree.status": {
        const worktree = workerWorktrees.find(
          (item) => item.path === command.worktreePath,
        );
        if (!worktree) throw new Error("Worktree not found.");
        return { worktree, status: status(worktree.branch ?? "HEAD") };
      }
      case "git.history":
        gitHistoryCommands.push(command);
        return {
          branch: "main",
          head: "1111111111111111111111111111111111111111",
          totalCount: 1,
          commits: [
            {
              hash: "1111111111111111111111111111111111111111",
              shortHash: "1111111",
              parents: [],
              subject: "Initial commit",
              authorName: "Cantrip",
              authorEmail: "test@cantrip.art",
              authoredAt: "2026-08-08T12:00:00.000Z",
              refs: [{ name: "HEAD", kind: "head", current: true }],
              isHead: true,
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      case "git.action":
        gitActionPaths.push(command.cwd);
        return { status: status(), output: "done" };
      case "git.diff":
        gitDiffCommands.push(command);
        return {
          path: command.path,
          scope: command.scope,
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          truncated: false,
        };
      case "code.prepareAgentTurn":
        return { prepared: true, sessions: [] };
      case "code.agentTurnState":
        return { notifiedSessions: 0, refreshed: [], conflicts: [] };
      case "chat.plan.set":
        return {
          mode: command.mode,
          threadId: command.threadId ?? `thread-${command.cwd}`,
        };
      case "chat.thread.ensure":
        return {
          threadId: command.threadId ?? `thread-${command.cwd}`,
        };
      case "chat.turn":
        chatTurnCommands.push(command);
        if (agentToolInvocation) {
          const invocation = agentToolInvocation;
          agentToolInvocation = null;
          const callId = `call-${chatTurnCommands.length}`;
          const toolResponse = await app.inject({
            method: "POST",
            url: "/api/internal/agent-tools/worktree",
            headers: { authorization: `Bearer ${config.workerToken}` },
            payload: {
              arguments: invocation.arguments,
              callId,
              chatId: command.chatId,
              executionLaneId: command.executionLaneId,
              tool: invocation.tool,
              workerId: "test-worker",
            },
          });
          if (toolResponse.statusCode !== 200) {
            throw new Error(String(toolResponse.json().error));
          }
          const toolResult = agentWorktreeToolResultSchema.parse(
            toolResponse.json(),
          );
          await options?.onEvent?.({
            type: "agent.activity",
            activity: {
              type: "worktree",
              id: `worktree-tool:${callId}`,
              operation: invocation.tool,
              status: "completed",
              summary: toolResult.summary,
              worktreeId: toolResult.worktreeId,
            },
          });
        }
        await options?.onEvent?.({
          type: "agent.activity",
          activity: {
            type: "command",
            id: `command-${chatTurnCommands.length}`,
            command: "pwd",
            cwd: command.cwd,
            status: "completed",
            exitCode: 0,
            output: command.cwd,
          },
        });
        return {
          threadId: `thread-${command.worktreeId}`,
          text: "Completed in the selected worktree.",
          status: "completed",
        };
      default:
        throw new Error(`Unexpected command: ${command.type}`);
    }
  },
} satisfies WorkerCommandBus;

let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
let primaryId: string;
let managedIds: string[] = [];
let routedChatId: string;
let routedTerminalId: string;
let linkedConsoleId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  const recordedWorker = await database.repository.recordWorker({
    workerId: "test-worker",
    name: "Test Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    code: {
      available: true,
      version: "1.109.5",
      upstreamRevision: "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
      patchset: 1,
      transport: "web-proxy",
      maxSessions: 4,
      reason: null,
    },
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  expect(recordedWorker.code.available).toBe(true);
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "test-worker",
    repositoryId: "repo-1",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "test-worker",
    {
      path: primaryPath,
      displayPath: "ArcaneArts/Cantrip",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  primaryId = (
    await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
  )[0]!.id;
  app = await buildApp({
    config,
    database,
    logger: false,
    workerBridge,
  });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("server worktree control plane", () => {
  it("renders durable Primary metadata and reconciles external worktrees", async () => {
    const initial = projectWorktreeListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/worktrees`,
        })
      ).json(),
    );
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      id: primaryId,
      isPrimary: true,
      origin: "cantrip",
    });
    const policyResponse = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/worktree-policy`,
      payload: { policy: "required-for-writes" },
    });
    expect(policyResponse.json()).toMatchObject({
      id: projectId,
      worktreePolicy: "required-for-writes",
    });

    workerWorktrees.push({
      path: externalPath,
      head: "3333333333333333333333333333333333333333",
      branch: "review",
      detached: false,
      isPrimary: false,
      managed: false,
      locked: false,
      lockReason: null,
      prunable: false,
      pruneReason: null,
      missing: false,
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/reconcile`,
    });
    expect(response.statusCode).toBe(200);
    const reconciled = projectWorktreeListSchema.parse(response.json());
    expect(reconciled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: primaryId, branch: "main" }),
        expect.objectContaining({
          path: externalPath,
          branch: "review",
          origin: "external",
        }),
      ]),
    );
  });

  it("serializes concurrent creates and keeps each server identity", async () => {
    const responses = await Promise.all(
      ["agent-one", "agent-two"].map((branch) =>
        app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/worktrees`,
          payload: {
            name: branch,
            mode: { type: "newBranch", branch, startPoint: "main" },
          },
        }),
      ),
    );
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([201, 201]);
    const created = responses.map((response) =>
      projectWorktreeSummarySchema.parse(response.json()),
    );
    managedIds = created.map(({ id }) => id);
    expect(new Set(managedIds).size).toBe(2);
    expect(created.every(({ origin }) => origin === "user")).toBe(true);
    expect(maximumConcurrentCreates).toBe(1);
  });

  it("shares Primary while binding each Codex turn and message to one lane", async () => {
    const createPrimaryChat = (title: string) =>
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/chats`,
        payload: { title, worktreeMode: "agent-managed" },
      });
    const [firstResponse, secondResponse] = await Promise.all([
      createPrimaryChat("Primary chat one"),
      createPrimaryChat("Primary chat two"),
    ]);
    expect([firstResponse.statusCode, secondResponse.statusCode]).toEqual([
      201, 201,
    ]);
    const first = chatSummarySchema.parse(firstResponse.json());
    const second = chatSummarySchema.parse(secondResponse.json());
    const [firstLanes, secondLanes] = await Promise.all([
      database.repository.listChatExecutionLanes(LOCAL_USER_ID, first.id),
      database.repository.listChatExecutionLanes(LOCAL_USER_ID, second.id),
    ]);
    expect(firstLanes[0]).toMatchObject({
      worktreeId: primaryId,
      exclusive: false,
      state: "suspended",
    });
    expect(secondLanes[0]).toMatchObject({
      worktreeId: primaryId,
      exclusive: false,
      state: "suspended",
    });

    const started = await app.inject({
      method: "POST",
      url: `/api/chats/${first.id}/turns`,
      payload: { text: "Run pwd", idempotencyKey: "primary-turn-1" },
    });
    expect(started.statusCode, started.body).toBe(202);
    await expect
      .poll(async () => {
        const context = await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          first.id,
        );
        return context?.status;
      })
      .toBe("idle");

    const command = chatTurnCommands.at(-1)!;
    expect(command).toMatchObject({
      chatId: first.id,
      cwd: primaryPath,
      isPrimary: true,
      worktreeId: primaryId,
      worktreeMode: "agent-managed",
      worktreePolicy: "required-for-writes",
    });
    expect(command.executionLaneId).toBeTruthy();
    const messages = chatMessageListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/chats/${first.id}/messages`,
        })
      ).json(),
    );
    expect(messages).toHaveLength(3);
    expect(
      messages.every(
        ({ executionLaneId, worktreeId }) =>
          executionLaneId === command.executionLaneId &&
          worktreeId === primaryId,
      ),
    ).toBe(true);
    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      first.id,
    );
    expect(context).toMatchObject({
      threadId: `thread-${primaryId}`,
      worktreeId: primaryId,
    });
    expect(context?.executionLaneId).toBeNull();
  });

  it("resolves queued prompts at dispatch time unless explicitly pinned", async () => {
    const chat = chatSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chats`,
          payload: { title: "Queued routing", worktreeMode: "agent-managed" },
        })
      ).json(),
    );
    const dispatchFrozenPrompt = async (worktreeId: string | null) => {
      const before = chatTurnCommands.length;
      const prompt = queuedPromptSchema.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/queue`,
            payload: {
              text: "Queued pwd",
              idempotencyKey: `queued-${before}`,
              frozen: true,
              worktreeId,
            },
          })
        ).json(),
      );
      await app.inject({
        method: "PATCH",
        url: `/api/queued-prompts/${prompt.id}`,
        payload: { frozen: false },
      });
      await expect.poll(() => chatTurnCommands.length).toBe(before + 1);
      await expect
        .poll(
          async () =>
            (
              await database.repository.getChatExecutionContext(
                LOCAL_USER_ID,
                chat.id,
              )
            )?.status,
        )
        .toBe("idle");
      return chatTurnCommands.at(-1)!;
    };

    await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/worktree`,
      payload: { worktreeId: managedIds[0], mode: "agent-managed" },
    });
    const dynamic = await dispatchFrozenPrompt(null);
    expect(dynamic.worktreeId).toBe(managedIds[0]);

    const releaseCurrent = async () => {
      const lane = (
        await database.repository.listChatExecutionLanes(LOCAL_USER_ID, chat.id)
      ).find(
        ({ state, worktreeId }) =>
          state !== "released" && worktreeId !== primaryId,
      )!;
      const response = await app.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/execution-lanes/${lane.id}/release`,
        payload: {},
      });
      expect(response.statusCode).toBe(200);
    };
    await releaseCurrent();

    const pinned = await dispatchFrozenPrompt(managedIds[1]!);
    expect(pinned.worktreeId).toBe(managedIds[1]);
    await releaseCurrent();

    await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/worktree`,
      payload: { worktreeId: managedIds[0], mode: "agent-managed" },
    });
    expect(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chat.id),
    ).toMatchObject({
      threadId: `thread-${managedIds[0]}`,
      worktreeId: managedIds[0],
    });
    await releaseCurrent();
  });

  it("continues an agent turn in a separately routed worktree runtime", async () => {
    const targetId = managedIds[0]!;
    const target = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
    ).find(({ id }) => id === targetId)!;
    const chat = chatSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chats`,
          payload: {
            title: "Agent transition",
            worktreeMode: "agent-managed",
          },
        })
      ).json(),
    );
    const before = chatTurnCommands.length;
    agentToolInvocation = {
      tool: "cantrip_worktree_switch",
      arguments: {
        worktreeId: targetId,
        purpose: "Implement the requested change away from Primary",
      },
    };

    const started = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/turns`,
      payload: {
        text: "Implement this safely",
        idempotencyKey: "agent-transition-turn",
      },
    });
    expect(started.statusCode).toBe(202);
    await expect.poll(() => chatTurnCommands.length).toBe(before + 2);
    await expect
      .poll(
        async () =>
          (
            await database.repository.getChatExecutionContext(
              LOCAL_USER_ID,
              chat.id,
            )
          )?.status,
      )
      .toBe("idle");

    const [originCommand, continuationCommand] = chatTurnCommands.slice(before);
    expect(originCommand).toMatchObject({
      chatId: chat.id,
      cwd: primaryPath,
      isPrimary: true,
      worktreeId: primaryId,
      worktreePolicy: "required-for-writes",
    });
    expect(continuationCommand).toMatchObject({
      chatId: chat.id,
      cwd: target.path,
      isPrimary: false,
      worktreeId: targetId,
      worktreePolicy: "required-for-writes",
    });
    expect(continuationCommand!.executionLaneId).not.toBe(
      originCommand!.executionLaneId,
    );
    expect(continuationCommand!.prompt).toContain(
      `Continued in ${target.name}`,
    );

    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chat.id,
    );
    expect(context).toMatchObject({
      worktreeId: targetId,
      threadId: `thread-${targetId}`,
    });
    const lanes = await database.repository.listChatExecutionLanes(
      LOCAL_USER_ID,
      chat.id,
    );
    expect(lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: originCommand!.executionLaneId,
          worktreeId: primaryId,
          state: "suspended",
        }),
        expect.objectContaining({
          id: continuationCommand!.executionLaneId,
          worktreeId: targetId,
          state: "suspended",
          transitionKind: null,
        }),
      ]),
    );
    const messages = chatMessageListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/messages`,
        })
      ).json(),
    );
    const worktreeActivities = messages.filter(({ content }) =>
      content.some(
        (part) => part.type === "activity" && part.activity.type === "worktree",
      ),
    );
    expect(worktreeActivities).toHaveLength(1);
    expect(worktreeActivities[0]).toMatchObject({
      executionLaneId: originCommand!.executionLaneId,
      worktreeId: primaryId,
    });

    const activeLane = lanes.find(
      ({ id }) => id === continuationCommand!.executionLaneId,
    )!;
    const released = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/execution-lanes/${activeLane.id}/release`,
      payload: {},
    });
    expect(released.statusCode).toBe(200);
  });

  it("rejects agent transitions from pinned, stale, or spoofed lanes", async () => {
    const chat = chatSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chats`,
          payload: {
            title: "Pinned agent safety",
            worktreeId: primaryId,
            worktreeMode: "pinned",
          },
        })
      ).json(),
    );
    const execution = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      chat.id,
      "agent",
      "Pinned safety check",
    );
    expect(execution).not.toBeNull();
    const payload = {
      arguments: {
        worktreeId: managedIds[0],
        purpose: "Attempt a forbidden transition",
      },
      callId: "pinned-call",
      chatId: chat.id,
      executionLaneId: execution!.executionLaneId,
      tool: "cantrip_worktree_switch",
      workerId: execution!.workerId,
    };
    const pinned = await app.inject({
      method: "POST",
      url: "/api/internal/agent-tools/worktree",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload,
    });
    expect(pinned.statusCode).toBe(409);
    expect(pinned.json().error).toContain("pinned");

    const spoofed = await app.inject({
      method: "POST",
      url: "/api/internal/agent-tools/worktree",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: { ...payload, callId: "spoofed-call", workerId: "other-worker" },
    });
    expect(spoofed.statusCode).toBe(409);
    expect(spoofed.json().error).toContain("active chat lane");
    await database.repository.finishChatExecutionLane(
      chat.id,
      execution!.executionLaneId,
      "idle",
    );

    const stale = await app.inject({
      method: "POST",
      url: "/api/internal/agent-tools/worktree",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: { ...payload, callId: "stale-call" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain("active chat lane");
  });

  it("recovers a durable pending transition when its worker reconnects", async () => {
    const targetId = managedIds[1]!;
    const target = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
    ).find(({ id }) => id === targetId)!;
    const chat = chatSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chats`,
          payload: {
            title: "Transition restart recovery",
            worktreeMode: "agent-managed",
          },
        })
      ).json(),
    );
    const execution = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      chat.id,
      "agent",
      "Interrupted origin turn",
    );
    expect(execution).not.toBeNull();
    const pending = await database.repository.scheduleChatWorktreeTransition(
      LOCAL_USER_ID,
      chat.id,
      execution!.executionLaneId,
      targetId,
      "switch",
      "Continue after server restart",
    );
    expect(pending?.lane.state).toBe("delivering");
    await database.repository.resetInterruptedChatExecutions();

    const before = chatTurnCommands.length;
    const heartbeat = await app.inject({
      method: "POST",
      url: "/api/internal/workers/heartbeat",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: {
        workerId: "test-worker",
        name: "Test Worker",
        platform: "darwin",
        architecture: "arm64",
        codexVersion: "0.146.1",
        codexRuntime: unprobedCodexRuntimeReport,
        code: {
          available: true,
          version: "1.109.5",
          upstreamRevision: "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
          patchset: 1,
          transport: "web-proxy",
          maxSessions: 4,
          reason: null,
        },
        remoteSurfaces: {
          browser: false,
          transports: ["websocket"],
          maxSessions: 1,
        },
        startedAt: new Date().toISOString(),
      },
    });
    expect(heartbeat.statusCode).toBe(202);
    await expect.poll(() => chatTurnCommands.length).toBe(before + 1);
    await expect
      .poll(
        async () =>
          (
            await database.repository.getChatExecutionContext(
              LOCAL_USER_ID,
              chat.id,
            )
          )?.status,
      )
      .toBe("idle");
    expect(chatTurnCommands.at(-1)).toMatchObject({
      chatId: chat.id,
      cwd: target.path,
      worktreeId: targetId,
    });

    const activeLane = (
      await database.repository.listChatExecutionLanes(LOCAL_USER_ID, chat.id)
    ).find(
      ({ state, worktreeId }) =>
        state !== "released" && worktreeId === targetId,
    )!;
    const released = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/execution-lanes/${activeLane.id}/release`,
      payload: {},
    });
    expect(released.statusCode).toBe(200);
  });

  it("recovers interrupted executions without losing durable lane metadata", async () => {
    const chat = chatSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chats`,
          payload: { title: "Restart recovery", worktreeMode: "agent-managed" },
        })
      ).json(),
    );
    const started = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      chat.id,
      "agent",
      "Recovery test",
    );
    expect(started?.executionLaneId).toBeTruthy();
    await database.repository.updateChatRuntime(
      chat.id,
      started!.workerId,
      started!.worktreeId,
      "thread-recovery",
      "00000000-0000-0000-0000-000000000021",
      "running",
    );

    await database.repository.resetInterruptedChatExecutions();

    const recovered = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chat.id,
    );
    expect(recovered).toMatchObject({
      status: "failed",
      threadId: "thread-recovery",
      worktreeId: primaryId,
    });
    expect(recovered?.executionLaneId).toBeNull();
    const lane = (
      await database.repository.listChatExecutionLanes(LOCAL_USER_ID, chat.id)
    )[0]!;
    expect(lane).toMatchObject({
      id: started!.executionLaneId,
      state: "suspended",
      codexThreadId: "thread-recovery",
      purpose: "Recovery test",
    });
  });

  it("routes tabs, forks, and chat transitions through explicit worktrees", async () => {
    const [firstId, secondId] = managedIds as [string, string];
    const chatResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chats`,
      payload: {
        title: "Pinned work",
        worktreeId: firstId,
        worktreeMode: "pinned",
      },
    });
    const chat = chatSummarySchema.parse(chatResponse.json());
    routedChatId = chat.id;
    expect(chat).toMatchObject({
      activeWorktreeId: firstId,
      worktreeMode: "pinned",
    });

    const terminal = terminalSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/terminals`,
          payload: { title: "Worktree shell", worktreeId: firstId },
        })
      ).json(),
    );
    routedTerminalId = terminal.id;
    expect(terminal.worktreeId).toBe(firstId);
    const explorer = explorerSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/explorers`,
          payload: { title: "Worktree files", worktreeId: secondId },
        })
      ).json(),
    );
    expect(explorer.worktreeId).toBe(secondId);
    expect(
      (await database.repository.listWorkers(LOCAL_USER_ID))[0]?.code.available,
    ).toBe(true);
    const codeTabResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/code-tabs`,
      payload: {
        title: "Worktree Code",
        worktreeId: secondId,
        profileId: "main-profile",
      },
    });
    expect(codeTabResponse.statusCode, codeTabResponse.body).toBe(201);
    const codeTab = codeTabSummarySchema.parse(codeTabResponse.json());
    expect(codeTab).toMatchObject({
      worktreeId: secondId,
      activeWorkerId: "test-worker",
      profileId: "main-profile",
      themeMode: "follow-cantrip",
      status: "idle",
    });
    const renamedCodeTab = codeTabSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/code-tabs/${codeTab.id}`,
          payload: { title: "Review Code", themeMode: "independent" },
        })
      ).json(),
    );
    expect(renamedCodeTab).toMatchObject({
      title: "Review Code",
      themeMode: "follow-cantrip",
    });
    const session = await database.repository.getOrCreateCodeSession(
      LOCAL_USER_ID,
      codeTab.id,
      {
        version: "1.109.5",
        upstreamRevision: "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
        patchset: 1,
        fingerprint: "a".repeat(64),
      },
    );
    expect(codeSessionSummarySchema.parse(session)).toMatchObject({
      codeTabId: codeTab.id,
      projectId,
      workerId: "test-worker",
      worktreeId: secondId,
      profileId: "main-profile",
      status: "starting",
    });
    expect(
      codeSessionListSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/code-tabs/${codeTab.id}/sessions`,
          })
        ).json(),
      ),
    ).toHaveLength(1);
    const retargetedCodeTab = codeTabSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/code-tabs/${codeTab.id}/worktree`,
          payload: { worktreeId: firstId },
        })
      ).json(),
    );
    expect(retargetedCodeTab.worktreeId).toBe(firstId);
    expect(
      await app.inject({
        method: "DELETE",
        url: `/api/code-tabs/${codeTab.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      await database.repository.listCodeSessions(LOCAL_USER_ID, codeTab.id),
    ).toBeNull();
    const history = projectViewSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/views`,
          payload: { title: "History", kind: "history", worktreeId: secondId },
        })
      ).json(),
    );
    expect(history.worktreeId).toBe(secondId);

    const fork = chatSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/fork`,
          payload: {
            worktreeId: secondId,
            worktreeMode: "agent-managed",
          },
        })
      ).json(),
    );
    expect(fork).toMatchObject({
      activeWorktreeId: secondId,
      worktreeMode: "agent-managed",
    });

    const switched = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/worktree`,
      payload: { worktreeId: secondId, mode: "pinned" },
    });
    expect(switched.statusCode).toBe(409);

    await database.repository.setChatStatus(chat.id, "running");
    const blockedSwitch = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/worktree`,
      payload: { worktreeId: primaryId, mode: "agent-managed" },
    });
    expect(blockedSwitch.statusCode).toBe(409);
    await database.repository.setChatStatus(chat.id, "idle");

    const consoleTab = terminalSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/console`,
        })
      ).json(),
    );
    linkedConsoleId = consoleTab.id;
    expect(consoleTab.worktreeId).toBe(firstId);
  });

  it("uses exact worktree paths for status, history, and Git actions", async () => {
    const target = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
    ).find(({ id }) => id === managedIds[0])!;
    const observedHead = "4".repeat(40);
    workerWorktrees.find(({ path }) => path === target.path)!.head =
      observedHead;
    const statusResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/status`,
    });
    expect(
      worktreeStatusResultSchema.parse(statusResponse.json()).worktree.path,
    ).toBe(target.path);
    expect(
      (
        await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
      ).find(({ id }) => id === target.id)?.head,
    ).toBe(observedHead);
    const historyResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/history`,
    });
    expect(gitHistorySchema.parse(historyResponse.json()).commits).toHaveLength(
      1,
    );
    expect(gitHistoryCommands.at(-1)).toMatchObject({
      cwd: target.path,
      revisions: expect.arrayContaining(
        workerWorktrees
          .map(({ head }) => head)
          .filter((head): head is string => typeof head === "string"),
      ),
    });
    const actionResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/actions`,
      payload: { type: "stageAll" },
    });
    gitActionResultSchema.parse(actionResponse.json());
    expect(gitActionPaths.at(-1)).toBe(target.path);
    const diffResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees/${target.id}/git/diff?path=src%2Fapp.ts&scope=unstaged`,
    });
    expect(gitFileDiffSchema.parse(diffResponse.json())).toMatchObject({
      path: "src/app.ts",
      scope: "unstaged",
    });
    expect(gitDiffCommands.at(-1)).toMatchObject({
      cwd: target.path,
      path: "src/app.ts",
      scope: "unstaged",
    });
  });

  it("locks, unlocks, and protects Primary and external removal", async () => {
    const managedId = managedIds[0]!;
    const locked = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${managedId}/lock`,
      payload: { reason: "Review in progress" },
    });
    expect(projectWorktreeSummarySchema.parse(locked.json())).toMatchObject({
      locked: true,
      lockReason: "Review in progress",
    });
    const unlocked = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/${managedId}/unlock`,
    });
    expect(projectWorktreeSummarySchema.parse(unlocked.json()).locked).toBe(
      false,
    );
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}/worktrees/${primaryId}`,
        })
      ).statusCode,
    ).toBe(409);
    const external = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
    ).find(({ origin }) => origin === "external")!;
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}/worktrees/${external.id}`,
        })
      ).statusCode,
    ).toBe(409);
  });

  it("blocks removal while a chat, lease, or terminal is active", async () => {
    const [firstId, secondId] = managedIds as [string, string];
    await database.repository.setChatStatus(routedChatId, "running");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}/worktrees/${secondId}`,
        })
      ).statusCode,
    ).toBe(409);
    await database.repository.setChatStatus(routedChatId, "idle");

    await database.repository.setTerminalStatus(linkedConsoleId, "exited");
    await database.repository.setTerminalStatus(routedTerminalId, "running");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}/worktrees/${firstId}`,
        })
      ).statusCode,
    ).toBe(409);
    await database.repository.setTerminalStatus(routedTerminalId, "exited");
    const lane = (
      await database.repository.listChatExecutionLanes(
        LOCAL_USER_ID,
        routedChatId,
      )
    ).find(
      ({ worktreeId, state }) => worktreeId === firstId && state !== "released",
    )!;
    const released = await app.inject({
      method: "POST",
      url: `/api/chats/${routedChatId}/execution-lanes/${lane.id}/release`,
      payload: {},
    });
    expect(released.statusCode).toBe(200);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/worktrees/${firstId}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(projectWorktreeSummarySchema.parse(removed.json())).toMatchObject({
      id: firstId,
      lifecycleState: "missing",
    });
  });

  it("retains reconciled metadata while the worker is offline", async () => {
    connected = false;
    const listed = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/worktrees`,
    });
    expect(listed.statusCode).toBe(200);
    expect(
      projectWorktreeListSchema.parse(listed.json()).length,
    ).toBeGreaterThan(1);
    const reconcile = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/worktrees/reconcile`,
    });
    expect(reconcile.statusCode).toBe(502);
    connected = true;
  });
});
