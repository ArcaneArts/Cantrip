import {
  chatWireListSchema,
  standaloneChatWireSummarySchema,
  archivedStandaloneChatWireSummarySchema,
  archivedChatWireListSchema,
  archivedChatCleanupResultSchema,
  chatWireSummarySchema,
  encryptedStandaloneChatCreateSchema,
  contextualChatWireSummarySchema,
  chatExecutionLaneListSchema,
  chatExecutionLaneReleaseSchema,
  chatCompactAcceptedSchema,
  chatGoalWireResponseSchema,
  chatGoalResponseSchema,
  chatGoalCreateSchema,
  chatGoalUpdateSchema,
  chatGoalClearSchema,
  encryptedChatPlanWireStateSchema,
  chatPlanUpdateSchema,
  chatPlanAnswerSchema,
  chatPlanAcceptedSchema,
  agentThreadSyncSchema,
  terminalWireSummarySchema,
  chatInterruptAcceptedSchema,
  chatPauseStateSchema,
  chatPauseUpdateSchema,
  chatPermissionProfileStateSchema,
  chatPermissionProfileUpdateSchema,
  agentInteractionRequestWireListSchema,
  agentInteractionRequestWireSchema,
  agentInteractionResolutionCreateSchema,
  orderedIdsSchema,
  chatMessageWireListSchema,
  chatMessageListSchema,
  chatMessageWirePageSchema,
  CHAT_MESSAGE_PAGE_DEFAULT_LIMIT,
  chatModelConfigurationUpdateSchema,
  chatReasoningStateSchema,
  chatRuntimeSelectionSchema,
  chatReasoningUpdateSchema,
  encryptedConversationPromptSubmitResultSchema,
  encryptedChatTurnCreateSchema,
  encryptedChatPromptSubmitResultSchema,
  encryptedChatComposerDraftWireStateSchema,
  encryptedChatComposerDraftUpdateSchema,
} from "@cantrip/protocol";
import { request, post, withQuery } from "@/lib/api-client";
import { chatTitleEncryption } from "@/lib/chat-title-encryption";
import type {
  ExecutionTarget,
  GithubAgentWorkflowContext,
  ChatWorktreeUpdate,
  ChatGoalCreate,
  ChatGoalUpdate,
  ChatPlanUpdate,
  ChatPlanAnswer,
  AgentInteractionRequestStatus,
  AgentInteractionResolutionCreate,
  ModelConfiguration,
  ReasoningEffort,
  ChatAttachmentSummary,
  ChatTurnMode,
  ChatComposerDraft,
} from "@cantrip/protocol";
import {
  openTaskGoalOpaqueSnapshot,
  openTaskMessageOpaqueSummary,
} from "@/lib/task-message-encryption";
import { openEncryptedChatPlanWireState } from "@/lib/chat-plan-encryption";
import { surfaceTitleEncryption } from "@/lib/surface-title-encryption";
import {
  openEncryptedAgentInteractionRequest,
  createEncryptedAgentInteractionResponse,
} from "@/lib/interaction-encryption";
import {
  openChatMessageOpaqueSummary,
  createEncryptedChatTurn,
  protectChatGoalObjective,
  openChatGoalObjective,
  openQueuedPromptOpaqueSummary,
} from "@/lib/chat-message-encryption";
import {
  type ChatMessagePage,
  mapWithConcurrency,
  CHAT_MESSAGE_DECRYPT_CONCURRENCY,
} from "@/lib/chat-message-history";
import {
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
} from "@/lib/client-session";
import { clientEncryption } from "@/lib/client-encryption";
import {
  type NativeTurnSettingsEvidence,
  nativeCorrelatedTurnIdentities,
  readNativeTurnSettings,
  enrichNativeTurnSummaries,
} from "../native-history-turn-settings";
import { clientLogger } from "../client-log-relay";
import {
  openChatComposerDraft,
  protectChatComposerDraft,
} from "@/lib/chat-composer-draft-encryption";
import { getPolicies } from "./policies";

export async function getChats(projectId: string) {
  return Promise.all(
    chatWireListSchema
      .parse(
        await request(`/api/projects/${encodeURIComponent(projectId)}/chats`),
      )
      .map((chat) => chatTitleEncryption.open(chat)),
  );
}

export async function getStandaloneChats() {
  return Promise.all(
    standaloneChatWireSummarySchema
      .array()
      .parse(await request("/api/chats?context=standalone"))
      .map((chat) => chatTitleEncryption.openStandalone(chat)),
  );
}

export async function getArchivedStandaloneChats() {
  return Promise.all(
    archivedStandaloneChatWireSummarySchema
      .array()
      .parse(await request("/api/chats/archived?context=standalone"))
      .map((chat) => chatTitleEncryption.openArchivedStandalone(chat)),
  );
}

export async function getArchivedChats(projectId: string) {
  return Promise.all(
    archivedChatWireListSchema
      .parse(
        await request(
          `/api/projects/${encodeURIComponent(projectId)}/archived-chats`,
        ),
      )
      .map((chat) => chatTitleEncryption.openArchived(chat)),
  );
}

export async function cleanupArchivedChats() {
  return archivedChatCleanupResultSchema.parse(
    await post("/api/chats/archives/cleanup", {}),
  );
}

export async function createChat(
  projectId: string,
  title: string,
  worktreeId?: string,
  worktreeMode?: "agent-managed" | "pinned",
  paneId?: string,
  target?: ExecutionTarget,
  githubAgentContext?: GithubAgentWorkflowContext,
  autoTitle = false,
) {
  const id = crypto.randomUUID();
  return chatTitleEncryption.open(
    chatWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/chats`, {
        id,
        titleProtection: await chatTitleEncryption.protect(id, title),
        autoTitle,
        ...(worktreeId ? { worktreeId } : {}),
        ...(worktreeMode ? { worktreeMode } : {}),
        ...(paneId ? { paneId } : {}),
        ...(target ? { target } : {}),
        ...(githubAgentContext ? { githubAgentContext } : {}),
      }),
    ),
  );
}

export async function createStandaloneChat(
  title?: string,
  autoTitle = title === undefined,
) {
  const id = crypto.randomUUID();
  return chatTitleEncryption.openStandalone(
    standaloneChatWireSummarySchema.parse(
      await post(
        "/api/chats",
        encryptedStandaloneChatCreateSchema.parse({
          id,
          titleProtection: await chatTitleEncryption.protect(
            id,
            title ?? "New chat",
          ),
          autoTitle,
        }),
      ),
    ),
  );
}

async function openContextualChat(raw: unknown) {
  const chat = contextualChatWireSummarySchema.parse(raw);
  return chat.contextKind === "standalone"
    ? chatTitleEncryption.openStandalone(chat)
    : chatTitleEncryption.open(chat);
}

export async function renameChat(chatId: string, title: string) {
  const expectedIdentity = getClientSessionIdentitySnapshot();
  if (!expectedIdentity)
    throw new Error("Sign in before renaming a conversation.");
  const titleProtection = await chatTitleEncryption.protect(chatId, title);
  return openContextualChat(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          titleProtection,
        }),
      },
      { expectedIdentity },
    ),
  );
}

export async function acknowledgeChatCompletion(chatId: string) {
  return openContextualChat(
    await post(`/api/chats/${encodeURIComponent(chatId)}/completion/read`, {}),
  );
}

export async function updateChatWorktree(
  chatId: string,
  input: ChatWorktreeUpdate,
) {
  return chatTitleEncryption.open(
    chatWireSummarySchema.parse(
      await request(`/api/chats/${encodeURIComponent(chatId)}/worktree`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    ),
  );
}

export async function getChatExecutionLanes(chatId: string) {
  return chatExecutionLaneListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/execution-lanes`),
  );
}

export async function releaseChatExecutionLane(
  chatId: string,
  laneId: string,
  input: { allowDirty: boolean; returnToPrimary: boolean },
) {
  await post(
    `/api/chats/${encodeURIComponent(chatId)}/execution-lanes/${encodeURIComponent(laneId)}/release`,
    chatExecutionLaneReleaseSchema.parse(input),
  );
}

export async function deleteChat(chatId: string) {
  await request(`/api/chats/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
  });
}

export async function restoreArchivedChat(chatId: string) {
  return openContextualChat(
    await post(`/api/chats/${encodeURIComponent(chatId)}/restore`, {}),
  );
}

export async function permanentlyDeleteArchivedChat(chatId: string) {
  await request(`/api/chats/${encodeURIComponent(chatId)}/permanent`, {
    method: "DELETE",
  });
}

export async function forkChat(
  chatId: string,
  sourceTitle: string,
  messageId?: string,
  options?: { attachToTabLayout?: boolean },
) {
  const expectedIdentity = getClientSessionIdentitySnapshot();
  if (!expectedIdentity)
    throw new Error("Sign in before forking a conversation.");
  const id = crypto.randomUUID();
  return openContextualChat(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/fork`,
      {
        method: "POST",
        body: JSON.stringify({
          id,
          titleProtection: await chatTitleEncryption.protect(
            id,
            `${sourceTitle} (fork)`,
          ),
          ...(messageId ? { messageId } : {}),
          ...(options?.attachToTabLayout !== undefined
            ? { attachToTabLayout: options.attachToTabLayout }
            : {}),
        }),
      },
      { expectedIdentity },
    ),
  );
}

export async function compactChat(chatId: string) {
  return chatCompactAcceptedSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/compact`, {}),
  );
}

async function openChatGoalWireResponse(raw: unknown) {
  const response = chatGoalWireResponseSchema.parse(raw);
  if ("kind" in response && response.kind === "chat-encrypted") {
    return chatGoalResponseSchema.parse({
      goal: response.goal
        ? {
            ...response.goal,
            objective: await openChatGoalObjective(
              response.goal.protectedObjective,
            ),
          }
        : null,
    });
  }
  return chatGoalResponseSchema.parse({
    goal:
      "kind" in response && response.kind === "task-encrypted" && response.goal
        ? await openTaskGoalOpaqueSnapshot(response.goal)
        : response.goal,
  });
}

export async function getChatGoal(chatId: string) {
  return openChatGoalWireResponse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/goal?encrypted=1`),
  );
}

export async function createChatGoal(chatId: string, input: ChatGoalCreate) {
  return openChatGoalWireResponse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/goal`,
      chatGoalCreateSchema.parse(input),
    ),
  );
}

export async function updateChatGoal(
  chatId: string,
  input: Pick<ChatGoalUpdate, "status"> & { objective?: string },
) {
  const protectedObjective =
    input.objective === undefined
      ? undefined
      : await protectChatGoalObjective(input.objective);
  const result = await openChatGoalWireResponse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/goal?encrypted=1`, {
      method: "PATCH",
      body: JSON.stringify(
        chatGoalUpdateSchema.parse({
          status: input.status,
          protectedObjective,
        }),
      ),
    }),
  );
  if (
    input.objective !== undefined &&
    result.goal?.objective !== input.objective.trim()
  ) {
    throw new Error(
      "The goal edit was not applied. Your changes are still in the editor.",
    );
  }
  return result;
}

export async function clearChatGoal(chatId: string) {
  return chatGoalClearSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/goal`, {
      method: "DELETE",
    }),
  );
}

export async function getChatPlan(chatId: string) {
  return openEncryptedChatPlanWireState(
    chatId,
    encryptedChatPlanWireStateSchema.parse(
      await request(`/api/chats/${encodeURIComponent(chatId)}/plan`),
    ),
  );
}

export async function updateChatPlan(chatId: string, input: ChatPlanUpdate) {
  return openEncryptedChatPlanWireState(
    chatId,
    encryptedChatPlanWireStateSchema.parse(
      await request(`/api/chats/${encodeURIComponent(chatId)}/plan`, {
        method: "PATCH",
        body: JSON.stringify(chatPlanUpdateSchema.parse(input)),
      }),
    ),
  );
}

export async function answerChatPlan(chatId: string, input: ChatPlanAnswer) {
  const answer = chatPlanAnswerSchema.parse(input);
  const plan = await getChatPlan(chatId);
  if (!plan.question) {
    throw new Error("This chat has no pending Plan Mode question.");
  }
  const expectedIds = new Set(
    plan.question.questions.map((question) => question.id),
  );
  const answerIds = Object.keys(answer.answers);
  if (
    answerIds.length !== expectedIds.size ||
    answerIds.some((id) => !expectedIds.has(id))
  ) {
    throw new Error("Answer every pending Plan Mode question once.");
  }

  const requests = await getAgentInteractionRequests({
    chatId,
    status: "pending",
  });
  const pending = requests.find(
    (request) =>
      request.requestKey === plan.question?.id &&
      request.payload.kind === "userInput",
  );
  if (!pending) {
    throw new Error("The pending Plan Mode question is no longer available.");
  }
  await respondToAgentInteractionRequest(pending.id, {
    idempotencyKey: crypto.randomUUID(),
    response: {
      kind: "userInput",
      answers: Object.fromEntries(
        Object.entries(answer.answers).map(([id, answers]) => [
          id,
          { answers },
        ]),
      ),
    },
  });
  return chatPlanAcceptedSchema.parse({
    accepted: true,
    requestKey: pending.requestKey,
  });
}

export async function syncChat(chatId: string) {
  return agentThreadSyncSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/sync`, {}),
  );
}

export async function createChatConsole(chatId: string) {
  const id = crypto.randomUUID();
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    "Console",
    "terminal",
  );
  const stateProtection = await surfaceTitleEncryption.protectTerminalState(
    id,
    null,
    "",
  );
  return surfaceTitleEncryption.openTerminal(
    terminalWireSummarySchema.parse(
      await post(`/api/chats/${encodeURIComponent(chatId)}/console`, {
        id,
        titleProtection,
        stateProtection,
      }),
    ),
  );
}

export async function interruptChat(chatId: string) {
  return chatInterruptAcceptedSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/interrupt`, {}),
  );
}

export async function setChatPaused(chatId: string, paused: boolean) {
  return chatPauseStateSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/pause`, {
      method: "PATCH",
      body: JSON.stringify(chatPauseUpdateSchema.parse({ paused })),
    }),
  );
}

export async function getChatPermissionProfiles(chatId: string) {
  return chatPermissionProfileStateSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/permission-profiles`,
    ),
  );
}

export async function updateChatPermissionProfile(
  chatId: string,
  id: string | null,
) {
  return chatPermissionProfileStateSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/permission-profile`,
      {
        method: "PATCH",
        body: JSON.stringify(chatPermissionProfileUpdateSchema.parse({ id })),
      },
    ),
  );
}

export async function getAgentInteractionRequests(
  input: {
    chatId?: string;
    status?: AgentInteractionRequestStatus;
    limit?: number;
  } = {},
) {
  const query = new URLSearchParams();
  if (input.chatId) query.set("chatId", input.chatId);
  if (input.status) query.set("status", input.status);
  if (input.limit) query.set("limit", String(input.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const requests = agentInteractionRequestWireListSchema.parse(
    await request(`/api/agent-requests${suffix}`),
  );
  return Promise.all(
    requests.map((request) =>
      "protectedPayload" in request
        ? openEncryptedAgentInteractionRequest(request)
        : request,
    ),
  );
}

export async function respondToAgentInteractionRequest(
  requestId: string,
  input: AgentInteractionResolutionCreate,
) {
  const path = `/api/agent-requests/${encodeURIComponent(requestId)}`;
  const current = agentInteractionRequestWireSchema.parse(await request(path));
  const response = agentInteractionRequestWireSchema.parse(
    await post(
      `${path}/respond`,
      "protectedPayload" in current
        ? await createEncryptedAgentInteractionResponse(current, input)
        : agentInteractionResolutionCreateSchema.parse(input),
    ),
  );
  return "protectedPayload" in response
    ? openEncryptedAgentInteractionRequest(response)
    : response;
}

export async function reorderProjects(ids: string[]) {
  await request("/api/projects/order", {
    method: "PATCH",
    body: JSON.stringify(orderedIdsSchema.parse({ ids })),
  });
}

export async function getMessages(chatId: string) {
  const response = chatMessageWireListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/messages`),
  );
  return chatMessageListSchema.parse(
    await Promise.all(
      response.messages.map((message) =>
        response.kind === "task-encrypted"
          ? openTaskMessageOpaqueSummary(message)
          : openChatMessageOpaqueSummary(message),
      ),
    ),
  );
}

export async function getMessagePage(
  chatId: string,
  options: {
    beforeSequence?: number;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ChatMessagePage> {
  const readIdentity = getClientSessionIdentitySnapshot();
  const encryptionLifetime = clientEncryption.getSnapshot();
  const response = chatMessageWirePageSchema.parse(
    await request(
      withQuery(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
        beforeSequence: options.beforeSequence,
        limit: options.limit ?? CHAT_MESSAGE_PAGE_DEFAULT_LIMIT,
      }),
      { signal: options.signal },
    ),
  );
  const messages =
    response.kind === "task-encrypted"
      ? await mapWithConcurrency(
          response.messages,
          CHAT_MESSAGE_DECRYPT_CONCURRENCY,
          (message) => openTaskMessageOpaqueSummary(message),
        )
      : await mapWithConcurrency(
          response.messages,
          CHAT_MESSAGE_DECRYPT_CONCURRENCY,
          (message) => openChatMessageOpaqueSummary(message),
        );
  let openedMessages = chatMessageListSchema.parse(messages);
  let nativeTurnSettings: NativeTurnSettingsEvidence[] = [];
  if (response.kind !== "task-encrypted" && readIdentity) {
    const turns = nativeCorrelatedTurnIdentities(openedMessages);
    if (turns.length) {
      try {
        const evidence = await readNativeTurnSettings({
          chatId,
          turns,
          identity: readIdentity,
          signal: options.signal,
        });
        if (
          !clientSessionIdentityMatches(readIdentity) ||
          clientEncryption.getSnapshot() !== encryptionLifetime
        )
          throw new Error(
            "The encryption session changed while reading native history.",
          );
        openedMessages = enrichNativeTurnSummaries(openedMessages, evidence);
        nativeTurnSettings = evidence;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (
          !clientSessionIdentityMatches(readIdentity) ||
          clientEncryption.getSnapshot() !== encryptionLifetime
        )
          throw error;
        // Supplemental archive availability must not hide the canonical chat
        // transcript. Missing evidence never overwrites a valid live capture.
        clientLogger.warn("Native turn settings archive could not be read", {
          subsystem: "chat",
          event: "chat.native-history.settings.unavailable",
          chatId,
          counts: { turns: turns.length },
        });
      }
    }
  }
  return { messages: openedMessages, page: response.page, nativeTurnSettings };
}

export async function updateChatModel(chatId: string, modelId: string) {
  return chatTitleEncryption.open(
    chatWireSummarySchema.parse(
      await request(`/api/chats/${encodeURIComponent(chatId)}/model`, {
        method: "PATCH",
        body: JSON.stringify({ modelId }),
      }),
    ),
  );
}

export async function updateChatModelConfiguration(
  chatId: string,
  configuration: ModelConfiguration,
) {
  return openContextualChat(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/model-configuration`,
      {
        method: "PATCH",
        body: JSON.stringify(
          chatModelConfigurationUpdateSchema.parse(configuration),
        ),
      },
    ),
  );
}

export async function getChatReasoning(chatId: string, modelId?: string) {
  return chatReasoningStateSchema.parse(
    await request(
      withQuery(`/api/chats/${encodeURIComponent(chatId)}/reasoning`, {
        modelId,
      }),
    ),
  );
}

export async function getChatRuntimeSelection(chatId: string) {
  return chatRuntimeSelectionSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/runtime-selection`),
  );
}

export async function updateChatReasoning(
  chatId: string,
  reasoningEffort: ReasoningEffort | null,
) {
  return chatReasoningStateSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/reasoning`, {
      method: "PATCH",
      body: JSON.stringify(
        chatReasoningUpdateSchema.parse({ reasoningEffort }),
      ),
    }),
  );
}

export async function startTurn(
  chatId: string,
  text: string,
  configuration: ModelConfiguration,
  attachments: ChatAttachmentSummary[] = [],
  mode: ChatTurnMode = "default",
) {
  if (!configuration.modelId) throw new Error("Choose a model first.");
  await getPolicies();
  const idempotencyKey = crypto.randomUUID();
  const input = await createEncryptedChatTurn({
    attachments,
    idempotencyKey,
    messageId: crypto.randomUUID(),
    mode,
    modelId: configuration.modelId,
    promptId: crypto.randomUUID(),
    reasoningEffort: configuration.reasoningEffort,
    customSubagentModel: configuration.customSubagentModel,
    subagentModelId: configuration.subagentModelId,
    subagentReasoningEffort: configuration.subagentReasoningEffort,
    text,
  });
  const result = encryptedConversationPromptSubmitResultSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/turns`,
      encryptedChatTurnCreateSchema.parse(input),
    ),
  );
  return result.status === "started"
    ? {
        status: "started" as const,
        message: await ("kind" in result && result.kind === "task-encrypted"
          ? openTaskMessageOpaqueSummary(result.message)
          : openChatMessageOpaqueSummary(result.message)),
      }
    : {
        status: "queued" as const,
        prompt: await openQueuedPromptOpaqueSummary(result.prompt),
      };
}

export async function retryChatTurn(
  chatId: string,
  messageId: string,
  text: string,
  configuration: ModelConfiguration,
  attachments: ChatAttachmentSummary[] = [],
  mode: ChatTurnMode = "default",
) {
  if (!configuration.modelId) throw new Error("Choose a model first.");
  await getPolicies();
  const idempotencyKey = crypto.randomUUID();
  const input = await createEncryptedChatTurn({
    attachments,
    idempotencyKey,
    messageId: crypto.randomUUID(),
    mode,
    modelId: configuration.modelId,
    promptId: crypto.randomUUID(),
    reasoningEffort: configuration.reasoningEffort,
    customSubagentModel: configuration.customSubagentModel,
    subagentModelId: configuration.subagentModelId,
    subagentReasoningEffort: configuration.subagentReasoningEffort,
    text,
  });
  const result = encryptedChatPromptSubmitResultSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(messageId)}/retry`,
      encryptedChatTurnCreateSchema.parse(input),
    ),
  );
  if (result.status !== "started") {
    throw new Error("An edited message cannot be queued.");
  }
  return {
    status: "started" as const,
    message: await openChatMessageOpaqueSummary(result.message),
  };
}

export async function getChatComposerDraft(chatId: string) {
  return openChatComposerDraft(
    chatId,
    encryptedChatComposerDraftWireStateSchema.parse(
      await request(`/api/chats/${encodeURIComponent(chatId)}/composer-draft`),
    ),
  );
}

export async function saveChatComposerDraft(
  chatId: string,
  draft: ChatComposerDraft | null,
) {
  const state = draft ? await protectChatComposerDraft(chatId, draft) : null;
  const wire = encryptedChatComposerDraftWireStateSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/composer-draft`, {
      method: "PUT",
      body: JSON.stringify(
        encryptedChatComposerDraftUpdateSchema.parse({ state }),
      ),
    }),
  );
  return openChatComposerDraft(chatId, wire);
}
