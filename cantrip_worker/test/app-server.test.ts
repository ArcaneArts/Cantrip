import { describe, expect, it } from "vitest";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";

import {
  CANTRIP_CLI_DEVELOPER_INSTRUCTIONS,
  CANTRIP_DYNAMIC_TOOLS_OVERRIDE,
  cantripChatThreadParams,
  agentInteractionRequestFromServerRequest,
  appendBoundedCommandOutput,
  boundedCommandOutput,
  changedFiles,
  codexChatApprovalPolicy,
  codexChatThreadSecurityParams,
  codexResultForAgentInteraction,
  CodexAppServer,
  codexEndpointFromLine,
  codexReasoningEffortParams,
  codexStartupExitMessage,
  codexMcpConfigOverride,
  codexModelProviderName,
  codexThreadPermissionParams,
  codexWorkflowTurnPolicy,
  codexWorktreeTurnPolicy,
  codexWorkspaceContext,
  commandTelemetryFromCompletion,
  commandTelemetryFromDelta,
  commandTelemetryFromStart,
  failClosedAgentInteractionReply,
  findActiveChatTurn,
  GOAL_CONTINUATION_PROMPT,
  goalShouldContinue,
  isKnownCodexNotificationMethod,
  normalizeAgentMessage,
  normalizeCodexThreadTurn,
  normalizeCodexThreadItem,
  normalizeNoticeActivity,
  normalizeRateLimitActivity,
  normalizeTokenUsageActivity,
  latestChangedLine,
  parseCodexRpcMessage,
  parseCodexSkills,
  parsePermissionProfileList,
  parseWorkflowStructuredResult,
  planQuestionId,
  flushStagedAgentMessage,
  stageAgentMessage,
  workflowMeasuredUsage,
} from "../src/codex/app-server.js";

describe("active chat turn selection", () => {
  it("finds a live first turn by chat ID before its thread ID is persisted", () => {
    const turns = new Map([
      [
        "turn-stale",
        {
          chatId: "chat-stale",
          executionKind: "chat" as const,
          threadId: "thread-stale",
        },
      ],
      [
        "turn-live",
        {
          chatId: "chat-live",
          executionKind: "chat" as const,
          threadId: "thread-live",
        },
      ],
    ]);

    expect(findActiveChatTurn(turns, "chat-live", null)?.[0]).toBe("turn-live");
    expect(findActiveChatTurn(turns, "chat-live", "thread-stale")?.[0]).toBe(
      "turn-live",
    );
  });
});

const correlation = {
  sourceMethod: "item/completed",
  diagnosticId: "runtime-session:12",
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
};

describe("Codex rich event normalization", () => {
  it("retains a strict rolling 256 KiB UTF-8 command tail", () => {
    const exact = boundedCommandOutput("🙂".repeat(65_536));
    expect(Buffer.byteLength(exact.output!, "utf8")).toBe(256 * 1_024);
    expect(exact.truncated).toBe(false);

    const truncated = appendBoundedCommandOutput(exact, "tail🙂");
    expect(Buffer.byteLength(truncated.output!, "utf8")).toBeLessThanOrEqual(
      256 * 1_024,
    );
    expect(truncated.output).toMatch(/tail🙂$/u);
    expect(truncated.output).not.toContain("�");
    expect(truncated.truncated).toBe(true);

    const continued = appendBoundedCommandOutput(truncated, "\nnew output");
    expect(continued.output).toMatch(/tail🙂\nnew output$/u);
    expect(Buffer.byteLength(continued.output!, "utf8")).toBeLessThanOrEqual(
      256 * 1_024,
    );

    const sanitized = boundedCommandOutput(
      "\u001b[31mred\u001b[0m\u0000\u0007\nnext\tcolumn",
    );
    expect(sanitized).toEqual({
      output: "red\nnext\tcolumn",
      truncated: false,
    });
  });

  it("reconciles output deltas that arrive before start and completion", () => {
    const early = commandTelemetryFromDelta(null, "early", 1_100);
    const started = commandTelemetryFromStart(early, null, 1_000, 1_200);
    const running = commandTelemetryFromDelta(started, " output", 1_300);
    const completed = commandTelemetryFromCompletion(running, null, 300, 1_400);
    expect(completed).toEqual({
      output: "early output",
      truncated: false,
      startedAtMs: 1_000,
      updatedAtMs: 1_400,
    });

    expect(commandTelemetryFromCompletion(null, "done", 250, 2_000)).toEqual({
      output: "done",
      truncated: false,
      startedAtMs: 1_750,
      updatedAtMs: 2_000,
    });
  });

  it("prefers authoritative completion output after malformed delta ordering", () => {
    const pending = commandTelemetryFromDelta(null, "partial", 1_000);
    expect(
      commandTelemetryFromCompletion(pending, "complete output", 50, 1_100),
    ).toMatchObject({
      output: "complete output",
      truncated: false,
      startedAtMs: 1_000,
    });
  });

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

  it("normalizes command timing and best-effort file previews", () => {
    expect(
      normalizeCodexThreadItem(
        {
          type: "commandExecution",
          id: "command-1",
          command: "pnpm test",
          cwd: "/workspace/path with spaces",
          status: "inProgress",
          exitCode: null,
          aggregatedOutput: null,
          durationMs: null,
        },
        "/workspace",
        "started",
        { ...correlation, itemId: "command-1" },
        {
          commandOutput: { output: "running", truncated: false },
          startedAtMs: 1_000,
          updatedAtMs: 1_100,
          completedAtMs: null,
        },
      ),
    ).toMatchObject({
      type: "command",
      output: null,
      outputTail: "running",
      outputTruncated: false,
      startedAtMs: 1_000,
      updatedAtMs: 1_100,
      completedAtMs: null,
    });
    expect(
      normalizeCodexThreadItem(
        {
          type: "commandExecution",
          id: "command-1",
          command: "pnpm test",
          cwd: "/workspace/path with spaces",
          status: "inProgress",
          exitCode: null,
          aggregatedOutput: "last output",
          durationMs: null,
        },
        "/workspace",
        "completed",
        { ...correlation, itemId: "command-1" },
        { completedAtMs: 1_200, status: "completed", updatedAtMs: 1_200 },
      ),
    ).toMatchObject({
      status: "completed",
      output: "last output",
      outputTail: "last output",
      completedAtMs: 1_200,
      updatedAtMs: 1_200,
    });
    expect(
      normalizeCodexThreadItem(
        {
          type: "fileChange",
          id: "files-1",
          status: "inProgress",
          changes: [
            {
              path: "/workspace/src/path with spaces.ts",
              kind: { type: "update" },
              diff: "@@ -1 +1 @@\n-old\n+new value",
            },
            {
              path: "/workspace/assets/image.png",
              kind: { type: "update" },
              diff: "Binary files differ",
            },
          ],
        },
        "/workspace",
        "started",
        { ...correlation, itemId: "files-1" },
        { startedAtMs: 2_000, updatedAtMs: 2_100, completedAtMs: null },
      ),
    ).toMatchObject({
      type: "fileChange",
      changes: [
        {
          path: "src/path with spaces.ts",
          latestLine: "new value",
          lastActivityAtMs: 2_100,
        },
        { path: "assets/image.png" },
      ],
    });
    expect(latestChangedLine("Binary files differ")).toBeNull();
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
    ).toMatchObject({
      type: "rateLimit",
      limitId: "codex",
      primary: { usedPercent: 42 },
    });

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

  it("keeps model final-answer items provisional until the turn completes", () => {
    const first = normalizeAgentMessage(
      {
        type: "agentMessage",
        id: "message-1",
        text: "I’ll inspect the repository first.",
        phase: "final_answer",
      },
      { ...correlation, itemId: "message-1" },
    )!;
    const second = normalizeAgentMessage(
      {
        type: "agentMessage",
        id: "message-2",
        text: "Here is the completed answer.",
        phase: "final_answer",
      },
      { ...correlation, itemId: "message-2" },
    )!;

    const stagedFirst = stageAgentMessage(null, first);
    expect(stagedFirst).toMatchObject({ emitted: [], pending: first });

    const continued = flushStagedAgentMessage(stagedFirst.pending, false);
    expect(continued).toMatchObject({
      emitted: [{ id: "message-1", phase: "commentary" }],
      pending: null,
    });

    const stagedSecond = stageAgentMessage(continued.pending, second);
    const completed = flushStagedAgentMessage(stagedSecond.pending, true);
    expect(completed).toMatchObject({
      emitted: [{ id: "message-2", phase: "final_answer" }],
      pending: null,
    });
  });

  it("demotes an earlier provisional answer when another answer arrives", () => {
    const first = normalizeAgentMessage(
      {
        type: "agentMessage",
        id: "message-1",
        text: "First progress update.",
        phase: "final_answer",
      },
      { ...correlation, itemId: "message-1" },
    )!;
    const second = normalizeAgentMessage(
      {
        type: "agentMessage",
        id: "message-2",
        text: "Second progress update.",
        phase: "final_answer",
      },
      { ...correlation, itemId: "message-2" },
    )!;

    const stagedFirst = stageAgentMessage(null, first);
    expect(stageAgentMessage(stagedFirst.pending, second)).toMatchObject({
      emitted: [{ id: "message-1", phase: "commentary" }],
      pending: { id: "message-2", phase: "final_answer" },
    });
  });

  it("keeps only the last completed thread message as the final answer", () => {
    const completed = normalizeCodexThreadTurn(
      {
        id: "turn-1",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        durationMs: 1_000,
        error: null,
        items: [
          {
            type: "agentMessage",
            id: "message-1",
            text: "I’ll inspect the repository first.",
            phase: "final_answer",
          },
          {
            type: "commandExecution",
            id: "command-1",
            command: "rg --files",
            cwd: "/workspace",
            status: "completed",
            exitCode: 0,
            aggregatedOutput: "README.md",
            durationMs: 50,
          },
          {
            type: "agentMessage",
            id: "message-2",
            text: "Here is the answer.",
            phase: "final_answer",
          },
        ],
      },
      "/workspace",
      "thread-1",
    );

    expect(completed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agentMessage",
          id: "message-1",
          phase: "commentary",
        }),
        expect.objectContaining({
          type: "agentMessage",
          id: "message-2",
          phase: "final_answer",
        }),
      ]),
    );

    const running = normalizeCodexThreadTurn(
      {
        id: "turn-2",
        status: "inProgress",
        startedAt: 1,
        completedAt: null,
        durationMs: null,
        error: null,
        items: [
          {
            type: "agentMessage",
            id: "message-running",
            text: "I’m still looking.",
            phase: "final_answer",
          },
        ],
      },
      "/workspace",
      "thread-1",
    );
    expect(running.items[0]).toMatchObject({
      type: "agentMessage",
      id: "message-running",
      phase: "commentary",
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

describe("Cantrip CLI cutover", () => {
  it("registers no Cantrip dynamic tools for new or resumed threads", () => {
    expect(CANTRIP_DYNAMIC_TOOLS_OVERRIDE).toEqual({ dynamicTools: [] });
    const newThreadParams = cantripChatThreadParams();
    const resumedThreadParams = cantripChatThreadParams();
    expect(newThreadParams.dynamicTools).toEqual([]);
    expect(resumedThreadParams.dynamicTools).toEqual([]);
    expect(JSON.stringify(newThreadParams)).not.toContain("cantrip_");
    expect(JSON.stringify(resumedThreadParams)).not.toContain("cantrip_");
  });

  it("directs Codex to the documented CLI instead of private tools", () => {
    expect(CANTRIP_CLI_DEVELOPER_INSTRUCTIONS).toContain("`cantrip -h`");
    expect(CANTRIP_CLI_DEVELOPER_INSTRUCTIONS).toContain(
      "`cantrip policy read <policy-key>`",
    );
    expect(CANTRIP_CLI_DEVELOPER_INSTRUCTIONS).not.toContain("cantrip_");
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

describe("codexReasoningEffortParams", () => {
  const model = {
    id: "logical-model",
    routeId: "provider-route",
    name: "gpt-test",
    reasoningEffort: null,
  };

  it("uses the App Server effort override when an effort is selected", () => {
    expect(
      codexReasoningEffortParams({ ...model, reasoningEffort: "high" }),
    ).toEqual({ effort: "high" });
  });

  it("leaves the provider default untouched when no effort is selected", () => {
    expect(codexReasoningEffortParams(model)).toEqual({});
  });
});

describe("codexWorktreeTurnPolicy", () => {
  it("enforces inspection-only Primary for required-for-writes projects", () => {
    expect(
      codexWorktreeTurnPolicy({
        cwd: "/workspace/project",
        rootKind: "git-worktree",
        isPrimary: true,
        resultMode: { kind: "visible" },
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
      rootKind: "git-worktree",
      isPrimary: false,
      resultMode: { kind: "visible" },
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
        rootKind: "git-worktree",
        isPrimary: true,
        resultMode: { kind: "visible" },
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

  it("adds current policy summaries as separate application context", () => {
    const policy = codexWorktreeTurnPolicy({
      cwd: "/workspace/project",
      rootKind: "git-worktree",
      isPrimary: false,
      resultMode: { kind: "visible" },
      policyContext:
        "Effective Cantrip policies apply.\n\n[review] Review\nRead the policy.",
      worktreeMode: "agent-managed",
      worktreePolicy: "agent-managed",
    });
    expect(policy.additionalContext["cantrip.policies"]).toEqual({
      kind: "application",
      value:
        "Effective Cantrip policies apply.\n\n[review] Review\nRead the policy.",
    });
    expect(policy.additionalContext["cantrip.worktree-policy"]).toBeDefined();
  });

  it("forces structured Task turns read-only even with implementation access", () => {
    const policy = codexWorktreeTurnPolicy({
      cwd: "/workspace/project",
      rootKind: "git-worktree",
      isPrimary: false,
      resultMode: { kind: "structured", outputSchema: { type: "object" } },
      worktreeMode: "pinned",
      worktreePolicy: "direct",
      permissionProfileActive: true,
      policyContext: "Effective policy summaries",
    });
    expect(policy.sandboxPolicy).toEqual({
      type: "readOnly",
      networkAccess: false,
    });
    expect(policy.additionalContext["cantrip.worktree-policy"].value).toContain(
      "unconditionally read-only",
    );
    expect(policy.additionalContext["cantrip.policies"]?.value).toBe(
      "Effective policy summaries",
    );
  });

  it("uses direct non-Git context for worker-managed folders", () => {
    const policy = codexWorktreeTurnPolicy({
      cwd: "/workspace/folder",
      isPrimary: true,
      resultMode: { kind: "visible" },
      rootKind: "folder-root",
      worktreeMode: "agent-managed",
      worktreePolicy: "required-for-writes",
    });

    expect(policy.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/workspace/folder"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    const context = policy.additionalContext["cantrip.worktree-policy"].value;
    expect(context).toContain("worker-managed folder without Git protection");
    expect(context).toContain("Writes occur directly");
    expect(context).toContain("worktree commands are unavailable");
    expect(context).toContain("git init does not convert");
    expect(context).not.toContain("may use `cantrip worktree`");
  });
});

describe("Codex permission profile params", () => {
  it("disables approval escalation and implementation access for Task planning", () => {
    expect(
      codexChatThreadSecurityParams(":danger-full-access", true, true),
    ).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
  });

  it("never composes beta permission profiles with the legacy sandbox", () => {
    expect(codexThreadPermissionParams(":read-only", true)).toEqual({
      permissions: ":read-only",
    });
    expect(codexThreadPermissionParams(":read-only", false)).toEqual({
      sandbox: "workspace-write",
    });
    expect(codexThreadPermissionParams(":yolo", true)).toEqual({
      permissions: ":danger-full-access",
    });
  });

  it("only disables approvals for supported YOLO chat profiles", () => {
    expect(codexChatApprovalPolicy(":yolo", true)).toBe("never");
    expect(codexChatApprovalPolicy(":danger-full-access", true)).toBe(
      "on-request",
    );
    expect(codexChatApprovalPolicy(":yolo", false)).toBe("on-request");
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

  it("uses Codex's built-in Ollama provider for local models", () => {
    expect(
      codexModelProviderName({
        id: "local-ollama",
        name: "Ollama",
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: null,
      }),
    ).toBe("ollama");
  });

  it("routes Grok subscription traffic through Cantrip's credential proxy", () => {
    expect(
      codexModelProviderName({
        id: "supergrok",
        name: "SuperGrok",
        kind: "grok",
        baseUrl: "http://127.0.0.1:54321/v1",
        apiKey: null,
        accountId: "grok-account",
        credentialHomeKey: "grok-account-home",
      }),
    ).toBe("cantrip_runtime");
  });

  it("keeps other compatible APIs on Cantrip's configured provider", () => {
    expect(
      codexModelProviderName({
        id: "open-router",
        name: "OpenRouter",
        kind: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
      }),
    ).toBe("cantrip_runtime");
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

describe("codexStartupExitMessage", () => {
  it("surfaces the final startup diagnostic without terminal control codes", () => {
    expect(
      codexStartupExitMessage(1, null, [
        "first warning",
        "\u001b[31mmodel catalog is missing base instructions\u001b[0m",
      ]),
    ).toBe(
      "Codex app-server exited before listening (code 1): model catalog is missing base instructions",
    );
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

describe("parsePermissionProfileList", () => {
  it("normalizes null Codex descriptions without rejecting the capability", () => {
    expect(
      parsePermissionProfileList({
        data: [
          { id: ":workspace", description: null, allowed: true },
          { id: ":read-only", description: "Read only", allowed: true },
        ],
      }),
    ).toEqual([
      { id: ":workspace", description: "", allowed: true },
      { id: ":read-only", description: "Read only", allowed: true },
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
    ).rejects.toThrow(/Codex runtime is missing.*expected >=0\.147\.0/u);
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
    ).rejects.toThrow(/Codex runtime is missing.*expected >=0\.147\.0/u);
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
