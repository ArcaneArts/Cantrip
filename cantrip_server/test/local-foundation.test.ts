import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  agentInteractionRequestListSchema,
  agentInteractionRequestSchema,
  agentThreadSyncSchema,
  browserListSchema,
  browserSummarySchema,
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  chatListSchema,
  chatGoalResponseSchema,
  chatMessageListSchema,
  chatMessageSchema,
  chatPauseStateSchema,
  chatPermissionProfileStateSchema,
  chatPlanStateSchema,
  chatSummarySchema,
  explorerDirectorySchema,
  explorerFileSchema,
  explorerListSchema,
  explorerSummarySchema,
  gitActionResultSchema,
  gitHistorySchema,
  gitStatusSchema,
  githubRepositoryListSchema,
  githubIssueDetailSchema,
  githubIssueListSchema,
  modelProfileSummarySchema,
  modelProviderSummarySchema,
  projectListSchema,
  projectSummarySchema,
  projectViewListSchema,
  projectViewSummarySchema,
  queuedPromptListSchema,
  queuedPromptSchema,
  remoteDesktopListSchema,
  remoteDesktopSummarySchema,
  remoteSurfaceListSchema,
  remoteSurfaceConnectionMessageSchema,
  remoteSurfaceSummarySchema,
  serverBootstrapSchema,
  settingsBundleSchema,
  skillListSchema,
  terminalListSchema,
  terminalSummarySchema,
  unprobedCodexRuntimeReport,
  workerListSchema,
} from "@cantrip/protocol";
import type {
  AgentInteractionRequestCreate,
  PlanMode,
  ThreadGoal,
  WorkerCommand,
} from "@cantrip/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-local-foundation-"),
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

let turnRequests = 0;
let compactRequests = 0;
const turnModelIds: string[] = [];
const turnProviderIds: string[] = [];
const turnRouteIds: string[] = [];
const turnPermissionProfileIds: string[] = [];
const turnPrompts: string[] = [];
const turnSkillNames: string[][] = [];
const turnTimeouts: Array<number | null | undefined> = [];
const deletedProjectPaths: string[] = [];
const authProviderIds: string[] = [];
const exhaustedProviderIds = new Set<string>();
const steeredPrompts: string[] = [];
const pauseCommands: Array<{ chatId: string; paused: boolean }> = [];
let codexGoal: ThreadGoal | null = null;
let codexPlanMode: PlanMode = "default";
let releasePlanQuestion: (() => void) | null = null;
let releaseAgentInteraction: (() => void) | null = null;
const deliveredAgentInteractionResponses: unknown[] = [];
const issueComments: string[] = [];
const closedIssues: Array<{ comment: string | null; number: number }> = [];
const relayedSurfaceFrames: Array<{
  workerId: string;
  sequence: number;
  payload: number[];
}> = [];
const surfaceAttachCommands: Array<
  Extract<WorkerCommand, { type: "surface.attach" }>
> = [];
const surfaceFrameListeners = new Set<
  (
    header: Parameters<WorkerCommandBus["sendSurfaceFrame"]>[1],
    payload: Uint8Array,
  ) => void
>();
let releaseHeldTurn: (() => void) | null = null;
let heldProjectCloneName: string | null = null;
let releaseProjectClone: (() => void) | null = null;
const workerBridge = {
  attach() {},
  close() {},
  isConnected(workerId: string) {
    return workerId === "test-worker";
  },
  sendSurfaceFrame(workerId, header, payload) {
    relayedSurfaceFrames.push({
      workerId,
      sequence: header.sequence,
      payload: [...payload],
    });
    return true;
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames(_workerId, listener) {
    surfaceFrameListeners.add(listener);
    return () => surfaceFrameListeners.delete(listener);
  },
  async request(_workerId, command, options) {
    switch (command.type) {
      case "codex.auth.status":
        authProviderIds.push(command.providerId);
        return {
          authenticated: true,
          authMode: "chatgpt",
          email: "test@example.com",
          planType: "plus",
          weeklyUsage: {
            usedPercent: exhaustedProviderIds.has(command.providerId)
              ? 100
              : 37,
            resetsAt: 1_786_665_600,
          },
        };
      case "codex.auth.login.start":
        authProviderIds.push(command.providerId);
        return {
          loginId: "login-1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "TEST-CODE",
        };
      case "codex.auth.logout":
        authProviderIds.push(command.providerId);
        return { accepted: true };
      case "github.auth.status":
        return { authenticated: true, login: "cantrip-test", source: "gh-cli" };
      case "github.repositories.cached":
      case "github.repositories.list":
        return [
          {
            id: "github-repository-1",
            name: "Cantrip",
            nameWithOwner: "ArcaneArts/Cantrip",
            description: "Test repository",
            isPrivate: true,
            isFork: false,
            url: "https://github.com/ArcaneArts/Cantrip",
            defaultBranch: "main",
            updatedAt: "2026-08-07T12:00:00.000Z",
          },
        ];
      case "github.issues.list":
        return {
          state: command.state,
          total: 1,
          issues: [
            {
              number: 42,
              title: "Test the GitHub issue view",
              state: command.state,
              url: "https://github.com/ArcaneArts/Cantrip/issues/42",
              author: "cantrip-test",
              commentCount: 1,
              labels: [{ name: "feature", color: "22d3ee" }],
              createdAt: "2026-08-07T12:00:00.000Z",
              updatedAt: "2026-08-07T13:00:00.000Z",
              closedAt:
                command.state === "closed" ? "2026-08-07T14:00:00.000Z" : null,
            },
          ],
        };
      case "github.issue.get":
      case "github.issue.comment":
      case "github.issue.close": {
        if (command.type === "github.issue.comment") {
          issueComments.push(command.body);
        }
        if (command.type === "github.issue.close") {
          closedIssues.push({
            number: command.number,
            comment: command.comment,
          });
        }
        const closed = command.type === "github.issue.close";
        return {
          number: command.number,
          title: "Test the GitHub issue view",
          state: closed ? "closed" : "open",
          url: `https://github.com/ArcaneArts/Cantrip/issues/${command.number}`,
          author: "cantrip-test",
          commentCount: 1,
          labels: [{ name: "feature", color: "22d3ee" }],
          createdAt: "2026-08-07T12:00:00.000Z",
          updatedAt: "2026-08-07T13:00:00.000Z",
          closedAt: closed ? "2026-08-07T14:00:00.000Z" : null,
          body: "Issue details",
          comments: [
            {
              id: "comment-1",
              author: "reviewer",
              body: "Looks good",
              url: `https://github.com/ArcaneArts/Cantrip/issues/${command.number}#issuecomment-1`,
              createdAt: "2026-08-07T12:30:00.000Z",
              updatedAt: "2026-08-07T12:30:00.000Z",
            },
          ],
        };
      }
      case "project.clone":
        if (command.repository.nameWithOwner === heldProjectCloneName) {
          await new Promise<void>((resolve) => {
            releaseProjectClone = resolve;
          });
        }
        return {
          path: path.join(dataDirectory, "repositories", "Cantrip"),
          displayPath: "ArcaneArts/Cantrip",
          reused: false,
          updated: false,
          warning: null,
        };
      case "project.files.delete":
        deletedProjectPaths.push(command.path);
        return { deleted: true };
      case "git.history":
        return {
          branch: "main",
          head: "0123456789abcdef",
          totalCount: 1,
          commits: [
            {
              hash: "0123456789abcdef",
              shortHash: "0123456",
              parents: [],
              subject: "feat: test history",
              authorName: "Cantrip Test",
              authorEmail: "test@cantrip.art",
              authoredAt: "2026-08-07T12:00:00.000Z",
              refs: [
                { name: "HEAD", kind: "head", current: true },
                { name: "main", kind: "local", current: true },
              ],
              isHead: true,
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      case "git.status":
        return {
          branch: "main",
          head: "0123456789abcdef",
          upstream: "origin/main",
          ahead: 1,
          behind: 0,
          files: [
            {
              path: "README.md",
              originalPath: null,
              indexStatus: " ",
              worktreeStatus: "M",
              staged: false,
              unstaged: true,
            },
          ],
          branches: [
            {
              name: "main",
              kind: "local",
              current: true,
              hash: "0123456789abcdef",
              upstream: "origin/main",
            },
          ],
        };
      case "git.action":
        return {
          status: {
            branch:
              command.action.type === "createBranch"
                ? command.action.name
                : "main",
            head: "0123456789abcdef",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            files: [],
            branches: [
              {
                name: "main",
                kind: "local",
                current: command.action.type !== "createBranch",
                hash: "0123456789abcdef",
                upstream: "origin/main",
              },
            ],
          },
          output: "Git action complete",
        };
      case "explorer.directory.list":
        return {
          path: command.path,
          entries: [
            {
              name: "README.md",
              path: "README.md",
              kind: "file",
              size: 18,
              modifiedAt: "2026-08-07T12:00:00.000Z",
              viewable: true,
              markdown: true,
            },
          ],
          truncated: false,
        };
      case "explorer.file.read":
        return {
          path: command.path,
          content: "# Cantrip explorer\n",
          size: 18,
          markdown: true,
        };
      case "skills.list":
        return [
          {
            name: "skill-creator",
            displayName: "Skill Creator",
            description: "Create reusable skills",
          },
        ];
      case "permission-profiles.list":
        return {
          available: true,
          profiles: [
            {
              id: ":read-only",
              description: "Inspection only",
              allowed: true,
            },
            {
              id: ":workspace",
              description: "Workspace writes",
              allowed: true,
            },
            {
              id: ":danger-full-access",
              description: "Unrestricted access",
              allowed: true,
            },
            {
              id: ":blocked",
              description: "Disabled by policy",
              allowed: false,
            },
          ],
          reason: null,
        };
      case "terminal.open":
        return { status: "detached" };
      case "terminal.detach":
      case "terminal.input":
      case "terminal.resize":
      case "terminal.close":
        return { accepted: true };
      case "surface.attach":
        surfaceAttachCommands.push(command);
        return { accepted: true, transport: "websocket" };
      case "surface.detach":
      case "surface.suspend":
      case "surface.resume":
      case "surface.close":
        return { accepted: true };
      case "surface.desktop.probe":
        return { available: true, message: null };
      case "chat.turn": {
        if (command.prompt !== "Render rich events") {
          turnRequests += 1;
          turnModelIds.push(command.model.id);
          turnProviderIds.push(command.provider.id);
          turnRouteIds.push(command.model.routeId);
          turnPermissionProfileIds.push(command.permissionProfileId);
          turnPrompts.push(command.prompt);
          turnSkillNames.push(command.skillNames);
          turnTimeouts.push(options?.timeoutMs);
        }
        if (command.prompt === "Finish the long-running goal") {
          await options?.onEvent?.({
            type: "agent.checkpoint",
            turnId: "goal-turn-1",
            text: "Finished the first goal milestone.",
          });
        }
        if (command.prompt === "Draft a deployment plan") {
          await options?.onEvent?.({
            type: "agent.plan.updated",
            turnId: "plan-turn-1",
            explanation: "Choose the deployment topology.",
            steps: [
              { step: "Inspect the runtime", status: "completed" },
              { step: "Choose a topology", status: "inProgress" },
            ],
          });
          await options?.onEvent?.({
            type: "agent.interaction.requested",
            request: {
              requestKey: "plan-question-1",
              threadId: command.threadId ?? "codex-plan-thread-1",
              turnId: "plan-turn-1",
              itemId: "plan-item-1",
              payload: {
                kind: "userInput",
                questions: [
                  {
                    id: "topology",
                    header: "Topology",
                    question: "Which topology should the plan target?",
                    isOther: true,
                    isSecret: false,
                    options: [
                      {
                        label: "Four nodes",
                        description: "Load balance across four servers.",
                      },
                    ],
                  },
                ],
                autoResolutionMs: null,
              },
              expiresAt: "2030-08-08T18:30:00.000Z",
            },
          });
          await options?.onEvent?.({
            type: "agent.plan.question",
            question: {
              id: "plan-question-1",
              threadId: command.threadId ?? "codex-plan-thread-1",
              turnId: "plan-turn-1",
              itemId: "plan-item-1",
              createdAt: "2026-08-08T12:00:00.000Z",
              questions: [
                {
                  id: "topology",
                  header: "Topology",
                  question: "Which topology should the plan target?",
                  isOther: true,
                  isSecret: false,
                  options: [
                    {
                      label: "Four nodes",
                      description: "Load balance across four servers.",
                    },
                  ],
                },
              ],
            },
          });
          await new Promise<void>((resolve) => {
            releasePlanQuestion = resolve;
          });
        }
        if (command.prompt === "Request a command approval") {
          await options?.onEvent?.({
            type: "agent.interaction.requested",
            request: {
              requestKey: "runtime-bridge:approval-1",
              threadId: command.threadId ?? "codex-approval-thread-1",
              turnId: "approval-turn-1",
              itemId: "approval-item-1",
              payload: {
                kind: "commandExecution",
                startedAtMs: 1_786_665_600_000,
                approvalId: null,
                environmentId: null,
                reason: "Run the verification suite",
                command: "pnpm check",
                cwd: command.cwd,
                commandActions: null,
                networkApprovalContext: null,
                additionalPermissions: null,
                proposedExecpolicyAmendment: null,
                proposedNetworkPolicyAmendments: null,
                availableDecisions: ["accept", "decline", "cancel"],
              },
              expiresAt: "2030-08-08T18:30:00.000Z",
            },
          });
          await new Promise<void>((resolve) => {
            releaseAgentInteraction = resolve;
          });
        }
        if (command.prompt === "Render rich events") {
          const richCorrelation = (
            sourceMethod: string,
            itemId: string | null,
          ) => ({
            sourceMethod,
            diagnosticId: `runtime-session:${itemId ?? "turn"}`,
            threadId: "codex-rich-thread-1",
            turnId: "rich-turn-1",
            itemId,
          });
          await options?.onEvent?.({
            type: "agent.message",
            message: {
              id: "commentary-1",
              text: "I’m comparing the event schemas.",
              phase: "commentary",
              correlation: richCorrelation("item/completed", "commentary-1"),
            },
          });
          await options?.onEvent?.({
            type: "agent.activity",
            activity: {
              type: "reasoning",
              id: "reasoning-1",
              status: "completed",
              summary: ["Compared the supported event unions."],
              correlation: richCorrelation("item/completed", "reasoning-1"),
            },
          });
          await options?.onEvent?.({
            type: "agent.activity",
            activity: {
              type: "mcpToolCall",
              id: "mcp-1",
              status: "completed",
              server: "github",
              tool: "search_issues",
              error: null,
              durationMs: 75,
              correlation: richCorrelation("item/completed", "mcp-1"),
            },
          });
          const tokenUsage = {
            totalTokens: 1_200,
            inputTokens: 800,
            cachedInputTokens: 200,
            cacheWriteInputTokens: 0,
            outputTokens: 300,
            reasoningOutputTokens: 100,
          };
          await options?.onEvent?.({
            type: "agent.activity",
            activity: {
              type: "usage",
              id: "turn:rich-turn-1:usage",
              status: "completed",
              total: tokenUsage,
              last: tokenUsage,
              modelContextWindow: 10_000,
              contextUsedPercent: 12,
              correlation: richCorrelation("thread/tokenUsage/updated", null),
            },
          });
          await options?.onEvent?.({
            type: "agent.message",
            message: {
              id: "final-1",
              text: "Rich events are preserved.",
              phase: "final_answer",
              correlation: richCorrelation("item/completed", "final-1"),
            },
          });
          await options?.onEvent?.({
            type: "agent.activity",
            activity: {
              type: "turnSummary",
              id: "turn:rich-turn-1:summary",
              status: "completed",
              durationMs: 2_000,
              startedAt: 1_786_134_300,
              completedAt: 1_786_134_302,
              correlation: richCorrelation("turn/completed", null),
            },
          });
          return {
            threadId: "codex-rich-thread-1",
            turnId: "rich-turn-1",
            text: "Rich events are preserved.",
            status: "completed",
          };
        }
        await options?.onEvent?.({
          type: "agent.activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "pwd",
            cwd: ".",
            status: "running",
            exitCode: null,
            output: null,
          },
        });
        await options?.onEvent?.({
          type: "agent.activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "pwd",
            cwd: ".",
            status: "completed",
            exitCode: 0,
            output: "/worktree\n",
          },
        });
        await options?.onEvent?.({
          type: "agent.activity",
          activity: {
            type: "fileChange",
            id: "file-change-1",
            status: "completed",
            changes: [{ path: "README.md", kind: "update" }],
          },
        });
        if (command.prompt.includes("Hold queue open.")) {
          await new Promise<void>((resolve) => {
            releaseHeldTurn = resolve;
          });
        }
        return {
          threadId: command.threadId ?? "codex-thread-1",
          text: "The local agent replied.",
          status: "completed",
        };
      }
      case "chat.compact":
        compactRequests += 1;
        return { accepted: true };
      case "chat.pause.set":
        pauseCommands.push({ chatId: command.chatId, paused: command.paused });
        return { paused: command.paused };
      case "chat.interrupt":
        return { interrupted: false };
      case "chat.goal.get":
        return { goal: codexGoal };
      case "chat.goal.create":
        codexGoal = {
          threadId: command.threadId ?? "codex-goal-thread-1",
          objective: command.objective,
          status: "active",
          tokenBudget: command.tokenBudget ?? null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1_786_665_600,
          updatedAt: 1_786_665_600,
        };
        return { goal: codexGoal };
      case "chat.goal.update":
        if (!codexGoal) return { goal: null };
        codexGoal = {
          ...codexGoal,
          status: command.status,
          updatedAt: codexGoal.updatedAt + 1,
        };
        return { goal: codexGoal };
      case "chat.goal.clear":
        codexGoal = null;
        return { cleared: true };
      case "chat.plan.get":
        return { mode: codexPlanMode, threadId: command.threadId };
      case "chat.plan.set":
        codexPlanMode = command.mode;
        return {
          mode: codexPlanMode,
          threadId: command.threadId ?? "codex-plan-thread-1",
        };
      case "chat.plan.answer":
        releasePlanQuestion?.();
        releasePlanQuestion = null;
        return { accepted: true, requestKey: command.questionId };
      case "agent.interaction.respond":
        deliveredAgentInteractionResponses.push(command.response);
        releaseAgentInteraction?.();
        releaseAgentInteraction = null;
        return { accepted: true };
      case "agent.interaction.cancel":
        releaseAgentInteraction?.();
        releaseAgentInteraction = null;
        return { accepted: true };
      case "chat.steer":
        steeredPrompts.push(command.prompt);
        return { steered: true, turnId: "turn-held" };
      case "chat.sync":
        return {
          threadId: command.threadId,
          status: "idle",
          turns: [
            {
              id: "console-turn-1",
              status: "completed",
              startedAt: 1_786_134_300,
              completedAt: 1_786_134_302,
              durationMs: 2_000,
              items: [
                {
                  type: "userMessage",
                  id: "console-user-1",
                  text: "What is 4+4?",
                },
                {
                  type: "agentMessage",
                  id: "console-commentary-1",
                  text: "I’m calculating the result.",
                  phase: "commentary",
                  correlation: {
                    sourceMethod: "thread/read",
                    diagnosticId: null,
                    threadId: command.threadId,
                    turnId: "console-turn-1",
                    itemId: "console-commentary-1",
                  },
                },
                {
                  type: "activity",
                  activity: {
                    type: "reasoning",
                    id: "console-reasoning-1",
                    status: "completed",
                    summary: ["Added four and four."],
                    correlation: {
                      sourceMethod: "thread/read",
                      diagnosticId: null,
                      threadId: command.threadId,
                      turnId: "console-turn-1",
                      itemId: "console-reasoning-1",
                    },
                  },
                },
                {
                  type: "activity",
                  activity: {
                    type: "contextCompaction",
                    id: "console-compaction-1",
                    status: "completed",
                    correlation: {
                      sourceMethod: "thread/read",
                      diagnosticId: null,
                      threadId: command.threadId,
                      turnId: "console-turn-1",
                      itemId: "console-compaction-1",
                    },
                  },
                },
                {
                  type: "activity",
                  activity: {
                    type: "turnSummary",
                    id: "turn:console-turn-1:summary",
                    status: "completed",
                    durationMs: 2_000,
                    startedAt: 1_786_134_300,
                    completedAt: 1_786_134_302,
                    correlation: {
                      sourceMethod: "thread/read",
                      diagnosticId: null,
                      threadId: command.threadId,
                      turnId: "console-turn-1",
                      itemId: null,
                    },
                  },
                },
                {
                  type: "agentMessage",
                  id: "console-agent-1",
                  text: "8",
                  phase: "final_answer",
                  correlation: {
                    sourceMethod: "thread/read",
                    diagnosticId: null,
                    threadId: command.threadId,
                    turnId: "console-turn-1",
                    itemId: "console-agent-1",
                  },
                },
              ],
            },
          ],
        };
    }
  },
} satisfies WorkerCommandBus;

afterAll(async () => {
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("local server foundation", () => {
  it("persists server configuration, workers, and conversations", async () => {
    const firstDatabase = await connectDatabase(config);
    const firstApp = await buildApp({
      config,
      database: firstDatabase,
      logger: false,
      workerBridge,
    });

    const bootstrap = serverBootstrapSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/bootstrap" })).json(),
    );
    expect(bootstrap.auth).toMatchObject({
      mode: "none",
      currentUser: { kind: "anonymous" },
    });
    expect(bootstrap.routing.directWorkerConnections).toBe(false);
    expect(bootstrap.capabilities.worktrees).toBe(true);

    const initialSettings = settingsBundleSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    expect(initialSettings.preferences).toMatchObject({
      theme: "system",
      highContrast: false,
      desktopFrameRate: 30,
      desktopStreamQuality: "adaptive",
      defaultModelId: expect.any(String),
    });
    const provider = modelProviderSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/providers",
          payload: {
            name: "Test provider",
            kind: "openai-compatible",
            baseUrl: "https://models.example.test/v1",
            apiKey: "server-only-secret",
          },
        })
      ).json(),
    );
    expect(provider.hasApiKey).toBe(true);
    const editedProvider = modelProviderSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/settings/providers/${provider.id}`,
          payload: {
            name: "Edited test provider",
            kind: "openai-compatible",
            baseUrl: "https://edited-models.example.test/v1/",
          },
        })
      ).json(),
    );
    expect(editedProvider).toMatchObject({
      name: "Edited test provider",
      baseUrl: "https://edited-models.example.test/v1",
      hasApiKey: true,
    });
    const selectedModel = modelProfileSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/models",
          payload: {
            name: "Test model",
            reasoningEffort: "high",
            routes: [
              {
                providerId: provider.id,
                modelName: "test-model",
                enabled: true,
              },
            ],
          },
        })
      ).json(),
    );
    const editedModel = modelProfileSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/settings/models/${selectedModel.id}`,
          payload: {
            name: "Edited test model",
            reasoningEffort: "medium",
            routes: [
              {
                id: selectedModel.routes[0]?.id,
                providerId: provider.id,
                modelName: "edited-test-model",
                enabled: true,
              },
            ],
          },
        })
      ).json(),
    );
    expect(editedModel).toMatchObject({
      name: "Edited test model",
      reasoningEffort: "medium",
      routingPolicy: "priority",
      routes: [
        expect.objectContaining({
          providerName: "Edited test provider",
          modelName: "edited-test-model",
          position: 0,
        }),
      ],
    });
    const updatedSettings = settingsBundleSchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: {
            theme: "dark",
            highContrast: true,
            desktopFrameRate: 60,
            desktopStreamQuality: "balanced",
            defaultModelId: selectedModel.id,
          },
        })
      ).json(),
    );
    expect(updatedSettings.preferences).toEqual({
      theme: "dark",
      highContrast: true,
      desktopFrameRate: 60,
      desktopStreamQuality: "balanced",
      defaultModelId: selectedModel.id,
    });
    const chatGptProvider = modelProviderSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/providers",
          payload: {
            name: "Personal ChatGPT",
            kind: "chatgpt",
            baseUrl: "https://api.openai.com/v1",
          },
        })
      ).json(),
    );

    expect(
      await firstApp.inject({
        method: "POST",
        url: "/api/internal/workers/heartbeat",
        headers: { authorization: "Bearer wrong-worker-token" },
        payload: {},
      }),
    ).toMatchObject({ statusCode: 401 });
    const heartbeatResponse = await firstApp.inject({
      method: "POST",
      url: "/api/internal/workers/heartbeat",
      headers: { authorization: "Bearer test-worker-token" },
      payload: {
        workerId: "test-worker",
        name: "Test Worker",
        platform: "darwin",
        architecture: "arm64",
        codexVersion: "codex-cli 1.0.0",
        codexRuntime: unprobedCodexRuntimeReport,
        remoteSurfaces: {
          browser: true,
          desktop: true,
          transports: ["websocket"],
          maxSessions: 4,
        },
        startedAt: "2026-08-07T12:00:00.000Z",
      },
    });
    expect(heartbeatResponse.statusCode).toBe(202);
    expect(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/codex/auth/status?workerId=test-worker&providerId=${chatGptProvider.id}`,
        })
      ).json(),
    ).toMatchObject({
      authMode: "chatgpt",
      planType: "plus",
      weeklyUsage: { usedPercent: 37 },
    });
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/codex/auth/device-login",
          payload: {
            workerId: "test-worker",
            providerId: chatGptProvider.id,
          },
        })
      ).json(),
    ).toMatchObject({ userCode: "TEST-CODE" });
    expect(
      await firstApp.inject({
        method: "POST",
        url: "/api/codex/auth/logout",
        payload: {
          workerId: "test-worker",
          providerId: chatGptProvider.id,
        },
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(authProviderIds).toEqual([
      chatGptProvider.id,
      chatGptProvider.id,
      chatGptProvider.id,
    ]);
    expect(
      githubRepositoryListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: "/api/github/repositories/cache?workerId=test-worker&login=cantrip-test",
          })
        ).json(),
      ),
    ).toMatchObject([{ nameWithOwner: "ArcaneArts/Cantrip", imported: false }]);

    heldProjectCloneName = "ArcaneArts/Cantrip";
    const projectResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects/from-github",
      payload: {
        workerId: "test-worker",
        repositoryId: "github-repository-1",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
    });
    expect(projectResponse.statusCode).toBe(202);
    const queuedProject = projectSummarySchema.parse(projectResponse.json());
    expect(queuedProject).toMatchObject({
      setupStatus: "cloning",
      setupError: null,
      source: null,
    });
    expect(releaseProjectClone).not.toBeNull();
    const parallelResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects/from-github",
      payload: {
        workerId: "test-worker",
        repositoryId: "github-repository-2",
        nameWithOwner: "ArcaneArts/ParallelClone",
        url: "https://github.com/ArcaneArts/ParallelClone",
      },
    });
    expect(parallelResponse.statusCode).toBe(202);
    const parallelProject = projectSummarySchema.parse(parallelResponse.json());
    await vi.waitFor(async () => {
      const currentProjects = projectListSchema.parse(
        (await firstApp.inject({ method: "GET", url: "/api/projects" })).json(),
      );
      expect(
        currentProjects.find((candidate) => candidate.id === parallelProject.id)
          ?.setupStatus,
      ).toBe("ready");
      expect(
        currentProjects.find((candidate) => candidate.id === queuedProject.id)
          ?.setupStatus,
      ).toBe("cloning");
    });
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/projects/${parallelProject.id}`,
        payload: { deleteLocalFiles: false },
      }),
    ).toMatchObject({ statusCode: 204 });
    heldProjectCloneName = null;
    releaseProjectClone?.();
    releaseProjectClone = null;
    const project = await vi.waitFor(async () => {
      const current = projectListSchema
        .parse(
          (
            await firstApp.inject({ method: "GET", url: "/api/projects" })
          ).json(),
        )
        .find((candidate) => candidate.id === queuedProject.id);
      expect(current).toMatchObject({
        setupStatus: "ready",
        setupError: null,
        source: expect.objectContaining({ workerId: "test-worker" }),
      });
      return current!;
    });
    const remoteSurface = remoteSurfaceSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/remote-surfaces`,
          payload: {
            workerId: "test-worker",
            title: "Worker browser",
            configuration: {
              kind: "browser",
              initialUrl: "https://example.com/",
            },
          },
        })
      ).json(),
    );
    expect(remoteSurface).toMatchObject({
      workerId: "test-worker",
      kind: "browser",
      status: "idle",
      preferredTransport: "websocket",
      configuration: {
        kind: "browser",
        initialUrl: "https://example.com/",
        profileId: null,
      },
    });
    expect(
      remoteSurfaceListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/remote-surfaces`,
          })
        ).json(),
      ),
    ).toHaveLength(1);
    expect(
      remoteSurfaceSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/remote-surfaces/${remoteSurface.id}`,
            payload: { title: "Renamed worker browser" },
          })
        ).json(),
      ).title,
    ).toBe("Renamed worker browser");
    expect(
      remoteSurfaceSummarySchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/remote-surfaces/${remoteSurface.id}/suspend`,
          })
        ).json(),
      ).status,
    ).toBe("suspended");
    expect(
      remoteSurfaceSummarySchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/remote-surfaces/${remoteSurface.id}/resume`,
          })
        ).json(),
      ).status,
    ).toBe("active");
    await firstApp.ready();
    let resolveRejectedOrigin: ((code: number) => void) | null = null;
    const rejectedOriginPromise = new Promise<number>((resolve) => {
      resolveRejectedOrigin = resolve;
    });
    const rejectedSocket = await firstApp.injectWS(
      `/api/remote-surfaces/${remoteSurface.id}/connect`,
      { headers: { origin: "https://attacker.example" } },
      {
        onInit(socket) {
          socket.once("close", (code) => resolveRejectedOrigin?.(code));
        },
      },
    );
    expect(await rejectedOriginPromise).toBe(1008);
    rejectedSocket.terminate();
    let resolveReadyMessage: ((message: unknown) => void) | null = null;
    const readyMessagePromise = new Promise<unknown>((resolve) => {
      resolveReadyMessage = resolve;
    });
    const surfaceSocket = await firstApp.injectWS(
      `/api/remote-surfaces/${remoteSurface.id}/connect?width=800&height=600&devicePixelRatio=2`,
      { headers: { origin: "http://127.0.0.1:5173" } },
      {
        onInit(socket) {
          socket.once("message", (data) =>
            resolveReadyMessage?.(JSON.parse(data.toString())),
          );
        },
      },
    );
    const readyMessage = await readyMessagePromise;
    const connection = remoteSurfaceConnectionMessageSchema.parse(readyMessage);
    expect(connection).toMatchObject({
      type: "ready",
      surfaceId: remoteSurface.id,
      transport: "websocket",
    });
    if (connection.type !== "ready") throw new Error("Surface did not attach.");

    surfaceSocket.send(
      encodeRemoteSurfaceFrame(
        {
          protocolVersion: 1,
          surfaceId: remoteSurface.id,
          attachmentId: connection.attachmentId,
          sequence: 0,
          channel: "control",
        },
        new Uint8Array([1, 2, 3]),
      ),
    );
    await vi.waitFor(() =>
      expect(relayedSurfaceFrames.at(-1)).toEqual({
        workerId: "test-worker",
        sequence: 0,
        payload: [1, 2, 3],
      }),
    );

    const workerFrame = new Promise<Uint8Array>((resolve) => {
      surfaceSocket.once("message", (data) =>
        resolve(new Uint8Array(data as ArrayBuffer)),
      );
    });
    for (const listener of surfaceFrameListeners) {
      listener(
        {
          protocolVersion: 1,
          surfaceId: remoteSurface.id,
          attachmentId: connection.attachmentId,
          sequence: 0,
          channel: "frame",
        },
        new Uint8Array([9, 8, 7]),
      );
    }
    expect([...decodeRemoteSurfaceFrame(await workerFrame).payload]).toEqual([
      9, 8, 7,
    ]);
    surfaceSocket.terminate();
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/remote-surfaces/${remoteSurface.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      await firstDatabase.repository.listProjectWorktrees(
        LOCAL_USER_ID,
        project.id,
      ),
    ).toMatchObject([
      {
        name: "Primary",
        isPrimary: true,
        isDefault: true,
        lifecycleState: "ready",
        path: project.source!.path,
        workerId: "test-worker",
      },
    ]);
    expect(
      githubIssueListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/github/issues?state=open`,
          })
        ).json(),
      ),
    ).toMatchObject({ total: 1, issues: [{ number: 42, state: "open" }] });
    expect(
      githubIssueDetailSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/github/issues/42`,
          })
        ).json(),
      ),
    ).toMatchObject({ number: 42, body: "Issue details" });
    await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/github/issues/42/comments`,
      payload: { body: "Comment from Cantrip" },
    });
    expect(issueComments).toContain("Comment from Cantrip");
    expect(
      githubIssueDetailSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/projects/${project.id}/github/issues/42/close`,
            payload: { comment: "Closing from Cantrip" },
          })
        ).json(),
      ).state,
    ).toBe("closed");
    expect(closedIssues).toContainEqual({
      number: 42,
      comment: "Closing from Cantrip",
    });
    const history = gitHistorySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/git/history`,
        })
      ).json(),
    );
    expect(history).toMatchObject({
      branch: "main",
      commits: [{ subject: "feat: test history" }],
    });
    const gitStatus = gitStatusSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/git/status`,
        })
      ).json(),
    );
    expect(gitStatus).toMatchObject({
      branch: "main",
      ahead: 1,
      files: [{ path: "README.md", unstaged: true }],
    });
    const gitAction = gitActionResultSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/git/actions`,
          payload: { type: "stageAll" },
        })
      ).json(),
    );
    expect(gitAction).toMatchObject({
      output: "Git action complete",
      status: { files: [] },
    });
    const terminal = terminalSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/terminals`,
          payload: { title: "Dev shell" },
        })
      ).json(),
    );
    expect(terminal).toMatchObject({
      projectId: project.id,
      title: "Dev shell",
      activeWorkerId: "test-worker",
    });
    expect(
      terminalListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/terminals`,
          })
        ).json(),
      ),
    ).toHaveLength(1);
    expect(
      terminalSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/terminals/${terminal.id}`,
            payload: { title: "Renamed shell" },
          })
        ).json(),
      ).title,
    ).toBe("Renamed shell");
    expect(
      (
        await firstApp.inject({
          method: "DELETE",
          url: `/api/terminals/${terminal.id}`,
        })
      ).statusCode,
    ).toBe(204);

    const duplicateResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects/from-github",
      payload: {
        workerId: "test-worker",
        repositoryId: "github-repository-1",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
    });
    expect(duplicateResponse.statusCode).toBe(409);

    const chatResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/chats`,
      payload: { title: "Foundation" },
    });
    const chat = chatSummarySchema.parse(chatResponse.json());
    const selectedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}/model`,
          payload: { modelId: selectedModel.id },
        })
      ).json(),
    );
    expect(selectedChat).toMatchObject({
      modelId: selectedModel.id,
    });

    expect(
      chatPermissionProfileStateSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/permission-profiles`,
          })
        ).json(),
      ),
    ).toMatchObject({
      available: true,
      selectedId: ":workspace",
      effectiveId: ":workspace",
      forcedByWorktreePolicy: false,
    });
    const selectedPermissionProfile = chatPermissionProfileStateSchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}/permission-profile`,
          payload: { id: ":danger-full-access" },
        })
      ).json(),
    );
    expect(selectedPermissionProfile).toMatchObject({
      selectedId: ":danger-full-access",
      effectiveId: ":danger-full-access",
    });
    expect(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}/permission-profile`,
          payload: { id: ":blocked" },
        })
      ).statusCode,
    ).toBe(409);
    await firstApp.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/worktree-policy`,
      payload: { policy: "required-for-writes" },
    });
    expect(
      chatPermissionProfileStateSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/permission-profiles`,
          })
        ).json(),
      ),
    ).toMatchObject({
      selectedId: ":danger-full-access",
      effectiveId: ":read-only",
      forcedByWorktreePolicy: true,
    });
    await firstApp.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/worktree-policy`,
      payload: { policy: "agent-managed" },
    });

    const approvalInput: AgentInteractionRequestCreate = {
      requestKey: "runtime-1:approval-1",
      projectId: project.id,
      provenance: {
        chatId: chat.id,
        threadId: "thread-approval",
        turnId: "turn-approval",
        itemId: "item-approval",
        executionLaneId: null,
        workflowRunId: null,
        workflowNodeId: null,
        workerId: "test-worker",
      },
      payload: {
        kind: "commandExecution",
        startedAtMs: Date.now(),
        approvalId: null,
        environmentId: null,
        reason: "Install dependencies",
        command: "pnpm install",
        cwd: project.source!.path,
        networkApprovalContext: {
          host: "registry.npmjs.org",
          protocol: "https",
        },
        additionalPermissions: { network: { enabled: true } },
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        availableDecisions: ["accept", "decline", "cancel"],
      },
      expiresAt: "2030-08-08T18:00:00Z",
    };
    const approval =
      await firstDatabase.repository.recordAgentInteractionRequest(
        approvalInput,
      );
    expect(
      await firstDatabase.repository.recordAgentInteractionRequest(
        approvalInput,
      ),
    ).toEqual(approval);
    expect(
      (
        await firstDatabase.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        )
      )?.status,
    ).toBe("waiting-for-approval");
    expect(
      agentInteractionRequestListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/agent-requests?chatId=${chat.id}&status=pending`,
          })
        ).json(),
      ),
    ).toMatchObject([{ id: approval.id, status: "pending" }]);
    expect(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}/permission-profile`,
          payload: { id: ":workspace" },
        })
      ).statusCode,
    ).toBe(409);

    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/agent-requests/${approval.id}/respond`,
          payload: {
            idempotencyKey: "resolution-unavailable",
            response: {
              kind: "commandExecution",
              decision: "acceptForSession",
            },
          },
        })
      ).statusCode,
    ).toBe(409);

    const resolution = {
      idempotencyKey: "resolution-1",
      response: {
        kind: "commandExecution" as const,
        decision: "decline" as const,
      },
    };
    const resolvedApproval = agentInteractionRequestSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/agent-requests/${approval.id}/respond`,
          payload: resolution,
        })
      ).json(),
    );
    expect(resolvedApproval).toMatchObject({
      status: "resolved",
      response: { kind: "commandExecution", decision: "decline" },
      resolvedByUserId: LOCAL_USER_ID,
    });
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/agent-requests/${approval.id}/respond`,
          payload: resolution,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/agent-requests/${approval.id}/respond`,
          payload: { ...resolution, idempotencyKey: "resolution-2" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await firstDatabase.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        )
      )?.status,
    ).toBe("running");
    await firstDatabase.repository.setChatStatus(chat.id, "idle");

    const expiringRequest =
      await firstDatabase.repository.recordAgentInteractionRequest({
        requestKey: "runtime-1:approval-expired",
        projectId: project.id,
        provenance: {
          chatId: chat.id,
          threadId: "thread-approval",
          turnId: "turn-approval",
          itemId: "item-input",
          executionLaneId: null,
          workflowRunId: null,
          workflowNodeId: null,
          workerId: "test-worker",
        },
        payload: {
          kind: "userInput",
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Continue?",
              isOther: false,
              isSecret: false,
              options: [
                { label: "Yes", description: "Continue the operation." },
              ],
            },
          ],
          autoResolutionMs: 1,
        },
        expiresAt: "2020-01-01T00:00:00.000Z",
      });
    expect(
      agentInteractionRequestSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/agent-requests/${expiringRequest.id}`,
          })
        ).json(),
      ).status,
    ).toBe("expired");
    await firstDatabase.repository.setChatStatus(chat.id, "idle");

    const permissionRequest =
      await firstDatabase.repository.recordAgentInteractionRequest({
        requestKey: "runtime-1:approval-permissions",
        projectId: project.id,
        provenance: {
          chatId: chat.id,
          threadId: "thread-approval",
          turnId: "turn-approval",
          itemId: "item-permissions",
          executionLaneId: null,
          workflowRunId: null,
          workflowNodeId: null,
          workerId: "test-worker",
        },
        payload: {
          kind: "permissions",
          startedAtMs: Date.now(),
          environmentId: null,
          cwd: project.source!.path,
          reason: "Read test fixtures",
          requestedPermissions: {
            network: null,
            fileSystem: { read: ["/fixtures"], write: null },
          },
        },
        expiresAt: null,
      });
    await expect(
      firstDatabase.repository.validateAgentInteractionResolution(
        LOCAL_USER_ID,
        permissionRequest.id,
        {
          idempotencyKey: "resolution-overbroad",
          response: {
            kind: "permissions",
            permissions: {
              fileSystem: { read: ["/outside"] },
            },
            scope: "turn",
            strictAutoReview: false,
          },
        },
      ),
    ).rejects.toThrow(/subset of the requested permissions/u);
    await firstDatabase.repository.interruptAgentInteractionRequests(chat.id);
    await firstDatabase.repository.setChatStatus(chat.id, "idle");

    const secretRequest =
      await firstDatabase.repository.recordAgentInteractionRequest({
        requestKey: "runtime-1:approval-secret",
        projectId: project.id,
        provenance: {
          chatId: chat.id,
          threadId: "thread-approval",
          turnId: "turn-approval",
          itemId: "item-secret",
          executionLaneId: null,
          workflowRunId: null,
          workflowNodeId: null,
          workerId: "test-worker",
        },
        payload: {
          kind: "userInput",
          questions: [
            {
              id: "token",
              header: "Token",
              question: "Enter the temporary token",
              isOther: false,
              isSecret: true,
              options: null,
            },
          ],
          autoResolutionMs: null,
        },
        expiresAt: null,
      });
    expect(
      agentInteractionRequestSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/agent-requests/${secretRequest.id}/respond`,
            payload: {
              idempotencyKey: "resolution-secret",
              response: {
                kind: "userInput",
                answers: { token: { answers: ["do-not-persist"] } },
              },
            },
          })
        ).json(),
      ).response,
    ).toEqual({
      kind: "userInput",
      answers: { token: { answers: ["[redacted]"] } },
    });
    await firstDatabase.repository.setChatStatus(chat.id, "idle");

    const interruptedRequest =
      await firstDatabase.repository.recordAgentInteractionRequest({
        requestKey: "runtime-1:approval-interrupted",
        projectId: project.id,
        provenance: {
          chatId: chat.id,
          threadId: "thread-approval",
          turnId: "turn-approval",
          itemId: "item-file",
          executionLaneId: null,
          workflowRunId: null,
          workflowNodeId: null,
          workerId: "test-worker",
        },
        payload: {
          kind: "fileChange",
          startedAtMs: Date.now(),
          reason: "Write generated files",
          grantRoot: project.source!.path,
        },
        expiresAt: null,
      });
    await firstDatabase.repository.resetInterruptedChatExecutions();
    expect(
      (
        await firstDatabase.repository.getAgentInteractionRequest(
          LOCAL_USER_ID,
          interruptedRequest.id,
        )
      )?.status,
    ).toBe("interrupted");
    expect(
      (
        await firstDatabase.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        )
      )?.status,
    ).toBe("failed");
    await firstDatabase.repository.setChatStatus(chat.id, "idle");

    expect(
      skillListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/skills`,
          })
        ).json(),
      ),
    ).toEqual([
      {
        name: "skill-creator",
        displayName: "Skill Creator",
        description: "Create reusable skills",
      },
    ]);

    const messagePayload = {
      text: "$skill-creator Persist this message.",
      idempotencyKey: "first-message",
    };
    const firstMessage = chatMessageSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/turns`,
          payload: messagePayload,
        })
      ).json().message,
    );
    const repeatedMessage = chatMessageSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/turns`,
          payload: messagePayload,
        })
      ).json().message,
    );
    expect(repeatedMessage.id).toBe(firstMessage.id);
    await vi.waitFor(async () => {
      const messages = chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/messages`,
          })
        ).json(),
      );
      expect(messages).toHaveLength(4);
    });
    expect(turnRequests).toBe(1);
    expect(turnSkillNames[0]).toEqual(["skill-creator"]);
    expect(turnTimeouts).toEqual([null]);
    expect(turnModelIds).toContain(selectedModel.id);
    expect(turnPermissionProfileIds[0]).toBe(":danger-full-access");
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/compact`,
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(compactRequests).toBe(1);
    const firstSync = agentThreadSyncSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/sync`,
        })
      ).json(),
    );
    expect(firstSync.turns).toHaveLength(1);
    await firstApp.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/sync`,
    });
    const completedMessages = chatMessageListSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/messages`,
        })
      ).json(),
    );
    expect(completedMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "8", phase: "final_answer" }],
    });
    expect(
      completedMessages.some((message) =>
        message.content.some(
          (content) =>
            content.type === "text" && content.phase === "commentary",
        ),
      ),
    ).toBe(true);
    expect(
      completedMessages
        .flatMap((message) => message.content)
        .flatMap((content) =>
          content.type === "activity" ? [content.activity.type] : [],
        ),
    ).toEqual(
      expect.arrayContaining(["reasoning", "contextCompaction", "turnSummary"]),
    );
    const renamedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}`,
          payload: { title: "Renamed foundation" },
        })
      ).json(),
    );
    expect(renamedChat.title).toBe("Renamed foundation");
    const forkedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/fork`,
          payload: {
            messageId: completedMessages.at(-1)?.id,
          },
        })
      ).json(),
    );
    const duplicatedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/fork`,
          payload: {},
        })
      ).json(),
    );
    expect(
      chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${forkedChat.id}/messages`,
          })
        ).json(),
      ),
    ).toHaveLength(completedMessages.length);
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/chats/${forkedChat.id}/turns`,
        payload: {
          text: "Continue from the fork.",
          idempotencyKey: "fork-follow-up",
        },
      }),
    ).toMatchObject({ statusCode: 202 });
    await vi.waitFor(() => expect(turnPrompts).toHaveLength(2));
    expect(turnPrompts[1]).toContain(
      "Continue this existing Cantrip conversation",
    );
    expect(turnPrompts[1]).toContain("The local agent replied.");
    await vi.waitFor(async () => {
      const forkMessages = chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${forkedChat.id}/messages`,
          })
        ).json(),
      );
      expect(forkMessages).toHaveLength(completedMessages.length + 4);
    });
    const richChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Rich events" },
        })
      ).json(),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${richChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    await firstApp.inject({
      method: "POST",
      url: `/api/chats/${richChat.id}/turns`,
      payload: { text: "Render rich events", idempotencyKey: "rich-events" },
    });
    let richMessages = chatMessageListSchema.parse([]);
    await vi.waitFor(async () => {
      richMessages = chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${richChat.id}/messages`,
          })
        ).json(),
      );
      expect(richMessages).toHaveLength(7);
    });
    expect(richMessages.map((message) => message.content[0])).toMatchObject([
      { type: "text", text: "Render rich events" },
      { type: "text", phase: "commentary" },
      { type: "activity", activity: { type: "reasoning" } },
      { type: "activity", activity: { type: "mcpToolCall" } },
      { type: "activity", activity: { type: "usage" } },
      { type: "text", phase: "final_answer" },
      { type: "activity", activity: { type: "turnSummary" } },
    ]);
    expect(
      richMessages.filter((message) =>
        message.content.some(
          (content) =>
            content.type === "text" && content.phase === "final_answer",
        ),
      ),
    ).toHaveLength(1);
    const reorderedTerminal = terminalSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/terminals`,
          payload: { title: "Sortable shell" },
        })
      ).json(),
    );
    const explorer = explorerSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/explorers`,
          payload: { title: "Project files" },
        })
      ).json(),
    );
    expect(
      explorerListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/explorers`,
          })
        ).json(),
      ),
    ).toHaveLength(1);
    expect(
      explorerDirectorySchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/explorers/${explorer.id}/directory?path=`,
          })
        ).json(),
      ).entries[0],
    ).toMatchObject({ name: "README.md", markdown: true });
    expect(
      explorerFileSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/explorers/${explorer.id}/file?path=README.md`,
          })
        ).json(),
      ).content,
    ).toContain("Cantrip explorer");
    expect(
      explorerSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/explorers/${explorer.id}`,
            payload: { title: "Source browser" },
          })
        ).json(),
      ).title,
    ).toBe("Source browser");
    const browser = browserSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/browsers`,
          payload: { title: "Project web" },
        })
      ).json(),
    );
    expect(
      remoteSurfaceListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/remote-surfaces`,
          })
        ).json(),
      ),
    ).toContainEqual(
      expect.objectContaining({
        id: browser.id,
        kind: "browser",
        workerId: "test-worker",
      }),
    );
    expect(
      browserSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/browsers/${browser.id}`,
            payload: { title: "Docs", url: "https://example.com/docs" },
          })
        ).json(),
      ),
    ).toMatchObject({ title: "Docs", url: "https://example.com/docs" });
    expect(
      remoteSurfaceListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/remote-surfaces`,
            })
          ).json(),
        )
        .find(({ id }) => id === browser.id)?.configuration,
    ).toMatchObject({
      kind: "browser",
      initialUrl: "https://example.com/docs",
    });
    const projectView = projectViewSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/views`,
          payload: { kind: "history", title: "History" },
        })
      ).json(),
    );
    expect(
      projectViewSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/project-views/${projectView.id}`,
            payload: { title: "Repository history" },
          })
        ).json(),
      ),
    ).toMatchObject({ kind: "history", title: "Repository history" });
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}/tabs/order`,
        payload: {
          ids: [
            `chat:${duplicatedChat.id}`,
            `terminal:${reorderedTerminal.id}`,
            `browser:${browser.id}`,
            `view:${projectView.id}`,
            `explorer:${explorer.id}`,
            `chat:${forkedChat.id}`,
            `chat:${chat.id}`,
            `chat:${richChat.id}`,
          ],
        },
      }),
    ).toMatchObject({ statusCode: 204 });
    const reorderedChats = chatListSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/chats`,
        })
      ).json(),
    );
    expect(
      reorderedChats.map(({ id, position }) => ({ id, position })),
    ).toEqual([
      { id: duplicatedChat.id, position: 0 },
      { id: forkedChat.id, position: 5 },
      { id: chat.id, position: 6 },
      { id: richChat.id, position: 7 },
    ]);
    expect(
      terminalListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/terminals`,
          })
        ).json(),
      ),
    ).toMatchObject([{ id: reorderedTerminal.id, position: 1 }]);
    expect(
      explorerListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/explorers`,
          })
        ).json(),
      ),
    ).toMatchObject([{ id: explorer.id, position: 4 }]);
    expect(
      browserListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/browsers`,
          })
        ).json(),
      ),
    ).toMatchObject([{ id: browser.id, position: 2 }]);
    expect(
      projectViewListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/views`,
          })
        ).json(),
      ),
    ).toMatchObject([{ id: projectView.id, position: 3 }]);
    const remoteDesktop = remoteDesktopSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/remote-desktops`,
          payload: {},
        })
      ).json(),
    );
    expect(remoteDesktop).toMatchObject({
      projectId: project.id,
      workerId: "test-worker",
      status: "idle",
    });
    expect(JSON.stringify(remoteDesktop)).not.toContain("password");
    expect(
      remoteDesktopListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/remote-desktops`,
          })
        ).json(),
      ),
    ).toContainEqual(expect.objectContaining({ id: remoteDesktop.id }));
    expect(
      projectViewListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/views`,
            })
          ).json(),
        )
        .find(({ id }) => id === remoteDesktop.id),
    ).toMatchObject({ kind: "remote-desktop", title: "Remote Desktop" });
    let resolveDesktopReady: ((message: unknown) => void) | null = null;
    const desktopReadyPromise = new Promise<unknown>((resolve) => {
      resolveDesktopReady = resolve;
    });
    const desktopSocket = await firstApp.injectWS(
      `/api/remote-surfaces/${remoteDesktop.id}/connect`,
      { headers: { origin: "http://127.0.0.1:5173" } },
      {
        onInit(socket) {
          socket.once("message", (data) =>
            resolveDesktopReady?.(JSON.parse(data.toString())),
          );
        },
      },
    );
    expect(
      remoteSurfaceConnectionMessageSchema.parse(await desktopReadyPromise),
    ).toMatchObject({ type: "ready", surfaceId: remoteDesktop.id });
    expect(surfaceAttachCommands.at(-1)?.desktopStream).toEqual({
      targetFps: 60,
      quality: "balanced",
    });
    desktopSocket.terminate();
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/project-views/${remoteDesktop.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    const linkedConsole = terminalSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/console`,
        })
      ).json(),
    );
    expect(linkedConsole).toMatchObject({
      linkedChatId: chat.id,
      projectId: project.id,
      title: "Codex console",
    });
    expect(
      terminalSummarySchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/console`,
          })
        ).json(),
      ).id,
    ).toBe(linkedConsole.id);
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/terminals/${linkedConsole.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/chats/${duplicatedChat.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: "/api/projects/order",
        payload: { ids: [project.id] },
      }),
    ).toMatchObject({ statusCode: 204 });
    const changedModelResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/model`,
      payload: { modelId: initialSettings.preferences.defaultModelId },
    });
    expect(changedModelResponse.statusCode).toBe(200);
    expect(chatSummarySchema.parse(changedModelResponse.json()).modelId).toBe(
      initialSettings.preferences.defaultModelId,
    );
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/turns`,
        payload: {
          text: "Use the newly selected model.",
          idempotencyKey: "dynamic-model-turn",
          modelId: initialSettings.preferences.defaultModelId,
        },
      }),
    ).toMatchObject({ statusCode: 202 });
    await vi.waitFor(() => expect(turnModelIds).toHaveLength(3));
    expect(turnModelIds.at(-1)).toBe(
      initialSettings.preferences.defaultModelId,
    );

    const queueChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Prompt queue" },
        })
      ).json(),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${queueChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    await firstApp.inject({
      method: "POST",
      url: `/api/chats/${queueChat.id}/turns`,
      payload: { text: "Hold queue open.", idempotencyKey: "queue-running" },
    });
    await vi.waitFor(() => expect(releaseHeldTurn).not.toBeNull());

    const firstQueued = queuedPromptSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/turns`,
          payload: { text: "First follow-up", idempotencyKey: "queued-first" },
        })
      ).json().prompt,
    );
    const secondQueued = queuedPromptSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/turns`,
          payload: {
            text: "Second follow-up",
            idempotencyKey: "queued-second",
          },
        })
      ).json().prompt,
    );
    expect(
      queuedPromptListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/chats/${queueChat.id}/queue`,
            })
          ).json(),
        )
        .map(({ id }) => id),
    ).toEqual([firstQueued.id, secondQueued.id]);
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/chats/${queueChat.id}/queue/order`,
        payload: { ids: [secondQueued.id, firstQueued.id] },
      }),
    ).toMatchObject({ statusCode: 204 });
    const editedQueued = queuedPromptSchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/queued-prompts/${secondQueued.id}`,
          payload: { text: "Edited second follow-up", frozen: true },
        })
      ).json(),
    );
    expect(editedQueued).toMatchObject({
      id: secondQueued.id,
      position: 0,
      frozen: true,
      text: "Edited second follow-up",
    });
    await firstApp.inject({
      method: "PATCH",
      url: `/api/queued-prompts/${firstQueued.id}`,
      payload: { frozen: true },
    });
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/queued-prompts/${firstQueued.id}/steer`,
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(steeredPrompts).toContain("First follow-up");

    expect(
      chatPauseStateSchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/chats/${queueChat.id}/pause`,
            payload: { paused: true },
          })
        ).json(),
      ),
    ).toEqual({ paused: true });
    expect(pauseCommands.at(-1)).toEqual({
      chatId: queueChat.id,
      paused: true,
    });

    const turnsBeforeRelease = turnRequests;
    releaseHeldTurn?.();
    releaseHeldTurn = null;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(turnRequests).toBe(turnsBeforeRelease);
    await firstApp.inject({
      method: "PATCH",
      url: `/api/queued-prompts/${secondQueued.id}`,
      payload: { frozen: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(turnRequests).toBe(turnsBeforeRelease);
    expect(
      chatListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/chats`,
            })
          ).json(),
        )
        .find(({ id }) => id === queueChat.id),
    ).toMatchObject({ automationPaused: true, status: "idle" });
    expect(
      chatPauseStateSchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/chats/${queueChat.id}/pause`,
            payload: { paused: false },
          })
        ).json(),
      ),
    ).toEqual({ paused: false });
    await vi.waitFor(() =>
      expect(turnPrompts).toContain("Edited second follow-up"),
    );
    await vi.waitFor(async () => {
      const remaining = queuedPromptListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${queueChat.id}/queue`,
          })
        ).json(),
      );
      expect(remaining).toHaveLength(0);
    });

    const routedModel = modelProfileSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/models",
          payload: {
            name: "Priority model",
            reasoningEffort: "high",
            routes: [
              {
                providerId: chatGptProvider.id,
                modelName: "gpt-primary",
                enabled: true,
              },
              {
                providerId: provider.id,
                modelName: "gpt-fallback",
                reasoningEffort: "medium",
                enabled: true,
              },
            ],
          },
        })
      ).json(),
    );
    expect(routedModel.routes).toMatchObject([
      { providerId: chatGptProvider.id, position: 0 },
      { providerId: provider.id, position: 1 },
    ]);
    exhaustedProviderIds.add(chatGptProvider.id);
    const routedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Provider failover" },
        })
      ).json(),
    );
    const routedTurn = await firstApp.inject({
      method: "POST",
      url: `/api/chats/${routedChat.id}/turns`,
      payload: {
        text: "Use the first available provider.",
        idempotencyKey: "priority-route-turn",
        modelId: routedModel.id,
      },
    });
    expect(routedTurn.statusCode).toBe(202);
    expect(chatMessageSchema.parse(routedTurn.json().message)).toMatchObject({
      modelId: routedModel.id,
      modelRouteId: routedModel.routes[1]?.id,
      providerId: provider.id,
      providerModelName: "gpt-fallback",
    });
    await vi.waitFor(() => expect(turnProviderIds.at(-1)).toBe(provider.id));
    expect(turnRouteIds.at(-1)).toBe(routedModel.routes[1]?.id);

    const planChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Deployment plan" },
        })
      ).json(),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${planChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    expect(
      chatPlanStateSchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/chats/${planChat.id}/plan`,
            payload: { mode: "plan" },
          })
        ).json(),
      ).mode,
    ).toBe("plan");
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${planChat.id}/turns`,
          payload: {
            text: "Draft a deployment plan",
            idempotencyKey: "plan-turn",
            modelId: selectedModel.id,
          },
        })
      ).statusCode,
    ).toBe(202);
    const pendingPlan = await vi.waitFor(async () => {
      const state = chatPlanStateSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${planChat.id}/plan`,
          })
        ).json(),
      );
      expect(state.question?.id).toBe("plan-question-1");
      return state;
    });
    expect(pendingPlan.steps).toMatchObject([
      { status: "completed" },
      { status: "inProgress" },
    ]);
    expect(
      chatPlanStateSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${planChat.id}/plan`,
          })
        ).json(),
      ).question?.id,
    ).toBe("plan-question-1");
    expect(
      chatListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/chats`,
            })
          ).json(),
        )
        .find(({ id }) => id === planChat.id)?.hasPendingPlanQuestion,
    ).toBe(true);
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${planChat.id}/plan/answer`,
          payload: { answers: { topology: ["Four nodes"] } },
        })
      ).json(),
    ).toEqual({ accepted: true });
    expect(
      await firstDatabase.repository.getAgentInteractionRequestByKey(
        LOCAL_USER_ID,
        "plan-question-1",
      ),
    ).toMatchObject({
      status: "resolved",
      response: {
        kind: "userInput",
        answers: { topology: { answers: ["Four nodes"] } },
      },
    });
    await vi.waitFor(async () => {
      const current = chatListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/chats`,
            })
          ).json(),
        )
        .find(({ id }) => id === planChat.id);
      expect(current).toMatchObject({
        status: "idle",
        planMode: "plan",
        hasPendingPlanQuestion: false,
      });
    });

    const goalChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Long-running goal" },
        })
      ).json(),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${goalChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    expect(
      chatGoalResponseSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${goalChat.id}/goal`,
          })
        ).json(),
      ).goal,
    ).toBeNull();
    const createdGoal = chatGoalResponseSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${goalChat.id}/goal`,
          payload: {
            objective: "Finish the long-running goal",
            tokenBudget: 50_000,
          },
        })
      ).json(),
    ).goal;
    expect(createdGoal).toMatchObject({
      objective: "Finish the long-running goal",
      status: "active",
      tokenBudget: 50_000,
    });
    await vi.waitFor(() =>
      expect(turnPrompts).toContain("Finish the long-running goal"),
    );
    await vi.waitFor(async () => {
      const goalMessages = chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${goalChat.id}/messages`,
          })
        ).json(),
      );
      expect(goalMessages).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Finished the first goal milestone.",
              phase: "final_answer",
            },
          ],
        }),
      );
    });
    await vi.waitFor(async () => {
      const current = chatListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/projects/${project.id}/chats`,
            })
          ).json(),
        )
        .find(({ id }) => id === goalChat.id);
      expect(current?.status).toBe("idle");
    });
    expect(
      chatGoalResponseSchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/chats/${goalChat.id}/goal`,
            payload: { status: "paused" },
          })
        ).json(),
      ).goal?.status,
    ).toBe("paused");
    const turnsBeforeGoalResume = turnRequests;
    expect(
      chatGoalResponseSchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/chats/${goalChat.id}/goal`,
            payload: { status: "active" },
          })
        ).json(),
      ).goal?.status,
    ).toBe("active");
    await vi.waitFor(() =>
      expect(turnRequests).toBe(turnsBeforeGoalResume + 1),
    );
    expect(turnPrompts.at(-1)).toContain("Continue working toward");
    expect(
      (
        await firstApp.inject({
          method: "DELETE",
          url: `/api/chats/${goalChat.id}/goal`,
        })
      ).json(),
    ).toEqual({ cleared: true });
    expect(
      chatGoalResponseSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${goalChat.id}/goal`,
          })
        ).json(),
      ).goal,
    ).toBeNull();

    deliveredAgentInteractionResponses.length = 0;
    const bridgedApprovalChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Bridged approval" },
        })
      ).json(),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${bridgedApprovalChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${bridgedApprovalChat.id}/turns`,
          payload: {
            text: "Request a command approval",
            idempotencyKey: "bridged-approval-turn",
            modelId: selectedModel.id,
          },
        })
      ).statusCode,
    ).toBe(202);
    const bridgedApproval = await vi.waitFor(async () => {
      const pending = agentInteractionRequestListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/agent-requests?chatId=${bridgedApprovalChat.id}&status=pending`,
          })
        ).json(),
      );
      expect(pending).toHaveLength(1);
      return pending[0]!;
    });
    expect(
      (
        await firstDatabase.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          bridgedApprovalChat.id,
        )
      )?.status,
    ).toBe("waiting-for-approval");
    expect(deliveredAgentInteractionResponses).toEqual([]);
    expect(
      agentInteractionRequestSchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/agent-requests/${bridgedApproval.id}/respond`,
            payload: {
              idempotencyKey: "bridged-resolution-1",
              response: {
                kind: "commandExecution",
                decision: "decline",
              },
            },
          })
        ).json(),
      ).status,
    ).toBe("resolved");
    expect(deliveredAgentInteractionResponses).toEqual([
      {
        kind: "commandExecution",
        decision: "decline",
        execpolicyAmendment: null,
        networkPolicyAmendment: null,
      },
    ]);
    await vi.waitFor(async () => {
      expect(
        (
          await firstDatabase.repository.getChatExecutionContext(
            LOCAL_USER_ID,
            bridgedApprovalChat.id,
          )
        )?.status,
      ).toBe("idle");
    });

    await firstApp.close();

    const secondDatabase = await connectDatabase(config);
    const secondApp = await buildApp({
      config,
      database: secondDatabase,
      logger: false,
      workerBridge,
    });

    const projects = projectListSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/projects" })).json(),
    );
    const workers = workerListSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/workers" })).json(),
    );
    const restoredSettings = settingsBundleSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    const messages = chatMessageListSchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/messages`,
        })
      ).json(),
    );
    const restoredRichMessages = chatMessageListSchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/chats/${richChat.id}/messages`,
        })
      ).json(),
    );

    expect(projects).toHaveLength(1);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.codexRuntime).toEqual(unprobedCodexRuntimeReport);
    expect(messages.slice(0, 4)).toMatchObject([
      firstMessage,
      {
        role: "assistant",
        content: [
          {
            type: "activity",
            activity: {
              type: "command",
              status: "completed",
              command: "pwd",
              output: "/worktree\n",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "activity",
            activity: {
              type: "fileChange",
              status: "completed",
              changes: [{ path: "README.md", kind: "update" }],
            },
          },
        ],
      },
      { role: "assistant", content: [{ text: "The local agent replied." }] },
    ]);
    expect(restoredRichMessages).toHaveLength(7);
    expect(restoredRichMessages[2]?.content[0]).toMatchObject({
      type: "activity",
      activity: {
        type: "reasoning",
        correlation: {
          sourceMethod: "item/completed",
          diagnosticId: "runtime-session:reasoning-1",
        },
      },
    });
    expect(restoredSettings.preferences).toEqual({
      theme: "dark",
      highContrast: true,
      desktopFrameRate: 60,
      desktopStreamQuality: "balanced",
      defaultModelId: selectedModel.id,
    });
    expect(
      explorerListSchema.parse(
        (
          await secondApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/explorers`,
          })
        ).json(),
      ),
    ).toMatchObject([{ id: explorer.id, title: "Source browser" }]);
    expect(
      browserListSchema.parse(
        (
          await secondApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/browsers`,
          })
        ).json(),
      ),
    ).toMatchObject([
      { id: browser.id, title: "Docs", url: "https://example.com/docs" },
    ]);
    expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/browsers/${browser.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/explorers/${explorer.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });

    const unlinkResponse = await secondApp.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      payload: { deleteLocalFiles: false },
    });
    expect(unlinkResponse.statusCode).toBe(204);
    expect(deletedProjectPaths).toEqual([]);
    expect(
      projectListSchema.parse(
        (
          await secondApp.inject({ method: "GET", url: "/api/projects" })
        ).json(),
      ),
    ).toEqual([]);

    const queuedRelinked = projectSummarySchema.parse(
      (
        await secondApp.inject({
          method: "POST",
          url: "/api/projects/from-github",
          payload: {
            workerId: "test-worker",
            repositoryId: "github-repository-1",
            nameWithOwner: "ArcaneArts/Cantrip",
            url: "https://github.com/ArcaneArts/Cantrip",
          },
        })
      ).json(),
    );
    const relinked = await vi.waitFor(async () => {
      const current = projectListSchema
        .parse(
          (
            await secondApp.inject({ method: "GET", url: "/api/projects" })
          ).json(),
        )
        .find((candidate) => candidate.id === queuedRelinked.id);
      expect(current?.setupStatus).toBe("ready");
      return current!;
    });
    expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/projects/${relinked.id}`,
        payload: { deleteLocalFiles: true },
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(deletedProjectPaths).toEqual([
      path.join(dataDirectory, "repositories", "Cantrip"),
    ]);

    await secondApp.close();
  });
});
