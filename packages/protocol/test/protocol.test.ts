import { describe, expect, it } from "vitest";

import {
  accountSessionListSchema,
  agentActivityRawRequestLimitBytes,
  agentActivityRawResponseLimitBytes,
  agentActivitySchema,
  agentTurnResultSchema,
  agentInteractionRequestQuerySchema,
  agentInteractionRequestSchema,
  agentInteractionRuntimeRequestSchema,
  agentInteractionResolutionCreateSchema,
  auditEventListSchema,
  auditEventQuerySchema,
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  codexExternalImportApplySchema,
  codexMcpOauthStatusSchema,
  codexMcpResourceReadRequestSchema,
  browserCreateSchema,
  browserUpdateSchema,
  browserServiceFleetDiscoverySchema,
  cantripAgentOperationRequestSchema,
  cantripAgentOperationResultSchema,
  compatibleWorkerCantripMcpOperationCallSchema,
  cantripMcpBindingSchema,
  cantripMcpBrowserNavigateInputSchema,
  cantripMcpClientFocusProjectInputSchema,
  cantripMcpClientFocusProjectResultSchema,
  cantripMcpClientFocusSurfaceInputSchema,
  cantripMcpClientNotifyInputSchema,
  cantripMcpClientNotifyResultSchema,
  cantripMcpClientShowInteractionInputSchema,
  clientControlCommandSchema,
  cantripMcpConnectionDocumentSchema,
  cantripMcpContextGetResultSchema,
  cantripMcpExplorerReadInputSchema,
  cantripMcpExplorerReadResultSchema,
  cantripMcpExplorerWriteInputSchema,
  cantripMcpExplorerWriteResultSchema,
  cantripMcpRunConfigurationGetInputSchema,
  cantripMcpRunConfigurationReadOutputInputSchema,
  cantripMcpRunConfigurationStartInputSchema,
  cantripMcpRunConfigurationStatusInputSchema,
  cantripMcpRunConfigurationStopInputSchema,
  cantripMcpTargetListInputSchema,
  cantripMcpTerminalReadInputSchema,
  cantripMcpToolHelpInputSchema,
  cantripMcpWorktreeSwitchResultSchema,
  cantripCliCommandRequestSchema,
  cantripCliCommandResultSchema,
  cantripVersionSchema,
  CANTRIP_MCP_READ_OPERATIONS,
  CANTRIP_MCP_READ_TOOL_NAMES,
  CANTRIP_MCP_CLIENT_CONTROL_OPERATIONS,
  CANTRIP_MCP_MUTATION_OPERATIONS,
  CANTRIP_MCP_MUTATION_TOOL_NAMES,
  CANTRIP_MCP_OPERATIONS,
  CANTRIP_MCP_TOOL_NAMES,
  WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL,
  WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL,
  WORKER_WEBSOCKET_SUBPROTOCOLS,
  cantripMcpOperationsForPermissionProfile,
  cantripMcpToolNamesForOperations,
  isCantripMcpMutationOperation,
  chatAttachmentSummarySchema,
  chatGptModelInventorySchema,
  chatCreateSchema,
  chatExecutionLaneSummarySchema,
  chatGoalCreateSchema,
  chatGoalResponseSchema,
  chatPlanAnswerSchema,
  chatPlanStateSchema,
  chatPauseStateSchema,
  chatPauseUpdateSchema,
  chatRelocationContextPayloadSchema,
  chatRelocationCreateSchema,
  chatRelocationJobSummarySchema,
  chatTurnCreateSchema,
  codeAttachmentCreateSchema,
  codeRuntimeStatusSchema,
  codeTabSummarySchema,
  decodeWorkerConnectionEnvelope,
  decodeWorkerRequestEnvelope,
  decodeWorkerServerEnvelope,
  decodeRemoteSurfaceFrame,
  desktopStreamSettingsSchema,
  encodeRemoteSurfaceFrame,
  encodeWorkerConnectionEnvelope,
  encodeWorkerRequestEnvelope,
  encodeWorkerServerEnvelope,
  executionPlacementSchema,
  executionPlacementResolveRequestSchema,
  executionPlacementResolutionSchema,
  executionTargetCatalogSchema,
  executionTargetResolutionSchema,
  executionTargetResolveRequestSchema,
  executionTargetSchema,
  externalChatDiscoveryWorkerResultSchema,
  isManagedMcpName,
  projectExternalChatDiscoverySchema,
  modelProviderAccountSummarySchema,
  providerAccessTokenLeaseRequestSchema,
  providerAccessTokenLeaseSchema,
  providerLegacyCredentialCaptureResultSchema,
  providerAuthLiveStatusSchema,
  providerAuthStatusObservationSchema,
  settingsBundleSchema,
  providerModelCatalogEntrySchema,
  reasoningEffortSchema,
  explorerFileWriteSchema,
  explorerEntryNameSchema,
  explorerOperationRequestContentSchema,
  explorerMediaTypeForPath,
  remoteBrowserClipboardMessageSchema,
  remoteBrowserClientMessageSchema,
  remoteBrowserCursorMessageSchema,
  remoteBrowserServerMessageSchema,
  remoteSurfaceConnectionMessageSchema,
  remoteSurfaceWebRtcConfigurationSchema,
  remoteSurfaceWebRtcSignalSchema,
  gitActionSchema,
  gitAgentDraftCreateSchema,
  gitAgentDraftResultSchema,
  gitBranchActionPreviewSchema,
  gitBranchListSchema,
  gitBisectActionSchema,
  gitCommitActionPreviewSchema,
  gitCommitActionResultSchema,
  gitCommitSearchQuerySchema,
  gitCommitSearchResultSchema,
  gitConflictDetailSchema,
  gitConflictResolutionRequestSchema,
  gitManagedOperationPreviewSchema,
  gitManagedOperationControlSchema,
  gitManagedOperationRecordSchema,
  gitRemoteActionPreviewSchema,
  gitRemoteListSchema,
  gitRecoveryActionSchema,
  gitRecoveryCandidateListSchema,
  gitRecoveryPreviewSchema,
  gitCommitDetailSchema,
  gitComparisonSchema,
  gitFileDiffSchema,
  gitFileHistorySchema,
  gitBlameSchema,
  gitForcePushPreviewSchema,
  gitLfsActionPreviewSchema,
  gitLfsStatusSchema,
  gitPartialPatchPreviewSchema,
  gitStashActionPreviewSchema,
  gitStashCreateSchema,
  gitStashListSchema,
  gitStashMutationResultSchema,
  gitSubmoduleActionPreviewSchema,
  gitSubmoduleListSchema,
  gitTagActionPreviewSchema,
  gitTagListSchema,
  githubReleaseCreateSchema,
  githubIssueCreateSchema,
  githubPullRequestCreateResultSchema,
  githubPullRequestCheckoutPreparedSchema,
  githubPullRequestDetailSchema,
  githubPullRequestLifecyclePreviewSchema,
  githubReleaseListSchema,
  githubRepositoryCreateSchema,
  githubRepositoryOwnerListSchema,
  gitRevisionFileDiffSchema,
  gitRevisionCandidateListSchema,
  mentionedSkillNames,
  MAX_ELITE_GLITCH_COUNT,
  MIN_SIDEBAR_WIDTH,
  isZaiCodingPlanBaseUrl,
  normalizeResponsesBaseUrl,
  chatPermissionProfileStateSchema,
  queuedPromptSchema,
  projectReplicaJobSummarySchema,
  projectReplicaListSchema,
  projectSummarySchema,
  projectWorkspaceCreateSchema,
  projectWorkspaceSummarySchema,
  projectWorkspaceUpdateSchema,
  projectWorktreeSummarySchema,
  projectTabLayoutSummarySchema,
  projectTabLayoutWireSummarySchema,
  projectTokenUsageSchema,
  remoteDesktopCreateSchema,
  encryptedRemoteDesktopCreateSchema,
  encryptedRemoteDesktopUpdateSchema,
  remoteDesktopFleetSchema,
  remoteDesktopClientMessageSchema,
  remoteDesktopServerMessageSchema,
  remoteDesktopSummarySchema,
  remoteDesktopWireSummarySchema,
  remoteDesktopTargetInventorySchema,
  operationalProbeSchema,
  scriptCommandListSchema,
  serverBootstrapSchema,
  systemHealthSchema,
  terminalClientMessageSchema,
  terminalCreateSchema,
  terminalServiceConfigurationSchema,
  terminalSnapshotResultSchema,
  terminalSummarySchema,
  terminalServerMessageSchema,
  tabGroupMemberMoveSchema,
  tabGroupMemberOrderSchema,
  tabGroupOrderSchema,
  encryptedTabGroupUpdateSchema,
  tabGroupUpdateSchema,
  nativeSubagentCapabilityCompatible,
  codexRuntimeReportSchema,
  NATIVE_SUBAGENT_PROTOCOL_VERSION,
  unprobedCodexRuntimeReport,
  DEFAULT_ELITE_REVEAL_CONFIG,
  userSettingsSchema,
  userSettingsUpdateSchema,
  workerCommandSchema,
  workerEventSchema,
  inferenceProgressSnapshotSchema,
  workerNotificationSchema,
  workerProjectShareDescriptorSchema,
  workerProjectShareOpenResultSchema,
  worktreeCreateMutationFailureSchema,
  worktreeInventorySchema,
  workerEventEnvelopeSchema,
  workerHeartbeatSchema,
  workerCredentialSummarySchema,
  workerEnrollmentCodeResultSchema,
  workerEnrollmentCodeStatusSchema,
  workerEnrollmentExchangeSchema,
  workerManagementSummarySchema,
  workerNotificationEnvelopeSchema,
  workerCliCommandCallSchema,
  type PrivateDisplayLabelRecordKind,
} from "../src/index.js";

function protectedLabelFixture(recordKind: PrivateDisplayLabelRecordKind) {
  return {
    classification: { recordKind },
    protectedLabel: {
      formatVersion: 1 as const,
      keyRevision: 1,
      envelope: {
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  };
}

function terminalStateFixture() {
  return {
    classification: { recordKind: "terminal-state" as const },
    protectedState: {
      formatVersion: 1 as const,
      keyRevision: 1,
      envelope: {
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  };
}

function workflowContentFixture() {
  return terminalStateFixture().protectedState;
}

function customizationContentFixture() {
  return {
    ...terminalStateFixture().protectedState,
    domain: "customization-content" as const,
  };
}

function protectedChatMessageFixture() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    classification: {
      role: "assistant" as const,
      mode: "default" as const,
      attachmentIds: [],
    },
    protectedContent: workflowContentFixture(),
    reasoningEffort: null,
    idempotencyKey: "protected-usage-message",
  };
}

function attachmentChunkFixture() {
  return {
    sequence: 0,
    plaintextBytes: 7,
    eof: true,
    envelope: workflowContentFixture().envelope,
  };
}

function browserStateFixture() {
  return {
    classification: { recordKind: "browser-state" as const },
    protectedState: terminalStateFixture().protectedState,
  };
}

function remoteDesktopStateFixture() {
  return {
    classification: { recordKind: "remote-desktop-state" as const },
    protectedState: terminalStateFixture().protectedState,
  };
}

function remoteDesktopInventoryFixture() {
  return {
    classification: { recordKind: "remote-desktop-inventory" as const },
    protectedState: terminalStateFixture().protectedState,
  };
}

describe("worker channel JSON codec", () => {
  it("accepts a worker restart control command", () => {
    expect(workerCommandSchema.parse({ type: "worker.restart" })).toEqual({
      type: "worker.restart",
    });
  });

  it("validates worker-derived managed folder commands", () => {
    expect(
      workerCommandSchema.parse({
        type: "project.folder.materialize",
        jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb339",
        attempt: 1,
        projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
        displayName: "Scratch prototype",
      }),
    ).not.toHaveProperty("path");
    expect(
      workerCommandSchema.parse({
        type: "project.folder.materialize",
        jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb339",
        attempt: 1,
        projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
        displayName: "Existing project",
        existingPath: "C:\\code\\existing-project",
      }),
    ).toMatchObject({ existingPath: "C:\\code\\existing-project" });
    expect(
      workerCommandSchema.parse({
        type: "project.folder.delete",
        projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
      }),
    ).toEqual({
      type: "project.folder.delete",
      projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
    });
    expect(
      workerCommandSchema.safeParse({
        type: "project.folder.delete",
        projectId: "../outside",
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.parse({
        type: "project.folder-conversion.preflight",
        projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
        repository: {
          repositoryId: "42",
          nameWithOwner: "ArcaneArts/Scratch",
          url: "https://github.com/ArcaneArts/Scratch",
        },
      }),
    ).not.toHaveProperty("path");
    expect(
      workerCommandSchema.parse({
        type: "project.folder-conversion.execute",
        jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb339",
        attempt: 1,
        projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
        repository: {
          repositoryId: "42",
          nameWithOwner: "ArcaneArts/Scratch",
          url: "https://github.com/ArcaneArts/Scratch",
        },
        confirmationToken: "a".repeat(64),
        initialCommit: { message: "Initial commit" },
      }),
    ).not.toHaveProperty("path");
  });

  it("exports stable worker WebSocket subprotocols in compatibility order", () => {
    expect(WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL).toBe("cantrip-worker-legacy");
    expect(WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL).toBe(
      "cantrip-worker-auth-ready-v1",
    );
    expect(WORKER_WEBSOCKET_SUBPROTOCOLS).toEqual([
      "cantrip-worker-legacy",
      "cantrip-worker-auth-ready-v1",
    ]);
  });

  it("round-trips request and server envelopes", () => {
    const request = {
      kind: "request" as const,
      requestId: "request-codec",
      command: { type: "code.probe" as const },
    };
    const response = {
      kind: "response" as const,
      requestId: "request-codec",
      ok: true as const,
      result: { available: true },
    };

    expect(
      decodeWorkerRequestEnvelope(encodeWorkerRequestEnvelope(request)),
    ).toEqual({ data: request, success: true });
    expect(
      decodeWorkerServerEnvelope(encodeWorkerServerEnvelope(response)),
    ).toEqual({ data: response, success: true });
  });

  it("round-trips strict worker connection readiness envelopes", () => {
    const connection = {
      kind: "connection" as const,
      state: "ready" as const,
      protocolVersion: 1 as const,
      connectionGeneration: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
    };

    expect(
      decodeWorkerConnectionEnvelope(
        encodeWorkerConnectionEnvelope(connection),
      ),
    ).toEqual({ data: connection, success: true });
    expect(
      decodeWorkerConnectionEnvelope(
        JSON.stringify({ ...connection, authenticated: true }),
      ),
    ).toMatchObject({ reason: "invalid-message", success: false });
    expect(
      decodeWorkerConnectionEnvelope(
        JSON.stringify({ ...connection, protocolVersion: 2 }),
      ),
    ).toMatchObject({ reason: "invalid-message", success: false });
  });

  it("round-trips durable agent turn outcomes", () => {
    const notification = workerNotificationEnvelopeSchema.parse({
      kind: "notification",
      notification: {
        type: "chat.turn.outcome",
        chatId: "chat-1",
        clientMessageId: "message-1",
        executionLaneId: "lane-1",
        worktreeId: "worktree-1",
        outcome: {
          ok: true,
          result: {
            threadId: "thread-1",
            turnId: "turn-1",
            text: "Completed",
            status: "completed",
          },
        },
      },
    });

    expect(
      decodeWorkerServerEnvelope(encodeWorkerServerEnvelope(notification)),
    ).toEqual({ data: notification, success: true });
  });

  it("round-trips bounded external thread change notifications", () => {
    const notification = workerNotificationEnvelopeSchema.parse({
      kind: "notification",
      notification: {
        type: "chat.thread.changed",
        threadId: "thread-1",
        revision: 42,
        changes: ["turn", "goal"],
      },
    });

    expect(
      decodeWorkerServerEnvelope(encodeWorkerServerEnvelope(notification)),
    ).toEqual({ data: notification, success: true });
    expect(() =>
      workerNotificationEnvelopeSchema.parse({
        kind: "notification",
        notification: {
          type: "chat.thread.changed",
          threadId: "thread-1",
          revision: 43,
          changes: ["turn", "goal", "queue", "plan", "turn"],
        },
      }),
    ).toThrow();
  });

  it("distinguishes invalid JSON from an invalid worker envelope", () => {
    expect(decodeWorkerServerEnvelope("{")).toEqual({
      reason: "invalid-json",
      success: false,
    });
    expect(decodeWorkerServerEnvelope('{"kind":"unknown"}')).toEqual({
      reason: "invalid-message",
      success: false,
      value: { kind: "unknown" },
    });
  });
});

describe("model catalog protocol", () => {
  it("accepts settings from servers that predate managed model catalogs", () => {
    const parsed = settingsBundleSchema.parse({
      preferences: {
        theme: "system",
        highContrast: false,
        proMode: false,
        proModeOpacity: 80,
        sidebarWidth: 288,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: "model-1",
      },
      providers: [
        {
          id: "provider-1",
          name: "Ollama",
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          hasApiKey: false,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      models: [
        {
          id: "model-1",
          name: "gemma4:12b",
          routingPolicy: "priority",
          routes: [
            {
              id: "route-1",
              providerId: "provider-1",
              providerName: "Ollama",
              modelName: "gemma4:12b",
              enabled: true,
              position: 0,
            },
          ],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });

    expect(parsed.providers[0]).toMatchObject({
      weeklyUsageReservePercent: 3,
      accounts: [],
    });
    expect(parsed.models[0]).toMatchObject({
      canonicalModelId: null,
      discoveryManaged: false,
      routes: [
        expect.objectContaining({
          providerModelId: null,
          discoveryManaged: false,
        }),
      ],
    });
  });

  it("accepts native ChatGPT Codex model inventory", () => {
    const inventory = chatGptModelInventorySchema.parse({
      models: [
        {
          id: "gpt-5.6-sol-medium",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          description: "Codex model",
          hidden: false,
          isDefault: true,
          inputModalities: ["text", "image"],
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Balanced" },
          ],
          defaultReasoningEffort: "medium",
          modelSpecialty: "coding",
          supportsPersonality: true,
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
        },
      ],
      observedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(inventory.models[0]?.model).toBe("gpt-5.6-sol");
    expect(
      workerCommandSchema.parse({
        type: "model.chatgpt.catalog",
        provider: {
          id: "provider-1",
          name: "ChatGPT",
          kind: "chatgpt",
          baseUrl: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: null,
          accountId: "account-1",
          credentialHomeKey: "account-1",
        },
      }).type,
    ).toBe("model.chatgpt.catalog");
    expect(
      workerCommandSchema.parse({
        type: "provider.rate-limit-reset.consume",
        provider: {
          id: "provider-1",
          name: "ChatGPT",
          kind: "chatgpt",
          baseUrl: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: null,
          accountId: "account-1",
          credentialHomeKey: "account-1",
        },
        idempotencyKey: "ea13cab0-8573-4df4-9ef6-452507aab71f",
        creditId: "reset-1",
      }),
    ).toMatchObject({
      type: "provider.rate-limit-reset.consume",
      creditId: "reset-1",
    });
    expect(
      workerCommandSchema.safeParse({
        type: "provider.rate-limit-reset.consume",
        provider: {
          id: "provider-1",
          name: "Grok",
          kind: "grok",
          baseUrl: "https://cli-chat-proxy.grok.com/v1",
          apiKey: null,
          accountId: "account-1",
          credentialHomeKey: "account-1",
        },
        idempotencyKey: "ea13cab0-8573-4df4-9ef6-452507aab71f",
      }).success,
    ).toBe(false);
  });

  it("preserves provider-advertised reasoning efforts", () => {
    expect(reasoningEffortSchema.parse("ultra")).toBe("ultra");
    expect(reasoningEffortSchema.parse("provider-future-effort")).toBe(
      "provider-future-effort",
    );
    expect(reasoningEffortSchema.safeParse("").success).toBe(false);
  });

  it("accepts normalized catalog and pooled-account records", () => {
    expect(
      providerModelCatalogEntrySchema.parse({
        id: "provider-model-1",
        providerId: "provider-1",
        nativeModelId: "gemma4:12b",
        canonicalModelId: null,
        displayName: "gemma4:12b",
        description: null,
        contextWindow: 131_072,
        maxOutputTokens: null,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsTools: true,
        supportsParallelTools: null,
        supportsStructuredOutput: null,
        supportsVision: false,
        supportsReasoning: true,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        reasoningMandatory: null,
        family: "gemma",
        parameterSize: "12B",
        quantization: "Q4_K_M",
        digest: "sha256:test",
        metadataSource: "ollama",
        matchConfidence: null,
        hidden: false,
        isDefault: false,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        lastSeenAt: "2026-08-14T00:00:00.000Z",
      }).contextWindow,
    ).toBe(131_072);
    const account = modelProviderAccountSummarySchema.parse({
      id: "account-1",
      providerId: "provider-1",
      label: "Personal",
      email: "user@example.com",
      planType: "pro",
      position: 0,
      enabled: true,
      credentialState: "signed-in",
      weeklyUsageUsedPercent: 42.5,
      weeklyUsageResetsAt: "2026-08-21T00:00:00.000Z",
      authLastSyncedAt: "2026-08-14T00:00:00.000Z",
      workerBindings: [
        {
          workerId: "worker-1",
          authState: "signed-in",
          weeklyUsageUsedPercent: 42.5,
          weeklyUsageResetsAt: "2026-08-21T00:00:00.000Z",
          lastSyncedAt: "2026-08-14T00:00:00.000Z",
        },
      ],
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(account.weeklyUsageUsedPercent).toBe(42.5);
    expect(account.workerBindings[0]?.weeklyUsageUsedPercent).toBe(42.5);
  });
});

describe("Cantrip protocol", () => {
  it("validates bounded transport-neutral agent operations", () => {
    expect(
      cantripAgentOperationRequestSchema.parse({
        operation: "terminal.send",
        arguments: { target: "Build", sequence: 1 },
      }),
    ).toEqual({
      operation: "terminal.send",
      arguments: { target: "Build", sequence: 1 },
    });
    expect(
      cantripAgentOperationResultSchema.parse({ summary: "Sent input." }),
    ).toMatchObject({
      continuationScheduled: false,
      mutated: false,
      target: null,
      worktreeId: null,
    });
    expect(
      cantripAgentOperationRequestSchema.safeParse({
        operation: "shell.run",
        arguments: {},
      }).success,
    ).toBe(false);
  });

  it("validates expiring MCP bindings and reserves managed names", () => {
    const binding = cantripMcpBindingSchema.parse({
      bindingId: "00000000-0000-4000-8000-000000000001",
      ownerId: "owner-one",
      projectId: "project-one",
      chatId: "chat-one",
      executionLaneId: "lane-one",
      workerId: "worker-one",
      worktreeId: "worktree-one",
      rootKind: "git-worktree",
      permissionProfileId: ":workspace-write",
      allowedOperations: ["context.get"],
      issuedAt: "2026-08-21T12:00:00.000Z",
      expiresAt: "2026-08-21T18:00:00.000Z",
    });
    expect(binding.allowedOperations).toEqual(["context.get"]);
    expect(
      cantripMcpBindingSchema.safeParse({
        ...binding,
        canonicalRoot: "/private/worktree/path",
      }).success,
    ).toBe(false);
    expect(
      cantripMcpConnectionDocumentSchema.parse({
        protocolVersion: 1,
        endpoint: "http://127.0.0.1:43123",
        bindingId: binding.bindingId,
        credential: "A".repeat(43),
        expiresAt: binding.expiresAt,
      }),
    ).not.toHaveProperty("ownerId");
    expect(isManagedMcpName(" CANTRIP ")).toBe(true);
    expect(isManagedMcpName("CodeGraph")).toBe(true);
    expect(isManagedMcpName("database")).toBe(false);
    expect(
      cantripMcpBindingSchema.safeParse({
        ...binding,
        expiresAt: "2026-08-23T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("normalizes legacy MCP relay bindings without trusting legacy claims", () => {
    const call = compatibleWorkerCantripMcpOperationCallSchema.parse({
      requestId: "request-one",
      binding: {
        bindingId: "00000000-0000-4000-8000-000000000001",
        ownerId: "owner-one",
        projectId: "project-one",
        chatId: "chat-one",
        executionLaneId: "lane-one",
        workerId: "worker-one",
        worktreeId: "worktree-one",
        canonicalRoot: `ctrr_${"A".repeat(43)}`,
        rootKind: "git-worktree",
        permissionProfileId: ":workspace-write",
        allowedOperations: ["context.get", "future.operation"],
        issuedAt: "2026-08-21T12:00:00.000Z",
        expiresAt: "2026-08-21T18:00:00.000Z",
        futureClaim: "must-not-survive",
      },
      request: { operation: "context.get", arguments: {} },
    });

    expect(call.binding.allowedOperations).toEqual(["context.get"]);
    expect(call.binding).not.toHaveProperty("canonicalRoot");
    expect(call.binding).not.toHaveProperty("futureClaim");
  });

  it("bounds the read-only MCP catalog with operation-specific schemas", () => {
    expect(CANTRIP_MCP_READ_OPERATIONS).toHaveLength(
      CANTRIP_MCP_READ_TOOL_NAMES.length,
    );
    expect(
      cantripMcpToolHelpInputSchema.parse({ tool: "worktree_create" }),
    ).toEqual({ tool: "worktree_create" });
    expect(
      cantripMcpToolHelpInputSchema.safeParse({ tool: "shell" }).success,
    ).toBe(false);
    expect(cantripMcpTargetListInputSchema.parse({})).toEqual({
      cursor: 0,
      limit: 100,
    });
    expect(
      cantripMcpTargetListInputSchema.safeParse({ limit: 201 }).success,
    ).toBe(false);
    expect(
      cantripMcpExplorerReadInputSchema.safeParse({
        target: {
          kind: "surface",
          projectId: "project-one",
          surfaceKind: "explorer",
          surfaceId: "explorer-one",
        },
        path: "README.md",
        maxChars: 200_001,
      }).success,
    ).toBe(false);
    expect(
      cantripMcpTerminalReadInputSchema.safeParse({
        target: {
          kind: "surface",
          projectId: "project-one",
          surfaceKind: "terminal",
          surfaceId: "terminal-one",
        },
        maxChars: 100_001,
      }).success,
    ).toBe(false);
    const configurationId = "00000000-0000-4000-8000-000000000098";
    expect(
      cantripMcpRunConfigurationGetInputSchema.parse({ configurationId }),
    ).toEqual({ configurationId });
    expect(cantripMcpRunConfigurationGetInputSchema.safeParse({}).success).toBe(
      false,
    );
    expect(cantripMcpRunConfigurationStatusInputSchema.parse({})).toEqual({
      configurationId: null,
      worktreeId: null,
      limit: 256,
    });
    expect(
      cantripMcpRunConfigurationReadOutputInputSchema.parse({
        operationId: "00000000-0000-4000-8000-000000000099",
        configurationId,
      }),
    ).toMatchObject({ worktreeId: null, tail: 10_000 });
    expect(
      cantripMcpRunConfigurationReadOutputInputSchema.safeParse({
        operationId: "00000000-0000-4000-8000-000000000099",
        configurationId,
        tail: 100_001,
      }).success,
    ).toBe(false);
    expect(
      cantripMcpContextGetResultSchema.parse({
        summary: "Context is current.",
        data: {
          worker: { id: "worker-one", name: "Worker", online: true },
          context: {
            chatId: "chat-one",
            executionLaneId: "lane-one",
            permissionProfileId: ":workspace-write",
            projectId: "project-one",
            rootKind: "git-worktree",
            terminalId: null,
            workerId: "worker-one",
            worktreeId: "worktree-one",
            worktreeMode: "agent-managed",
          },
          binding: {
            status: "ready",
            mutationReady: true,
            staleClaims: [],
            recoveryInstruction: null,
            expiresAt: "2026-08-21T18:00:00.000Z",
          },
        },
      }).data.binding,
    ).toMatchObject({ status: "ready", mutationReady: true });
    expect(
      cantripMcpContextGetResultSchema.safeParse({
        summary: "Context is current.",
        data: {
          worker: { id: "worker-one", name: "Worker", online: true },
          context: {
            chatId: "chat-one",
            executionLaneId: "lane-one",
            permissionProfileId: ":read-only",
            projectId: "project-one",
            rootKind: "git-worktree",
            terminalId: null,
            workerId: "worker-one",
            worktreeId: "worktree-one",
            worktreeMode: "agent-managed",
            canonicalRoot: "/private/worktree/path",
          },
          binding: {
            status: "ready",
            mutationReady: true,
            staleClaims: [],
            recoveryInstruction: null,
            expiresAt: "2026-08-21T18:00:00.000Z",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      cantripMcpExplorerReadResultSchema.safeParse({
        summary: "Read README.md.",
        target: {
          kind: "surface",
          projectId: "project-one",
          surfaceKind: "explorer",
          surfaceId: "explorer-one",
        },
        worktreeId: "worktree-one",
        continuationScheduled: false,
        mutated: true,
        data: {
          path: "README.md",
          content: "content",
          size: 7,
          markdown: true,
          version: "a".repeat(64),
          truncated: false,
        },
      }).success,
    ).toBe(false);
  });

  it("bounds mutation tools and gates their operation catalog by permission", () => {
    expect(CANTRIP_MCP_MUTATION_OPERATIONS).toHaveLength(
      CANTRIP_MCP_MUTATION_TOOL_NAMES.length,
    );
    expect(CANTRIP_MCP_OPERATIONS).toHaveLength(CANTRIP_MCP_TOOL_NAMES.length);
    expect(cantripMcpOperationsForPermissionProfile(":read-only")).toEqual(
      CANTRIP_MCP_READ_OPERATIONS,
    );
    expect(cantripMcpOperationsForPermissionProfile(":workspace")).toEqual(
      CANTRIP_MCP_OPERATIONS,
    );
    expect(
      cantripMcpToolNamesForOperations(
        cantripMcpOperationsForPermissionProfile(":read-only"),
      ),
    ).toEqual(CANTRIP_MCP_READ_TOOL_NAMES);
    expect(cantripMcpToolNamesForOperations(CANTRIP_MCP_OPERATIONS)).toEqual(
      CANTRIP_MCP_TOOL_NAMES,
    );
    expect(
      CANTRIP_MCP_MUTATION_OPERATIONS.every(isCantripMcpMutationOperation),
    ).toBe(true);
    expect(isCantripMcpMutationOperation("context.get")).toBe(false);
    expect(isCantripMcpMutationOperation("run-configuration.start")).toBe(true);
    expect(isCantripMcpMutationOperation("run-configuration.restart")).toBe(
      true,
    );
    expect(isCantripMcpMutationOperation("run-configuration.stop")).toBe(true);
    expect(CANTRIP_MCP_READ_OPERATIONS).toEqual(
      expect.arrayContaining([
        "run-configuration.list",
        "run-configuration.get",
        "run-configuration.status",
        "run-configuration.read-output",
      ]),
    );
    expect(CANTRIP_MCP_MUTATION_OPERATIONS).toEqual(
      expect.arrayContaining([
        "run-configuration.start",
        "run-configuration.restart",
        "run-configuration.stop",
      ]),
    );
    expect(cantripMcpOperationsForPermissionProfile(":read-only")).not.toEqual(
      expect.arrayContaining([
        "run-configuration.start",
        "run-configuration.restart",
        "run-configuration.stop",
      ]),
    );
    const operationId = "00000000-0000-4000-8000-000000000099";
    const configurationId = "00000000-0000-4000-8000-000000000098";
    expect(
      cantripMcpRunConfigurationStartInputSchema.parse({
        operationId,
        configurationId,
      }),
    ).toEqual({ operationId, configurationId, worktreeId: null });
    expect(
      cantripMcpRunConfigurationStartInputSchema.safeParse({
        operationId,
        configuration: "Run Spectral Lab",
      }).success,
    ).toBe(false);
    expect(
      cantripMcpRunConfigurationStopInputSchema.safeParse({
        operationId,
        configurationId: "not-a-configuration-id",
      }).success,
    ).toBe(false);
    expect(CANTRIP_MCP_CLIENT_CONTROL_OPERATIONS).toEqual([
      "client.notify",
      "client.focus-project",
      "client.focus-surface",
      "client.show-interaction",
    ]);
    const target = {
      kind: "surface" as const,
      projectId: "project-one",
      surfaceKind: "explorer" as const,
      surfaceId: "explorer-one",
    };
    expect(
      cantripMcpExplorerWriteInputSchema.safeParse({
        target,
        path: "README.md",
        content: "x".repeat(200_001),
        version: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      cantripMcpBrowserNavigateInputSchema.safeParse({
        target: { ...target, surfaceKind: "browser" },
        url: "file:///private/secret",
      }).success,
    ).toBe(false);
    expect(
      cantripMcpExplorerWriteResultSchema.safeParse({
        summary: "Saved README.md.",
        target,
        worktreeId: "worktree-one",
        continuationScheduled: false,
        mutated: false,
        data: {
          path: "README.md",
          size: 7,
          markdown: true,
          version: "b".repeat(64),
        },
      }).success,
    ).toBe(false);
    expect(
      cantripMcpWorktreeSwitchResultSchema.safeParse({
        summary: "Continuation scheduled.",
        target: {
          kind: "worktree",
          projectId: "project-one",
          worktreeId: "worktree-two",
        },
        worktreeId: "worktree-two",
        continuationScheduled: false,
        mutated: true,
        data: {},
      }).success,
    ).toBe(false);
  });

  it("bounds client-control inputs and status-specific mutation results", () => {
    expect(cantripMcpClientFocusProjectInputSchema.parse({})).toEqual({});
    expect(
      cantripMcpClientNotifyInputSchema.safeParse({
        level: "info",
        title: "Ready",
        message: "x".repeat(2_001),
      }).success,
    ).toBe(false);
    const target = {
      kind: "surface" as const,
      projectId: "project-one",
      surfaceKind: "terminal" as const,
      surfaceId: "terminal-one",
    };
    expect(cantripMcpClientFocusSurfaceInputSchema.parse({ target })).toEqual({
      target,
    });
    expect(
      cantripMcpClientShowInteractionInputSchema.safeParse({
        interactionId: "",
      }).success,
    ).toBe(false);
    const unavailable = {
      summary: "No compatible client is connected.",
      target: { kind: "project" as const, projectId: "project-one" },
      worktreeId: "worktree-one",
      continuationScheduled: false as const,
      mutated: false,
      data: {
        correlationId: "00000000-0000-4000-8000-000000000001",
        status: "unavailable" as const,
      },
    };
    expect(cantripMcpClientFocusProjectResultSchema.parse(unavailable)).toEqual(
      unavailable,
    );
    expect(
      cantripMcpClientNotifyResultSchema.safeParse({
        ...unavailable,
        mutated: true,
      }).success,
    ).toBe(false);
  });

  it("validates CLI commands across the local broker and server boundary", () => {
    const request = cantripCliCommandRequestSchema.parse({
      command: "explorer.read",
      context: {
        codexThreadId: "thread-one",
        terminalId: null,
        cwd: "/workspace/project",
      },
      arguments: { path: "README.md", target: "Docs" },
    });
    expect(
      workerCliCommandCallSchema.parse({
        ...request,
        chatContext: {
          chatId: "chat-one",
          executionLaneId: "lane-one",
        },
        requestId: "request-one",
        workerId: "worker-one",
      }),
    ).toMatchObject({
      command: "explorer.read",
      chatContext: { chatId: "chat-one", executionLaneId: "lane-one" },
      context: { codexThreadId: "thread-one", selection: "auto" },
      workerId: "worker-one",
    });
    expect(
      cantripCliCommandRequestSchema.parse({
        command: "run.create",
        context: { ...request.context, selection: "cwd" },
        arguments: { document: { id: "opaque-to-the-envelope" } },
      }).context.selection,
    ).toBe("cwd");
    expect(
      cantripCliCommandResultSchema.parse({ summary: "Read README.md." }),
    ).toMatchObject({
      continuationScheduled: false,
      mutated: false,
      target: null,
      worktreeId: null,
    });
    expect(
      cantripCliCommandRequestSchema.parse({
        command: "policy.read",
        context: request.context,
        arguments: { key: "manual-change-protocol" },
      }),
    ).toMatchObject({
      command: "policy.read",
      arguments: { key: "manual-change-protocol" },
    });
  });

  it("keeps project replica contracts compatible across rolling clients", () => {
    const legacy = {
      id: "project-one",
      name: "Cantrip",
      position: 0,
      setupStatus: "ready",
      setupError: null,
      worktreePolicy: "agent-managed",
      github: null,
      source: {
        id: "source-one",
        workerId: "worker-one",
        path: "/srv/cantrip",
        displayPath: "Cantrip",
      },
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
    };
    const parsedLegacy = projectSummarySchema.parse(legacy);
    expect(parsedLegacy.replicas).toEqual([]);
    expect(parsedLegacy.originKind).toBe("github");
    expect(parsedLegacy.capabilities).toEqual({
      git: true,
      github: true,
      worktrees: true,
      replicas: true,
      relocation: true,
    });
    expect(parsedLegacy.source?.sourceKind).toBe("git");
    expect(
      projectSummarySchema.parse(legacy).preferredWorkerId,
    ).toBeUndefined();

    const replicas = projectReplicaListSchema.parse([
      {
        id: "source-one",
        projectId: "project-one",
        workerId: "worker-one",
        workerName: "Desk Mac",
        workerOnline: true,
        path: "/srv/cantrip",
        displayPath: "Cantrip",
        repositoryFingerprint: null,
        primaryWorktreeId: "primary:source-one",
        branch: "main",
        head: "abc123",
        dirty: false,
        ready: true,
        worktreeCount: 1,
        lastObservedAt: null,
        createdAt: "2026-08-11T12:00:00.000Z",
        updatedAt: "2026-08-11T12:00:00.000Z",
      },
    ]);
    expect(projectSummarySchema.parse({ ...legacy, replicas }).source).toEqual({
      ...legacy.source,
      sourceKind: "git",
      placementMode: "managed",
      ownershipKind: "cantrip",
      requestedPath: null,
      linkPath: null,
    });
  });

  it("validates authoritative managed-folder project capabilities", () => {
    const folder = projectSummarySchema.parse({
      id: "folder-project",
      name: "Scratch prototype",
      position: 1,
      originKind: "managed-folder",
      capabilities: {
        git: false,
        github: false,
        worktrees: false,
        replicas: false,
        relocation: false,
      },
      setupStatus: "preparing",
      setupError: null,
      worktreePolicy: "direct",
      preferredWorkerId: "worker-one",
      github: null,
      source: null,
      replicas: [],
      createdAt: "2026-08-18T12:00:00.000Z",
      updatedAt: "2026-08-18T12:00:00.000Z",
    });
    expect(folder.originKind).toBe("managed-folder");
    expect(folder.capabilities.git).toBe(false);
    expect(
      projectSummarySchema.safeParse({
        ...folder,
        capabilities: { ...folder.capabilities, git: true },
      }).success,
    ).toBe(false);
  });

  it("validates resolved execution placements and untrusted target selectors", () => {
    expect(
      executionPlacementSchema.parse({
        projectId: "project-one",
        workerId: "worker-two",
        projectReplicaId: "replica-two",
        worktreeId: "worktree-three",
        surface: {
          kind: "terminal",
          id: "terminal-four",
        },
      }),
    ).toMatchObject({
      workerId: "worker-two",
      projectReplicaId: "replica-two",
      worktreeId: "worktree-three",
    });
    expect(
      executionPlacementSchema.safeParse({
        projectId: "project-one",
        workerId: "worker-two",
        projectReplicaId: null,
        worktreeId: "worktree-three",
        surface: null,
      }).success,
    ).toBe(false);

    expect(
      executionTargetSchema.parse({
        kind: "surface",
        projectId: "project-one",
        surfaceKind: "terminal",
        surfaceId: "terminal-four",
      }),
    ).toEqual({
      kind: "surface",
      projectId: "project-one",
      surfaceKind: "terminal",
      surfaceId: "terminal-four",
    });
    for (const target of [
      { kind: "project", projectId: "project-one" },
      {
        kind: "worker",
        projectId: "project-one",
        workerId: "worker-two",
      },
      {
        kind: "replica",
        projectId: "project-one",
        projectReplicaId: "replica-two",
      },
      {
        kind: "worktree",
        projectId: "project-one",
        worktreeId: "worktree-three",
      },
    ]) {
      expect(executionTargetSchema.safeParse(target).success).toBe(true);
    }
    expect(
      executionTargetSchema.safeParse({
        kind: "surface",
        projectId: "project-one",
        surfaceKind: "terminal",
        surfaceId: "terminal-four",
        workerId: "untrusted-worker-claim",
      }).success,
    ).toBe(false);

    expect(
      executionPlacementResolveRequestSchema.parse({
        surfaceKind: "terminal",
        target: {
          kind: "worker",
          projectId: "project-one",
          workerId: "worker-two",
        },
      }),
    ).toMatchObject({ surfaceKind: "terminal" });
    expect(
      executionPlacementResolutionSchema.parse({
        placement: {
          projectId: "project-one",
          workerId: "worker-two",
          projectReplicaId: "replica-two",
          worktreeId: "worktree-three",
          surface: null,
        },
        selection: "project-preference",
      }).selection,
    ).toBe("project-preference");

    const resolvedTarget = executionTargetResolutionSchema.parse({
      target: {
        kind: "surface",
        projectId: "project-one",
        surfaceKind: "terminal",
        surfaceId: "terminal-four",
      },
      placement: {
        projectId: "project-one",
        workerId: "worker-two",
        projectReplicaId: "replica-two",
        worktreeId: "worktree-three",
        surface: { kind: "terminal", id: "terminal-four" },
      },
      worker: { workerId: "worker-two", name: "Build worker", online: true },
      availability: "available",
      unavailableReason: null,
    });
    expect(resolvedTarget.placement.surface?.id).toBe("terminal-four");
    expect(
      executionTargetResolveRequestSchema.parse({
        target: resolvedTarget.target,
      }).allowUnavailable,
    ).toBe(false);
    expect(
      executionTargetCatalogSchema.parse({
        projectId: "project-one",
        targets: [
          {
            ...resolvedTarget,
            resourceKind: "terminal",
            title: "Build shell",
            status: "running",
          },
        ],
        truncated: false,
      }).targets[0]?.resourceKind,
    ).toBe("terminal");
  });

  it("accepts placement targets on new surfaces without accepting ambiguous worktrees", () => {
    const target = {
      kind: "worktree" as const,
      projectId: "project-one",
      worktreeId: "worktree-three",
    };
    expect(
      chatCreateSchema.safeParse({
        title: "Placed chat",
        target,
      }).success,
    ).toBe(true);
    expect(
      terminalCreateSchema.safeParse({
        title: "Placed terminal",
        directoryPath: "packages/app/src",
        target,
      }).success,
    ).toBe(true);
    expect(
      terminalCreateSchema.safeParse({
        directoryPath: "../outside",
        target,
      }).success,
    ).toBe(false);
    expect(
      chatCreateSchema.safeParse({
        worktreeId: "legacy-worktree",
        target,
      }).success,
    ).toBe(false);
    expect(
      terminalCreateSchema.safeParse({
        worktreeId: "legacy-worktree",
        target,
      }).success,
    ).toBe(false);
  });

  it("uses the product-facing Agent name for untitled chat surfaces", () => {
    expect(chatCreateSchema.parse({}).title).toBe("New agent");
  });

  it("bounds fleet browser discovery and validates initial Browser placement", () => {
    expect(
      browserCreateSchema.parse({
        title: "Worker service",
        url: "http://127.0.0.1:4310/health",
        target: {
          kind: "worker",
          projectId: "project-one",
          workerId: "worker-two",
        },
      }).url,
    ).toBe("http://127.0.0.1:4310/health");
    expect(
      browserCreateSchema.safeParse({
        url: "file:///etc/passwd",
      }).success,
    ).toBe(false);

    const discovery = browserServiceFleetDiscoverySchema.parse({
      projectId: "project-one",
      observedAt: "2026-08-11T12:00:00.000Z",
      partial: true,
      workers: [
        {
          workerId: "worker-one",
          workerName: "Desk Mac",
          status: "ok",
          services: [
            {
              workerId: "worker-one",
              workerName: "Desk Mac",
              host: "127.0.0.1",
              port: 4310,
              protocol: "http",
              url: "http://127.0.0.1:4310/",
              title: "Cantrip",
              processName: "node",
              statusCode: 200,
              placement: {
                projectId: "project-one",
                workerId: "worker-one",
                projectReplicaId: null,
                worktreeId: null,
                surface: null,
              },
            },
          ],
          error: null,
        },
        {
          workerId: "worker-two",
          workerName: "Build host",
          status: "offline",
          services: [],
          error: {
            code: "worker-offline",
            message: "Build host is offline.",
          },
        },
      ],
    });
    expect(discovery.workers[0]?.services[0]?.placement.workerId).toBe(
      "worker-one",
    );
    expect(discovery.workers[1]?.status).toBe("offline");
  });

  it("validates bounded worker enrollment and redacted credential metadata", () => {
    const heartbeat = workerHeartbeatSchema.parse({
      workerId: "worker-one",
      name: "Desk Mac",
      platform: "darwin",
      architecture: "arm64",
      codexVersion: null,
      startedAt: "2026-08-11T12:00:00.000Z",
    });
    expect(
      workerEnrollmentExchangeSchema.parse({
        code: `ctwl_${"a".repeat(32)}`,
        heartbeat,
      }).heartbeat.workerId,
    ).toBe("worker-one");
    expect(heartbeat.projectReplicas).toEqual({
      provision: false,
      synchronize: false,
      remove: false,
      exactRevision: false,
      directPlacement: false,
      managedLinkPlacement: false,
      attachExisting: false,
      recursiveParentCreation: false,
    });
    expect(heartbeat.managedFolders).toEqual({
      create: false,
      attachExisting: false,
      convertToGithub: false,
      remove: false,
    });
    expect(heartbeat.chatRelocation).toBe(false);
    expect(heartbeat.codegraph).toEqual(
      expect.objectContaining({
        available: false,
        runtimeState: "unavailable",
        mcpInjectionAvailable: false,
      }),
    );
    expect(
      workerEnrollmentCodeResultSchema.safeParse({
        code: "short",
        label: null,
        expiresAt: "2026-08-11T12:10:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      workerEnrollmentCodeResultSchema.parse({
        id: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
        code: `ctwl_${"a".repeat(32)}`,
        label: null,
        expiresAt: "2026-08-11T12:10:00.000Z",
      }).workerId,
    ).toBeNull();
    expect(
      workerCredentialSummarySchema.parse({
        id: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
        workerId: "worker-one",
        label: "Desk Mac",
        scopes: ["worker:connect", "worker:heartbeat"],
        createdAt: "2026-08-11T12:00:00.000Z",
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
        active: true,
      }).active,
    ).toBe(true);
    expect(
      workerEnrollmentCodeStatusSchema.parse({
        id: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
        label: "Desk Mac",
        expiresAt: "2026-08-11T12:10:00.000Z",
        status: "pending",
      }).status,
    ).toBe("pending");
    expect(
      workerManagementSummarySchema.parse({
        ...heartbeat,
        name: "Studio Mac",
        runtimeName: "Desk Mac",
        code: {
          available: false,
          version: null,
          upstreamRevision: null,
          patchset: 0,
          transport: "web-proxy",
          maxSessions: 1,
          reason: "Not installed",
        },
        online: true,
        lastSeenAt: "2026-08-11T12:00:05.000Z",
        internal: false,
        editable: true,
        removable: true,
        credentialCount: 1,
        activeCredentialCount: 1,
        sources: [],
      }).runtimeName,
    ).toBe("Desk Mac");
    expect(
      workerCommandSchema.parse({
        type: "worker.credential.rotate",
        credential: `ctwk_${"b".repeat(43)}`,
      }).type,
    ).toBe("worker.credential.rotate");
  });

  it("validates short-lived provider access leases without durable secrets", () => {
    expect(providerAccessTokenLeaseRequestSchema.parse({})).toEqual({
      credentialRevision: null,
      forceRefresh: false,
      minimumValiditySeconds: 120,
    });
    const lease = providerAccessTokenLeaseSchema.parse({
      accessToken: "worker-access-token",
      credentialRevision: 4,
      expiresAt: "2026-08-15T12:30:00.000Z",
      issuedAt: "2026-08-15T12:00:00.000Z",
      leaseExpiresAt: "2026-08-15T12:05:00.000Z",
      planType: "pro",
      providerAccountId: "cantrip-account",
      providerId: "provider-one",
      providerIdentity: {
        accountId: "upstream-account",
        kind: "chatgpt",
        userId: "upstream-user",
      },
      providerKind: "chatgpt",
    });
    expect(lease.providerIdentity.kind).toBe("chatgpt");
    expect(lease.email).toBeNull();
    expect(JSON.stringify(lease)).not.toContain("refreshToken");
    expect(JSON.stringify(lease)).not.toContain("idToken");
  });

  it("validates bounded legacy provider credential migration messages", () => {
    expect(
      workerCommandSchema.parse({
        type: "provider.auth.legacy.capture",
        providerId: "provider-one",
        providerKind: "chatgpt",
        providerAccountId: "account-one",
        credentialHomeKey: "home-one",
      }).type,
    ).toBe("provider.auth.legacy.capture");
    expect(
      workerCommandSchema.parse({
        type: "provider.auth.legacy.purge",
        providerId: "provider-one",
        providerKind: "chatgpt",
        providerAccountId: "account-one",
        credentialHomeKey: "home-one",
        expectedSubjectBlindIndex: "A".repeat(43),
        serverCredentialRevision: 2,
      }).type,
    ).toBe("provider.auth.legacy.purge");
    const legacyCapture = providerLegacyCredentialCaptureResultSchema.parse({
      status: "available",
      credential: {
        subjectBlindIndex: "A".repeat(43),
        protectedCredential: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "A".repeat(16),
            ciphertext: "A".repeat(22),
          },
        },
      },
      metadata: { expiresAt: null },
    });
    expect(legacyCapture).toMatchObject({
      portableAuth: false,
      status: "available",
    });
    if (legacyCapture.status !== "available") throw new Error("capture failed");
    expect(legacyCapture.credential.subjectBlindIndex).toBe("A".repeat(43));
  });

  it("validates exact-revision replica job commands and durable state", () => {
    const jobId = "019fe8a8-6473-7b1f-9152-e06964be098a";
    expect(
      workerCommandSchema.parse({
        type: "project.replica.provision",
        jobId,
        attempt: 2,
        repository: { nameWithOwner: "ArcaneArts/Cantrip" },
        expectedRevision: "a".repeat(40),
      }),
    ).toMatchObject({ attempt: 2, expectedRevision: "a".repeat(40) });
    expect(
      projectReplicaJobSummarySchema.parse({
        id: jobId,
        projectId: "project-one",
        projectReplicaId: null,
        workerId: "worker-one",
        kind: "provision",
        state: "blocked",
        stateRevision: 3,
        idempotencyKey: "replica:project-one:worker-one",
        repository: "ArcaneArts/Cantrip",
        expectedRevision: "a".repeat(40),
        resolvedRevision: null,
        attempt: 2,
        progress: {
          stage: "blocked",
          percent: 0,
          updatedAt: "2026-08-11T12:00:00.000Z",
        },
        error: {
          code: "worker-offline",
          retryable: true,
        },
        createdAt: "2026-08-11T12:00:00.000Z",
        updatedAt: "2026-08-11T12:00:00.000Z",
        startedAt: "2026-08-11T12:00:00.000Z",
        cancellationUnsafeAt: null,
        completedAt: null,
      }).error,
    ).toMatchObject({ code: "worker-offline", retryable: true });
    expect(
      workerCommandSchema.safeParse({
        type: "project.replica.provision",
        jobId,
        attempt: 1,
        repository: { nameWithOwner: "ArcaneArts/Cantrip" },
        expectedRevision: "main",
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.parse({
        type: "project.replica.synchronize",
        jobId,
        attempt: 3,
        repository: { nameWithOwner: "ArcaneArts/Cantrip" },
        sourcePath: "/worker/repositories/ArcaneArts/Cantrip",
        expectedRevision: "b".repeat(40),
        policy: "fast-forward-primary",
      }),
    ).toMatchObject({
      type: "project.replica.synchronize",
      policy: "fast-forward-primary",
    });
    expect(
      workerCommandSchema.parse({
        type: "project.replica.remove",
        jobId,
        attempt: 4,
        repository: { nameWithOwner: "ArcaneArts/Cantrip" },
        sourcePath: "/worker/repositories/ArcaneArts/Cantrip",
        deleteLocalFiles: true,
      }),
    ).toMatchObject({ type: "project.replica.remove", deleteLocalFiles: true });
    expect(
      workerCommandSchema.parse({
        type: "project.replica.link.repair",
        projectId: jobId,
        repository: { nameWithOwner: "ArcaneArts/Cantrip" },
        sourcePath: "/worker/repositories/ArcaneArts/Cantrip",
        linkPath: "/workspace/Cantrip",
        repositoryFingerprint: "c".repeat(64),
      }),
    ).toMatchObject({
      type: "project.replica.link.repair",
      projectId: jobId,
    });
  });

  it("validates split project token usage analytics", () => {
    expect(
      projectTokenUsageSchema.parse({
        total: {
          inputTokens: 800,
          outputTokens: 400,
          totalTokens: 1_200,
        },
        agentTime: {
          activeAgentCount: 2,
          agentTimeMs: 1_200_000,
          wallTimeMs: 600_000,
          averageConcurrency: 2,
        },
        daily: [
          {
            date: "2026-08-11",
            inputTokens: 800,
            outputTokens: 400,
            totalTokens: 1_200,
          },
        ],
        providers: [
          {
            id: "provider-1",
            name: "ChatGPT",
            inputTokens: 800,
            outputTokens: 400,
            totalTokens: 1_200,
            agentTime: {
              activeAgentCount: 2,
              agentTimeMs: 1_200_000,
              wallTimeMs: 600_000,
              averageConcurrency: 2,
            },
          },
        ],
        models: [],
        range: { start: "2025-08-12", end: "2026-08-11" },
      }).total,
    ).toEqual({
      inputTokens: 800,
      outputTokens: 400,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 1_200,
    });
    expect(
      projectTokenUsageSchema.safeParse({
        total: { inputTokens: -1, outputTokens: 0, totalTokens: -1 },
        daily: [],
        providers: [],
        models: [],
        range: { start: "not-a-date", end: "2026-08-11" },
      }).success,
    ).toBe(false);
  });

  it("validates preview-only Git agent draft requests and provenance", () => {
    expect(
      gitAgentDraftCreateSchema.parse({
        task: "draft-commit-message",
        instructions: "Focus on the public API.",
      }),
    ).toMatchObject({
      task: "draft-commit-message",
      instructions: "Focus on the public API.",
    });
    expect(
      gitAgentDraftResultSchema.parse({
        generationId: "generation-1",
        task: "summarize-changes",
        text: "Changed the Git client.",
        modelId: "model-1",
        modelName: "gpt-5.6-sol",
        providerName: "ChatGPT",
        worktreeId: "worktree-1",
        generatedAt: "2026-08-10T12:00:00.000Z",
      }),
    ).toMatchObject({
      task: "summarize-changes",
      worktreeId: "worktree-1",
    });
    expect(() =>
      gitAgentDraftCreateSchema.parse({ task: "publish-commit" }),
    ).toThrow();
    expect(
      gitAgentDraftCreateSchema.parse({
        task: "review-commit-range",
        baseRevision: "origin/main",
        headRevision: "feature/review",
      }),
    ).toMatchObject({
      task: "review-commit-range",
      baseRevision: "origin/main",
      headRevision: "feature/review",
    });
    expect(() =>
      gitAgentDraftCreateSchema.parse({ task: "draft-pr-description" }),
    ).toThrow();
    expect(() =>
      gitAgentDraftCreateSchema.parse({
        task: "summarize-failed-checks",
      }),
    ).toThrow();
    expect(() =>
      gitAgentDraftCreateSchema.parse({
        task: "review-commit-range",
        baseRevision: "--output=/tmp/pwn",
        headRevision: "HEAD",
      }),
    ).toThrow();
  });

  it("validates durable bisect actions and classification controls", () => {
    const action = gitBisectActionSchema.parse({
      type: "bisect",
      goodRef: "v1.0.0",
      badRef: "HEAD",
    });
    expect(
      workerCommandSchema.parse({
        type: "git.operation.preview",
        cwd: "/repo",
        action,
      }),
    ).toMatchObject({ action });
    for (const control of ["good", "bad", "skip", "reset"] as const) {
      expect(
        gitManagedOperationControlSchema.parse({ action: control }),
      ).toEqual({ action: control });
    }
    expect(() =>
      gitBisectActionSchema.parse({
        type: "bisect",
        goodRef: "--exec=bad",
        badRef: "HEAD",
      }),
    ).toThrow();
  });

  it("validates durable merge and rebase operation envelopes", () => {
    const head = "1".repeat(40);
    const source = "2".repeat(40);
    const context = {
      type: "rebase" as const,
      originalHead: head,
      sourceRef: "origin/main",
      sourceRevision: source,
      targetRef: "refs/heads/feature",
      targetRevision: head,
      pendingCommits: [head],
      totalSteps: 1,
      checkpointRef: "refs/cantrip/checkpoints/rebase-example",
    };
    expect(
      gitManagedOperationPreviewSchema.parse({
        action: { type: "rebase", sourceRef: "origin/main" },
        token: "a".repeat(64),
        destructive: true,
        summary: "Rebase feature onto origin/main.",
        warnings: ["Published commit hashes may change."],
        context,
        commits: [
          {
            hash: head,
            shortHash: head.slice(0, 8),
            subject: "Feature work",
            authorName: "Cantrip",
            authoredAt: "2026-08-10T12:00:00.000Z",
          },
        ],
        files: [],
        patch: "",
        patchTruncated: false,
        wouldConflict: false,
      }).context.type,
    ).toBe("rebase");
    expect(
      gitManagedOperationRecordSchema.parse({
        ...context,
        id: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
        projectId: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f3",
        worktreeId: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f4",
        workerId: "local-worker",
        state: "conflicted",
        currentHead: head,
        currentStep: 1,
        conflictedPaths: ["src/app.ts"],
        output: "CONFLICT",
        error: null,
        createdAt: "2026-08-10T12:00:00.000Z",
        updatedAt: "2026-08-10T12:01:00.000Z",
        completedAt: null,
      }).state,
    ).toBe("conflicted");
    expect(
      workerCommandSchema.parse({
        type: "git.operation.control",
        cwd: "/repo",
        context,
        action: "continue",
      }).action,
    ).toBe("continue");
    expect(
      workerCommandSchema.safeParse({
        type: "git.operation.preview",
        cwd: "/repo",
        action: { type: "merge", sourceRef: "bad\nref" },
      }).success,
    ).toBe(false);
    const rewrite = gitManagedOperationPreviewSchema.parse({
      action: {
        type: "interactiveRebase",
        upstreamRef: "origin/main",
        todo: [
          {
            action: "reword",
            revision: head,
            message: "Clearer feature message",
          },
        ],
      },
      token: "b".repeat(64),
      destructive: true,
      summary: "Rewrite feature history.",
      warnings: ["Commit identities change."],
      context,
      commits: [],
      files: [],
      patch: "",
      patchTruncated: false,
      wouldConflict: false,
      todo: [
        {
          action: "reword",
          revision: head,
          message: "Clearer feature message",
        },
      ],
      todoText: `reword ${head} Feature work`,
      publishedRefs: ["origin/main"],
    });
    expect(rewrite.todo[0]?.action).toBe("reword");
    expect(rewrite.publishedRefs).toEqual(["origin/main"]);
    expect(
      gitForcePushPreviewSchema.parse({
        token: "c".repeat(64),
        destructive: true,
        summary: "Replace origin/main with main.",
        warnings: ["The lease is exact."],
        remote: "origin",
        localBranch: "main",
        remoteBranch: "main",
        localHead: head,
        expectedRemoteHead: source,
        localCommits: [],
        localCommitCount: 2,
        localCommitsTruncated: false,
        remoteCommits: [],
        remoteCommitCount: 1,
        remoteCommitsTruncated: false,
      }).expectedRemoteHead,
    ).toBe(source);
    expect(
      workerCommandSchema.parse({
        type: "git.force-push.apply",
        cwd: "/repo",
        token: "c".repeat(64),
      }).token,
    ).toBe("c".repeat(64));
    expect(
      workerCommandSchema.parse({
        type: "git.operation.amend",
        cwd: "/repo",
        context,
        message: "Edited during rebase",
      }).message,
    ).toBe("Edited during rebase");
    expect(
      workerCommandSchema.safeParse({
        type: "git.operation.preview",
        cwd: "/repo",
        action: {
          type: "interactiveRebase",
          upstreamRef: "origin/main",
          todo: [{ action: "reword", revision: head, message: null }],
        },
      }).success,
    ).toBe(false);
    const lifecyclePreview = githubPullRequestLifecyclePreviewSchema.parse({
      action: {
        type: "merge",
        method: "squash",
        commitTitle: null,
        commitMessage: null,
      },
      number: 44,
      title: "Review pull requests",
      state: "open",
      draft: false,
      headRef: "feature/review",
      headSha: "1".repeat(40),
      baseRef: "main",
      baseSha: "2".repeat(40),
      mergeable: true,
      mergeableState: "clean",
      checksState: "success",
      reviewDecision: "approved",
      destructive: true,
      confirmationPhrase: "squash #44",
      warnings: ["This merges the reviewed head."],
      token: "3".repeat(64),
    });
    expect(lifecyclePreview.confirmationPhrase).toBe("squash #44");
    expect(
      workerCommandSchema.parse({
        type: "github.pull-request.lifecycle.apply",
        cwd: "/repo",
        repository: "ArcaneArts/Cantrip",
        number: 44,
        request: {
          action: lifecyclePreview.action,
          token: lifecyclePreview.token,
          confirmation: "squash #44",
        },
      }).request,
    ).toMatchObject({ confirmation: "squash #44" });
    const checkout = githubPullRequestCheckoutPreparedSchema.parse({
      pullRequest: {
        number: 44,
        title: "Review pull requests",
        state: "open",
        url: "https://github.com/ArcaneArts/Cantrip/pull/44",
        author: "reviewer",
        commentCount: 2,
        labels: [],
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T01:00:00.000Z",
        closedAt: null,
        body: null,
        draft: false,
        merged: false,
        headRef: "feature/review",
        headSha: "1".repeat(40),
        baseRef: "main",
        baseSha: "2".repeat(40),
      },
      branch: "cantrip/pr/44-feature-review-11111111",
      name: "PR #44 Review pull requests",
      headSha: "1".repeat(40),
      remote: "origin",
    });
    expect(
      workerCommandSchema.parse({
        type: "github.pull-request.checkout.prepare",
        cwd: "/repo",
        repository: "ArcaneArts/Cantrip",
        number: 44,
      }),
    ).toMatchObject({ number: checkout.pullRequest.number });
  });

  it("validates reviewed commit actions and resumable conflict state", () => {
    const head = "1".repeat(40);
    const revision = "2".repeat(40);
    const action = {
      type: "cherryPick" as const,
      selection: {
        type: "range" as const,
        fromRevision: revision,
        toRevision: "3".repeat(40),
      },
    };
    expect(
      gitCommitActionPreviewSchema.parse({
        action,
        token: "a".repeat(64),
        destructive: false,
        summary: "Cherry-pick two commits.",
        warnings: ["Conflicts are expected."],
        resolvedRevisions: [revision, "3".repeat(40)],
        commits: [
          {
            hash: revision,
            shortHash: revision.slice(0, 8),
            subject: "Selected commit",
            authorName: "Cantrip",
            authoredAt: "2026-08-10T12:00:00.000Z",
          },
        ],
        files: [
          {
            path: "src/app.ts",
            originalPath: null,
            indexStatus: "U",
            worktreeStatus: "U",
            staged: true,
            unstaged: true,
          },
        ],
        patch: "@@ -1 +1 @@\n-old\n+new\n",
        patchTruncated: false,
        wouldConflict: true,
        checkpointRef: null,
      }).wouldConflict,
    ).toBe(true);
    expect(
      gitCommitActionResultSchema.parse({
        output: "conflict",
        status: {
          branch: "main",
          head,
          upstream: null,
          ahead: 0,
          behind: 0,
          files: [
            {
              path: "src/app.ts",
              originalPath: null,
              indexStatus: "U",
              worktreeStatus: "U",
              staged: true,
              unstaged: true,
            },
          ],
          branches: [],
        },
        headBefore: head,
        headAfter: head,
        checkpointRef: null,
        operation: {
          type: "cherry-pick",
          state: "conflicted",
          originalHead: head,
          currentHead: head,
          sourceRevisions: [revision],
          currentStep: 1,
          totalSteps: 1,
          conflictedPaths: ["src/app.ts"],
        },
      }).operation?.state,
    ).toBe("conflicted");
    expect(
      workerCommandSchema.safeParse({
        type: "git.commit.action.preview",
        cwd: "/repo",
        action: {
          type: "revert",
          revision: "HEAD~1",
          mainlineParent: null,
        },
      }).success,
    ).toBe(false);
  });

  it("validates bounded conflict detail and exact resolution commands", () => {
    const oid = "a".repeat(40);
    const stage = {
      available: true,
      oid,
      mode: "100644",
      size: 5,
      binary: false,
      content: "ours\n",
      truncated: false,
    };
    expect(
      gitConflictDetailSchema.parse({
        path: "src/app.ts",
        code: "UU",
        kind: "both-modified",
        baseAvailable: true,
        oursAvailable: true,
        theirsAvailable: true,
        base: stage,
        ours: stage,
        theirs: { ...stage, content: "theirs\n" },
        result: {
          exists: true,
          oid,
          size: 42,
          binary: false,
          content: "<<<<<<< ours\n=======\n>>>>>>> theirs\n",
          truncated: false,
        },
      }).kind,
    ).toBe("both-modified");
    expect(
      gitConflictResolutionRequestSchema.safeParse({
        path: "src/app.ts",
        strategy: "manual",
        content: null,
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.parse({
        type: "git.conflicts.apply",
        cwd: "/repo",
        request: {
          path: "src/app.ts",
          strategy: "ours",
          content: null,
        },
        token: "b".repeat(64),
      }).type,
    ).toBe("git.conflicts.apply");
  });

  it("transports conflicted stash operations as resumable worker state", () => {
    const head = "1".repeat(40);
    const stash = "9".repeat(40);
    expect(
      gitStashMutationResultSchema.parse({
        output: "CONFLICT",
        status: {
          branch: "main",
          head,
          upstream: null,
          ahead: 0,
          behind: 0,
          files: [],
          branches: [],
        },
        stash: null,
        conflictedPaths: ["src/app.ts"],
        operation: {
          type: "stash",
          state: "conflicted",
          originalHead: head,
          currentHead: head,
          sourceRef: "pop:stash@{0}",
          sourceRevision: stash,
          targetRef: "refs/heads/main",
          targetRevision: head,
          pendingCommits: [stash],
          currentStep: 1,
          totalSteps: 1,
          checkpointRef: "refs/cantrip/checkpoints/stash-test-clean",
          conflictedPaths: ["src/app.ts"],
        },
      }).operation?.type,
    ).toBe("stash");
  });

  it("validates remotes, tags, releases, and destructive review envelopes", () => {
    const hash = "d".repeat(40);
    const signature = {
      status: "unsigned" as const,
      signer: null,
      key: null,
      fingerprint: null,
      format: null,
      verification: "not-applicable" as const,
      verificationMessage: null,
    };
    expect(
      gitRemoteListSchema.parse({
        remotes: [
          {
            name: "origin",
            fetchUrl: "https://github.com/ArcaneArts/Cantrip.git",
            fetchUrlRedacted: false,
            pushUrl: "git@github.com:ArcaneArts/Cantrip.git",
            pushUrlRedacted: false,
            defaultFetch: true,
            defaultPush: true,
          },
        ],
        generatedAt: "2026-08-10T12:00:00.000Z",
      }).remotes,
    ).toHaveLength(1);
    expect(
      gitRemoteActionPreviewSchema.parse({
        action: { type: "remove", name: "origin" },
        token: "a".repeat(64),
        destructive: true,
        summary: "Remove origin.",
        warnings: [],
        remote: {
          name: "origin",
          fetchUrl: "https://github.com/ArcaneArts/Cantrip.git",
          fetchUrlRedacted: false,
          pushUrl: "https://github.com/ArcaneArts/Cantrip.git",
          pushUrlRedacted: false,
          defaultFetch: true,
          defaultPush: true,
        },
      }).destructive,
    ).toBe(true);
    const tag = {
      name: "v1.0.0",
      hash,
      targetHash: hash,
      targetType: "commit" as const,
      annotated: false,
      subject: "Release",
      taggerName: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      signature,
      publishedRemotes: ["origin"],
    };
    const parsedTags = gitTagListSchema.parse({
      tags: [tag],
      truncated: false,
      remoteChecks: [{ remote: "origin", available: true, error: null }],
      generatedAt: "2026-08-10T12:00:00.000Z",
    }).tags;
    expect(parsedTags).toHaveLength(1);
    expect(parsedTags[0]?.signature.verification).toBe("not-applicable");
    expect(
      gitTagActionPreviewSchema.parse({
        action: { type: "deleteRemote", name: "v1.0.0", remote: "origin" },
        token: "b".repeat(64),
        destructive: true,
        summary: "Delete remote tag.",
        warnings: [],
        tag,
      }).destructive,
    ).toBe(true);
    expect(() =>
      workerCommandSchema.parse({
        type: "git.tag.action.preview",
        cwd: "/repo",
        action: {
          type: "create",
          name: "v2",
          target: null,
          annotated: true,
          message: null,
        },
      }),
    ).toThrow(/message/iu);
    expect(() =>
      workerCommandSchema.parse({
        type: "git.remote.action.preview",
        cwd: "/repo",
        action: {
          type: "add",
          name: "origin",
          fetchUrl: "--upload-pack=bad",
          pushUrl: null,
        },
      }),
    ).toThrow();
    expect(
      githubReleaseListSchema.parse({
        releases: [
          {
            id: 1,
            tagName: "v1.0.0",
            name: "Cantrip 1.0",
            body: "Notes",
            url: "https://github.com/ArcaneArts/Cantrip/releases/tag/v1.0.0",
            author: "cantrip",
            draft: false,
            prerelease: false,
            createdAt: "2026-08-10T12:00:00.000Z",
            publishedAt: "2026-08-10T12:00:00.000Z",
          },
        ],
        truncated: false,
      }).releases,
    ).toHaveLength(1);
    expect(
      githubReleaseCreateSchema.parse({
        tagName: "v1.0.0",
        name: "Cantrip 1.0",
        body: "Notes",
        draft: true,
        prerelease: false,
      }).draft,
    ).toBe(true);
  });

  it("validates bounded submodule inventory and reviewed actions", () => {
    const hash = "a".repeat(40);
    const module = {
      name: "library",
      path: "modules/library",
      url: "https://github.com/ArcaneArts/library.git",
      branch: "main",
      expectedHash: hash,
      currentHash: hash,
      initialized: true,
      dirty: false,
      nested: false,
      state: "clean" as const,
    };
    expect(
      gitSubmoduleListSchema.parse({
        submodules: [module],
        truncated: false,
        generatedAt: "2026-08-10T12:00:00.000Z",
      }).submodules,
    ).toEqual([module]);
    expect(
      gitSubmoduleActionPreviewSchema.parse({
        action: {
          type: "deinitialize",
          path: "modules/library",
          force: false,
        },
        token: "b".repeat(64),
        destructive: true,
        summary: "Deinitialize modules/library.",
        warnings: [],
        targets: [module],
      }).destructive,
    ).toBe(true);
    expect(
      workerCommandSchema.parse({
        type: "git.submodule.action.preview",
        cwd: "/repo",
        action: {
          type: "update",
          path: null,
          recursive: true,
          remote: false,
        },
      }).type,
    ).toBe("git.submodule.action.preview");
    expect(() =>
      workerCommandSchema.parse({
        type: "git.submodule.action.apply",
        cwd: "/repo",
        action: {
          type: "deinitialize",
          path: "../outside",
          force: true,
        },
        token: "c".repeat(64),
      }),
    ).toThrow(/relative path/iu);
  });

  it("validates Git LFS capability, pointers, locks, and reviewed actions", () => {
    const status = gitLfsStatusSchema.parse({
      available: true,
      version: "git-lfs/3.7.0",
      message: null,
      patterns: [{ pattern: "*.psd", source: ".gitattributes" }],
      files: [
        {
          path: "assets/design.psd",
          oid: "d".repeat(64),
          size: 1_048_576,
          checkedOut: true,
          downloaded: false,
          status: "M",
        },
      ],
      filesTruncated: false,
      missingObjects: 1,
      pendingPaths: [{ path: "assets/design.psd", status: "M" }],
      locks: [
        {
          id: "lock-1",
          path: "assets/design.psd",
          owner: "cantrip",
          lockedAt: "2026-08-10T12:00:00.000Z",
          ours: true,
        },
      ],
      locksTruncated: false,
      locksCached: true,
      lockError: null,
      generatedAt: "2026-08-10T12:00:00.000Z",
    });
    expect(status.missingObjects).toBe(1);
    expect(
      gitLfsActionPreviewSchema.parse({
        action: { type: "prune", verifyRemote: true },
        token: "e".repeat(64),
        destructive: true,
        summary: "Prune old objects.",
        warnings: [],
        status,
      }).destructive,
    ).toBe(true);
    expect(
      workerCommandSchema.parse({
        type: "git.lfs.action.preview",
        cwd: "/repo",
        action: { type: "track", pattern: "*.psd" },
      }).type,
    ).toBe("git.lfs.action.preview");
    expect(() =>
      workerCommandSchema.parse({
        type: "git.lfs.action.apply",
        cwd: "/repo",
        action: { type: "lock", path: "../outside" },
        token: "f".repeat(64),
      }),
    ).toThrow(/relative path/iu);
  });

  it("validates bounded branch inventory and reviewed branch actions", () => {
    const hash = "a".repeat(40);
    const branch = {
      name: "feature/branches",
      fullRef: "refs/heads/feature/branches",
      kind: "local" as const,
      current: false,
      hash,
      upstream: "origin/feature/branches",
      upstreamGone: false,
      ahead: 2,
      behind: 1,
      mergedIntoHead: false,
      remoteName: "origin",
      remoteAvailable: true,
      trackingLocalBranches: [],
      worktree: { label: "review-lane", current: false },
      lastCommit: {
        hash,
        shortHash: "aaaaaaa",
        subject: "Add branches",
        authorName: "Cantrip",
        authoredAt: "2026-08-10T12:00:00.000Z",
      },
    };
    expect(
      gitBranchListSchema.parse({
        currentBranch: "main",
        head: hash,
        detached: false,
        defaultRemote: "origin",
        remotes: ["origin"],
        pullStrategy: {
          mode: "fast-forward-only",
          description: "Pulls must fast-forward.",
        },
        branches: [branch],
        truncated: false,
        generatedAt: "2026-08-10T12:00:00.000Z",
      }).branches,
    ).toHaveLength(1);
    expect(
      gitBranchActionPreviewSchema.parse({
        action: {
          type: "deleteRemote",
          remote: "origin",
          name: "feature/branches",
        },
        token: "b".repeat(64),
        destructive: true,
        summary: "Delete origin/feature/branches.",
        warnings: ["This removes the remote ref."],
        branch,
      }).destructive,
    ).toBe(true);
    expect(() =>
      workerCommandSchema.parse({
        type: "git.branch.action.preview",
        cwd: "/repo",
        action: { type: "fetch", remote: "--upload-pack=oops", prune: true },
      }),
    ).toThrow();
    expect(() =>
      workerCommandSchema.parse({
        type: "git.branch.action.apply",
        cwd: "/repo",
        action: {
          type: "create",
          name: "topic",
          startPoint: "--exec=oops",
          checkout: true,
        },
        token: "c".repeat(64),
      }),
    ).toThrow();
  });

  it("validates bounded commit inspection and revision diff commands", () => {
    const revision = "a".repeat(40);
    const parent = "b".repeat(40);
    expect(
      workerCommandSchema.parse({
        type: "git.commit.get",
        cwd: "/worker/projects/cantrip",
        revision,
        parentIndex: 1,
        revisions: [revision, parent],
      }),
    ).toMatchObject({ type: "git.commit.get", parentIndex: 1 });
    expect(
      workerCommandSchema.parse({
        type: "git.commit.signature.get",
        cwd: "/worker/projects/cantrip",
        revision,
      }),
    ).toMatchObject({ type: "git.commit.signature.get", revision });
    expect(
      workerCommandSchema.parse({
        type: "git.revision.diff",
        cwd: "/worker/projects/cantrip",
        revision,
        baseRevision: parent,
        path: "src/index.ts",
      }),
    ).toMatchObject({ type: "git.revision.diff", path: "src/index.ts" });
    expect(() =>
      workerCommandSchema.parse({
        type: "git.commit.get",
        cwd: "/repo",
        revision: "HEAD~1",
      }),
    ).toThrow();
    expect(() =>
      workerCommandSchema.parse({
        type: "git.revision.diff",
        cwd: "/repo",
        revision,
        baseRevision: null,
        path: "../secret",
      }),
    ).toThrow();

    expect(
      gitCommitDetailSchema.parse({
        hash: revision,
        shortHash: "aaaaaaaa",
        subject: "Inspect commits",
        message: "Inspect commits\n\nFull message",
        messageTruncated: false,
        parents: [parent],
        children: [],
        parentIndex: 0,
        baseHash: parent,
        author: {
          name: "Cantrip",
          email: "dev@cantrip.art",
          date: "2026-08-10T12:00:00.000Z",
        },
        committer: {
          name: "Cantrip",
          email: "dev@cantrip.art",
          date: "2026-08-10T12:00:00.000Z",
        },
        signature: {
          status: "valid",
          signer: "Cantrip",
          key: "ABC123",
          fingerprint: null,
          format: "gpg",
          verification: "available",
          verificationMessage: "Good signature from Cantrip",
        },
        refs: [],
        files: [
          {
            path: "src/index.ts",
            originalPath: null,
            status: "modified",
            additions: 4,
            deletions: 1,
            binary: false,
          },
        ],
        filesTruncated: false,
        filesChanged: 1,
        additions: 4,
        deletions: 1,
      }),
    ).toMatchObject({
      signature: {
        format: "gpg",
        verification: "available",
        verificationMessage: "Good signature from Cantrip",
      },
      files: [{ status: "modified" }],
    });
    expect(
      gitRevisionFileDiffSchema.parse({
        revision,
        baseRevision: parent,
        path: "src/index.ts",
        originalPath: null,
        patch: "@@ -1 +1 @@",
        truncated: false,
        binary: false,
      }).revision,
    ).toBe(revision);
  });

  it("validates bounded revision candidates and arbitrary comparisons", () => {
    const left = "a".repeat(40);
    const right = "b".repeat(40);
    expect(
      workerCommandSchema.parse({ type: "git.refs.list", cwd: "/repo" }),
    ).toMatchObject({ type: "git.refs.list" });
    expect(
      workerCommandSchema.parse({
        type: "git.compare",
        cwd: "/repo",
        left,
        right,
        mode: "merge-base",
      }),
    ).toMatchObject({ type: "git.compare", mode: "merge-base" });
    expect(() =>
      workerCommandSchema.parse({
        type: "git.compare",
        cwd: "/repo",
        left: "main",
        right,
        mode: "direct",
      }),
    ).toThrow();
    expect(
      gitRevisionCandidateListSchema.parse([
        {
          revision: left,
          hash: left,
          shortHash: left.slice(0, 10),
          name: "main",
          kind: "local",
          current: true,
          worktreeId: null,
          worktreeName: null,
        },
      ]),
    ).toHaveLength(1);
    expect(
      gitComparisonSchema.parse({
        mode: "direct",
        left,
        right,
        mergeBase: left,
        diffBase: left,
        leftAhead: 0,
        rightAhead: 1,
        leftCommits: [],
        rightCommits: [
          {
            hash: right,
            shortHash: right.slice(0, 8),
            subject: "Right work",
            authorName: "Cantrip",
            authoredAt: "2026-08-10T12:00:00.000Z",
          },
        ],
        leftCommitsTruncated: false,
        rightCommitsTruncated: false,
        files: [],
        filesTruncated: false,
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      }).rightAhead,
    ).toBe(1);
  });

  it("validates exact partial-patch previews and stale-safe applies", () => {
    const request = {
      operation: "stage" as const,
      path: "src/index.ts",
      hunks: [
        { hunkIndex: 0, lineIndexes: [1, 2] },
        { hunkIndex: 2, lineIndexes: null },
      ],
    };
    expect(
      workerCommandSchema.parse({
        type: "git.patch.preview",
        cwd: "/repo",
        request,
      }),
    ).toMatchObject({ type: "git.patch.preview", request });
    expect(
      workerCommandSchema.parse({
        type: "git.patch.apply",
        cwd: "/repo",
        request,
        token: "a".repeat(64),
      }),
    ).toMatchObject({ type: "git.patch.apply", token: "a".repeat(64) });
    expect(
      gitPartialPatchPreviewSchema.parse({
        operation: "stage",
        path: "src/index.ts",
        scope: "unstaged",
        patch:
          "diff --git a/src/index.ts b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n",
        token: "b".repeat(64),
        selectedHunks: 1,
        selectedLines: 2,
        warnings: [],
      }).selectedLines,
    ).toBe(2);
    expect(() =>
      workerCommandSchema.parse({
        type: "git.patch.preview",
        cwd: "/repo",
        request: { ...request, path: "../secret" },
      }),
    ).toThrow();
  });

  it("validates paginated file history and blame commands", () => {
    expect(
      gitFileHistorySchema.parse({
        path: "src/index.ts",
        revision: "1".repeat(40),
        commits: [
          {
            hash: "1".repeat(40),
            shortHash: "1".repeat(8),
            subject: "Update index",
            authorName: "Cantrip Test",
            authorEmail: "test@cantrip.art",
            authoredAt: "2026-08-10T12:00:00.000Z",
          },
        ],
        hasMore: false,
        nextCursor: null,
      }).commits,
    ).toHaveLength(1);
    expect(
      gitBlameSchema.parse({
        path: "src/index.ts",
        revision: "1".repeat(40),
        ranges: [
          {
            commit: "1".repeat(40),
            shortCommit: "1".repeat(8),
            authorName: "Cantrip Test",
            authorEmail: "test@cantrip.art",
            authoredAt: "2026-08-10T12:00:00.000Z",
            summary: "Update index",
            startLine: 1,
            endLine: 2,
            lines: ["one", "two"],
          },
        ],
        hasMore: true,
        nextCursor: 2,
      }).ranges[0]?.endLine,
    ).toBe(2);
    expect(
      workerCommandSchema.parse({
        type: "git.file.history",
        cwd: "/repo",
        path: "src/index.ts",
        revision: "main",
        cursor: 100,
        limit: 50,
      }),
    ).toMatchObject({ type: "git.file.history", revision: "main" });
    expect(() =>
      workerCommandSchema.parse({
        type: "git.file.blame",
        cwd: "/repo",
        path: "../secret",
      }),
    ).toThrow();
  });

  it("validates bounded multi-filter commit search", () => {
    const query = gitCommitSearchQuerySchema.parse({
      message: "fix race",
      author: "Ada",
      hash: null,
      dateFrom: "2026-08-01",
      dateTo: "2026-08-10",
      path: "src/index.ts",
      branch: "main",
      tag: null,
    });
    expect(
      gitCommitSearchResultSchema.parse({
        query,
        commits: [],
        hasMore: false,
        nextCursor: null,
      }).query,
    ).toMatchObject({ branch: "main", message: "fix race" });
    expect(
      workerCommandSchema.parse({
        type: "git.commit.search",
        cwd: "/repo",
        query,
        cursor: 0,
        limit: 100,
      }),
    ).toMatchObject({ type: "git.commit.search", query });
    expect(() => gitCommitSearchQuerySchema.parse({})).toThrow();
    expect(() =>
      gitCommitSearchQuerySchema.parse({
        message: "test",
        branch: "main",
        tag: "v1",
      }),
    ).toThrow();
    expect(() =>
      gitCommitSearchQuerySchema.parse({
        message: "test",
        dateFrom: "2026-08-10",
        dateTo: "2026-08-01",
      }),
    ).toThrow();
  });

  it("validates paginated recovery candidates and confirmed reset previews", () => {
    const hash = "1".repeat(40);
    expect(
      gitRecoveryCandidateListSchema.parse({
        kind: "reflog",
        entries: [
          {
            kind: "reflog",
            selector: "HEAD@{0}",
            hash,
            shortHash: hash.slice(0, 8),
            action: "reset",
            subject: "reset: moving to HEAD~1",
            explanation: "HEAD was reset.",
            actorName: "Cantrip Test",
            actorEmail: "test@cantrip.art",
            occurredAt: "2026-08-10T12:00:00.000Z",
          },
        ],
        hasMore: false,
        nextCursor: null,
      }).entries,
    ).toHaveLength(1);
    const action = gitRecoveryActionSchema.parse({
      type: "reset",
      mode: "hard",
      target: hash,
    });
    expect(
      gitRecoveryPreviewSchema.parse({
        action,
        token: "a".repeat(64),
        destructive: true,
        summary: "Reset this worktree.",
        warnings: ["Tracked changes will be overwritten."],
        confirmation: `RESET --HARD TO ${hash.slice(0, 10)}`,
        targetRevision: hash,
        currentHead: "2".repeat(40),
        branchBefore: null,
        checkpointRef: "refs/cantrip/recovery/reset-example",
        commitsRemoved: [],
        commitsRemovedTruncated: false,
        files: [],
        filesTruncated: false,
        status: {
          branch: "main",
          head: "2".repeat(40),
          upstream: null,
          ahead: 0,
          behind: 0,
          files: [],
          branches: [],
        },
      }).confirmation,
    ).toContain("RESET --HARD");
    expect(
      workerCommandSchema.parse({
        type: "git.recovery.list",
        cwd: "/repo",
        kind: "dangling",
        cursor: 0,
        limit: 50,
      }),
    ).toMatchObject({ type: "git.recovery.list", kind: "dangling" });
    expect(() =>
      gitRecoveryActionSchema.parse({
        type: "createBranch",
        branch: "unsafe\nbranch",
        target: hash,
      }),
    ).toThrow();
  });

  it("validates scoped stash creation, bounded lists, and reviewed actions", () => {
    expect(
      gitStashCreateSchema.parse({
        message: "Review work",
        includeStaged: false,
        includeUnstaged: true,
        includeUntracked: true,
      }),
    ).toMatchObject({ message: "Review work", includeUntracked: true });
    expect(
      workerCommandSchema.parse({
        type: "git.stash.create",
        cwd: "/repo",
        request: {
          message: "Review work",
          includeStaged: false,
          includeUnstaged: true,
          includeUntracked: true,
        },
      }),
    ).toMatchObject({ type: "git.stash.create" });
    expect(() =>
      gitStashCreateSchema.parse({
        message: "Invalid",
        includeStaged: true,
        includeUnstaged: false,
        includeUntracked: true,
      }),
    ).toThrow();
    const stash = {
      ref: "stash@{0}",
      hash: "a".repeat(40),
      shortHash: "a".repeat(8),
      message: "Review work",
      createdAt: "2026-08-10T12:00:00.000Z",
      baseHash: "b".repeat(40),
      files: [
        {
          path: "src/index.ts",
          additions: 2,
          deletions: 1,
          binary: false,
        },
      ],
      filesChanged: 1,
      filesTruncated: false,
      additions: 2,
      deletions: 1,
      includesUntracked: false,
    };
    expect(
      gitStashListSchema.parse({ stashes: [stash], truncated: false }).stashes,
    ).toHaveLength(1);
    expect(
      workerCommandSchema.parse({
        type: "git.stash.diff",
        cwd: "/repo",
        hash: stash.hash,
        path: "src/index.ts",
      }),
    ).toMatchObject({ type: "git.stash.diff", hash: stash.hash });
    const action = { type: "pop" as const, ref: stash.ref, hash: stash.hash };
    expect(
      workerCommandSchema.parse({
        type: "git.stash.action.apply",
        cwd: "/repo",
        action,
        token: "c".repeat(64),
      }),
    ).toMatchObject({ type: "git.stash.action.apply", action });
    expect(
      gitStashActionPreviewSchema.parse({
        action,
        stashes: [stash],
        destructive: true,
        token: "d".repeat(64),
        warnings: [],
      }).destructive,
    ).toBe(true);
    expect(() =>
      workerCommandSchema.parse({
        type: "git.stash.action.preview",
        cwd: "/repo",
        action: { type: "drop", ref: "stash@{0}", hash: "not-a-hash" },
      }),
    ).toThrow();
  });

  it("bounds discovered script commands and their terminal-safe invocation", () => {
    expect(
      scriptCommandListSchema.parse([
        {
          id: "package:package.json:dev",
          kind: "package",
          name: "dev",
          command: "pnpm run dev",
          description: "vite --host 0.0.0.0",
          source: "package.json",
        },
      ]),
    ).toHaveLength(1);
    expect(() =>
      scriptCommandListSchema.parse([
        {
          id: "dart:pubspec.yaml:release",
          kind: "dart",
          name: "release",
          command: "dart run release\nrm -rf build",
          description: null,
          source: "pubspec.yaml",
        },
      ]),
    ).toThrow(/control characters/u);
    expect(
      workerCommandSchema.parse({
        type: "project.script-commands",
        operationId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb330",
        terminalId: "terminal-1",
        serverId: "server-1",
        worktreePath: "/worker/projects/cantrip",
        stateProtection: terminalStateFixture(),
      }).type,
    ).toBe("project.script-commands");
    expect(
      workerCommandSchema.parse({
        type: "project.script-commands.inspect",
        operationId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb331",
        projectId: "project-one",
        worktreeId: "worktree-one",
        serverId: "server-1",
        sourcePath: "/worker/projects/cantrip",
      }).type,
    ).toBe("project.script-commands.inspect");
  });

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
      explorerOperationRequestContentSchema.parse({
        type: "explorer.file.write",
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

  it("accepts basename-only Explorer entry mutations", () => {
    expect(
      explorerOperationRequestContentSchema.parse({
        type: "explorer.entry.rename",
        path: "src/old.ts",
        name: "new.ts",
      }),
    ).toEqual({
      type: "explorer.entry.rename",
      path: "src/old.ts",
      name: "new.ts",
    });
    expect(
      explorerOperationRequestContentSchema.parse({
        type: "explorer.entry.delete",
        path: "src/generated",
      }),
    ).toMatchObject({ type: "explorer.entry.delete" });
    expect(() => explorerEntryNameSchema.parse("../outside.ts")).toThrow(
      /single file or folder name/u,
    );
    expect(() => explorerEntryNameSchema.parse("nested/name.ts")).toThrow(
      /single file or folder name/u,
    );
  });

  it("classifies browser-native Explorer media and bounds chunk reads", () => {
    expect(explorerMediaTypeForPath("assets/cover.PNG")).toEqual({
      kind: "image",
      mimeType: "image/png",
    });
    expect(explorerMediaTypeForPath("audio/theme.mp3")).toEqual({
      kind: "audio",
      mimeType: "audio/mpeg",
    });
    expect(explorerMediaTypeForPath("video/demo.webm")).toEqual({
      kind: "video",
      mimeType: "video/webm",
    });
    expect(explorerMediaTypeForPath("src/index.ts")).toBeNull();
    expect(
      explorerOperationRequestContentSchema.parse({
        type: "explorer.media.read",
        path: "video/demo.webm",
        offset: 1024,
        limit: 256 * 1024,
      }),
    ).toMatchObject({ type: "explorer.media.read", offset: 1024 });
    expect(() =>
      explorerOperationRequestContentSchema.parse({
        type: "explorer.media.read",
        path: "video/demo.webm",
        offset: 0,
        limit: 256 * 1024 + 1,
      }),
    ).toThrow();
  });

  it("bounds and validates worker-owned worktree observation", () => {
    const operationId = "019fdc2c-e848-7552-b2ea-6fc7ef09e9f2";
    const projectId = "019fdc2c-e848-7552-b2ea-6fc7ef09e9f3";
    const worktreeId = "019fdc2c-e848-7552-b2ea-6fc7ef09e9f4";
    const operationContext = {
      type: "rebase" as const,
      originalHead: "a".repeat(40),
      sourceRef: "origin/main",
      sourceRevision: "b".repeat(40),
      targetRef: "refs/heads/feature",
      targetRevision: "a".repeat(40),
      pendingCommits: ["a".repeat(40)],
      totalSteps: 1,
      checkpointRef: null,
    };
    expect(
      workerCommandSchema.parse({
        type: "worktree.observation.configure",
        targets: [
          {
            projectId,
            worktreeId,
            sourcePath: "/repo",
            worktreePath: "/repo",
            operation: { id: operationId, context: operationContext },
          },
        ],
        codegraphTargets: [
          {
            projectId,
            worktreeId,
            rootKind: "folder-root",
            sourcePath: "/folder",
            worktreePath: "/folder",
          },
        ],
      }),
    ).toMatchObject({
      type: "worktree.observation.configure",
      targets: [{ operation: { id: operationId } }],
      codegraphTargets: [{ rootKind: "folder-root" }],
    });
    expect(
      workerCommandSchema.parse({
        type: "codegraph.status",
        projectId,
        worktreeId,
        rootKind: "git-worktree",
        sourcePath: "/repo",
        worktreePath: "/repo",
      }),
    ).toMatchObject({
      type: "codegraph.status",
      projectId,
      worktreeId,
      rootKind: "git-worktree",
      sourcePath: "/repo",
      worktreePath: "/repo",
    });
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
    expect(
      workerNotificationEnvelopeSchema.parse({
        kind: "notification",
        notification: {
          type: "git.operation.observed",
          projectId,
          worktreeId,
          operationId,
          sourcePath: "/repo",
          worktreePath: "/repo",
          fingerprint: "c".repeat(64),
          observedAt: "2026-08-21T12:00:00.000Z",
          state: {
            state: "conflicted",
            currentHead: "a".repeat(40),
            currentStep: 1,
            totalSteps: 1,
            pendingCommitCount: 1,
            conflictedPathCount: 1,
            pausedAction: null,
          },
          conflicts: {
            files: [
              {
                path: "src/app.ts",
                code: "UU",
                kind: "both-modified",
                baseAvailable: true,
                oursAvailable: true,
                theirsAvailable: true,
              },
            ],
            truncated: false,
          },
        },
      }).notification.type,
    ).toBe("git.operation.observed");
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
    expect(projectWorkspaceUpdateSchema.parse({ isDefault: true })).toEqual({
      isDefault: true,
    });
    expect(() => projectWorkspaceUpdateSchema.parse({})).toThrow();
    expect(() =>
      projectWorkspaceUpdateSchema.parse({ isDefault: false }),
    ).toThrow();
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
    expect(githubIssueCreateSchema.parse({ title: "  New issue  " })).toEqual({
      title: "New issue",
      body: "",
    });
    expect(
      workerCommandSchema.parse({
        type: "github.issue.create",
        repository: "ArcaneArts/Cantrip",
        request: { title: "New issue", body: "Details" },
      }),
    ).toMatchObject({ request: { title: "New issue", body: "Details" } });
    expect(
      workerCommandSchema.safeParse({
        type: "github.issue.create",
        repository: "ArcaneArts/Cantrip",
        request: { title: "   " },
      }).success,
    ).toBe(false);
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
    expect(
      workerCommandSchema.parse({
        type: "github.pull-request.create",
        cwd: "/repo",
        repository: "ArcaneArts/Cantrip",
        request: {
          base: "main",
          head: "feature/pr-ui",
          title: "Add PR creation",
          body: "Ready for review.",
          draft: true,
          labels: ["feature"],
          reviewers: ["octocat"],
          linkedIssueNumbers: [42],
        },
      }).request,
    ).toMatchObject({ draft: true, linkedIssueNumbers: [42] });
    expect(
      workerCommandSchema.safeParse({
        type: "github.pull-request.create",
        cwd: "/repo",
        repository: "ArcaneArts/Cantrip",
        request: { base: "main", head: "main", title: "Invalid" },
      }).success,
    ).toBe(false);
    expect(
      githubPullRequestCreateResultSchema.parse({
        pullRequest: {
          number: 44,
          title: "Add PR creation",
          state: "open",
          url: "https://github.com/ArcaneArts/Cantrip/pull/44",
          author: "octocat",
          commentCount: 0,
          labels: [],
          createdAt: "2026-08-10T12:00:00.000Z",
          updatedAt: "2026-08-10T12:00:00.000Z",
          closedAt: null,
          body: "Ready for review.",
          draft: true,
          merged: false,
          headRef: "feature/pr-ui",
          headSha: "1".repeat(40),
          baseRef: "main",
          baseSha: "2".repeat(40),
        },
        warnings: [],
      }).pullRequest.headRef,
    ).toBe("feature/pr-ui");
    expect(
      workerCommandSchema.parse({
        type: "github.pull-request.get",
        cwd: "/repo/worktrees/feature",
        repository: "ArcaneArts/Cantrip",
        number: 44,
      }),
    ).toMatchObject({ number: 44, cwd: "/repo/worktrees/feature" });
    expect(
      githubPullRequestDetailSchema.parse({
        number: 44,
        title: "Add PR review",
        state: "open",
        url: "https://github.com/ArcaneArts/Cantrip/pull/44",
        author: "octocat",
        commentCount: 1,
        labels: [],
        createdAt: "2026-08-10T12:00:00.000Z",
        updatedAt: "2026-08-10T13:00:00.000Z",
        closedAt: null,
        body: "Ready for review.",
        draft: false,
        merged: false,
        headRef: "feature/pr-review",
        headSha: "1".repeat(40),
        baseRef: "main",
        baseSha: "2".repeat(40),
        comments: [],
        commentsTruncated: false,
        requestedReviewers: ["reviewer"],
        mergeable: true,
        mergeableState: "clean",
        reviewDecision: "review-required",
        checksState: "success",
        additions: 10,
        deletions: 2,
        changedFileCount: 1,
        commitCount: 1,
        commits: [
          {
            sha: "1".repeat(40),
            shortSha: "1".repeat(7),
            message: "feat: review pull requests",
            author: "Cantrip",
            authoredAt: "2026-08-10T12:00:00.000Z",
            url: "https://github.com/ArcaneArts/Cantrip/commit/1111111",
          },
        ],
        commitsTruncated: false,
        files: [],
        filesTruncated: false,
        checks: [],
        checksTruncated: false,
        reviews: [],
        reviewsTruncated: false,
        reviewThreads: [],
        reviewThreadsTruncated: false,
      }).reviewDecision,
    ).toBe("review-required");
    expect(
      workerCommandSchema.parse({
        type: "github.pull-request.review.comment",
        cwd: "/repo/worktrees/feature",
        repository: "ArcaneArts/Cantrip",
        number: 44,
        comment: {
          body: "Please rename this.",
          path: "src/review.ts",
          line: 12,
          side: "RIGHT",
        },
      }),
    ).toMatchObject({ comment: { line: 12, startLine: null } });
    expect(
      workerCommandSchema.safeParse({
        type: "github.pull-request.review.comment",
        cwd: "/repo",
        repository: "ArcaneArts/Cantrip",
        number: 44,
        comment: {
          body: "Unsafe path",
          path: "../secret",
          line: 1,
          side: "RIGHT",
        },
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.safeParse({
        type: "github.pull-request.review.submit",
        cwd: "/repo",
        repository: "ArcaneArts/Cantrip",
        number: 44,
        review: { event: "request-changes", body: "" },
      }).success,
    ).toBe(false);
  });

  it("validates GitHub repository owners and creation commands", () => {
    expect(
      githubRepositoryOwnerListSchema.parse([
        { login: "cyberpwnn", kind: "user" },
        { login: "ArcaneArts", kind: "organization" },
      ]),
    ).toHaveLength(2);
    const request = githubRepositoryCreateSchema.parse({
      owner: "ArcaneArts",
      name: "cantrip-labs",
      description: "A Cantrip project",
      visibility: "private",
    });
    expect(request.initialize).toBe("readme");
    expect(
      workerCommandSchema.parse({
        type: "github.repository-owners.list",
      }).type,
    ).toBe("github.repository-owners.list");
    expect(
      workerCommandSchema.parse({
        type: "github.repositories.create",
        request,
      }),
    ).toMatchObject({ request });
    expect(
      githubRepositoryCreateSchema.safeParse({
        ...request,
        name: "../unsafe",
      }).success,
    ).toBe(false);
  });

  it("validates worker-owned authenticated project share lifecycles", () => {
    const shareId = "11111111-1111-4111-8111-111111111111";
    const publicBasePath = `/project-shares/${"x".repeat(43)}`;
    const protectedRecord = {
      operationId: shareId,
      revision: 1,
      protectedContent: {
        formatVersion: 1,
        domain: "tunnel-content",
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    };
    expect(
      workerCommandSchema.parse({
        type: "project.share.open",
        shareId,
        protectedRecord,
      }),
    ).toEqual({
      type: "project.share.open",
      shareId,
      protectedRecord,
    });
    expect(
      workerCommandSchema.parse({
        type: "project.share.close",
        shareId,
      }),
    ).toEqual({ type: "project.share.close", shareId });
    expect(
      workerProjectShareOpenResultSchema.parse({
        accepted: true,
        shareId,
      }),
    ).toEqual({ accepted: true, shareId });
    expect(
      workerProjectShareDescriptorSchema.parse({
        shareId,
        protocol: "webdav",
        publicBasePath,
        publicOrigin: "http://127.0.0.1",
        loopbackHost: "127.0.0.1",
        loopbackPort: 43_210,
        username: "cantrip-user",
        password: "a-secure-random-password-value",
        realm: "Cantrip Project Share",
      }),
    ).toMatchObject({ protocol: "webdav", loopbackPort: 43_210 });
    expect(
      workerProjectShareDescriptorSchema.safeParse({
        shareId,
        protocol: "webdav",
        publicBasePath,
        publicOrigin: "http://127.0.0.1",
        loopbackHost: "0.0.0.0",
        loopbackPort: 43_210,
        username: "cantrip-user",
        password: "a-secure-random-password-value",
        realm: "Cantrip Project Share",
      }).success,
    ).toBe(false);
  });

  it("validates native customization worker commands and bounded MCP reads", () => {
    const protectedContent = {
      operationId: "8f8df681-8b15-4a74-82e9-e9025709d4fc",
      serverId: "https://cantrip.example",
      scope: {
        workerId: "worker-1",
        projectId: "project-1",
        chatId: "chat-1",
        providerId: "provider-1",
      },
    };
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
        threadId: "thread-1",
        ...protectedContent,
        ...runtime,
      }),
    ).toMatchObject({ forceReload: false, threadId: "thread-1" });
    expect(
      workerCommandSchema.parse({
        type: "customization.external.preview",
        ...protectedContent,
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
        ...protectedContent,
        ...runtime,
        protectedRequest: customizationContentFixture(),
      }).type,
    ).toBe("customization.skill.configure");
    expect(
      workerCommandSchema.parse({
        type: "customization.mcp.oauth.status",
        ...protectedContent,
        ...runtime,
        protectedRequest: customizationContentFixture(),
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
        ...protectedContent,
        ...runtime,
        protectedRequest: customizationContentFixture(),
      }).type,
    ).toBe("customization.external.apply");
  });

  it("models capability-gated chat permission profiles", () => {
    expect(
      chatPermissionProfileStateSchema.parse({
        available: true,
        profiles: [
          { id: ":workspace", description: "Workspace writes", allowed: true },
          {
            id: ":yolo",
            description: "Unrestricted access without approvals",
            allowed: true,
          },
        ],
        selectedId: ":workspace",
        effectiveId: ":read-only",
        defaultId: ":workspace",
        usesDefault: false,
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
    const worktree = projectWorktreeSummarySchema.parse({
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
    });
    expect(worktree.isPrimary).toBe(true);
    expect(worktree.rootKind).toBe("git-worktree");

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

  it("retains historical worktree activity without a tool-call protocol", () => {
    expect(
      agentActivitySchema.parse({
        type: "worktree",
        id: "worktree-tool:call-1",
        operation: "worktree.switch",
        status: "completed",
        summary: "Continuation scheduled.",
        worktreeId: "worktree-2",
      }).type,
    ).toBe("worktree");
  });

  it("validates protected trajectory captures and instruction provenance", () => {
    const activity = agentActivitySchema.parse({
      type: "instructionContext",
      id: "turn:turn-1:instructions",
      status: "completed",
      provenance: "assembled",
      text: "Cantrip developer instructions",
      sources: ["Cantrip runtime developer instructions"],
      model: "gpt-5.6-sol",
      provider: "provider-1",
      reasoningEffort: "high",
      collaborationMode: "default",
      permissionProfile: "trusted",
      runtimeVersion: "1.2.3",
      raw: {
        schemaVersion: 1,
        request: {
          mediaType: "text/plain; charset=utf-8",
          text: "Cantrip developer instructions",
          originalBytes: 30,
          truncated: false,
        },
        response: null,
        metadata: { source: "assembled" },
      },
    });
    expect(activity).toMatchObject({
      type: "instructionContext",
      provenance: "assembled",
      raw: { schemaVersion: 1 },
    });

    for (const [direction, limit] of [
      ["request", agentActivityRawRequestLimitBytes],
      ["response", agentActivityRawResponseLimitBytes],
    ] as const) {
      expect(
        agentActivitySchema.safeParse({
          ...activity,
          raw: {
            ...activity.raw,
            [direction]: {
              mediaType: "text/plain",
              text: "x".repeat(limit + 1),
              originalBytes: limit + 1,
              truncated: false,
            },
          },
        }).success,
      ).toBe(false);
    }
  });

  it("validates bounded live command and file inspection telemetry", () => {
    const output = "🙂".repeat(65_536);
    expect(new TextEncoder().encode(output)).toHaveLength(256 * 1_024);
    expect(
      agentActivitySchema.parse({
        type: "command",
        id: "command-1",
        status: "running",
        command: "pnpm test",
        cwd: ".",
        exitCode: null,
        output: "transcript output",
        outputTail: output,
        outputTruncated: true,
        startedAtMs: 1_000,
        updatedAtMs: 2_000,
        completedAtMs: null,
      }),
    ).toMatchObject({
      output: "transcript output",
      outputTail: output,
      outputTruncated: true,
      startedAtMs: 1_000,
    });
    expect(
      agentActivitySchema.safeParse({
        type: "command",
        id: "command-2",
        status: "running",
        command: "pnpm test",
        cwd: ".",
        exitCode: null,
        output: null,
        outputTail: `${output}x`,
      }).success,
    ).toBe(false);
    expect(
      agentActivitySchema.parse({
        type: "fileChange",
        id: "files-1",
        status: "running",
        startedAtMs: 1_000,
        updatedAtMs: 2_000,
        changes: [
          {
            path: "src/path with spaces.ts",
            kind: "update",
            latestLine: "export const ready = true;",
            lastActivityAtMs: 2_000,
          },
        ],
      }),
    ).toMatchObject({
      changes: [
        {
          path: "src/path with spaces.ts",
          latestLine: "export const ready = true;",
        },
      ],
    });
  });

  it("validates CLI results and bounded terminal snapshots", () => {
    const target = {
      kind: "surface" as const,
      projectId: "project-1",
      surfaceKind: "terminal" as const,
      surfaceId: "terminal-2",
    };
    expect(
      cantripCliCommandResultSchema.parse({
        summary: "Terminal is running.",
        target,
        mutated: true,
        data: { status: "running" },
      }),
    ).toMatchObject({ target, mutated: true });
    expect(
      terminalSnapshotResultSchema.parse({
        terminalId: "terminal-2",
        status: "running",
        data: "recent output",
        truncated: false,
        exitCode: null,
      }).status,
    ).toBe("running");
    expect(
      workerCommandSchema.parse({
        type: "terminal.snapshot",
        terminalId: "terminal-2",
        serverId: "https://cantrip.example",
        operationId: "snapshot-operation",
        sequence: 0,
        protectedRequest: terminalStateFixture().protectedState,
      }),
    ).toMatchObject({
      type: "terminal.snapshot",
      operationId: "snapshot-operation",
    });
    expect(
      browserUpdateSchema.safeParse({ url: "file:///etc/passwd" }).success,
    ).toBe(false);
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

  it("keeps provider auth live status strictly free of secret material", () => {
    const safeStatus = {
      state: "pending" as const,
      authMode: null,
      email: null,
      planType: null,
      weeklyUsage: null,
      failureCode: null,
    };
    const observation = {
      type: "provider.auth.status.observed" as const,
      observationId: "00000000-0000-4000-8000-000000000001",
      providerId: "provider-1",
      providerAccountId: "account-1",
      providerKind: "chatgpt" as const,
      sequence: 1,
      observedAt: "2026-08-21T12:00:00.000Z",
      expiresAt: "2026-08-21T12:15:00.000Z",
      status: safeStatus,
    };
    expect(providerAuthStatusObservationSchema.parse(observation)).toEqual(
      observation,
    );
    const liveStatus = {
      providerId: observation.providerId,
      providerAccountId: observation.providerAccountId,
      providerKind: observation.providerKind,
      workerId: "worker-1",
      revision: 1,
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
      status: safeStatus,
    };
    expect(providerAuthLiveStatusSchema.parse(liveStatus).status).toEqual(
      safeStatus,
    );
    for (const secret of [
      "accessToken",
      "refreshToken",
      "deviceCode",
      "userCode",
      "privateKey",
      "protectedCredential",
    ]) {
      expect(
        providerAuthStatusObservationSchema.safeParse({
          ...observation,
          status: { ...safeStatus, [secret]: "must-not-cross-live" },
        }).success,
      ).toBe(false);
      expect(
        providerAuthLiveStatusSchema.safeParse({
          ...liveStatus,
          [secret]: "must-not-cross-live",
        }).success,
      ).toBe(false);
    }
    expect(
      providerAuthStatusObservationSchema.safeParse({
        ...observation,
        status: {
          ...safeStatus,
          state: "authenticated",
          authMode: "grok",
        },
      }).success,
    ).toBe(false);
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
    expect(
      workerCommandSchema.parse({
        type: "provider.auth.account.clear",
        providerId: "chatgpt-provider-1",
        providerKind: "chatgpt",
        providerAccountId: "account-1",
        credentialHomeKey: "account-home-1",
      }).type,
    ).toBe("provider.auth.account.clear");
    expect(
      workerCommandSchema.parse({
        type: "codex.auth.login.start",
        providerId: "chatgpt-provider-1",
        providerAccountId: "account-1",
        providerKind: "chatgpt",
        credentialHomeKey: "account-home-1",
        observationId: "00000000-0000-4000-8000-000000000001",
      }).type,
    ).toBe("codex.auth.login.start");
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

  it("validates worker-backed latest-turn rollback", () => {
    expect(
      workerCommandSchema.parse({
        type: "chat.turn.rollback",
        chatId: "chat-1",
        clientMessageId: "message-1",
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
    ).toBe("chat.turn.rollback");
  });

  it("validates an ephemeral provider connection test without chat state", () => {
    const command = workerCommandSchema.parse({
      type: "model.provider.test",
      model: {
        id: "glm-5.3",
        routeId: "route-zai",
        name: "glm-5.3",
        reasoningEffort: null,
      },
      provider: {
        id: "provider-zai",
        name: "Z.ai Coding Plan",
        kind: "openai-compatible",
        baseUrl: "https://api.z.ai/api/v1",
        apiKey: "server-leased-secret",
      },
    });

    expect(command).toMatchObject({
      type: "model.provider.test",
      model: { name: "glm-5.3" },
      provider: { name: "Z.ai Coding Plan" },
    });
  });

  it("carries project worktree and opaque effective policies into worker-backed turns", () => {
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
      policyProjectId: "project-1",
      policies: { policies: [] },
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
      rootKind: "git-worktree",
      worktreeMode: "agent-managed",
      worktreePolicy: "required-for-writes",
      policyProjectId: "project-1",
      policies: { policies: [] },
      planMode: "plan",
      automationPaused: true,
    });

    expect(
      workerCommandSchema.parse({
        ...turn,
        rootKind: "folder-root",
      }),
    ).toMatchObject({ type: "chat.turn", rootKind: "folder-root" });

    const taskTurn = workerCommandSchema.parse({
      ...turn,
      resultMode: {
        kind: "task-message-encrypted",
        messageId: "11111111-1111-4111-8111-111111111111",
        idempotencyKey: "task-message-1",
      },
      taskDispatchLease: {
        cycleId: "22222222-2222-4222-8222-222222222222",
        operationId: "task-operation-1",
        leaseOwner: "scheduler-1",
        fencingToken: 1,
        leaseExpiresAt: "2026-08-24T12:02:00.000Z",
      },
    });
    expect(taskTurn.taskDispatchLease?.fencingToken).toBe(1);
    expect(
      workerNotificationSchema.parse({
        type: "chat.turn.outcome",
        chatId: taskTurn.chatId,
        clientMessageId: taskTurn.clientMessageId,
        executionLaneId: taskTurn.executionLaneId,
        worktreeId: taskTurn.worktreeId,
        taskDispatchFence: {
          cycleId: taskTurn.taskDispatchLease!.cycleId,
          operationId: taskTurn.taskDispatchLease!.operationId,
          leaseOwner: taskTurn.taskDispatchLease!.leaseOwner,
          fencingToken: taskTurn.taskDispatchLease!.fencingToken,
        },
        outcome: {
          ok: true,
          result: { threadId: "thread-1", text: "Done", status: "completed" },
        },
      }).taskDispatchFence,
    ).toMatchObject({ operationId: "task-operation-1", fencingToken: 1 });
    expect(
      workerCommandSchema.safeParse({
        ...turn,
        taskDispatchLease: taskTurn.taskDispatchLease,
      }).success,
    ).toBe(false);
  });

  it("keeps workflow node execution distinct and attempt-attributed", () => {
    const command = workerCommandSchema.parse({
      type: "workflow.node.execute",
      workflowRunId: "run-1",
      workflowRevisionId: "revision-1",
      revisionNodeId: "revision-node-1",
      nodePosition: 0,
      nodeType: "agent",
      runNodeId: "run-node-1",
      attemptId: "attempt-1",
      idempotencyKey: "execute-1",
      worktreeId: null,
      cwd: "/workspace",
      threadId: null,
      protectedDefinition: workflowContentFixture(),
      protectedRunInput: workflowContentFixture(),
      predecessorResults: [],
      outgoingDependencies: [],
      mutationMode: "read-only",
      permissionProfileId: ":read-only",
      maxNodeExecutions: 100,
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
      rootKind: "git-worktree",
    });
    expect(
      workerCommandSchema.parse({ ...command, rootKind: "folder-root" }),
    ).toMatchObject({
      type: "workflow.node.execute",
      rootKind: "folder-root",
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
    const protectedGateDecision = workerCommandSchema.parse({
      type: "workflow.gate.decide.protected",
      workflowRunId: "run-1",
      workflowRevisionId: "revision-1",
      revisionNodeId: "revision-node-1",
      nodePosition: 0,
      runNodeId: "run-node-1",
      attemptId: "attempt-1",
      gateId: "gate-1",
      denialPolicy: "fail-run",
      protectedDefinition: workflowContentFixture(),
      protectedRunInput: workflowContentFixture(),
      predecessorResults: [],
      outgoingDependencies: [],
      mutationMode: "read-only",
      permissionProfileId: ":read-only",
      protectedResponse: workflowContentFixture(),
    });
    expect(protectedGateDecision).toMatchObject({
      type: "workflow.gate.decide.protected",
      gateId: "gate-1",
      denialPolicy: "fail-run",
    });
    expect(
      workerCommandSchema.safeParse({
        ...protectedGateDecision,
        reason: "A private gate reason must not cross this boundary.",
      }).success,
    ).toBe(false);
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

  it("routes protected workflow interactions without visible payloads", () => {
    const event = workerEventSchema.parse({
      type: "workflow.node.interaction.requested.protected",
      attemptId: "attempt-1",
      request: {
        requestKey: "request-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        classification: { kind: "userInput" },
        protectedPayload: workflowContentFixture(),
        expiresAt: "2026-08-21T12:00:00.000Z",
      },
    });

    expect(event).toMatchObject({
      type: "workflow.node.interaction.requested.protected",
      attemptId: "attempt-1",
      request: {
        requestKey: "request-1",
        classification: { kind: "userInput" },
      },
    });
    expect("payload" in event.request).toBe(false);
    expect(
      agentInteractionRequestQuerySchema.parse({
        workflowRunId: "run-1",
        status: "pending",
      }),
    ).toEqual({
      workflowRunId: "run-1",
      status: "pending",
      limit: 100,
    });
  });

  it("carries exact usage as minimized protected-chat telemetry", () => {
    const usage = {
      totalTokens: 1_200,
      inputTokens: 800,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 25,
      outputTokens: 300,
      reasoningOutputTokens: 100,
    };
    const event = workerEventSchema.parse({
      type: "agent.protected-message",
      message: protectedChatMessageFixture(),
      telemetry: {
        kind: "usage",
        usage,
        modelContextWindow: 128_000,
        contextUsedPercent: 12.5,
        turnId: "turn-1",
        plaintextActivity: "must be stripped",
      },
    });

    expect(event.telemetry).toEqual({
      kind: "usage",
      usage,
      modelContextWindow: 128_000,
      contextUsedPercent: 12.5,
      turnId: "turn-1",
    });
    expect(JSON.stringify(event.telemetry)).not.toContain("plaintextActivity");
    const taskEvent = workerEventSchema.parse({
      type: "agent.protected-task-message",
      message: {
        ...protectedChatMessageFixture(),
        idempotencyKey: "protected-task-activity",
      },
      telemetry: {
        kind: "activity",
        activityType: "command",
        turnId: "turn-1",
        raw: "must be stripped",
      },
    });
    expect(taskEvent).toMatchObject({
      type: "agent.protected-task-message",
      telemetry: {
        kind: "activity",
        activityType: "command",
        turnId: "turn-1",
      },
    });
    expect(JSON.stringify(taskEvent.telemetry)).not.toContain("raw");
    expect(
      workerEventSchema.safeParse({
        ...event,
        telemetry: {
          ...event.telemetry,
          usage: { ...usage, inputTokens: -1 },
        },
      }).success,
    ).toBe(false);
    expect(
      agentTurnResultSchema.parse({
        threadId: "thread-1",
        turnId: "turn-1",
        text: "",
        measuredUsage: usage,
        status: "completed",
      }).measuredUsage,
    ).toEqual(usage);
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

  it("does not serialize provider credentials through worker events", () => {
    const secret = "provider-refresh-token-that-must-not-escape";
    const event = workerEventSchema.parse({
      type: "terminal.ready",
      accessToken: "provider-access-token-that-must-not-escape",
      refreshToken: secret,
      credentialEnvelope: `encrypted:${secret}`,
    });

    expect(event).toEqual({ type: "terminal.ready" });
    expect(JSON.stringify(event)).not.toContain(secret);
    expect(JSON.stringify(event)).not.toContain("provider-access-token");
    expect(JSON.stringify(event)).not.toContain("credentialEnvelope");
  });

  it("validates provider-neutral inference progress without prompt content", () => {
    const input = {
      kind: "progress",
      requestId: "message-one",
      cycle: 1,
      sequence: 1,
      phase: "prefill",
      fractionComplete: 10_240 / 46_492,
      completedTokens: 10_240,
      totalTokens: 46_492,
      precision: "estimated",
      source: "provider-observer",
      startedAt: "2026-08-24T11:59:00.000Z",
      observedAt: "2026-08-24T12:00:00.000Z",
    } as const;
    expect(
      inferenceProgressSnapshotSchema.safeParse({
        ...input,
        prompt: "must not cross this boundary",
      }).success,
    ).toBe(false);
    const progress = inferenceProgressSnapshotSchema.parse(input);
    expect(progress).toEqual(input);
    expect(
      workerEventSchema.parse({
        type: "agent.inference-progress",
        progress,
      }),
    ).toMatchObject({
      type: "agent.inference-progress",
      progress: { phase: "prefill", completedTokens: 10_240 },
    });
    expect(
      inferenceProgressSnapshotSchema.safeParse({
        ...progress,
        fractionComplete: null,
      }).success,
    ).toBe(false);
    expect(
      inferenceProgressSnapshotSchema.safeParse({
        ...progress,
        startedAt: "2026-08-24T12:00:01.000Z",
      }).success,
    ).toBe(false);
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
      threadId: null,
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
    expect(compact.threadId).toBeNull();
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
    expect(
      worktreeCreateMutationFailureSchema.parse({
        code: "worktree-create-rolled-back",
        error: "The newly created worktree was rolled back.",
        mutation: {
          outcome: "rolledBack",
          retryable: true,
          target: {
            kind: "worktree",
            projectId: "project-1",
            worktreeId: "worktree-1",
          },
        },
      }).mutation.outcome,
    ).toBe("rolledBack");
    expect(
      worktreeCreateMutationFailureSchema.safeParse({
        code: "worktree-create-not-started",
        error: "Creation did not start.",
        mutation: {
          outcome: "notStarted",
          retryable: false,
          target: {
            kind: "worktree",
            projectId: "project-1",
            worktreeId: "worktree-1",
          },
        },
      }).success,
    ).toBe(false);
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
    expect(normalizeResponsesBaseUrl("https://api.z.ai/api/v1/responses")).toBe(
      "https://api.z.ai/api/v1",
    );
    expect(
      new URL(
        `${normalizeResponsesBaseUrl("https://api.z.ai/api/v1/responses")}/responses`,
      ).toString(),
    ).toBe("https://api.z.ai/api/v1/responses");
  });

  it("recognizes only the canonical Z.ai Coding Plan Responses root", () => {
    expect(isZaiCodingPlanBaseUrl("https://api.z.ai/api/v1")).toBe(true);
    expect(isZaiCodingPlanBaseUrl("https://API.Z.AI/api/v1/responses")).toBe(
      true,
    );
    expect(isZaiCodingPlanBaseUrl("https://api.z.ai/api/coding/paas/v4")).toBe(
      false,
    );
    expect(isZaiCodingPlanBaseUrl("https://openrouter.ai/api/v1")).toBe(false);
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
    expect(heartbeat.externalCodexHistory).toBe(false);
  });

  it("defaults legacy workers to unavailable and gates newer subagent protocols", () => {
    const legacy = codexRuntimeReportSchema.parse({
      ...unprobedCodexRuntimeReport,
      nativeSubagents: undefined,
    });
    expect(legacy.nativeSubagents).toEqual(
      unprobedCodexRuntimeReport.nativeSubagents,
    );
    expect(nativeSubagentCapabilityCompatible(legacy.nativeSubagents)).toBe(
      false,
    );

    const newer = codexRuntimeReportSchema.parse({
      ...unprobedCodexRuntimeReport,
      nativeSubagents: {
        available: true,
        protocolVersion: 2,
        reason: null,
      },
    });
    expect(newer.nativeSubagents.protocolVersion).toBe(2);
    expect(nativeSubagentCapabilityCompatible(newer.nativeSubagents)).toBe(
      false,
    );
    expect(
      nativeSubagentCapabilityCompatible({
        available: true,
        protocolVersion: NATIVE_SUBAGENT_PROTOCOL_VERSION,
        reason: null,
      }),
    ).toBe(true);
  });

  it("validates external Codex history discovery metadata and commands", () => {
    const command = workerCommandSchema.parse({
      type: "external.chat-history.discover",
      includeArchived: false,
      targets: [
        {
          projectReplicaId: "replica-one",
          path: "/workspace/Cantrip",
          repositoryFingerprint: "fingerprint",
          worktrees: [
            {
              worktreeId: "worktree-one",
              path: "/workspace/Cantrip",
              isPrimary: true,
            },
          ],
        },
      ],
    });
    expect(command.type).toBe("external.chat-history.discover");

    const workerResult = externalChatDiscoveryWorkerResultSchema.parse({
      sources: [
        {
          kind: "chatgpt-codex",
          sourceId: "a".repeat(64),
          name: "ChatGPT Codex",
          platform: "darwin",
          homeLabel: "~/.codex",
          availability: "available",
          message: null,
          runtimeVersion: "0.149.0",
          truncated: false,
          threads: [
            {
              sourceThreadId: "thread-one",
              title: "Import chat history",
              preview: "Continue the Cantrip work",
              cwd: "/workspace/Cantrip",
              createdAt: "2026-08-14T10:00:00.000Z",
              updatedAt: "2026-08-15T10:00:00.000Z",
              archived: false,
              source: "vscode",
              status: "not-loaded",
              modelProvider: "openai",
              cliVersion: "0.149.0",
              git: null,
              match: {
                kind: "worktree-path",
                projectReplicaId: "replica-one",
                worktreeId: "worktree-one",
              },
            },
          ],
        },
      ],
      truncated: false,
    });
    expect(workerResult.sources[0]?.threads).toHaveLength(1);
    expect(workerResult.sources[0]?.threads[0]?.existingImport).toBeNull();
    expect(
      projectExternalChatDiscoverySchema.parse({
        projectId: "project-one",
        observedAt: "2026-08-15T10:00:00.000Z",
        partial: false,
        truncated: false,
        workers: [
          {
            workerId: "worker-one",
            workerName: "Worker One",
            platform: "darwin",
            status: "ok",
            sources: workerResult.sources.map((source) => ({
              ...source,
              threads: source.threads.map((thread) => ({
                ...thread,
                existingImport: {
                  jobId: "00000000-0000-4000-8000-000000000001",
                  projectId: "project-one",
                  chatId: "chat-one",
                  state: "succeeded",
                },
              })),
            })),
            error: null,
          },
        ],
      }).workers[0],
    ).toMatchObject({
      status: "ok",
      sources: [
        {
          threads: [
            {
              existingImport: {
                projectId: "project-one",
                state: "succeeded",
              },
            },
          ],
        },
      ],
    });
  });

  it("validates Cantrip Code capabilities, durable tabs, and worker commands", () => {
    expect(
      codeAttachmentCreateSchema.parse({
        appearance: "dark",
        expectedWorkerId: "code-worker",
        expectedWorktreeId: "worktree-1",
      }),
    ).toMatchObject({
      expectedWorkerId: "code-worker",
      expectedWorktreeId: "worktree-1",
    });
    expect(
      codeAttachmentCreateSchema.safeParse({ appearance: "dark" }).success,
    ).toBe(false);
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
        initialFile: "packages/protocol/src/index.ts",
        themeMode: "follow-cantrip",
        appearance: "high-contrast-dark",
      }),
    ).toMatchObject({
      type: "code.open",
      initialFile: "packages/protocol/src/index.ts",
      presentation: "workbench",
    });
    expect(
      workerCommandSchema.parse({
        type: "code.openFile",
        sessionId: "session-1",
        path: "packages/protocol/src/index.ts",
      }).type,
    ).toBe("code.openFile");
    expect(
      workerCommandSchema.parse({
        type: "code.endpoint.revoke",
        tunnelId: "11111111-1111-4111-8111-111111111111",
      }).type,
    ).toBe("code.endpoint.revoke");
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

  it("validates one-click managed desktops without client configuration", () => {
    expect(remoteDesktopCreateSchema.parse({})).toEqual({});
    expect(remoteDesktopCreateSchema.parse({ tabGroupId: "group-1" })).toEqual({
      tabGroupId: "group-1",
    });
    expect(
      remoteDesktopCreateSchema.safeParse({
        desktopTarget: {
          kind: "monitor",
          id: "display-1",
          name: "Studio Display",
        },
      }).success,
    ).toBe(false);
    expect(
      remoteDesktopCreateSchema.safeParse({ host: "127.0.0.1" }).success,
    ).toBe(false);
    const summary = remoteDesktopSummarySchema.parse({
      id: "desktop-1",
      projectId: "project-1",
      title: "Desk",
      position: 2,
      workerId: "worker-1",
      stateRevision: 1,
      target: { kind: "monitor", id: null, name: null },
      status: "offline",
      lastError: null,
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
    });
    expect(summary).not.toHaveProperty("password");
    expect(summary).not.toHaveProperty("secretRef");
    expect(
      remoteDesktopWireSummarySchema.safeParse({
        id: "desktop-1",
        projectId: "project-1",
        titleProtection: protectedLabelFixture("project-view"),
        position: 2,
        workerId: "worker-1",
        stateProtection: remoteDesktopStateFixture(),
        stateRevision: 1,
        target: { kind: "monitor", id: null, name: "Private display" },
        status: "offline",
        lastError: null,
        createdAt: "2026-08-08T12:00:00.000Z",
        updatedAt: "2026-08-08T12:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      encryptedRemoteDesktopCreateSchema.safeParse({
        id: "00000000-0000-4000-8000-000000000421",
        titleProtection: protectedLabelFixture("project-view"),
        stateProtection: remoteDesktopStateFixture(),
        desktopTarget: {
          kind: "window",
          id: "window-42",
          application: "Code",
          title: "Cantrip",
        },
      }).success,
    ).toBe(false);
    expect(
      encryptedRemoteDesktopUpdateSchema.safeParse({
        expectedStateRevision: 1,
        stateProtection: remoteDesktopStateFixture(),
        target: {
          kind: "window",
          id: "window-42",
          application: "Code",
          title: "Cantrip",
        },
      }).success,
    ).toBe(false);
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
            iconKey: "desktop-app-v1-abc123",
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
      workerCommandSchema.parse({
        type: "surface.desktop.targets",
        serverId: "server-1",
        operationId: "00000000-0000-4000-8000-000000000422",
        resourceId: "worker-1",
        limit: 100,
      }).type,
    ).toBe("surface.desktop.targets");
    expect(
      remoteDesktopFleetSchema.parse({
        projectId: "project-1",
        observedAt: "2026-08-12T12:00:00.000Z",
        partial: true,
        workers: [
          {
            workerId: "worker-1",
            workerName: "Studio Mac",
            platform: "darwin",
            architecture: "arm64",
            status: "ok",
            inventory: { monitors: [], windows: [] },
            desktops: [summary],
            error: null,
          },
          {
            workerId: "worker-2",
            workerName: "Offline PC",
            platform: "win32",
            architecture: "x64",
            status: "offline",
            inventory: { monitors: [], windows: [] },
            desktops: [],
            error: {
              code: "worker-offline",
              message: "Offline PC is offline.",
            },
          },
        ],
      }).workers[1]?.status,
    ).toBe("offline");
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
      remoteDesktopServerMessageSchema.safeParse({
        type: "desktop-targets",
        inventory: { monitors: [], windows: [] },
        requested: { kind: "monitor", id: null, name: "Private display" },
        active: { kind: "monitor", id: null, name: "Private display" },
        launchingApplication: null,
        message: null,
      }).success,
    ).toBe(false);
    expect(
      remoteDesktopServerMessageSchema.parse({
        type: "desktop-targets",
        operationId: "00000000-0000-4000-8000-000000000423",
        stateProtection: remoteDesktopInventoryFixture(),
        monitorCount: 1,
        windowCount: 2,
      }),
    ).not.toHaveProperty("inventory");
    expect(
      remoteDesktopClientMessageSchema.parse({
        type: "request-target-icons",
        keys: ["desktop-app-v1-abc123"],
      }).type,
    ).toBe("request-target-icons");
    expect(
      remoteDesktopServerMessageSchema.parse({
        type: "desktop-target-icons",
        icons: [
          {
            key: "desktop-app-v1-abc123",
            mimeType: "image/png",
            data: Buffer.from("png").toString("base64"),
          },
        ],
      }).type,
    ).toBe("desktop-target-icons");
    expect(
      workerCommandSchema.parse({
        type: "surface.configure",
        surfaceId: "desktop-1",
        serverId: "server-1",
        stateResource: "remote-desktop-row",
        stateRevision: 1,
        stateProtection: remoteDesktopStateFixture(),
        configuration: { kind: "desktop" },
      }).type,
    ).toBe("surface.configure");
    expect(
      userSettingsSchema.parse({
        theme: "system",
        highContrast: false,
        proMode: false,
        proModeOpacity: 80,
        sidebarWidth: 288,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: null,
      }),
    ).toMatchObject({
      desktopFrameRate: 30,
      eliteMode: true,
      eliteRevealConfig: DEFAULT_ELITE_REVEAL_CONFIG,
      defaultPermissionProfileId: ":workspace",
      defaultWorkerId: null,
      automaticReplicaProvisioning: false,
      automaticReplicaSynchronization: "off",
      mobileProjectTabConfigurations: {},
    });
    expect(
      userSettingsSchema.safeParse({
        theme: "system",
        highContrast: false,
        proMode: false,
        proModeOpacity: 80,
        sidebarWidth: 288,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: null,
        mobileProjectTabConfigurations: {
          "project-1": Array.from(
            { length: 21 },
            (_, index) => `group-${String(index)}`,
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      userSettingsSchema.safeParse({
        theme: "system",
        highContrast: false,
        proMode: false,
        proModeOpacity: 80,
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
        proMode: false,
        proModeOpacity: 80,
        sidebarWidth: MIN_SIDEBAR_WIDTH - 1,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: null,
      }).success,
    ).toBe(false);
    expect(
      userSettingsSchema.safeParse({
        theme: "system",
        highContrast: false,
        proMode: false,
        proModeOpacity: 80,
        sidebarWidth: MIN_SIDEBAR_WIDTH,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: null,
        defaultPermissionProfileId: ":unknown",
      }).success,
    ).toBe(false);
    expect(userSettingsUpdateSchema.parse({ theme: "dark" })).toEqual({
      theme: "dark",
    });
    expect(
      userSettingsUpdateSchema.safeParse({
        eliteRevealConfig: {
          ...DEFAULT_ELITE_REVEAL_CONFIG,
          glitchCountMax: 1,
          glitchCountMin: 2,
        },
      }).success,
    ).toBe(false);
    expect(
      userSettingsUpdateSchema.safeParse({
        eliteRevealConfig: {
          ...DEFAULT_ELITE_REVEAL_CONFIG,
          glitchCountMax: MAX_ELITE_GLITCH_COUNT,
          glitchCountMin: MAX_ELITE_GLITCH_COUNT,
        },
      }).success,
    ).toBe(true);
    expect(
      userSettingsUpdateSchema.safeParse({
        eliteRevealConfig: {
          ...DEFAULT_ELITE_REVEAL_CONFIG,
          glitchCountMax: MAX_ELITE_GLITCH_COUNT + 1,
        },
      }).success,
    ).toBe(false);
    expect(
      userSettingsUpdateSchema.parse({
        eliteMode: true,
        eliteRevealConfig: {
          ...DEFAULT_ELITE_REVEAL_CONFIG,
          variants: ["chromatic"],
        },
      }),
    ).toMatchObject({
      eliteMode: true,
      eliteRevealConfig: {
        variants: ["chromatic"],
        variantWeights: {
          chromatic: 0.25,
          "full-frame": 0.01,
          "left-frame": 0.01,
          "right-frame": 0.01,
          scanline: 0.33,
        },
      },
    });
    expect(
      userSettingsUpdateSchema.parse({
        eliteRevealConfig: {
          glitchCountMax: 3,
          glitchCountMin: 1,
          glitchShowMs: 9,
          staggerSpreadMs: 50,
          variants: ["outline"],
        },
      }).eliteRevealConfig?.variantWeights,
    ).toEqual(DEFAULT_ELITE_REVEAL_CONFIG.variantWeights);
    expect(
      userSettingsUpdateSchema.parse({
        eliteRevealConfig: {
          glitchCountMax: 3,
          glitchCountMin: 1,
          glitchShowMs: 9,
          staggerSpreadMs: 50,
          variants: ["outline"],
        },
      }).eliteRevealConfig?.glitchTerminalContents,
    ).toBe(false);
    expect(
      userSettingsUpdateSchema.safeParse({
        eliteRevealConfig: {
          ...DEFAULT_ELITE_REVEAL_CONFIG,
          variantWeights: {
            ...DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
            chromatic: 10.01,
          },
        },
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
            title: "Chat",
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
    expect(
      tabGroupUpdateSchema.parse({ revision: 3, title: "  Agents  " }),
    ).toEqual({ revision: 3, title: "Agents" });
    expect(
      tabGroupUpdateSchema.safeParse({ revision: 3, title: "   " }).success,
    ).toBe(false);
    expect(
      encryptedTabGroupUpdateSchema.safeParse({
        revision: 3,
        titleProtection: protectedLabelFixture("tab-group"),
      }).success,
    ).toBe(true);
    expect(
      encryptedTabGroupUpdateSchema.safeParse({
        revision: 3,
        titleProtection: protectedLabelFixture("chat"),
      }).success,
    ).toBe(false);
    const wireGroup = {
      id: "group-1",
      projectId: "project-1",
      titleProtection: null,
      position: 0,
      anchorTabKey: "chat:chat-1",
      members: [
        {
          tabKey: "chat:chat-1",
          groupId: "group-1",
          projectId: "project-1",
          tabKind: "chat" as const,
          tabId: "chat-1",
          titleProtection: protectedLabelFixture("chat"),
          position: 0,
          createdAt: "2026-08-09T12:00:00.000Z",
          updatedAt: "2026-08-09T12:00:00.000Z",
        },
      ],
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    };
    expect(
      projectTabLayoutWireSummarySchema.safeParse({
        projectId: "project-1",
        revision: 3,
        groups: [wireGroup],
      }).success,
    ).toBe(true);
    expect(
      projectTabLayoutWireSummarySchema.safeParse({
        projectId: "project-1",
        revision: 3,
        groups: [
          {
            ...wireGroup,
            titleProtection: protectedLabelFixture("tab-group"),
          },
        ],
      }).success,
    ).toBe(false);
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

  it("describes liveness and database readiness without account data", () => {
    expect(
      operationalProbeSchema.parse({
        status: "alive",
        service: "cantrip_server",
        timestamp: "2026-08-07T12:00:00.000Z",
      }),
    ).toMatchObject({ status: "alive" });
    expect(
      operationalProbeSchema.parse({
        status: "not-ready",
        service: "cantrip_server",
        database: {
          engine: "postgres",
          status: "unavailable",
          latencyMs: 12,
        },
        timestamp: "2026-08-07T12:00:00.000Z",
      }),
    ).toMatchObject({
      status: "not-ready",
      database: { status: "unavailable" },
    });
  });

  it("describes the local server boundary explicitly", () => {
    const bootstrap = serverBootstrapSchema.parse({
      protocolVersion: 1,
      server: {
        id: "server-id",
        version: { major: 1, minor: 1, patch: 1375, version: "1.1.1375" },
        deploymentMode: "local",
        bootstrapMode: "pnpm-dev",
      },
      auth: {
        mode: "none",
        state: "authenticated",
        currentUser: {
          id: "local-user",
          kind: "anonymous",
          displayName: "Local User",
          email: null,
          role: "owner",
        },
        registration: {
          enabled: false,
          bootstrapRequired: false,
          licenseRequired: false,
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

    expect(bootstrap.auth.currentUser?.kind).toBe("anonymous");
    expect(bootstrap.auth.currentUser?.role).toBe("owner");
    expect(bootstrap.auth.state).toBe("authenticated");
    expect(bootstrap.routing.directWorkerConnections).toBe(false);
    expect(bootstrap.storage).toEqual({
      conversations: "server",
      files: "worker",
    });
    expect(bootstrap.capabilities.worktrees).toBe(true);
    expect(bootstrap.capabilities.projectReplicas).toBe(false);
    expect(bootstrap.capabilities.browserFleetDiscovery).toBe(false);
    expect(bootstrap.capabilities.remoteDesktopFleet).toBe(false);
  });

  it("rejects inconsistent Cantrip version fields", () => {
    expect(() =>
      cantripVersionSchema.parse({
        major: 1,
        minor: 1,
        patch: 1375,
        version: "1.1.1374",
      }),
    ).toThrow(/does not match/u);
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

  it("accepts direct, host-only, and relay WebRTC configurations", () => {
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
      remoteSurfaceWebRtcConfigurationSchema.parse({
        iceServers: [],
        iceTransportPolicy: "all",
        negotiationTimeoutMs: 8_000,
      }),
    ).toEqual({
      iceServers: [],
      iceTransportPolicy: "all",
      negotiationTimeoutMs: 8_000,
    });
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
        operationId: "00000000-0000-4000-8000-000000000001",
        stateProtection: browserStateFixture(),
        title: "",
        canGoBack: false,
        canGoForward: false,
        loading: true,
      }),
    ).toMatchObject({ loading: true });
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
        type: "browser-input-focus",
        editable: true,
      }),
    ).toEqual({ type: "browser-input-focus", editable: true });
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
      terminalServiceConfigurationSchema.parse({
        enabled: true,
        command: "pnpm dev",
      }),
    ).toEqual({ enabled: true, command: "pnpm dev" });
    expect(
      terminalServiceConfigurationSchema.safeParse({
        enabled: true,
        command: "   ",
      }).success,
    ).toBe(false);
    expect(
      terminalSummarySchema.parse({
        id: "terminal-1",
        projectId: "project-1",
        kind: "interactive",
        title: "Terminal",
        position: 0,
        status: "idle",
        activeWorkerId: "worker-1",
        worktreeId: "worktree-1",
        linkedChatId: null,
        runConfigurationId: null,
        runConfigurationRuntimeId: null,
        directoryPath: null,
        service: { enabled: false, command: "" },
        createdAt: "2026-08-11T12:00:00.000Z",
        updatedAt: "2026-08-11T12:00:00.000Z",
      }).service,
    ).toEqual({ enabled: false, command: "" });
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
        operationId: "terminal-operation",
        sequence: 0,
        protectedData: terminalStateFixture().protectedState,
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
        operationId: "terminal-operation",
        serverId: "server-1",
        worktreePath: "/workspace",
        stateProtection: terminalStateFixture(),
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
    expect(
      workerCommandSchema.parse({
        type: "terminal.services.reconcile",
        services: [
          {
            terminalId: "terminal-1",
            serverId: "server-1",
            worktreePath: "/workspace",
            stateProtection: terminalStateFixture(),
          },
        ],
      }).type,
    ).toBe("terminal.services.reconcile");
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
        operationId: "11111111-1111-4111-8111-111111111111",
        direction: "upload",
        chunk: attachmentChunkFixture(),
      }).type,
    ).toBe("attachment.upload.chunk");
    expect(
      workerCommandSchema.parse({
        type: "chat.turn",
        chatId: "chat-1",
        clientMessageId: "message-1",
        executionLaneId: "lane-1",
        worktreeId: "worktree-1",
        policyProjectId: "project-1",
        policies: { policies: [] },
        threadId: null,
        prompt: "Review the diagram.",
        attachments: [
          {
            id: attachment.id,
            chatId: attachment.chatId,
            sizeBytes: attachment.sizeBytes,
            status: attachment.status,
            protectedMetadata: workflowContentFixture(),
            createdAt: attachment.createdAt,
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

  it("bounds account session and audit-event visibility contracts", () => {
    expect(
      accountSessionListSchema.parse([
        {
          id: "session-1",
          authMethod: "account-password",
          label: "Safari on macOS",
          current: true,
          createdAt: "2026-08-11T12:00:00.000Z",
          lastSeenAt: "2026-08-11T12:01:00.000Z",
          expiresAt: "2026-08-12T12:00:00.000Z",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "session-1",
        connected: false,
      }),
    ]);

    expect(auditEventQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(auditEventQuerySchema.parse({ before: "42", limit: "10" })).toEqual({
      before: 42,
      limit: 10,
    });
    expect(auditEventQuerySchema.safeParse({ limit: 201 }).success).toBe(false);

    expect(
      auditEventListSchema.parse({
        items: [
          {
            id: 42,
            ownerId: "owner-1",
            actor: { userId: "owner-1", sessionId: "session-1" },
            action: "auth.login-succeeded",
            result: "succeeded",
            resource: { type: "session", id: "session-1" },
            requestId: "request-1",
            occurredAt: "2026-08-11T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      }).items[0]?.action,
    ).toBe("auth.login-succeeded");
    expect(
      auditEventListSchema.safeParse({
        items: [
          {
            id: 42,
            ownerId: "owner-1",
            actor: { userId: "owner-1", sessionId: "session-1" },
            action: "auth.login-succeeded",
            result: "succeeded",
            resource: { type: "session", id: null },
            requestId: null,
            metadata: { leakedSecret: "x".repeat(501) },
            occurredAt: "2026-08-11T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("validates durable chat relocation requests, snapshots, and jobs", () => {
    const sourcePlacement = {
      projectId: "project-1",
      workerId: "worker-alpha",
      projectReplicaId: "replica-alpha",
      worktreeId: "worktree-alpha",
      surface: { kind: "chat" as const, id: "chat-1" },
    };
    const targetPlacement = {
      ...sourcePlacement,
      workerId: "worker-beta",
      projectReplicaId: "replica-beta",
      worktreeId: "worktree-beta",
    };
    expect(
      chatRelocationCreateSchema.parse({
        target: {
          kind: "worker",
          projectId: "project-1",
          workerId: "worker-beta",
        },
        approved: true,
        idempotencyKey: "relocate:chat-1:worker-beta",
      }).approved,
    ).toBe(true);
    expect(
      chatRelocationCreateSchema.safeParse({
        target: {
          kind: "worker",
          projectId: "project-1",
          workerId: "worker-beta",
        },
        approved: false,
        idempotencyKey: "relocate:chat-1:worker-beta",
      }).success,
    ).toBe(false);
    expect(
      chatRelocationContextPayloadSchema.parse({
        version: 1,
        messages: [
          {
            sequence: 1,
            role: "user",
            mode: "default",
            content: [{ type: "text", text: "Continue on Beta." }],
            createdAt: "2026-08-12T00:00:00.000Z",
          },
        ],
        attachments: [
          {
            attachment: {
              id: "attachment-1",
              chatId: "chat-1",
              sizeBytes: 7,
              status: "ready",
              protectedMetadata: workflowContentFixture(),
              createdAt: "2026-08-12T00:00:00.000Z",
            },
            sha256: "a".repeat(64),
            sourceWorkerId: "worker-alpha",
            availableWorkerIds: ["worker-alpha"],
          },
        ],
      }).messages,
    ).toHaveLength(1);
    expect(
      chatRelocationJobSummarySchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        projectId: "project-1",
        chatId: "chat-1",
        state: "waiting-for-idle",
        stateRevision: 1,
        idempotencyKey: "relocate:chat-1:worker-beta",
        sourcePlacement,
        sourcePlacementRevision: 1,
        targetPlacement,
        contextSnapshotId: "11111111-1111-4111-8111-111111111111",
        targetRuntimeThreadId: null,
        targetModelRouteId: null,
        attempt: 0,
        progress: {
          stage: "waiting-for-idle",
          percent: 0,
          updatedAt: "2026-08-12T00:00:00.000Z",
        },
        error: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        startedAt: null,
        cancellationUnsafeAt: null,
        completedAt: null,
      }).targetPlacement.workerId,
    ).toBe("worker-beta");
  });
});
