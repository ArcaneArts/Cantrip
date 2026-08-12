import { describe, expect, it } from "vitest";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";

import {
  CANTRIP_DYNAMIC_TOOLS,
  CANTRIP_WORKTREE_DYNAMIC_TOOLS,
  agentInteractionRequestFromServerRequest,
  changedFiles,
  codexResultForAgentInteraction,
  CodexAppServer,
  codexEndpointFromLine,
  codexMcpConfigOverride,
  codexModelProviderName,
  codexThreadPermissionParams,
  codexWorkflowTurnPolicy,
  codexWorktreeTurnPolicy,
  codexWorkspaceContext,
  executeDynamicExecutionTool,
  failClosedAgentInteractionReply,
  GOAL_CONTINUATION_PROMPT,
  goalShouldContinue,
  isKnownCodexNotificationMethod,
  normalizeAgentMessage,
  normalizeCodexThreadItem,
  normalizeNoticeActivity,
  normalizeRateLimitActivity,
  normalizeTokenUsageActivity,
  parseCodexRpcMessage,
  parseCodexSkills,
  parseWorkflowStructuredResult,
  planQuestionId,
  workflowMeasuredUsage,
} from "../src/codex/app-server.js";

const correlation = {
  sourceMethod: "item/completed",
  diagnosticId: "runtime-session:12",
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
};

describe("Codex rich event normalization", () => {
  it("keeps supported reasoning summaries and drops private reasoning content", () => {
    const activity = normalizeCodexThreadItem(
      {
        type: "reasoning",
        id: "reasoning-1",
        summary: ["Compared the runtime capabilities."],
        content: ["unsupported private chain of thought"],
      },
      "/workspace",
      "completed",
      { ...correlation, itemId: "reasoning-1" },
    );

    expect(activity).toEqual(
      expect.objectContaining({
        type: "reasoning",
        status: "completed",
        summary: ["Compared the runtime capabilities."],
      }),
    );
    expect(activity).not.toHaveProperty("content");
  });

  it("normalizes tools, subagents, web, images, review, and compaction", () => {
    const items = [
      {
        type: "mcpToolCall" as const,
        id: "mcp-1",
        server: "github",
        tool: "search_issues",
        status: "completed" as const,
        error: null,
        durationMs: 125,
      },
      {
        type: "dynamicToolCall" as const,
        id: "dynamic-1",
        namespace: "cantrip",
        tool: "worktree_status",
        status: "completed" as const,
        success: true,
        durationMs: 25,
      },
      {
        type: "collabAgentToolCall" as const,
        id: "collab-1",
        tool: "spawnAgent",
        status: "inProgress" as const,
        senderThreadId: "thread-1",
        receiverThreadIds: ["thread-2"],
        prompt: "Inspect the worker bridge.",
        model: "gpt-5.6-sol",
        agentsStates: {
          "thread-2": { status: "running", message: "Inspecting." },
        },
      },
      {
        type: "subAgentActivity" as const,
        id: "subagent-1",
        kind: "started" as const,
        agentThreadId: "thread-2",
        agentPath: "/root/reviewer",
      },
      {
        type: "webSearch" as const,
        id: "search-1",
        query: "Codex App Server events",
        action: { type: "search", queries: ["Codex event schema"] },
      },
      {
        type: "imageView" as const,
        id: "image-1",
        path: "/workspace/screenshots/app.png",
      },
      {
        type: "enteredReviewMode" as const,
        id: "review-1",
        review: "Review the current diff.",
      },
      { type: "contextCompaction" as const, id: "compact-1" },
    ];

    expect(
      items.map(
        (item) =>
          normalizeCodexThreadItem(item, "/workspace", "completed", {
            ...correlation,
            itemId: item.id,
          })?.type,
      ),
    ).toEqual([
      "mcpToolCall",
      "dynamicToolCall",
      "collabToolCall",
      "subAgent",
      "webSearch",
      "imageView",
      "reviewMode",
      "contextCompaction",
    ]);
    expect(
      normalizeCodexThreadItem(items[2]!, "/workspace", "completed", {
        ...correlation,
        itemId: "collab-1",
      }),
    ).toMatchObject({ type: "collabToolCall", prompt: null });
    expect(
      normalizeCodexThreadItem(
        {
          type: "webSearch",
          id: "open-1",
          query: "",
          action: {
            type: "open_page",
            url: "https://user:secret@example.com/report?token=private#result",
          },
        },
        "/workspace",
        "completed",
        { ...correlation, itemId: "open-1" },
      ),
    ).toMatchObject({
      type: "webSearch",
      action: "Opened https://example.com/report",
    });
  });

  it("normalizes phased messages, token usage, and rate limits", () => {
    expect(
      normalizeAgentMessage(
        {
          type: "agentMessage",
          id: "message-1",
          text: "Checking the server bridge.",
          phase: "commentary",
        },
        { ...correlation, itemId: "message-1" },
      ),
    ).toMatchObject({
      phase: "commentary",
      text: "Checking the server bridge.",
    });

    const breakdown = {
      totalTokens: 1_500,
      inputTokens: 1_000,
      cachedInputTokens: 500,
      cacheWriteInputTokens: 0,
      outputTokens: 400,
      reasoningOutputTokens: 100,
    };
    expect(
      normalizeTokenUsageActivity(
        {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: breakdown,
            last: breakdown,
            modelContextWindow: 10_000,
          },
        },
        { ...correlation, itemId: null },
      ),
    ).toMatchObject({ type: "usage", contextUsedPercent: 15 });

    expect(
      normalizeRateLimitActivity(
        {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            planType: "plus",
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1_786_212_000,
            },
            secondary: null,
            rateLimitReachedType: null,
          },
        },
        "turn-1",
        { ...correlation, itemId: null },
      ),
    ).toMatchObject({ type: "rateLimit", primary: { usedPercent: 42 } });

    expect(
      normalizeNoticeActivity({
        level: "error",
        message: "The provider rejected the request.",
        details: "Request id req-1",
        willRetry: true,
        correlation: { ...correlation, itemId: null },
      }),
    ).toMatchObject({
      type: "notice",
      status: "failed",
      willRetry: true,
      correlation: { diagnosticId: "runtime-session:12" },
    });
  });
});

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

describe("Cantrip dynamic execution tools", () => {
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
    expect(CANTRIP_DYNAMIC_TOOLS.map(({ name }) => name)).toEqual([
      ...CANTRIP_WORKTREE_DYNAMIC_TOOLS.map(({ name }) => name),
      "cantrip_targets_list",
      "cantrip_target_inspect",
      "cantrip_explorer_list",
      "cantrip_explorer_read",
      "cantrip_terminal_read",
      "cantrip_browser_services",
      "cantrip_explorer_write",
      "cantrip_terminal_input",
      "cantrip_terminal_service_restart",
      "cantrip_browser_navigate",
    ]);
    expect(
      CANTRIP_DYNAMIC_TOOLS.every(
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
      executeDynamicExecutionTool(
        async (input) => ({
          summary: `Scheduled ${String(input.arguments.worktreeId)}`,
          target: null,
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
      executeDynamicExecutionTool(async () => {
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

describe("Codex workflow node policy", () => {
  it("maps node mutation and network requirements into scoped sandboxes", () => {
    expect(
      codexWorkflowTurnPolicy(
        {
          cwd: "/workspace/project",
          mutationMode: "read-only",
          networkAccess: "none",
          permissionProfileId: null,
        },
        false,
      ),
    ).toEqual({
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(
      codexWorkflowTurnPolicy(
        {
          cwd: "/workspace/project/../project",
          mutationMode: "write",
          networkAccess: "unrestricted",
          permissionProfileId: null,
        },
        false,
      ),
    ).toEqual({
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/workspace/project"],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });

  it("fails closed for restricted network without named profiles", () => {
    expect(() =>
      codexWorkflowTurnPolicy(
        {
          cwd: "/workspace/project",
          mutationMode: "read-only",
          networkAccess: "restricted",
          permissionProfileId: ":restricted",
        },
        false,
      ),
    ).toThrow(/requires a supported Codex permission profile/u);
    expect(
      codexWorkflowTurnPolicy(
        {
          cwd: "/workspace/project",
          mutationMode: "read-only",
          networkAccess: "restricted",
          permissionProfileId: ":restricted",
        },
        true,
      ),
    ).toEqual({});
  });

  it("parses bounded structured output and reports unavailable cost honestly", () => {
    expect(parseWorkflowStructuredResult("plain text", {})).toBe("plain text");
    expect(
      parseWorkflowStructuredResult('{"approved":true}', { type: "object" }),
    ).toEqual({ approved: true });
    expect(() =>
      parseWorkflowStructuredResult("not json", { type: "object" }),
    ).toThrow();
    expect(
      workflowMeasuredUsage(
        {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 2,
          cacheWriteInputTokens: 0,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        },
        250.4,
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
      totalTokens: 15,
      durationMs: 250,
      estimatedCostUsd: null,
      costAvailable: false,
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

describe("codexMcpConfigOverride", () => {
  it("maps Cantrip stdio and HTTP settings to Codex config keys", () => {
    expect(
      codexMcpConfigOverride([
        {
          name: "local_tools",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@example/mcp"],
          environment: { TOKEN: "secret" },
          enabled: true,
        },
        {
          name: "remote_tools",
          transport: "http",
          url: "https://example.com/mcp",
          bearerTokenEnvironmentVariable: "MCP_TOKEN",
          headers: { "X-Team": "Cantrip" },
          environmentHeaders: { Authorization: "MCP_AUTH_HEADER" },
          enabled: false,
        },
      ]),
    ).toEqual({
      mcp_servers: {
        local_tools: {
          command: "npx",
          args: ["-y", "@example/mcp"],
          env: { TOKEN: "secret" },
          enabled: true,
        },
        remote_tools: {
          url: "https://example.com/mcp",
          bearer_token_env_var: "MCP_TOKEN",
          http_headers: { "X-Team": "Cantrip" },
          env_http_headers: { Authorization: "MCP_AUTH_HEADER" },
          enabled: false,
        },
      },
    });
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

  it("uses the dedicated workflow entry point for unavailable runtimes", async () => {
    const runtime = new CodexAppServer(
      "/definitely/missing/codex",
      "/private/tmp/cantrip-workflow-runtime-test",
      "/private/tmp/cantrip-workflow-runtime-test/home",
      unprobedCodexRuntimeReport,
    );

    await expect(
      runtime.runWorkflowNode({
        workflowRunId: "run-1",
        runNodeId: "run-node-1",
        attemptId: "attempt-1",
        idempotencyKey: "execute-1",
        worktreeId: null,
        cwd: "/private/tmp/cantrip-workflow-runtime-test",
        threadId: null,
        prompt: "Inspect the project",
        developerInstructions: null,
        skillNames: [],
        outputSchema: {},
        mutationMode: "read-only",
        networkAccess: "none",
        approvalMode: "interactive",
        permissionProfileId: null,
        timeoutMs: 60_000,
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
