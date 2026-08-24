import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  NATIVE_SUBAGENT_PROTOCOL_VERSION,
  unprobedCodexRuntimeReport,
  type AgentActivity,
  type AgentInteractionRuntimeRequest,
  type NormalizedAgentMessage,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAppServer,
  agentPathSegments,
  childThreadMetadataFromNotification,
  type CodexProcessLauncher,
} from "../src/codex/app-server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const compatibility = {
  ...unprobedCodexRuntimeReport,
  compatibility: "compatible" as const,
  degradedReasons: [],
  initialize: {
    experimentalApi: true,
    platformFamily: "unix",
    platformOs: "macos",
    userAgent: "codex_cli_rs/0.149.0",
  },
  methods: {
    "thread/list": "available" as const,
    "thread/read": "available" as const,
  },
  nativeSubagents: {
    available: true,
    protocolVersion: NATIVE_SUBAGENT_PROTOCOL_VERSION,
    reason: null,
  },
  version: { raw: "codex-cli 0.149.0", semantic: "0.149.0" },
};

const provider = {
  id: "subagent-provider",
  name: "Subagent provider",
  kind: "openai-compatible" as const,
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
};

const model = {
  id: "subagent-model",
  routeId: "subagent-route",
  name: "subagent-model",
  reasoningEffort: "high" as const,
};

function launcher(): CodexProcessLauncher {
  return (binary, arguments_, options) =>
    spawn(process.execPath, [binary, ...arguments_], {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
}

async function fakeCodexBinary(directory: string): Promise<string> {
  const binary = path.join(directory, "fake-subagent-codex.cjs");
  const wsEntry = createRequire(import.meta.url).resolve("ws");
  await writeFile(
    binary,
    `const { WebSocketServer } = require(${JSON.stringify(wsEntry)});

const rootThreadId = "root-thread";
const rootTurnId = "root-turn";
const childThreadId = "child-thread";
const childTurnId = "child-turn";
const nestedThreadId = "nested-thread";
const nestedTurnId = "nested-turn";
const recoveredThreadId = "recovered-thread";
const recoveredTurnId = "recovered-turn";
const fixtureStartedAt = Math.floor(Date.now() / 1000);

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
  const address = server.address();
  process.stdout.write("listening on: ws://127.0.0.1:" + address.port + "\\n");
});

function reply(socket, id, result) {
  socket.send(JSON.stringify({ id, result }));
}

function notify(socket, method, params) {
  socket.send(JSON.stringify({ method, params }));
}

function completedTurn(socket, threadId, turnId) {
  notify(socket, "turn/completed", {
    threadId,
    turn: {
      id: turnId,
      status: "completed",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 10
    }
  });
}

server.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id === undefined) return;
    if (message.method === "initialize") {
      reply(socket, message.id, {});
      return;
    }
    if (message.method === "thread/start") {
      reply(socket, message.id, { thread: { id: rootThreadId } });
      return;
    }
    if (message.method === "thread/list") {
      reply(socket, message.id, {
        data: [
          {
            id: childThreadId,
            parentThreadId: rootThreadId,
            agentNickname: "Scout",
            agentRole: "explorer",
            status: { type: "idle" },
            source: { subAgent: { threadSpawn: { parentThreadId: rootThreadId, depth: 1, agentPath: "root/Scout" } } },
            turns: []
          },
          {
            id: nestedThreadId,
            parentThreadId: childThreadId,
            agentNickname: "Indexer",
            agentRole: "explorer",
            status: { type: "idle" },
            source: { subAgent: { threadSpawn: { parentThreadId: childThreadId, depth: 2, agentPath: "root/Scout/Indexer" } } },
            turns: []
          },
          {
            id: recoveredThreadId,
            parentThreadId: rootThreadId,
            agentNickname: "Recovery",
            agentRole: "reviewer",
            status: { type: "idle" },
            source: { subAgent: { threadSpawn: { parentThreadId: rootThreadId, depth: 1, agentPath: "root/Recovery" } } },
            turns: []
          }
        ],
        nextCursor: null
      });
      return;
    }
    if (message.method === "thread/read") {
      const threadId = message.params.threadId;
      const turnId = threadId === childThreadId ? childTurnId : threadId === nestedThreadId ? nestedTurnId : recoveredTurnId;
      const text = threadId === childThreadId ? "Child result" : threadId === nestedThreadId ? "Nested result" : "Recovered child result";
      const nickname = threadId === childThreadId ? "Scout" : threadId === nestedThreadId ? "Indexer" : "Recovery";
      const parentThreadId = threadId === nestedThreadId ? childThreadId : rootThreadId;
      const turnStatus = threadId === recoveredThreadId ? "failed" : "completed";
      reply(socket, message.id, {
        thread: {
          id: threadId,
          parentThreadId,
          agentNickname: nickname,
          agentRole: threadId === recoveredThreadId ? "reviewer" : "explorer",
          status: { type: "idle" },
          source: { subAgent: { threadSpawn: { parentThreadId, depth: threadId === nestedThreadId ? 2 : 1, agentPath: threadId === nestedThreadId ? "root/Scout/Indexer" : "root/" + nickname } } },
          turns: [{
            id: turnId,
            status: turnStatus,
            error: null,
            startedAt: fixtureStartedAt,
            completedAt: fixtureStartedAt + 1,
            durationMs: 10,
            items: [
              { type: "userMessage", id: "prompt-" + threadId, clientId: null, content: [{ type: "text", text: "Private task for " + nickname }] },
              { type: "agentMessage", id: threadId === childThreadId ? "child-message" : threadId === nestedThreadId ? "nested-message" : "message-" + threadId, text, phase: "final_answer" }
            ]
          }]
        }
      });
      return;
    }
    if (message.method !== "turn/start") {
      if (String(message.id) === "child-approval") return;
      socket.send(JSON.stringify({
        id: message.id,
        error: { code: -32601, message: "unsupported " + message.method }
      }));
      return;
    }

    reply(socket, message.id, { turn: { id: rootTurnId } });
    setTimeout(() => {
      notify(socket, "turn/started", {
        threadId: rootThreadId,
        turn: { id: rootTurnId, startedAt: 1 }
      });
      notify(socket, "item/started", {
        threadId: rootThreadId,
        turnId: rootTurnId,
        item: {
          type: "collabAgentToolCall",
          id: "spawn-child",
          tool: "spawn_agent",
          senderThreadId: rootThreadId,
          receiverThreadIds: [childThreadId],
          prompt: "Inspect the child path",
          model: "subagent-model",
          status: "inProgress",
          agentsStates: { [childThreadId]: { status: "running", message: null } }
        }
      });
      notify(socket, "thread/started", {
        thread: {
          id: childThreadId,
          parentThreadId: rootThreadId,
          agentNickname: "Scout",
          agentRole: "explorer",
          status: { type: "active", activeFlags: [] },
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: rootThreadId,
                depth: 1,
                agent_path: "root/Scout",
                agent_nickname: "Scout",
                agent_role: "explorer"
              }
            }
          }
        }
      });
      notify(socket, "turn/started", {
        threadId: childThreadId,
        turn: { id: childTurnId, startedAt: 1 }
      });
      notify(socket, "item/completed", {
        threadId: rootThreadId,
        turnId: rootTurnId,
        item: {
          type: "collabAgentToolCall",
          id: "followup-child",
          tool: "send_input",
          senderThreadId: rootThreadId,
          receiverThreadIds: [childThreadId],
          prompt: "Check the handoff path too",
          model: null,
          status: "completed",
          agentsStates: { [childThreadId]: { status: "running", message: null } }
        }
      });
      notify(socket, "item/completed", {
        threadId: rootThreadId,
        turnId: rootTurnId,
        item: {
          type: "collabAgentToolCall",
          id: "wait-child",
          tool: "wait",
          senderThreadId: rootThreadId,
          receiverThreadIds: [childThreadId],
          prompt: null,
          model: null,
          status: "completed",
          agentsStates: { [childThreadId]: { status: "completed", message: "Handoff response" } }
        }
      });
      notify(socket, "item/completed", {
        threadId: rootThreadId,
        turnId: rootTurnId,
        item: {
          type: "collabAgentToolCall",
          id: "interrupt-child",
          tool: "close_agent",
          senderThreadId: rootThreadId,
          receiverThreadIds: [childThreadId],
          prompt: null,
          model: null,
          status: "completed",
          agentsStates: { [childThreadId]: { status: "shutdown", message: null } }
        }
      });
      notify(socket, "thread/status/changed", {
        threadId: childThreadId,
        status: { type: "notLoaded" }
      });
      notify(socket, "item/completed", {
        threadId: childThreadId,
        turnId: childTurnId,
        item: {
          type: "agentMessage",
          id: "child-message",
          text: "Child result",
          phase: "final_answer"
        }
      });
      socket.send(JSON.stringify({
        id: "child-approval",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: childThreadId,
          turnId: childTurnId,
          itemId: "child-command",
          startedAtMs: Date.now(),
          command: "echo child",
          cwd: process.cwd()
        }
      }));

      notify(socket, "item/started", {
        threadId: childThreadId,
        turnId: childTurnId,
        item: {
          type: "collabAgentToolCall",
          id: "spawn-nested",
          tool: "spawn_agent",
          senderThreadId: childThreadId,
          receiverThreadIds: [nestedThreadId],
          prompt: "Inspect the nested path",
          model: "subagent-model",
          status: "inProgress",
          agentsStates: { [nestedThreadId]: { status: "running", message: null } }
        }
      });
      notify(socket, "thread/started", {
        thread: {
          id: nestedThreadId,
          parentThreadId: childThreadId,
          agentNickname: "Indexer",
          agentRole: "explorer",
          status: { type: "active", activeFlags: [] },
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: childThreadId,
                depth: 2,
                agent_path: "root/Scout/Indexer",
                agent_nickname: "Indexer",
                agent_role: "explorer"
              }
            }
          }
        }
      });
      notify(socket, "turn/started", {
        threadId: nestedThreadId,
        turn: { id: nestedTurnId, startedAt: 1 }
      });
      notify(socket, "item/completed", {
        threadId: nestedThreadId,
        turnId: nestedTurnId,
        item: {
          type: "agentMessage",
          id: "nested-message",
          text: "Nested result",
          phase: "final_answer"
        }
      });
      completedTurn(socket, nestedThreadId, nestedTurnId);
      completedTurn(socket, childThreadId, childTurnId);

      setTimeout(() => {
        notify(socket, "item/completed", {
          threadId: rootThreadId,
          turnId: rootTurnId,
          item: {
            type: "agentMessage",
            id: "root-message",
            text: "Root result",
            phase: "final_answer"
          }
        });
        completedTurn(socket, rootThreadId, rootTurnId);
      }, 25);
    }, 10);
  });
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
`,
    "utf8",
  );
  return binary;
}

describe("native subagent execution ownership", () => {
  it("parses native thread metadata without trusting missing parents", () => {
    expect(agentPathSegments("root/Scout.Indexer")).toEqual([
      "root",
      "Scout",
      "Indexer",
    ]);
    expect(
      childThreadMetadataFromNotification({
        thread: {
          id: "child",
          parentThreadId: "root",
          agentNickname: "Scout",
          source: { subAgent: { thread_spawn: { depth: 1 } } },
        },
      }),
    ).toMatchObject({
      threadId: "child",
      parentThreadId: "root",
      nickname: "Scout",
      depth: 1,
    });
    expect(
      childThreadMetadataFromNotification({ thread: { id: "orphan" } }),
    ).toBeNull();
  });

  it("isolates nested child completion and routes child interactions to the root channel", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-subagents-"));
    temporaryDirectories.push(root);
    const runtime = new CodexAppServer(
      await fakeCodexBinary(root),
      root,
      path.join(root, "codex-home"),
      compatibility,
      undefined,
      undefined,
      undefined,
      launcher(),
    );
    const activities: AgentActivity[] = [];
    const messages: NormalizedAgentMessage[] = [];
    const interactions: AgentInteractionRuntimeRequest[] = [];
    try {
      const result = await runtime.runTurn({
        attachments: [],
        automationPaused: false,
        captureProtectedDiagnostics: true,
        chatId: "subagent-chat",
        clientMessageId: "subagent-message",
        cwd: root,
        isPrimary: true,
        mcpServers: [],
        model,
        permissionProfileId: null,
        planMode: "default",
        policyContext: null,
        prompt: "Use subagents when useful.",
        provider,
        rootKind: "git-worktree",
        skillNames: [],
        subagentDefaults: null,
        subagentProtocolVersion: NATIVE_SUBAGENT_PROTOCOL_VERSION,
        threadId: null,
        worktreeMode: "agent-managed",
        worktreePolicy: "required-for-writes",
        onActivity: (activity) => activities.push(activity),
        onInteractionRequest: (request) => {
          interactions.push(request);
          void runtime.cancelAgentInteraction(request.requestKey, "fixture");
        },
        onMessage: (message) => messages.push(message),
      });

      expect(result).toMatchObject({
        status: "completed",
        text: "Root result",
        threadId: "root-thread",
        turnId: "root-turn",
      });
      expect(interactions).toHaveLength(1);
      expect(interactions[0]).toMatchObject({
        threadId: "child-thread",
        turnId: "child-turn",
      });
      expect(
        messages.map((message) => ({
          text: message.text,
          threadId: message.agentScope?.agentThreadId,
          depth: message.agentScope?.depth,
          path: message.agentScope?.agentPath,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            text: "Nested result",
            threadId: "nested-thread",
            depth: 2,
            path: ["root", "Scout", "Indexer"],
          },
          {
            text: "Child result",
            threadId: "child-thread",
            depth: 1,
            path: ["root", "Scout"],
          },
          {
            text: "Root result",
            threadId: "root-thread",
            depth: 0,
            path: ["root"],
          },
          {
            text: "Recovered child result",
            threadId: "recovered-thread",
            depth: 1,
            path: ["root", "Recovery"],
          },
        ]),
      );
      expect(
        messages
          .filter(({ text }) => text === "Child result")
          .map(({ id, phase }) => ({ id, phase })),
      ).toEqual([
        { id: "child-message", phase: "commentary" },
        { id: "child-message", phase: "final_answer" },
      ]);
      expect(
        messages.filter(({ text }) => text === "Nested result"),
      ).toHaveLength(1);
      expect(
        activities.some(
          (activity) =>
            activity.type === "agentCommunication" &&
            activity.kind === "returned" &&
            activity.agentScope?.agentThreadId === "nested-thread",
        ),
      ).toBe(true);
      expect(
        activities.some(
          (activity) =>
            activity.type === "agentCommunication" &&
            activity.kind === "failed" &&
            activity.agentScope?.agentThreadId === "recovered-thread",
        ),
      ).toBe(true);
      expect(
        activities
          .filter(
            (activity) =>
              activity.type === "agentCommunication" &&
              activity.agentScope?.agentThreadId === "child-thread",
          )
          .map((activity) =>
            activity.type === "agentCommunication" ? activity.kind : null,
          ),
      ).toEqual(
        expect.arrayContaining([
          "spawned",
          "followupSent",
          "returned",
          "statusChanged",
        ]),
      );
      expect(
        activities.some(
          (activity) =>
            activity.agentScope?.agentThreadId === "child-thread" &&
            activity.status === "failed",
        ),
      ).toBe(false);
      expect(
        activities.some(
          (activity) =>
            activity.type === "agentCommunication" &&
            activity.kind === "returned" &&
            activity.message === "Handoff response",
        ),
      ).toBe(true);
    } finally {
      runtime.close();
    }
  });
});
