import { describe, expect, it } from "vitest";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";

import {
  CANTRIP_WORKTREE_DYNAMIC_TOOLS,
  agentInteractionRequestFromServerRequest,
  changedFiles,
  codexResultForAgentInteraction,
  CodexAppServer,
  codexEndpointFromLine,
  codexModelProviderName,
  codexThreadPermissionParams,
  codexWorktreeTurnPolicy,
  codexWorkspaceContext,
  executeDynamicWorktreeTool,
  failClosedAgentInteractionReply,
  GOAL_CONTINUATION_PROMPT,
  goalShouldContinue,
  isKnownCodexNotificationMethod,
  parseCodexRpcMessage,
  parseCodexSkills,
  planQuestionId,
} from "../src/codex/app-server.js";

describe("Codex agent interaction bridge", () => {
  it("normalizes all supported App Server request families", () => {
    const now = Date.parse("2026-08-08T18:00:00.000Z");
    const command = agentInteractionRequestFromServerRequest(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-command",
        startedAtMs: now,
        approvalId: null,
        environmentId: null,
        reason: "Needs registry access",
        command: "pnpm install",
        cwd: "/workspace",
        commandActions: [{ type: "unknown", command: "pnpm install" }],
        networkApprovalContext: {
          host: "registry.npmjs.org",
          protocol: "https",
        },
        additionalPermissions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        availableDecisions: ["accept", "decline", "cancel"],
      },
      "request-command",
      now,
    );
    expect(command).toMatchObject({
      requestKey: "request-command",
      expiresAt: "2026-08-08T18:30:00.000Z",
      payload: {
        kind: "commandExecution",
        command: "pnpm install",
        availableDecisions: ["accept", "decline", "cancel"],
      },
    });

    expect(
      agentInteractionRequestFromServerRequest(
        "item/fileChange/requestApproval",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-file",
          startedAtMs: now,
          reason: "Write a report",
          grantRoot: "/workspace",
        },
        "request-file",
        now,
      )?.payload.kind,
    ).toBe("fileChange");
    expect(
      agentInteractionRequestFromServerRequest(
        "item/permissions/requestApproval",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-permissions",
          startedAtMs: now,
          environmentId: null,
          cwd: "/workspace",
          reason: "Read fixtures",
          permissions: {
            network: null,
            fileSystem: { read: ["/fixtures"], write: null },
          },
        },
        "request-permissions",
        now,
      )?.payload.kind,
    ).toBe("permissions");
    expect(
      agentInteractionRequestFromServerRequest(
        "item/tool/requestUserInput",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-question",
          questions: [
            {
              id: "target",
              header: "Target",
              question: "Which target?",
              isOther: true,
              isSecret: false,
              options: null,
            },
          ],
          autoResolutionMs: 5_000,
        },
        "request-input",
        now,
      ),
    ).toMatchObject({
      expiresAt: "2026-08-08T18:00:05.000Z",
      payload: { kind: "userInput", autoResolutionMs: 5_000 },
    });
    expect(
      agentInteractionRequestFromServerRequest(
        "mcpServer/elicitation/request",
        {
          threadId: "thread-1",
          turnId: null,
          serverName: "deployments",
          mode: "url",
          message: "Authorize deployments",
          url: "https://example.com/oauth",
          elicitationId: "elicitation-1",
          _meta: { source: "test" },
        },
        "request-mcp",
        now,
      ),
    ).toMatchObject({
      turnId: null,
      itemId: null,
      payload: { kind: "mcpElicitation", mode: "url" },
    });
  });

  it("maps responses exactly and fails closed by request family", () => {
    expect(
      codexResultForAgentInteraction({
        kind: "commandExecution",
        decision: "acceptWithExecpolicyAmendment",
        execpolicyAmendment: ["pnpm", "test"],
        networkPolicyAmendment: null,
      }),
    ).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["pnpm", "test"],
        },
      },
    });
    expect(
      codexResultForAgentInteraction({
        kind: "mcpElicitation",
        action: "accept",
        content: { environment: "staging" },
        metadata: { source: "cantrip" },
      }),
    ).toEqual({
      action: "accept",
      content: { environment: "staging" },
      _meta: { source: "cantrip" },
    });
    expect(() =>
      codexResultForAgentInteraction({
        kind: "commandExecution",
        decision: "acceptWithExecpolicyAmendment",
        execpolicyAmendment: null,
        networkPolicyAmendment: null,
      }),
    ).toThrow(/Missing execpolicy amendment/u);
    expect(
      failClosedAgentInteractionReply("commandExecution", "expired"),
    ).toEqual({ result: { decision: "cancel" } });
    expect(failClosedAgentInteractionReply("permissions", "expired")).toEqual({
      result: {
        permissions: {},
        scope: "turn",
        strictAutoReview: false,
      },
    });
    expect(failClosedAgentInteractionReply("userInput", "expired")).toEqual({
      error: { code: -32_000, message: "expired" },
    });
  });
});

describe("Cantrip dynamic worktree tools", () => {
  it("advertises all lifecycle operations with strict object schemas", () => {
    expect(CANTRIP_WORKTREE_DYNAMIC_TOOLS.map(({ name }) => name)).toEqual([
      "cantrip_worktrees_list",
      "cantrip_worktree_create",
      "cantrip_worktree_acquire",
      "cantrip_worktree_switch",
      "cantrip_worktree_status",
      "cantrip_worktree_release",
      "cantrip_worktree_remove",
    ]);
    expect(
      CANTRIP_WORKTREE_DYNAMIC_TOOLS.every(
        ({ inputSchema }) => inputSchema.additionalProperties === false,
      ),
    ).toBe(true);
  });

  it("returns structured dynamic-tool results and isolates handler errors", async () => {
    const params = {
      arguments: { worktreeId: "worktree-2" },
      callId: "call-1",
      threadId: "thread-1",
      tool: "cantrip_worktree_switch",
      turnId: "turn-1",
    };
    await expect(
      executeDynamicWorktreeTool(
        async (input) => ({
          summary: `Scheduled ${String(input.arguments.worktreeId)}`,
          worktreeId: "worktree-2",
          continuationScheduled: true,
        }),
        params,
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: expect.stringContaining("worktree-2"),
        },
      ],
    });
    await expect(
      executeDynamicWorktreeTool(async () => {
        throw new Error("unsafe transition");
      }, params),
    ).resolves.toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "unsafe transition" }],
    });
  });
});

describe("codexWorkspaceContext", () => {
  it("binds every app-server operation to one resolved worktree root", () => {
    expect(codexWorkspaceContext("/tmp/project/../project/worktree")).toEqual({
      cwd: "/tmp/project/worktree",
      runtimeWorkspaceRoots: ["/tmp/project/worktree"],
    });
  });
});

describe("codexWorktreeTurnPolicy", () => {
  it("enforces inspection-only Primary for required-for-writes projects", () => {
    expect(
      codexWorktreeTurnPolicy({
        cwd: "/workspace/project",
        isPrimary: true,
        worktreeMode: "agent-managed",
        worktreePolicy: "required-for-writes",
      }),
    ).toEqual({
      additionalContext: {
        "cantrip.worktree-policy": {
          kind: "application",
          value: expect.stringContaining("Primary is inspection-only"),
        },
      },
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  it("grants checkout-scoped writes outside Primary and explains pinned mode", () => {
    const policy = codexWorktreeTurnPolicy({
      cwd: "/workspace/project/../project/feature",
      isPrimary: false,
      worktreeMode: "pinned",
      worktreePolicy: "required-for-writes",
    });
    expect(policy.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/workspace/project/feature"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(policy.additionalContext["cantrip.worktree-policy"].value).toContain(
      "pinned to the current worktree",
    );
  });

  it("omits the legacy sandbox payload when a permission profile is active", () => {
    expect(
      codexWorktreeTurnPolicy({
        cwd: "/workspace/project",
        isPrimary: true,
        worktreeMode: "agent-managed",
        worktreePolicy: "required-for-writes",
        permissionProfileActive: true,
      }),
    ).toEqual({
      additionalContext: {
        "cantrip.worktree-policy": {
          kind: "application",
          value: expect.stringContaining("Primary is inspection-only"),
        },
      },
    });
  });
});

describe("Codex permission profile params", () => {
  it("never composes beta permission profiles with the legacy sandbox", () => {
    expect(codexThreadPermissionParams(":read-only", true)).toEqual({
      permissions: ":read-only",
    });
    expect(codexThreadPermissionParams(":read-only", false)).toEqual({
      sandbox: "workspace-write",
    });
  });
});

describe("changedFiles", () => {
  it("summarizes added, updated, and deleted files from a turn diff", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
    ].join("\n");

    expect(changedFiles(diff)).toEqual([
      { path: "README.md", kind: "update" },
      { path: "src/new.ts", kind: "add" },
      { path: "old.ts", kind: "delete" },
    ]);
  });
});

describe("codexModelProviderName", () => {
  it("uses Codex's built-in OpenAI provider for ChatGPT accounts", () => {
    expect(
      codexModelProviderName({
        id: "personal-chatgpt",
        name: "Personal ChatGPT",
        kind: "chatgpt",
        baseUrl: "https://api.openai.com/v1",
        apiKey: null,
      }),
    ).toBe("openai");
  });
});

describe("codexEndpointFromLine", () => {
  it("recognizes both plain and colored Codex endpoint announcements", () => {
    expect(codexEndpointFromLine("  listening on: ws://127.0.0.1:54321")).toBe(
      "ws://127.0.0.1:54321",
    );
    expect(
      codexEndpointFromLine(
        "  \u001b[2mlistening on:\u001b[0m \u001b[32mws://127.0.0.1:54321\u001b[0m",
      ),
    ).toBe("ws://127.0.0.1:54321");
  });
});

describe("parseCodexRpcMessage", () => {
  it("preserves raw method payloads while rejecting malformed envelopes", () => {
    expect(
      parseCodexRpcMessage(
        JSON.stringify({
          method: "future/event",
          params: { nested: { value: 42 } },
        }),
      ),
    ).toEqual({
      method: "future/event",
      params: { nested: { value: 42 } },
    });
    expect(parseCodexRpcMessage("not json")).toBeNull();
    expect(parseCodexRpcMessage(JSON.stringify({ method: 42 }))).toBeNull();
    expect(
      parseCodexRpcMessage(
        JSON.stringify({ id: 1, error: { code: "bad", message: "failed" } }),
      ),
    ).toBeNull();
  });

  it("distinguishes generated notifications from future schema drift", () => {
    expect(isKnownCodexNotificationMethod("turn/plan/updated")).toBe(true);
    expect(isKnownCodexNotificationMethod("future/event")).toBe(false);
  });
});

describe("parseCodexSkills", () => {
  it("returns enabled skills for the requested working directory", () => {
    expect(
      parseCodexSkills(
        {
          data: [
            {
              cwd: "/workspace",
              skills: [
                {
                  name: "skill-creator",
                  description: "Create reusable skills",
                  path: "/skills/skill-creator/SKILL.md",
                  enabled: true,
                  interface: { displayName: "Skill Creator" },
                },
                {
                  name: "disabled",
                  description: "Disabled",
                  path: "/skills/disabled/SKILL.md",
                  enabled: false,
                },
              ],
            },
          ],
        },
        "/workspace",
      ),
    ).toEqual([
      {
        name: "skill-creator",
        description: "Create reusable skills",
        displayName: "Skill Creator",
        path: "/skills/skill-creator/SKILL.md",
      },
    ]);
  });
});

describe("Codex goals", () => {
  const goal = {
    threadId: "thread-1",
    objective: "Complete the task",
    status: "active" as const,
    tokenBudget: null,
    tokensUsed: 100,
    timeUsedSeconds: 30,
    createdAt: 1,
    updatedAt: 2,
  };

  it("continues only active goals with an explicit follow-up prompt", () => {
    expect(goalShouldContinue(goal)).toBe(true);
    expect(goalShouldContinue(goal, true)).toBe(false);
    expect(goalShouldContinue({ ...goal, status: "paused" })).toBe(false);
    expect(goalShouldContinue({ ...goal, status: "complete" })).toBe(false);
    expect(GOAL_CONTINUATION_PROMPT).toContain("active goal");
  });
});

describe("Codex runtime compatibility enforcement", () => {
  it("returns a clear error before starting an unavailable runtime", async () => {
    const runtime = new CodexAppServer(
      "/definitely/missing/codex",
      "/private/tmp/cantrip-runtime-test",
      "/private/tmp/cantrip-runtime-test/home",
      unprobedCodexRuntimeReport,
    );

    await expect(
      runtime.runTurn({
        chatId: "chat-1",
        clientMessageId: "message-1",
        cwd: "/private/tmp/cantrip-runtime-test",
        isPrimary: true,
        model: {
          id: "model-1",
          routeId: "route-1",
          name: "gpt-5.6-sol",
          reasoningEffort: null,
        },
        provider: {
          id: "provider-1",
          name: "ChatGPT",
          kind: "chatgpt",
          baseUrl: "https://api.openai.com/v1",
          apiKey: null,
        },
        planMode: "default",
        prompt: "Inspect the project",
        skillNames: [],
        threadId: null,
        worktreeMode: "agent-managed",
        worktreePolicy: "required-for-writes",
      }),
    ).rejects.toThrow(/Codex runtime is missing.*expected >=0\.146\.0/u);
  });
});

describe("Codex Plan Mode", () => {
  it("uses a stable request identity without encoding any timeout", () => {
    expect(
      planQuestionId(
        { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
        42,
      ),
    ).toBe("thread-1:turn-1:item-1:42");
  });
});
