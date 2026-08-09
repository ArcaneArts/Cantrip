import { describe, expect, it } from "vitest";

import {
  agentActivitySchema,
  agentInteractionRequestSchema,
  agentInteractionRuntimeRequestSchema,
  agentInteractionResolutionCreateSchema,
  agentWorktreeToolCallSchema,
  agentWorktreeToolResultSchema,
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  codexExternalImportApplySchema,
  codexMcpOauthStatusSchema,
  codexMcpResourceReadRequestSchema,
  chatAttachmentSummarySchema,
  chatExecutionLaneSummarySchema,
  chatGoalCreateSchema,
  chatGoalResponseSchema,
  chatPlanAnswerSchema,
  chatPlanStateSchema,
  chatPauseStateSchema,
  chatPauseUpdateSchema,
  chatTurnCreateSchema,
  codeRuntimeStatusSchema,
  codeTabSummarySchema,
  decodeCodeTunnelFrame,
  decodeRemoteSurfaceFrame,
  desktopStreamSettingsSchema,
  encodeCodeTunnelFrame,
  encodeRemoteSurfaceFrame,
  explorerFileWriteSchema,
  remoteBrowserClipboardMessageSchema,
  remoteBrowserClientMessageSchema,
  remoteBrowserCursorMessageSchema,
  remoteBrowserServerMessageSchema,
  remoteSurfaceConnectionMessageSchema,
  remoteSurfaceWebRtcConfigurationSchema,
  remoteSurfaceWebRtcSignalSchema,
  gitActionSchema,
  gitFileDiffSchema,
  mentionedSkillNames,
  MIN_SIDEBAR_WIDTH,
  normalizeResponsesBaseUrl,
  chatPermissionProfileStateSchema,
  queuedPromptSchema,
  projectWorkspaceCreateSchema,
  projectWorkspaceSummarySchema,
  projectWorkspaceUpdateSchema,
  projectWorktreeSummarySchema,
  projectTabLayoutSummarySchema,
  remoteDesktopCreateSchema,
  remoteDesktopClientMessageSchema,
  remoteDesktopSummarySchema,
  remoteDesktopTargetInventorySchema,
  remoteDesktopUpdateSchema,
  serverBootstrapSchema,
  systemHealthSchema,
  terminalClientMessageSchema,
  terminalServerMessageSchema,
  tabGroupMemberMoveSchema,
  tabGroupMemberOrderSchema,
  tabGroupOrderSchema,
  unprobedCodexRuntimeReport,
  userSettingsSchema,
  workerCommandSchema,
  workerEventSchema,
  workerProjectShareOpenResultSchema,
  worktreeInventorySchema,
  workerEventEnvelopeSchema,
  workerHeartbeatSchema,
  workerNotificationEnvelopeSchema,
} from "../src/index.js";

describe("Cantrip protocol", () => {
  it("bounds version-checked explorer file writes", () => {
    const version = "a".repeat(64);
    expect(
      explorerFileWriteSchema.parse({
        path: "src/index.ts",
        content: "export {};\n",
        version,
      }),
    ).toEqual({
      path: "src/index.ts",
      content: "export {};\n",
      version,
    });
    expect(
      workerCommandSchema.parse({
        type: "explorer.file.write",
        root: "/workspace/Cantrip",
        path: "src/index.ts",
        content: "export {};\n",
        version,
      }),
    ).toMatchObject({ type: "explorer.file.write", version });
    expect(() =>
      explorerFileWriteSchema.parse({
        path: "src/index.ts",
        content: "export {};\n",
        version: "stale",
      }),
    ).toThrow();
  });

  it("bounds and validates worker-owned worktree observation", () => {
    expect(
      workerCommandSchema.parse({
        type: "worktree.observation.configure",
        targets: [{ sourcePath: "/repo", worktreePath: "/repo" }],
      }),
    ).toMatchObject({ type: "worktree.observation.configure" });
    expect(() =>
      workerCommandSchema.parse({
        type: "worktree.observation.configure",
        targets: [
          { sourcePath: "/repo", worktreePath: "/repo" },
          { sourcePath: "/repo", worktreePath: "/repo" },
        ],
      }),
    ).toThrow(/unique/u);
    expect(
      workerNotificationEnvelopeSchema.parse({
        kind: "notification",
        notification: {
          type: "worktree.status.observed",
          sourcePath: "/repo",
          worktreePath: "/repo",
          result: {
            worktree: {
              path: "/repo",
              head: "a".repeat(40),
              branch: "main",
              detached: false,
              isPrimary: true,
              managed: false,
              locked: false,
              lockReason: null,
              prunable: false,
              pruneReason: null,
              missing: false,
            },
            status: {
              branch: "main",
              head: "a".repeat(40),
              upstream: null,
              ahead: 0,
              behind: 0,
              files: [],
              branches: [],
            },
          },
        },
      }).notification.type,
    ).toBe("worktree.status.observed");
  });

  it("validates project workspace names, memberships, and summaries", () => {
    expect(
      projectWorkspaceCreateSchema.parse({ name: "  Personal  " }),
    ).toEqual({ name: "Personal" });
    expect(
      projectWorkspaceUpdateSchema.parse({
        projectIds: ["project-1", "project-2"],
      }),
    ).toEqual({ projectIds: ["project-1", "project-2"] });
    expect(() => projectWorkspaceUpdateSchema.parse({})).toThrow();
    expect(() =>
      projectWorkspaceSummarySchema.parse({
        id: "workspace-1",
        name: "Personal",
        position: 0,
        isDefault: false,
        projectIds: [""],
        createdAt: "2026-08-09T12:00:00.000Z",
        updatedAt: "2026-08-09T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("bounds GitHub issue pagination to pages of at most 100", () => {
    expect(
      workerCommandSchema.parse({
        type: "github.issues.list",
        repository: "ArcaneArts/Cantrip",
        state: "open",
      }),
    ).toMatchObject({ kind: "issue", page: 1, limit: 100 });
    expect(
      workerCommandSchema.parse({
        type: "github.issues.list",
        repository: "ArcaneArts/Cantrip",
        kind: "pull-request",
        state: "closed",
      }),
    ).toMatchObject({ kind: "pull-request", state: "closed" });
    expect(() =>
      workerCommandSchema.parse({
        type: "github.issues.list",
        repository: "ArcaneArts/Cantrip",
        state: "open",
        page: 1,
        limit: 101,
      }),
    ).toThrow();
  });

  it("validates worker-owned authenticated project share lifecycles", () => {
    const publicBasePath = `/project-shares/${"x".repeat(43)}`;
    expect(
      workerCommandSchema.parse({
        type: "project.share.open",
        shareId: "share-1",
        root: "/worker/projects/cantrip",
        publicBasePath,
        publicOrigin: "https://surface.cantrip.example",
      }),
    ).toEqual({
      type: "project.share.open",
      shareId: "share-1",
      root: "/worker/projects/cantrip",
      publicBasePath,
      publicOrigin: "https://surface.cantrip.example",
    });
    expect(
      workerCommandSchema.parse({
        type: "project.share.close",
        shareId: "share-1",
      }),
    ).toEqual({ type: "project.share.close", shareId: "share-1" });
    expect(
      workerProjectShareOpenResultSchema.parse({
        shareId: "share-1",
        protocol: "webdav",
        publicBasePath,
        publicOrigin: "https://surface.cantrip.example",
        loopbackHost: "127.0.0.1",
        loopbackPort: 43_210,
        username: "cantrip-user",
        password: "a-secure-random-password-value",
        realm: "Cantrip Project Share",
      }),
    ).toMatchObject({ protocol: "webdav", loopbackPort: 43_210 });
    expect(
      workerProjectShareOpenResultSchema.safeParse({
        shareId: "share-1",
        protocol: "webdav",
        publicBasePath,
        publicOrigin: "https://surface.cantrip.example",
        loopbackHost: "0.0.0.0",
        loopbackPort: 43_210,
        username: "cantrip-user",
        password: "a-secure-random-password-value",
        realm: "Cantrip Project Share",
      }).success,
    ).toBe(false);
  });

  it("validates native customization worker commands and bounded MCP reads", () => {
    const runtime = {
      cwd: "/workspace/Cantrip",
      model: {
        id: "model-1",
        routeId: "route-1",
        name: "gpt-5.6-sol",
        reasoningEffort: "high" as const,
      },
      provider: {
        id: "provider-1",
        name: "ChatGPT",
        kind: "chatgpt" as const,
        baseUrl: "https://api.openai.com/v1",
        apiKey: null,
      },
    };
    expect(
      workerCommandSchema.parse({
        type: "customization.inventory.read",
        ...runtime,
      }),
    ).toMatchObject({ forceReload: false });
    expect(
      workerCommandSchema.parse({
        type: "customization.external.preview",
        ...runtime,
      }).type,
    ).toBe("customization.external.preview");
    expect(
      codexMcpResourceReadRequestSchema.parse({
        server: "docs",
        uri: "docs://readme",
      }),
    ).toEqual({ server: "docs", uri: "docs://readme" });
    expect(() =>
      codexMcpResourceReadRequestSchema.parse({
        server: "docs",
        uri: "x".repeat(8_193),
      }),
    ).toThrow();
    expect(
      workerCommandSchema.parse({
        type: "customization.skill.configure",
        ...runtime,
        path: "/workspace/Cantrip/.agents/review/SKILL.md",
        enabled: false,
      }).type,
    ).toBe("customization.skill.configure");
    expect(
      workerCommandSchema.parse({
        type: "customization.mcp.oauth.status",
        ...runtime,
        server: "docs",
      }).type,
    ).toBe("customization.mcp.oauth.status");
    expect(
      codexMcpOauthStatusSchema.parse({
        server: "docs",
        status: "succeeded",
        error: null,
      }).status,
    ).toBe("succeeded");
    expect(
      codexExternalImportApplySchema.safeParse({
        itemIds: ["candidate-1", "candidate-1"],
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.parse({
        type: "customization.external.apply",
        ...runtime,
        itemIds: ["candidate-1"],
      }).type,
    ).toBe("customization.external.apply");
  });

  it("models capability-gated chat permission profiles", () => {
    expect(
      chatPermissionProfileStateSchema.parse({
        available: true,
        profiles: [
          { id: ":workspace", description: "Workspace writes", allowed: true },
        ],
        selectedId: ":workspace",
        effectiveId: ":read-only",
        forcedByWorktreePolicy: true,
        reason: null,
      }),
    ).toMatchObject({ effectiveId: ":read-only" });
  });

  it("validates durable structured agent interaction requests", () => {
    const request = {
      id: "request-1",
      requestKey: "worker-1:runtime-1:42",
      projectId: "project-1",
      provenance: {
        chatId: "chat-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        executionLaneId: "lane-1",
        workflowRunId: null,
        workflowNodeId: null,
        workerId: "worker-1",
      },
      payload: {
        kind: "commandExecution" as const,
        startedAtMs: 1_786_210_000_000,
        approvalId: null,
        environmentId: null,
        reason: "Needs network access",
        command: "pnpm install",
        cwd: "/workspace/Cantrip",
        networkApprovalContext: {
          host: "registry.npmjs.org",
          protocol: "https",
        },
        additionalPermissions: { network: { enabled: true } },
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        availableDecisions: ["accept", "decline", "cancel"],
      },
      status: "pending" as const,
      response: null,
      resolvedByUserId: null,
      expiresAt: "2026-08-08T18:00:00.000Z",
      resolvedAt: null,
      createdAt: "2026-08-08T17:00:00.000Z",
      updatedAt: "2026-08-08T17:00:00.000Z",
    };

    expect(agentInteractionRequestSchema.parse(request)).toEqual(request);
    expect(
      agentInteractionResolutionCreateSchema.parse({
        idempotencyKey: "resolve-1",
        response: {
          kind: "commandExecution",
          decision: "decline",
        },
      }),
    ).toMatchObject({ response: { execpolicyAmendment: null } });
    expect(() =>
      agentInteractionRequestSchema.parse({
        ...request,
        status: "resolved",
        response: { kind: "fileChange", decision: "decline" },
      }),
    ).toThrow(/Response kind must match request kind/u);
    expect(() =>
      agentInteractionRequestSchema.parse({
        ...request,
        status: "resolved",
      }),
    ).toThrow(/Resolved requests require response and resolution data/u);

    const runtimeRequest = agentInteractionRuntimeRequestSchema.parse({
      requestKey: "runtime-1:request-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      payload: request.payload,
      expiresAt: "2026-08-08T18:30:00.000Z",
    });
    expect(
      workerEventEnvelopeSchema.parse({
        kind: "event",
        requestId: "worker-turn-1",
        event: { type: "agent.interaction.requested", request: runtimeRequest },
      }).event.type,
    ).toBe("agent.interaction.requested");
    expect(
      workerCommandSchema.parse({
        type: "agent.interaction.respond",
        requestKey: runtimeRequest.requestKey,
        response: { kind: "commandExecution", decision: "decline" },
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
      }).type,
    ).toBe("agent.interaction.respond");
  });

  it("validates durable worktree and execution-lane summaries", () => {
    expect(
      projectWorktreeSummarySchema.parse({
        id: "worktree-1",
        projectSourceId: "source-1",
        projectId: "project-1",
        workerId: "worker-1",
        name: "Primary",
        path: "/workspace/project",
        displayPath: "ArcaneArts/Cantrip",
        isPrimary: true,
        isDefault: true,
        origin: "cantrip",
        lifecycleState: "ready",
        branch: "main",
        head: "0123456789abcdef",
        detached: false,
        locked: false,
        lockReason: null,
        lastScannedAt: "2026-08-08T12:00:00.000Z",
        createdAt: "2026-08-08T12:00:00.000Z",
        updatedAt: "2026-08-08T12:00:00.000Z",
      }).isPrimary,
    ).toBe(true);

    expect(
      chatExecutionLaneSummarySchema.parse({
        id: "lane-1",
        chatId: "chat-1",
        worktreeId: "worktree-1",
        workerId: "worker-1",
        acquiringActor: "agent",
        exclusive: true,
        purpose: "Implement the requested change",
        state: "active",
        baseRevision: "origin/main",
        startingHead: "0123456789abcdef",
        runtimeSessionId: "runtime-1",
        codexThreadId: "thread-1",
        transitionKind: null,
        createdAt: "2026-08-08T12:00:00.000Z",
        activatedAt: "2026-08-08T12:00:01.000Z",
        releasedAt: null,
        updatedAt: "2026-08-08T12:00:01.000Z",
      }).state,
    ).toBe("active");
  });

  it("validates lane-scoped agent worktree tool calls and activity", () => {
    expect(
      agentWorktreeToolCallSchema.parse({
        callId: "call-1",
        chatId: "chat-1",
        executionLaneId: "lane-1",
        workerId: "worker-1",
        tool: "cantrip_worktree_switch",
        arguments: { worktreeId: "worktree-2", purpose: "Implement safely" },
      }).tool,
    ).toBe("cantrip_worktree_switch");
    expect(
      agentWorktreeToolResultSchema.parse({
        summary: "Continuation scheduled.",
        worktreeId: "worktree-2",
        continuationScheduled: true,
      }).continuationScheduled,
    ).toBe(true);
    expect(
      agentActivitySchema.parse({
        type: "worktree",
        id: "worktree-tool:call-1",
        operation: "cantrip_worktree_switch",
        status: "completed",
        summary: "Continuation scheduled.",
        worktreeId: "worktree-2",
      }).type,
    ).toBe("worktree");
  });

  it("accepts non-secret Codex account and device login state", () => {
    expect(
      codexAuthStatusSchema.parse({
        authenticated: true,
        authMode: "chatgpt",
        email: "user@example.com",
        planType: "plus",
        weeklyUsage: { usedPercent: 42, resetsAt: 1_786_665_600 },
      }).planType,
    ).toBe("plus");
    expect(
      codexDeviceLoginSchema.parse({
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      }).userCode,
    ).toBe("ABCD-1234");
  });

  it("scopes Codex authentication commands to a provider", () => {
    expect(
      workerCommandSchema.parse({
        type: "codex.auth.status",
        providerId: "chatgpt-provider-1",
      }),
    ).toMatchObject({ providerId: "chatgpt-provider-1" });
    expect(
      workerCommandSchema.safeParse({ type: "codex.auth.status" }).success,
    ).toBe(false);
  });

  it("validates worker-backed chat compaction", () => {
    expect(
      workerCommandSchema.parse({
        type: "chat.compact",
        chatId: "chat-1",
        cwd: "/workspace",
        threadId: "thread-1",
        model: {
          id: "model-1",
          routeId: "route-1",
          name: "gpt-test",
          reasoningEffort: null,
        },
        provider: {
          id: "provider-1",
          name: "ChatGPT",
          kind: "chatgpt",
          baseUrl: "https://api.openai.com/v1",
          apiKey: null,
        },
        permissionProfileId: ":workspace",
      }).type,
    ).toBe("chat.compact");
  });

  it("carries project worktree policy into worker-backed turns", () => {
    const turn = workerCommandSchema.parse({
      type: "chat.turn",
      chatId: "chat-1",
      clientMessageId: "message-1",
      executionLaneId: "lane-1",
      worktreeId: "worktree-1",
      cwd: "/workspace",
      isPrimary: true,
      worktreeMode: "agent-managed",
      worktreePolicy: "required-for-writes",
      threadId: null,
      prompt: "Implement this safely.",
      skillNames: [],
      model: {
        id: "model-1",
        routeId: "route-1",
        name: "gpt-test",
        reasoningEffort: null,
      },
      provider: {
        id: "provider-1",
        name: "ChatGPT",
        kind: "chatgpt",
        baseUrl: "https://api.openai.com/v1",
        apiKey: null,
      },
      permissionProfileId: ":read-only",
      planMode: "plan",
      automationPaused: true,
    });
    expect(turn).toMatchObject({
      isPrimary: true,
      worktreeMode: "agent-managed",
      worktreePolicy: "required-for-writes",
      planMode: "plan",
      automationPaused: true,
    });
  });

  it("keeps workflow node execution distinct and attempt-attributed", () => {
    const command = workerCommandSchema.parse({
      type: "workflow.node.execute",
      workflowRunId: "run-1",
      runNodeId: "run-node-1",
      attemptId: "attempt-1",
      idempotencyKey: "execute-1",
      worktreeId: null,
      cwd: "/workspace",
      threadId: null,
      prompt: "Review this project.",
      developerInstructions: "Return only the requested JSON.",
      skillNames: ["review"],
      outputSchema: { type: "object" },
      mutationMode: "read-only",
      networkAccess: "none",
      approvalMode: "interactive",
      permissionProfileId: ":read-only",
      timeoutMs: 60_000,
      model: {
        id: "model-1",
        routeId: "route-1",
        name: "gpt-test",
        reasoningEffort: null,
      },
      provider: {
        id: "provider-1",
        name: "ChatGPT",
        kind: "chatgpt",
        baseUrl: "https://api.openai.com/v1",
        apiKey: null,
      },
    });
    expect(command).toMatchObject({
      type: "workflow.node.execute",
      attemptId: "attempt-1",
    });

    expect(
      workerCommandSchema.parse({
        type: "workflow.node.interrupt",
        workflowRunId: "run-1",
        runNodeId: "run-node-1",
        attemptId: "attempt-1",
        threadId: "thread-1",
        model: command.model,
        provider: command.provider,
      }).type,
    ).toBe("workflow.node.interrupt");
    expect(
      workerEventSchema.parse({
        type: "workflow.node.activity",
        attemptId: "attempt-1",
        activity: {
          type: "reasoning",
          id: "activity-1",
          status: "running",
          summary: ["Reviewing"],
        },
      }),
    ).toMatchObject({
      type: "workflow.node.activity",
      attemptId: "attempt-1",
    });
  });

  it("validates cooperative chat pause state and worker commands", () => {
    expect(chatPauseUpdateSchema.parse({ paused: true })).toEqual({
      paused: true,
    });
    expect(chatPauseStateSchema.parse({ paused: false })).toEqual({
      paused: false,
    });
    expect(
      workerCommandSchema.parse({
        type: "chat.pause.set",
        chatId: "chat-1",
        paused: true,
      }),
    ).toEqual({ type: "chat.pause.set", chatId: "chat-1", paused: true });
  });

  it("validates durable Plan Mode state and no-timeout worker questions", () => {
    const state = chatPlanStateSchema.parse({
      mode: "plan",
      explanation: "Confirm the deployment shape before implementation.",
      steps: [
        { step: "Inspect the runtime", status: "completed" },
        { step: "Choose a topology", status: "inProgress" },
      ],
      question: {
        id: "question-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        createdAt: "2026-08-08T12:00:00.000Z",
        questions: [
          {
            id: "topology",
            header: "Topology",
            question: "Which topology should the plan target?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Multi-node", description: "Use four instances." },
            ],
          },
        ],
      },
    });
    expect(state.question?.questions[0]?.id).toBe("topology");
    expect(
      chatPlanAnswerSchema.parse({ answers: { topology: ["Multi-node"] } }),
    ).toEqual({ answers: { topology: ["Multi-node"] } });
    expect(
      workerEventEnvelopeSchema.parse({
        kind: "event",
        requestId: "request-1",
        event: { type: "agent.plan.question", question: state.question },
      }).event.type,
    ).toBe("agent.plan.question");
  });

  it("validates worker-backed chat interruption", () => {
    const compact = workerCommandSchema.parse({
      type: "chat.interrupt",
      chatId: "chat-1",
      threadId: "thread-1",
      model: {
        id: "model-1",
        routeId: "route-1",
        name: "gpt-test",
        reasoningEffort: null,
      },
      provider: {
        id: "provider-1",
        name: "ChatGPT",
        kind: "chatgpt",
        baseUrl: "https://api.openai.com/v1",
        apiKey: null,
      },
    });
    expect(compact.type).toBe("chat.interrupt");
  });

  it("validates native Codex goal state and worker commands", () => {
    const response = chatGoalResponseSchema.parse({
      goal: {
        threadId: "thread-1",
        objective: "Finish the release checklist",
        status: "active",
        tokenBudget: 50_000,
        tokensUsed: 1_200,
        timeUsedSeconds: 90,
        createdAt: 1_786_665_600,
        updatedAt: 1_786_665_690,
      },
    });
    expect(response.goal).toMatchObject({
      status: "active",
      tokenBudget: 50_000,
    });
    expect(
      chatGoalCreateSchema.safeParse({ objective: "   ", tokenBudget: 0 })
        .success,
    ).toBe(false);
    expect(
      workerCommandSchema.parse({
        type: "chat.goal.create",
        chatId: "chat-1",
        cwd: "/workspace",
        threadId: null,
        objective: "Finish the release checklist",
        tokenBudget: null,
        model: {
          id: "model-1",
          routeId: "route-1",
          name: "gpt-test",
          reasoningEffort: null,
        },
        provider: {
          id: "provider-1",
          name: "ChatGPT",
          kind: "chatgpt",
          baseUrl: "https://api.openai.com/v1",
          apiKey: null,
        },
        permissionProfileId: ":workspace",
      }).type,
    ).toBe("chat.goal.create");
    expect(
      workerEventEnvelopeSchema.parse({
        kind: "event",
        requestId: "request-1",
        event: {
          type: "agent.checkpoint",
          turnId: "turn-1",
          text: "Finished the first milestone.",
        },
      }).event.type,
    ).toBe("agent.checkpoint");
  });

  it("extracts unique explicit skill mentions", () => {
    expect(
      mentionedSkillNames(
        "Use $skill-creator and $browser:control-in-app-browser, then $skill-creator again.",
      ),
    ).toEqual(["skill-creator", "browser:control-in-app-browser"]);
    expect(mentionedSkillNames("The total costs$20.")).toEqual([]);
  });

  it("validates worker-backed Git actions", () => {
    expect(
      gitActionSchema.parse({
        type: "commit",
        message: "feat: add Git controls",
        all: true,
      }),
    ).toMatchObject({ type: "commit", all: true });
    expect(
      gitActionSchema.safeParse({ type: "stage", paths: [] }).success,
    ).toBe(false);
    expect(
      gitActionSchema.parse({ type: "discard", paths: ["src/app.ts"] }),
    ).toEqual({ type: "discard", paths: ["src/app.ts"] });
    expect(
      workerCommandSchema.parse({
        type: "git.diff",
        cwd: "/workspace/Cantrip",
        path: "src/app.ts",
        scope: "unstaged",
      }).type,
    ).toBe("git.diff");
    expect(
      gitFileDiffSchema.parse({
        path: "src/app.ts",
        scope: "staged",
        patch: "@@ -1 +1 @@",
        truncated: false,
      }).scope,
    ).toBe("staged");
  });

  it("validates worker worktree lifecycle commands and inventories", () => {
    expect(
      workerCommandSchema.parse({
        type: "worktree.create",
        sourcePath: "/workspace/Cantrip",
        worktreeId: "worktree-1",
        name: "Feature lane",
        mode: {
          type: "newBranch",
          branch: "agent/feature-lane",
        },
      }),
    ).toMatchObject({
      type: "worktree.create",
      mode: { type: "newBranch", startPoint: null },
    });
    expect(
      workerCommandSchema.parse({
        type: "worktree.remove",
        sourcePath: "/workspace/Cantrip",
        worktreePath: "/worker/worktrees/feature",
      }),
    ).toMatchObject({ force: false, allowExternal: false });
    expect(
      worktreeInventorySchema.parse({
        sourcePath: "/workspace/Cantrip",
        primaryPath: "/workspace/Cantrip",
        gitCommonDir: "/workspace/Cantrip/.git",
        managedRoot: "/worker/worktrees",
        repositoryFingerprint: "a".repeat(64),
        worktrees: [
          {
            path: "/workspace/Cantrip",
            head: "0123456789abcdef",
            branch: "main",
            detached: false,
            isPrimary: true,
            managed: false,
            locked: false,
            lockReason: null,
            prunable: false,
            pruneReason: null,
            missing: false,
          },
        ],
      }).worktrees[0]?.isPrimary,
    ).toBe(true);
  });

  it("normalizes Responses provider URLs to their API root", () => {
    expect(
      normalizeResponsesBaseUrl(
        "https://openrouter.ai/api/v1/chat/completions",
      ),
    ).toBe("https://openrouter.ai/api/v1");
    expect(normalizeResponsesBaseUrl("https://openrouter.ai/api/v1/chat")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(normalizeResponsesBaseUrl("https://openrouter.ai")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(normalizeResponsesBaseUrl("http://127.0.0.1:11434/v1/")).toBe(
      "http://127.0.0.1:11434/v1",
    );
  });

  it("accepts a worker heartbeat", () => {
    const heartbeat = workerHeartbeatSchema.parse({
      architecture: "arm64",
      codexVersion: "codex-cli 1.0.0",
      name: "Local Worker",
      platform: "darwin",
      startedAt: "2026-08-07T12:00:00.000Z",
      workerId: "local-worker",
    });

    expect(heartbeat.workerId).toBe("local-worker");
    expect(heartbeat.codexRuntime).toEqual(unprobedCodexRuntimeReport);
    expect(heartbeat.remoteSurfaces).toMatchObject({
      browser: false,
      desktop: false,
      transports: ["websocket"],
    });
    expect(heartbeat.code).toBeUndefined();
  });

  it("validates Cantrip Code capabilities, durable tabs, and worker commands", () => {
    const heartbeat = workerHeartbeatSchema.parse({
      architecture: "arm64",
      codexVersion: "codex-cli 1.0.0",
      name: "Code Worker",
      platform: "darwin",
      startedAt: "2026-08-07T12:00:00.000Z",
      workerId: "code-worker",
      code: {
        available: true,
        version: "1.109.5",
        upstreamRevision: "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
        patchset: 1,
        transport: "web-proxy",
        maxSessions: 4,
        reason: null,
      },
    });
    expect(heartbeat.code).toMatchObject({ available: true, patchset: 1 });
    expect(
      codeTabSummarySchema.parse({
        id: "code-1",
        projectId: "project-1",
        title: "Code",
        position: 3,
        activeWorkerId: "code-worker",
        worktreeId: "worktree-1",
        profileId: "default",
        themeMode: "follow-cantrip",
        status: "running",
        lastError: null,
        createdAt: "2026-08-07T12:00:00.000Z",
        updatedAt: "2026-08-07T12:00:00.000Z",
      }),
    ).toMatchObject({ status: "running", themeMode: "follow-cantrip" });
    expect(
      workerCommandSchema.parse({
        type: "code.open",
        sessionId: "session-1",
        codeTabId: "code-1",
        projectId: "project-1",
        worktreeId: "worktree-1",
        cwd: "/workspace/Cantrip",
        profileId: "default",
        themeMode: "follow-cantrip",
        appearance: "high-contrast-dark",
      }).type,
    ).toBe("code.open");
    expect(
      workerCommandSchema.parse({
        type: "code.prepareAgentTurn",
        cwd: "/workspace/Cantrip",
      }).type,
    ).toBe("code.prepareAgentTurn");
    expect(
      workerCommandSchema.parse({
        type: "code.agentTurnState",
        cwd: "/workspace/Cantrip",
        phase: "completed",
        paths: ["packages/protocol/src/index.ts"],
      }).type,
    ).toBe("code.agentTurnState");
    expect(
      codeRuntimeStatusSchema.parse({
        sessionId: "session-1",
        status: "running",
        editorBuild: {
          version: "1.109.5",
          upstreamRevision: "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
          patchset: 1,
          fingerprint: "a".repeat(64),
        },
        processInstanceId: "process-1",
        bridgeConnected: true,
        dirtyEditors: [],
        workbench: {
          activeEditor: null,
          git: null,
          conflicts: [],
          savePolicy: "always",
          agentStatus: "idle",
        },
        startedAt: "2026-08-07T12:00:00.000Z",
        lastActivityAt: "2026-08-07T12:00:00.000Z",
        lastError: null,
      }).workbench.savePolicy,
    ).toBe("always");
    expect(
      codeRuntimeStatusSchema.safeParse({
        sessionId: "session-1",
        status: "running",
        editorBuild: {
          version: "1.109.5",
          upstreamRevision: "short-sha",
          patchset: 1,
          fingerprint: "a".repeat(64),
        },
        processInstanceId: "process-1",
        bridgeConnected: false,
        dirtyEditors: [],
        startedAt: null,
        lastActivityAt: null,
        lastError: null,
      }).success,
    ).toBe(false);
  });

  it("encodes bounded, independently identifiable Code tunnel frames", () => {
    const header = {
      protocolVersion: 1 as const,
      attachmentId: "attachment-1",
      sessionId: "session-1",
      streamId: "stream-1",
      kind: "websocket-data" as const,
      binary: false,
    };
    const encoded = encodeCodeTunnelFrame(
      header,
      new TextEncoder().encode("hello"),
    );
    expect(new TextDecoder().decode(encoded.subarray(0, 4))).toBe("CTCD");
    expect(decodeCodeTunnelFrame(encoded)).toMatchObject({
      header,
      payload: new TextEncoder().encode("hello"),
    });
    expect(() =>
      encodeCodeTunnelFrame(
        {
          ...header,
          kind: "http-request-start",
          method: "GET",
          path: "//not-a-path",
          basePath: "/code/token",
          headers: [],
        },
        new Uint8Array(),
      ),
    ).toThrow();
  });

  it("validates one-click managed desktops without client configuration", () => {
    expect(remoteDesktopCreateSchema.parse({})).toEqual({});
    expect(remoteDesktopCreateSchema.parse({ tabGroupId: "group-1" })).toEqual({
      tabGroupId: "group-1",
    });
    expect(
      remoteDesktopCreateSchema.safeParse({ host: "127.0.0.1" }).success,
    ).toBe(false);
    const summary = remoteDesktopSummarySchema.parse({
      id: "desktop-1",
      projectId: "project-1",
      title: "Desk",
      position: 2,
      workerId: "worker-1",
      target: { kind: "monitor", id: null, name: null },
      status: "offline",
      lastError: null,
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
    });
    expect(summary).not.toHaveProperty("password");
    expect(summary).not.toHaveProperty("secretRef");
    expect(
      remoteDesktopUpdateSchema.parse({
        target: {
          kind: "window",
          id: "window-42",
          application: "Code",
          title: "Cantrip",
        },
      }).target,
    ).toMatchObject({ kind: "window", application: "Code" });
    expect(
      remoteDesktopTargetInventorySchema.parse({
        monitors: [
          {
            kind: "monitor",
            id: "1",
            name: "Studio Display",
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
            primary: true,
          },
        ],
        windows: [
          {
            kind: "window",
            id: "42",
            application: "Code",
            title: "Cantrip",
            x: 20,
            y: 30,
            width: 1200,
            height: 800,
            minimized: false,
            focused: true,
          },
        ],
      }).windows,
    ).toHaveLength(1);
    expect(
      workerCommandSchema.parse({ type: "surface.desktop.probe" }).type,
    ).toBe("surface.desktop.probe");
    expect(
      desktopStreamSettingsSchema.parse({ targetFps: 60, quality: "sharp" }),
    ).toEqual({ targetFps: 60, quality: "sharp" });
    expect(
      remoteDesktopClientMessageSchema.parse({
        type: "stream-feedback",
        intervalMs: 2_000,
        receivedFrames: 55,
        renderedFrames: 54,
        droppedFrames: 1,
        averageDecodeMs: 4.2,
      }).type,
    ).toBe("stream-feedback");
    expect(
      remoteDesktopClientMessageSchema.parse({ type: "refresh-targets" }).type,
    ).toBe("refresh-targets");
    expect(
      workerCommandSchema.parse({
        type: "surface.configure",
        surfaceId: "desktop-1",
        configuration: {
          kind: "desktop",
          target: {
            kind: "monitor",
            id: "1",
            name: "Studio Display",
          },
        },
      }).type,
    ).toBe("surface.configure");
    expect(
      userSettingsSchema.parse({
        theme: "system",
        highContrast: false,
        sidebarWidth: 288,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: null,
      }),
    ).toMatchObject({ desktopFrameRate: 30 });
    expect(
      userSettingsSchema.safeParse({
        theme: "system",
        highContrast: false,
        sidebarWidth: MIN_SIDEBAR_WIDTH,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: null,
      }).success,
    ).toBe(true);
    expect(
      userSettingsSchema.safeParse({
        theme: "system",
        highContrast: false,
        sidebarWidth: MIN_SIDEBAR_WIDTH - 1,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: null,
      }).success,
    ).toBe(false);
  });

  it("validates revisioned project tab layouts and unique order mutations", () => {
    expect(
      projectTabLayoutSummarySchema.parse({
        projectId: "project-1",
        revision: 3,
        groups: [
          {
            id: "group-1",
            projectId: "project-1",
            position: 0,
            anchorTabKey: "chat:chat-1",
            members: [
              {
                tabKey: "chat:chat-1",
                groupId: "group-1",
                projectId: "project-1",
                tabKind: "chat",
                tabId: "chat-1",
                title: "Chat",
                position: 0,
                createdAt: "2026-08-09T12:00:00.000Z",
                updatedAt: "2026-08-09T12:00:00.000Z",
              },
            ],
            createdAt: "2026-08-09T12:00:00.000Z",
            updatedAt: "2026-08-09T12:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({ revision: 3 });
    expect(
      tabGroupOrderSchema.safeParse({
        revision: 3,
        groupIds: ["group-1", "group-1"],
      }).success,
    ).toBe(false);
    expect(
      tabGroupMemberOrderSchema.safeParse({
        revision: 3,
        tabKeys: ["chat:chat-1", "chat:chat-1"],
      }).success,
    ).toBe(false);
    expect(
      tabGroupMemberMoveSchema.safeParse({
        revision: 3,
        tabKey: "chat:chat-1",
        targetGroupId: null,
        targetMemberPosition: 0,
      }).success,
    ).toBe(false);
    expect(
      tabGroupMemberMoveSchema.parse({
        revision: 3,
        tabKey: "chat:chat-1",
        targetGroupId: null,
        targetMemberPosition: 0,
        targetGroupPosition: 1,
      }),
    ).toMatchObject({ targetGroupId: null, targetGroupPosition: 1 });
  });

  it("rejects an unhealthy server payload", () => {
    const result = systemHealthSchema.safeParse({
      database: { engine: "sqlite", ready: true },
      live: {
        acceptedConnectionCount: 1,
        connectionCount: 1,
        currentCursor: 2,
        deliveredEventCount: 1,
        disconnectedConnectionCount: 0,
        heartbeatPongCount: 1,
        heartbeatTimeoutCount: 0,
        protocolViolationCount: 0,
        publicationCount: 2,
        queuePressureCount: 0,
        replayEventCount: 2,
        replaySessionCount: 0,
        replayedEventCount: 0,
        resyncRequiredCount: 0,
        resumeAttemptCount: 0,
        serverEpoch: "00000000-0000-4000-8000-000000000001",
        slowConsumerClosureCount: 0,
      },
      service: "cantrip_server",
      status: "ok",
      timestamp: "2026-08-07T12:00:00.000Z",
      workers: { connected: 0 },
    });

    expect(result.success).toBe(false);
  });

  it("describes the local server boundary explicitly", () => {
    const bootstrap = serverBootstrapSchema.parse({
      protocolVersion: 1,
      server: {
        id: "server-id",
        deploymentMode: "local",
        bootstrapMode: "pnpm-dev",
      },
      auth: {
        mode: "none",
        currentUser: {
          id: "local-user",
          kind: "anonymous",
          displayName: "Local User",
          email: null,
        },
      },
      routing: {
        workerConnection: "server-only",
        directWorkerConnections: false,
      },
      storage: { conversations: "server", files: "worker" },
      agent: { model: "gemma4:26b", modelProvider: "ollama" },
      capabilities: {
        accounts: false,
        passwordProtection: false,
        linkCodes: false,
        multipleWorkers: false,
        workerSwitching: false,
        gitSync: false,
        worktrees: true,
        remoteSurfaces: {
          enabled: true,
          transports: ["websocket"],
          relayOnly: true,
        },
        code: {
          enabled: true,
          transport: "web-proxy",
          isolatedOrigin: true,
        },
      },
    });

    expect(bootstrap.auth.currentUser.kind).toBe("anonymous");
    expect(bootstrap.routing.directWorkerConnections).toBe(false);
    expect(bootstrap.storage).toEqual({
      conversations: "server",
      files: "worker",
    });
    expect(bootstrap.capabilities.worktrees).toBe(true);
  });

  it("round-trips versioned binary Remote Surface frames", () => {
    const encoded = encodeRemoteSurfaceFrame(
      {
        protocolVersion: 1,
        surfaceId: "surface-1",
        attachmentId: "attachment-1",
        sequence: 42,
        channel: "frame",
      },
      new Uint8Array([0, 1, 127, 255]),
    );
    const decoded = decodeRemoteSurfaceFrame(encoded);

    expect(decoded.header).toEqual({
      protocolVersion: 1,
      surfaceId: "surface-1",
      attachmentId: "attachment-1",
      sequence: 42,
      channel: "frame",
    });
    expect([...decoded.payload]).toEqual([0, 1, 127, 255]);
  });

  it("accepts relay-only WebRTC signaling and rejects direct ICE policy", () => {
    const configuration = remoteSurfaceWebRtcConfigurationSchema.parse({
      iceServers: [
        {
          urls: ["turn:relay.cantrip.art:3478?transport=udp"],
          username: "123:local-user",
          credential: "short-lived-credential",
        },
      ],
      iceTransportPolicy: "relay",
      negotiationTimeoutMs: 8_000,
    });
    expect(configuration.iceTransportPolicy).toBe("relay");
    expect(
      remoteSurfaceWebRtcConfigurationSchema.safeParse({
        ...configuration,
        iceTransportPolicy: "all",
      }).success,
    ).toBe(false);
    expect(
      remoteSurfaceConnectionMessageSchema.parse({
        type: "ready",
        surfaceId: "surface-1",
        attachmentId: "attachment-1",
        transport: "webrtc",
        webrtc: configuration,
      }).webrtc,
    ).toEqual(configuration);
    expect(
      remoteSurfaceWebRtcSignalSchema.parse({
        type: "candidate",
        candidate: "candidate:1 1 UDP 1 relay.example 3478 typ relay",
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: null,
      }).type,
    ).toBe("candidate");
  });

  it("rejects malformed Remote Surface binary envelopes", () => {
    const encoded = encodeRemoteSurfaceFrame(
      {
        protocolVersion: 1,
        surfaceId: "surface-1",
        attachmentId: "attachment-1",
        sequence: 0,
        channel: "control",
      },
      new Uint8Array(),
    );
    encoded[0] = 0;
    expect(() => decodeRemoteSurfaceFrame(encoded)).toThrow(/magic/i);
  });

  it("validates remote browser control and navigation state", () => {
    expect(
      remoteBrowserClientMessageSchema.parse({
        type: "pointer",
        event: "down",
        x: 12,
        y: 24,
        button: "left",
      }),
    ).toMatchObject({ buttons: 0, deltaX: 0, deltaY: 0 });
    expect(
      remoteBrowserServerMessageSchema.parse({
        type: "browser-state",
        url: "about:blank",
        title: "",
        canGoBack: false,
        canGoForward: false,
        loading: true,
      }),
    ).toMatchObject({ url: "about:blank", loading: true });
    expect(
      remoteBrowserClientMessageSchema.parse({
        type: "touch",
        event: "start",
        points: [{ id: 1, x: 40, y: 80 }],
      }),
    ).toMatchObject({
      points: [{ id: 1, radiusX: 1, radiusY: 1, force: 1 }],
    });
    expect(
      remoteBrowserServerMessageSchema.parse({
        type: "browser-runtime",
        status: "recovering",
      }),
    ).toEqual({
      type: "browser-runtime",
      status: "recovering",
      message: null,
    });
    expect(
      remoteBrowserCursorMessageSchema.parse({
        type: "browser-cursor",
        cursor: "pointer",
      }).cursor,
    ).toBe("pointer");
    expect(
      remoteBrowserClipboardMessageSchema.parse({
        type: "browser-clipboard",
        operation: "copy-selection",
        text: "Cantrip",
      }).text,
    ).toBe("Cantrip");
  });

  it("accepts correlated agent activity from a worker", () => {
    const event = workerEventEnvelopeSchema.parse({
      kind: "event",
      requestId: "request-1",
      event: {
        type: "agent.activity",
        activity: {
          type: "fileChange",
          id: "change-1",
          status: "completed",
          changes: [{ path: "src/App.tsx", kind: "update" }],
        },
      },
    });

    expect(event.event.activity.type).toBe("fileChange");

    const reasoning = workerEventEnvelopeSchema.parse({
      kind: "event",
      requestId: "request-2",
      event: {
        type: "agent.activity",
        activity: {
          type: "reasoning",
          id: "reasoning-1",
          status: "completed",
          summary: ["Compared the two supported paths."],
          correlation: {
            sourceMethod: "item/completed",
            diagnosticId: "session-1:9",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "reasoning-1",
          },
        },
      },
    });
    expect(reasoning.event).toMatchObject({
      type: "agent.activity",
      activity: {
        type: "reasoning",
        correlation: { diagnosticId: "session-1:9" },
      },
    });

    expect(
      workerEventEnvelopeSchema.parse({
        kind: "event",
        requestId: "request-3",
        event: {
          type: "agent.message",
          message: {
            id: "message-1",
            text: "I’m checking the runtime contract.",
            phase: "commentary",
            correlation: null,
          },
        },
      }).event.type,
    ).toBe("agent.message");
  });

  it("validates interactive terminal frames", () => {
    expect(
      terminalClientMessageSchema.parse({
        type: "resize",
        cols: 120,
        rows: 40,
      }),
    ).toEqual({ type: "resize", cols: 120, rows: 40 });
    expect(
      terminalServerMessageSchema.parse({
        type: "output",
        data: "\u001b[32mready\u001b[0m",
      }).type,
    ).toBe("output");
    expect(
      workerEventEnvelopeSchema.parse({
        kind: "event",
        requestId: "terminal-request-1",
        event: { type: "terminal.ready" },
      }).event.type,
    ).toBe("terminal.ready");
    expect(
      workerCommandSchema.parse({
        type: "terminal.open",
        terminalId: "terminal-1",
        attachmentId: "attachment-1",
        cwd: "/workspace",
        cols: 120,
        rows: 40,
        launch: {
          type: "codex",
          threadId: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
          model: {
            id: "model-1",
            routeId: "route-1",
            name: "gpt-5.6-sol",
            reasoningEffort: "high",
          },
          provider: {
            id: "provider-1",
            name: "ChatGPT",
            kind: "chatgpt",
            baseUrl: "https://api.openai.com/v1",
            apiKey: null,
          },
        },
      }).launch.type,
    ).toBe("codex");
  });

  it("validates persisted prompt queues and live steering", () => {
    expect(
      queuedPromptSchema.parse({
        id: "prompt-1",
        chatId: "chat-1",
        text: "Focus on the failing test.",
        modelId: "model-1",
        worktreeId: null,
        position: 0,
        frozen: true,
        createdAt: "2026-08-07T12:00:00.000Z",
        updatedAt: "2026-08-07T12:00:00.000Z",
      }).frozen,
    ).toBe(true);
    expect(
      workerCommandSchema.parse({
        type: "chat.steer",
        chatId: "chat-1",
        threadId: null,
        prompt: "Focus on the failing test.",
        model: {
          id: "model-1",
          routeId: "route-1",
          name: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
        provider: {
          id: "provider-1",
          name: "ChatGPT",
          kind: "chatgpt",
          baseUrl: "https://api.openai.com/v1",
          apiKey: null,
        },
      }).type,
    ).toBe("chat.steer");
  });

  it("validates attachment-only turns and worker attachment commands", () => {
    expect(
      chatTurnCreateSchema.parse({
        attachmentIds: ["attachment-1"],
        idempotencyKey: "attachment-turn-1",
      }),
    ).toMatchObject({
      text: "",
      attachmentIds: ["attachment-1"],
      mode: "default",
    });
    expect(
      chatTurnCreateSchema.safeParse({
        text: "",
        attachmentIds: [],
        idempotencyKey: "empty-turn",
      }).success,
    ).toBe(false);
    expect(
      chatTurnCreateSchema.safeParse({
        attachmentIds: ["attachment-1"],
        mode: "goal",
        idempotencyKey: "attachment-goal",
      }).success,
    ).toBe(false);
    expect(
      chatTurnCreateSchema.parse({
        text: "Ship the feature",
        mode: "goal",
        idempotencyKey: "goal-turn",
      }).mode,
    ).toBe("goal");

    const attachment = chatAttachmentSummarySchema.parse({
      id: "attachment-1",
      chatId: "chat-1",
      fileName: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 12,
      kind: "image",
      source: "file",
      status: "ready",
      previewText: null,
      createdAt: "2026-08-08T12:00:00.000Z",
    });
    expect(attachment.kind).toBe("image");
    expect(
      workerCommandSchema.parse({
        type: "attachment.upload.chunk",
        chatId: "chat-1",
        attachmentId: attachment.id,
        chunkIndex: 0,
        data: Buffer.from("diagram").toString("base64"),
      }).type,
    ).toBe("attachment.upload.chunk");
    expect(
      workerCommandSchema.parse({
        type: "chat.turn",
        chatId: "chat-1",
        clientMessageId: "message-1",
        executionLaneId: "lane-1",
        worktreeId: "worktree-1",
        threadId: null,
        prompt: "Review the diagram.",
        attachments: [
          {
            id: attachment.id,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            kind: attachment.kind,
          },
        ],
        cwd: "/workspace",
        isPrimary: false,
        permissionProfileId: ":workspace",
        planMode: "default",
        worktreeMode: "agent-managed",
        worktreePolicy: "agent-managed",
        skillNames: [],
        model: {
          id: "model-1",
          routeId: "route-1",
          name: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
        provider: {
          id: "provider-1",
          name: "ChatGPT",
          kind: "chatgpt",
          baseUrl: "https://api.openai.com/v1",
          apiKey: null,
        },
      }).attachments,
    ).toHaveLength(1);
  });
});
