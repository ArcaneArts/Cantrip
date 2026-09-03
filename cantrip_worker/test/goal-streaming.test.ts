import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  unprobedCodexRuntimeReport,
  type CodexRuntimeReport,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAppServer,
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
    userAgent: "codex_cli_rs/0.153.0",
  },
  methods: {
    ...unprobedCodexRuntimeReport.methods,
    "thread/goal/clear": "available" as const,
    "thread/goal/get": "available" as const,
    "thread/goal/set": "available" as const,
  },
  version: { raw: "codex-cli 0.153.0", semantic: "0.153.0" },
};

const provider = {
  id: "goal-provider",
  name: "Goal provider",
  kind: "openai-compatible" as const,
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
};

const model = {
  id: "goal-model-profile",
  routeId: "goal-route",
  name: "goal-model",
  reasoningEffort: null,
};

async function fakeCodexBinary(directory: string): Promise<string> {
  const binary = path.join(directory, "fake-goal-codex.cjs");
  const wsEntry = createRequire(import.meta.url).resolve("ws");
  await writeFile(
    binary,
    `const { WebSocketServer } = require(${JSON.stringify(wsEntry)});

const mode = process.argv[2];
const threadId = "goal-thread";
const actualTurnId = "runtime-goal-turn";
let cleared = false;
let turnStartCount = 0;
let globalSkillRootsRegistered = false;
const completedTurns = [];
const expectedGlobalSkillRoot = ${JSON.stringify(path.join(directory, "global-skills"))};
let goal = mode === "replace-completed"
  ? {
      threadId,
      objective: "Old completed goal",
      status: "complete",
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 5,
      createdAt: 1,
      updatedAt: 2
    }
  : {
      threadId,
      objective: "Active goal",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 2
    };

const command = {
  type: "commandExecution",
  id: "goal-command",
  command: "pwd",
  cwd: process.cwd(),
  status: "completed",
  aggregatedOutput: process.cwd() + "\\n",
  exitCode: 0,
  durationMs: 5
};
const answer = {
  type: "agentMessage",
  id: "goal-answer",
  text: "Goal work is visible.",
  phase: "final_answer"
};

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
  const address = server.address();
  process.stdout.write("listening on: ws://127.0.0.1:" + address.port + "\\n");
});

function reply(socket, id, result) {
  socket.send(JSON.stringify({ id, result }));
}

server.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id === undefined) return;
    if (message.method === "initialize") {
      reply(socket, message.id, {});
      return;
    }
    if (message.method === "skills/extraRoots/set") {
      if (JSON.stringify(message.params.extraRoots) !== JSON.stringify([expectedGlobalSkillRoot])) {
        process.exit(41);
      }
      globalSkillRootsRegistered = true;
      reply(socket, message.id, {});
      return;
    }
    if (message.method === "skills/list") {
      if (!globalSkillRootsRegistered) process.exit(42);
      reply(socket, message.id, {
        data: [{ cwd: message.params.cwds[0], skills: [], errors: [] }]
      });
      return;
    }
    if (message.method === "thread/resume") {
      reply(socket, message.id, { thread: { id: threadId } });
      return;
    }
    if (message.method === "thread/goal/get") {
      reply(socket, message.id, { goal });
      return;
    }
    if (message.method === "thread/goal/clear") {
      cleared = true;
      goal = null;
      reply(socket, message.id, { cleared: true });
      return;
    }
    if (message.method === "thread/goal/set") {
      if (mode === "replace-completed" && !cleared) {
        socket.send(JSON.stringify({
          id: message.id,
          error: { code: -32000, message: "completed goal was not cleared" }
        }));
        return;
      }
      goal = {
        threadId,
        objective: message.params.objective,
        status: "active",
        tokenBudget: message.params.tokenBudget,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 3,
        updatedAt: 3
      };
      reply(socket, message.id, { goal });
      return;
    }
    if (message.method === "turn/start") {
      turnStartCount += 1;
      if (mode === "automatic-continuation") {
        if (turnStartCount > 1) {
          socket.send(JSON.stringify({
            id: message.id,
            error: { code: -32000, message: "duplicate manual continuation" }
          }));
          return;
        }
        reply(socket, message.id, { turn: { id: "goal-turn-1" } });
        setTimeout(() => {
          const firstAnswer = { ...answer, id: "goal-answer-1", text: "First checkpoint." };
          completedTurns.push({
            id: "goal-turn-1",
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 10,
            items: [{ ...firstAnswer, id: "history-goal-answer-1" }]
          });
          socket.send(JSON.stringify({
            method: "turn/started",
            params: { threadId, turn: { id: "goal-turn-1", startedAt: 1 } }
          }));
          socket.send(JSON.stringify({
            method: "item/completed",
            params: { threadId, turnId: "goal-turn-1", item: firstAnswer }
          }));
          socket.send(JSON.stringify({
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: "goal-turn-1", status: "completed", error: null, durationMs: 10 }
            }
          }));
          socket.send(JSON.stringify({
            method: "turn/started",
            params: { threadId, turn: { id: "goal-turn-2", startedAt: 2 } }
          }));
          setTimeout(() => {
            const finalAnswer = { ...answer, id: "goal-answer-2", text: "Goal complete." };
            completedTurns.push({
              id: "goal-turn-2",
              status: "completed",
              error: null,
              startedAt: 2,
              completedAt: 3,
              durationMs: 10,
              items: [
                { ...command, id: "history-goal-command-2" },
                { ...finalAnswer, id: "history-goal-answer-2" }
              ]
            });
            socket.send(JSON.stringify({
              method: "item/completed",
              params: { threadId, turnId: "goal-turn-2", item: command }
            }));
            socket.send(JSON.stringify({
              method: "item/completed",
              params: { threadId, turnId: "goal-turn-2", item: finalAnswer }
            }));
            goal = { ...goal, status: "complete", updatedAt: 4 };
            socket.send(JSON.stringify({
              method: "thread/goal/updated",
              params: { threadId, goal }
            }));
            socket.send(JSON.stringify({
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: "goal-turn-2", status: "completed", error: null, durationMs: 10 }
              }
            }));
          }, 100);
        }, 10);
        return;
      }
      reply(socket, message.id, { turn: { id: "synthetic-start-response" } });
      setTimeout(() => {
        socket.send(JSON.stringify({
          method: "item/started",
          params: {
            threadId,
            turnId: actualTurnId,
            item: { ...command, status: "inProgress", aggregatedOutput: "", exitCode: null }
          }
        }));
        socket.send(JSON.stringify({
          method: "item/completed",
          params: { threadId, turnId: actualTurnId, item: command }
        }));
        socket.send(JSON.stringify({
          method: "item/completed",
          params: { threadId, turnId: actualTurnId, item: answer }
        }));
        goal = { ...goal, status: "complete", updatedAt: 4 };
        socket.send(JSON.stringify({
          method: "thread/goal/updated",
          params: { threadId, goal }
        }));
        socket.send(JSON.stringify({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: actualTurnId,
              status: "completed",
              error: null,
              durationMs: 10
            }
          }
        }));
        completedTurns.push({
          id: actualTurnId,
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 10,
          items: [
            { ...command, id: "history-goal-command" },
            { ...answer, id: "history-goal-answer" }
          ]
        });
      }, 10);
      return;
    }
    if (message.method === "thread/read") {
      reply(socket, message.id, {
        thread: {
          id: threadId,
          turns: completedTurns
        }
      });
      return;
    }
    socket.send(JSON.stringify({
      id: message.id,
      error: { code: -32601, message: "unsupported " + message.method }
    }));
  });
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
`,
    "utf8",
  );
  return binary;
}

function launcher(
  mode: "automatic-continuation" | "replace-completed" | "turn-id-race",
): CodexProcessLauncher {
  return (binary, arguments_, options) =>
    spawn(process.execPath, [binary, mode, ...arguments_], {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
}

async function fixture(
  mode: "automatic-continuation" | "replace-completed" | "turn-id-race",
  options: {
    compatibility?: CodexRuntimeReport;
    registerGlobalSkills?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-goal-streaming-"));
  temporaryDirectories.push(root);
  const binary = await fakeCodexBinary(root);
  return {
    root,
    runtime: new CodexAppServer(
      binary,
      root,
      path.join(root, "codex-home"),
      options.compatibility ?? compatibility,
      undefined,
      undefined,
      undefined,
      launcher(mode),
      options.registerGlobalSkills ? [path.join(root, "global-skills")] : [],
    ),
  };
}

describe("Codex goal streaming", () => {
  it("keeps the standalone runtime identity while reloading skills", async () => {
    const standaloneCompatibility = {
      ...compatibility,
      methods: {
        ...compatibility.methods,
        "skills/extraRoots/set": "available" as const,
        "skills/list": "available" as const,
      },
    };
    const { root, runtime } = await fixture("turn-id-race", {
      compatibility: standaloneCompatibility,
      registerGlobalSkills: true,
    });
    try {
      await runtime.reloadSkills({
        cwd: root,
        executionProfile: "standalone-chat",
        model,
        provider,
        subagentDefaults: null,
      });

      await expect(
        runtime.runTurn({
          attachments: [],
          automationPaused: false,
          captureProtectedDiagnostics: false,
          chatId: "standalone-chat",
          clientMessageId: "standalone-message",
          cwd: root,
          executionProfile: "standalone-chat",
          isPrimary: true,
          mcpServers: [],
          model,
          permissionProfileId: null,
          planMode: "default",
          policyContext: null,
          prompt: "Complete the standalone turn.",
          provider,
          rootKind: null,
          skillNames: [],
          subagentDefaults: null,
          subagentProtocolVersion: undefined,
          threadId: "goal-thread",
          worktreeMode: null,
          worktreePolicy: null,
        }),
      ).resolves.toMatchObject({
        status: "completed",
        text: "Goal work is visible.",
      });
    } finally {
      runtime.close();
    }
  });

  it("registers worker-global skill roots before serving the native skill catalog", async () => {
    const globalSkillCompatibility = {
      ...compatibility,
      methods: {
        ...compatibility.methods,
        "skills/extraRoots/set": "available" as const,
      },
    };
    const { root, runtime } = await fixture("replace-completed", {
      compatibility: globalSkillCompatibility,
      registerGlobalSkills: true,
    });
    try {
      await expect(
        runtime.listSkills({ cwd: root, model, provider }),
      ).resolves.toEqual([]);
    } finally {
      runtime.close();
    }
  });

  it("clears a completed goal before creating its replacement", async () => {
    const { root, runtime } = await fixture("replace-completed");
    try {
      await expect(
        runtime.createGoal({
          cwd: root,
          model,
          objective: "Replacement goal",
          permissionProfileId: null,
          provider,
          threadId: "goal-thread",
          tokenBudget: null,
        }),
      ).resolves.toMatchObject({
        goal: { objective: "Replacement goal", status: "active" },
      });
    } finally {
      runtime.close();
    }
  });

  it("streams an automatic goal turn whose runtime ID differs from turn/start", async () => {
    const { root, runtime } = await fixture("turn-id-race");
    const messages: string[] = [];
    const commands: string[] = [];
    try {
      const result = await runtime.runTurn({
        attachments: [],
        chatId: "goal-chat",
        clientMessageId: "goal-message",
        cwd: root,
        isPrimary: true,
        mcpServers: [],
        model,
        permissionProfileId: null,
        planMode: "default",
        prompt: "Continue the active goal.",
        provider,
        skillNames: [],
        threadId: "goal-thread",
        worktreeMode: "agent-managed",
        worktreePolicy: "required-for-writes",
        onActivity: (activity) => {
          if (activity.type === "command") commands.push(activity.command);
        },
        onMessage: (message) => messages.push(message.text),
      });

      expect(result).toMatchObject({
        status: "completed",
        text: "Goal work is visible.",
        threadId: "goal-thread",
        turnId: "runtime-goal-turn",
      });
      expect(messages).toEqual(["Goal work is visible."]);
      expect(commands).toContain("pwd");
    } finally {
      runtime.close();
    }
  });

  it("follows runtime-managed goal continuations without starting duplicates", async () => {
    const { root, runtime } = await fixture("automatic-continuation");
    const messages: string[] = [];
    const checkpoints: string[] = [];
    try {
      const result = await runtime.runTurn({
        attachments: [],
        chatId: "goal-chat",
        clientMessageId: "goal-message",
        cwd: root,
        isPrimary: true,
        mcpServers: [],
        model,
        permissionProfileId: null,
        planMode: "default",
        prompt: "Continue the active goal.",
        provider,
        skillNames: [],
        threadId: "goal-thread",
        worktreeMode: "agent-managed",
        worktreePolicy: "required-for-writes",
        onCheckpoint: ({ text }) => checkpoints.push(text),
        onMessage: (message) => messages.push(message.text),
      });

      expect(result).toMatchObject({
        status: "completed",
        text: "Goal complete.",
        turnId: "goal-turn-2",
      });
      expect(checkpoints).toEqual(["First checkpoint."]);
      expect(messages).toEqual(["First checkpoint.", "Goal complete."]);
    } finally {
      runtime.close();
    }
  });
});
