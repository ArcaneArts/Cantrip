import type {
  AgentInteractionResponse,
  ChatAttachmentSummary,
  ChatComposerDraft,
  ChatMessage,
  ChatPlanAnswer,
  ChatRelocationJobSummary,
  ChatSummary,
  ChatTurnMode,
  InferenceProgressSnapshot,
  ModelConfiguration,
  ReasoningEffort,
  SettingsBundle,
  SkillSummary,
  StandaloneChatSummary,
} from "@cantrip/protocol";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { modelDisplayName } from "@/components/app/application-shell-model";
import {
  attachmentKind,
  insertComposerText,
  MAX_ATTACHMENT_BYTES,
  MAX_COMPOSER_ATTACHMENTS,
} from "@/components/chat/attachment-utils";
import {
  agentInspectorActive,
  type AgentInspectTab,
} from "@/components/chat/agent-inspect-content";
import { readAgentInspectWidth } from "@/components/chat/agent-inspect-panel";
import {
  buildAgentTurnProjection,
  mergeAgentCardsIntoTimeline,
} from "@/components/chat/agent-turn-projection";
import {
  DEFAULT_CHAT_SIDE_PANEL_VIEW,
  subagentRootSidePanelView,
  subagentSidePanelView,
  type ChatSidePanelView,
} from "@/components/chat/chat-side-panel-state";
import { useStickyChatScroll } from "@/components/chat/use-sticky-chat-scroll";
import { scheduleChatComposerFocus } from "@/components/chat/chat-composer-focus";
import { type EditingSentMessage } from "@/components/chat/chat-transcript-entries";
import {
  scheduleChatComposerNoticeDismiss,
  type ChatComposerNoticeTone,
} from "@/components/chat/chat-composer-notice";
import { useChatTurnPromptOverlay } from "@/components/chat/chat-turn-prompt-overlay";
import {
  editableMessageAttachments,
  editableMessageText,
  latestEditableUserMessage,
} from "@/components/chat/latest-message-edit";
import { ensureChatWorkerEncryption } from "@/lib/chat-worker-encryption";
import { shouldSyncChatWithExternalConsole } from "@/lib/chat-transcript-sync";
import {
  imageInputCapabilityMessage,
  resolveImageInputCapability,
} from "@/components/chat/image-input-capability";
import { chatModelConfiguration } from "@/components/chat/model-reasoning-picker";
import { isChatRelocationActive } from "@/components/chat/chat-relocation-dialog";
import {
  filterCommandPalette,
  type CommandPaletteSuggestion,
} from "@/components/chat/command-palette";
import {
  activeGithubMention,
  expandGithubReferences,
  filterGithubReferences,
  insertGithubMention,
  type GithubReference,
} from "@/components/chat/github-mentions";
import {
  activeSkillMention,
  filterSkills,
  insertSkillMention,
  skillMentionSegments,
} from "@/components/chat/skill-mentions";
import {
  buildChatTimeline,
  findLatestLiveActivityGroupKey,
} from "@/components/chat/timeline";
import {
  slashCommandQuery,
  type SlashCommandSuggestion,
} from "@/components/chat/slash-commands";
import { type ChatSurfaceCapabilities } from "@/components/chat/chat-surface-capabilities";
import { taskChatIsInspectOnly } from "@/components/tasks/task-chat-access";
import { providerSupportsCatalog } from "@/components/settings/provider-catalog-display";
import { providerCatalogQueryOptions } from "@/components/settings/use-provider-catalog";
import { errorMessage as errorText } from "@/lib/error-message";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import { useAppLiveStatus } from "@/lib/app-live-react";
import {
  chatResourceRefreshIntervalMs,
  chatTranscriptNeedsFastRefresh,
} from "@/lib/chat-resource-refresh";
import { scopedChatComposerDraftPersistence } from "@/lib/chat-composer-draft-persistence";
import { scheduleWhenIdle } from "@/lib/chat-message-history";
import {
  inferenceProgressHistoryQueryKey,
  type InferenceProgressTrace,
} from "@/lib/inference-progress-history";
import { useChatMessageHistory } from "@/lib/use-chat-message-history";
import { codeGraphChatRefreshIntervalMs } from "@/lib/codegraph-refresh";
import { type AppToastInput } from "@/components/ui/app-toast";
import {
  chatAttachmentContentUrl,
  answerChatPlan,
  compactChat,
  clearChatGoal,
  deleteChatAttachment,
  deleteQueuedPrompt,
  forkChat,
  getChatComposerDraft,
  getChatGoal,
  getChatPermissionProfiles,
  getChatPlan,
  getChatReasoning,
  getCodeGraphWorktreeStatus,
  getGithubIssues,
  getAgentInteractionRequests,
  getQueuedPrompts,
  getSkills,
  getTask,
  getWorkers,
  getWorkflows,
  getWorkflowAutomationTriggers,
  invokeSavedWorkflowCommand,
  interruptChat,
  loadChatAttachmentContent,
  retryChatTurn,
  reorderQueuedPrompts,
  respondToAgentInteractionRequest,
  saveChatComposerDraft,
  setChatPaused,
  startTurn,
  steerQueuedPrompt,
  syncChat,
  updateChatModelConfiguration,
  updateChatPermissionProfile,
  updateChatGoal,
  updateQueuedPrompt,
  uploadChatAttachment,
} from "@/lib/api";
import { watchDesktopWindowFocus } from "@/lib/desktop-popout";

interface ComposerAttachmentState {
  attachment: ChatAttachmentSummary;
  contentUrl: string;
  error: string | null;
  localPreview: boolean;
  uploading: boolean;
}

export function useChatTranscriptController({
  capabilities,
  chat,
  desktopRuntime = false,
  filesOpen = false,
  filesRequestedPath = null,
  githubEnabled,
  inspectOnly = false,
  inspectOpen,
  inspectOverlay,
  onCreateChat,
  onDelete,
  onForked,
  onFilesOpenChange = () => undefined,
  onInspectOpenChange,
  onOpenFile,
  onOpenWorkflow,
  onRename,
  onOpenRelocation,
  onToast,
  relocationJob,
  refocusOnWindowActivation,
  settings,
  syncEnabled,
}: {
  capabilities: ChatSurfaceCapabilities;
  chat: ChatSummary | StandaloneChatSummary;
  desktopRuntime?: boolean;
  filesOpen?: boolean;
  filesRequestedPath?: string | null;
  githubEnabled: boolean;
  inspectOnly?: boolean;
  inspectOpen: boolean;
  inspectOverlay: boolean;
  onCreateChat(): void;
  onDelete(): void;
  onForked(chat: ChatSummary | StandaloneChatSummary): void;
  onFilesOpenChange?(open: boolean): void;
  onInspectOpenChange(open: boolean): void;
  onOpenFile(path: string): void;
  onOpenWorkflow(workflowId: string): void;
  onRename(title: string): void;
  onOpenRelocation(): void;
  onToast(toast: AppToastInput): void;
  relocationJob: ChatRelocationJobSummary | null;
  refocusOnWindowActivation: boolean;
  settings: SettingsBundle | undefined;
  syncEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  const projectId = chat.projectId;
  const projectChatQueryKey = useMemo(
    () =>
      capabilities.context === "standalone"
        ? (["standalone-chats"] as const)
        : (["chats", projectId] as const),
    [capabilities.context, projectId],
  );
  const composerDraftQueryKey = useMemo(
    () => ["chat-composer-draft", chat.id] as const,
    [chat.id],
  );
  const initialComposerDraftRef = useRef<{
    cached: boolean;
    draft: ChatComposerDraft | null;
  } | null>(null);
  if (!initialComposerDraftRef.current) {
    const cached = queryClient.getQueryData<ChatComposerDraft | null>(
      composerDraftQueryKey,
    );
    initialComposerDraftRef.current = {
      cached: cached !== undefined,
      draft: cached ?? null,
    };
  }
  const initialComposerDraft = initialComposerDraftRef.current;
  const workers = useQuery({
    queryFn: getWorkers,
    queryKey: ["workers"],
  });
  const liveStatus = useAppLiveStatus();
  const chatResourcesLive = liveStatus === "live";
  const relocationActive = isChatRelocationActive(relocationJob);
  const relocationNeedsAttention =
    relocationJob?.state === "blocked" || relocationJob?.state === "failed";
  const inspectActive = agentInspectorActive(chat.status);
  const codeGraphProbeDeadlineRef = useRef(
    chat.status === "running" ? Date.now() + 5_000 : 0,
  );
  const previousChatStatusRef = useRef(chat.status);
  const chatRefreshInterval = chatResourceRefreshIntervalMs(
    chat.status,
    chatResourcesLive,
  );
  const [draft, setDraft] = useState(initialComposerDraft.draft?.text ?? "");
  const [composerMode, setComposerMode] = useState<ChatTurnMode>(
    capabilities.modes === "default-only"
      ? "default"
      : (initialComposerDraft.draft?.mode ?? "default"),
  );
  const [composerReasoningEffort, setComposerReasoningEffort] =
    useState<ReasoningEffort | null>(
      initialComposerDraft.draft?.reasoningEffort ?? chat.reasoningEffort,
    );
  const [composerDraftHydrated, setComposerDraftHydrated] = useState(
    initialComposerDraft.cached,
  );
  const composerDraftEditedRef = useRef(false);
  const composerDraftPersistence = useMemo(
    () =>
      scopedChatComposerDraftPersistence(queryClient, chat.id, (nextDraft) =>
        saveChatComposerDraft(chat.id, nextDraft),
      ),
    [chat.id, queryClient],
  );
  const [editingPrompt, setEditingPrompt] = useState<{
    id: string;
    frozen: boolean;
  } | null>(null);
  const [editingSentMessage, setEditingSentMessage] =
    useState<EditingSentMessage | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [skillMenuDismissed, setSkillMenuDismissed] = useState(false);
  const [githubMenuDismissed, setGithubMenuDismissed] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [selectedGithubIndex, setSelectedGithubIndex] = useState(0);
  const [selectedGithubReferences, setSelectedGithubReferences] = useState<
    GithubReference[]
  >([]);
  const [composerCaret, setComposerCaret] = useState(0);
  const [composerScrollTop, setComposerScrollTop] = useState(0);
  const [draftAttachments, setDraftAttachments] = useState<
    ComposerAttachmentState[]
  >([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [inspectWidth, setInspectWidth] = useState(readAgentInspectWidth);
  const [filesWidth, setFilesWidth] = useState(readAgentInspectWidth);
  const [inspectTab, setInspectTab] = useState<AgentInspectTab>("trajectory");
  const [sidePanelView, setSidePanelView] = useState<ChatSidePanelView>(
    DEFAULT_CHAT_SIDE_PANEL_VIEW,
  );
  const [trajectoryTargetKey, setTrajectoryTargetKey] = useState<string | null>(
    null,
  );
  const [viewingAttachment, setViewingAttachment] =
    useState<ChatAttachmentSummary | null>(null);
  const commandListRef = useRef<HTMLDivElement>(null);
  const skillListRef = useRef<HTMLDivElement>(null);
  const githubListRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const editedMessageRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const standaloneFilesVisible =
    capabilities.scratchFiles && chat.contextKind === "standalone";
  const sidePanelWidth =
    !inspectOverlay && standaloneFilesVisible && filesOpen
      ? filesWidth
      : !inspectOverlay && inspectOpen
        ? inspectWidth
        : 0;
  const idleHistoryPrefetchChatRef = useRef<string | null>(null);
  const {
    contentRef: transcriptContentRef,
    onScroll: handleTranscriptScroll,
    preserveScrollDuringPrepend,
    scrollToBottom: scrollTranscriptToBottom,
    showScrollToBottom,
    viewportRef: transcriptViewportRef,
  } = useStickyChatScroll(chat.id);
  useEffect(() => {
    setInspectTab("trajectory");
    setTrajectoryTargetKey(null);
    setSidePanelView(DEFAULT_CHAT_SIDE_PANEL_VIEW);
  }, [chat.id]);

  const handleInspectOpenChange = useCallback(
    (open: boolean) => {
      if (!capabilities.inspect) return;
      if (!open) {
        setTrajectoryTargetKey(null);
        setSidePanelView(DEFAULT_CHAT_SIDE_PANEL_VIEW);
      }
      onInspectOpenChange(open);
    },
    [capabilities.inspect, onInspectOpenChange],
  );

  const viewTurnTrajectory = useCallback(
    (turnKey: string) => {
      if (!capabilities.inspect) return;
      setSidePanelView(DEFAULT_CHAT_SIDE_PANEL_VIEW);
      setInspectTab("trajectory");
      setTrajectoryTargetKey(turnKey);
      onInspectOpenChange(true);
    },
    [capabilities.inspect, onInspectOpenChange],
  );
  const viewSubagent = useCallback(
    (agentKey: string, focusItemKey: string | null = null) => {
      if (!capabilities.subagents) return;
      setSidePanelView(subagentSidePanelView(agentKey, focusItemKey));
      onInspectOpenChange(true);
    },
    [capabilities.subagents, onInspectOpenChange],
  );
  const viewSubagentRoot = useCallback(
    (rootTurnId: string) => {
      if (!capabilities.subagents) return;
      setSidePanelView(subagentRootSidePanelView(rootTurnId));
      onInspectOpenChange(true);
    },
    [capabilities.subagents, onInspectOpenChange],
  );
  useEffect(() => {
    if (!refocusOnWindowActivation) return;
    let mounted = true;
    let stopWatching: (() => void) | null = null;
    void watchDesktopWindowFocus(() => {
      if (!mounted) return;
      scheduleChatComposerFocus(
        () => (mounted ? composerRef.current : null),
        (callback) => window.requestAnimationFrame(callback),
      );
    })
      .then((stop) => {
        if (mounted) stopWatching = stop;
        else stop();
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        clientLogger.warn("Desktop chat focus observer failed", {
          ...operationalErrorMetadata(error),
          chatId: chat.id,
          event: "chat.composer.focus-observe.failed",
          operation: "observe-window-focus",
          reasonCode: "native-window-error",
          status: "unavailable",
          subsystem: "chat",
        });
      });
    return () => {
      mounted = false;
      stopWatching?.();
    };
  }, [chat.id, refocusOnWindowActivation]);
  const fallbackModelId =
    chat.contextKind === "standalone"
      ? (settings?.preferences.defaultChatModelId ??
        settings?.preferences.defaultModelId ??
        null)
      : (settings?.preferences.defaultModelId ?? null);
  const selectedModelId = chat.modelId ?? fallbackModelId ?? "";
  const currentModelConfiguration = chatModelConfiguration(
    chat,
    fallbackModelId,
  );
  const activeChatWorker = workers.data?.find(
    ({ workerId }) => workerId === chat.activeWorkerId,
  );
  const selectedModel = settings?.models.find(
    (model) => model.id === selectedModelId,
  );
  const effectiveSubagentModelId = currentModelConfiguration.customSubagentModel
    ? currentModelConfiguration.subagentModelId
    : currentModelConfiguration.modelId;
  const effectiveSubagentReasoningEffort =
    currentModelConfiguration.customSubagentModel
      ? currentModelConfiguration.subagentReasoningEffort
      : currentModelConfiguration.reasoningEffort;
  const selectedSubagentModel = settings?.models.find(
    (model) => model.id === effectiveSubagentModelId,
  );
  const subagentModelSummary = [
    selectedSubagentModel
      ? modelDisplayName(selectedSubagentModel)
      : (effectiveSubagentModelId ?? "Inherited model"),
    effectiveSubagentReasoningEffort,
  ]
    .filter(Boolean)
    .join(" · ");
  const hasImageAttachment = draftAttachments.some(
    ({ attachment }) => attachment.kind === "image",
  );
  const selectedCatalogProviders = (settings?.providers ?? []).filter(
    (provider) =>
      provider.kind !== "chatgpt" &&
      providerSupportsCatalog(provider) &&
      selectedModel?.routes.some(
        (route) => route.enabled && route.providerId === provider.id,
      ),
  );
  const providerCatalogQueries = useQueries({
    queries: selectedCatalogProviders.map((provider) =>
      providerCatalogQueryOptions(
        provider.id,
        chat.activeWorkerId,
        hasImageAttachment,
      ),
    ),
  });
  const imageCapability =
    hasImageAttachment && selectedModel
      ? resolveImageInputCapability({
          catalogs: new Map(
            selectedCatalogProviders.map((provider, index) => [
              provider.id,
              providerCatalogQueries[index]?.data,
            ]),
          ),
          model: selectedModel,
          providers: settings?.providers ?? [],
        })
      : null;
  const imageCapabilityLoading =
    hasImageAttachment &&
    selectedCatalogProviders.some(
      (_, index) =>
        providerCatalogQueries[index]?.isPending &&
        !providerCatalogQueries[index]?.data,
    );
  useEffect(() => {
    if (
      chat.status === "running" &&
      previousChatStatusRef.current !== "running"
    ) {
      codeGraphProbeDeadlineRef.current = Date.now() + 5_000;
    } else if (chat.status !== "running") {
      codeGraphProbeDeadlineRef.current = 0;
    }
    previousChatStatusRef.current = chat.status;
  }, [chat.status]);
  const codeGraphStatus = useQuery({
    enabled:
      capabilities.context === "project" &&
      chat.status === "running" &&
      Boolean(projectId && chat.activeWorktreeId),
    queryFn: () =>
      getCodeGraphWorktreeStatus(projectId!, chat.activeWorktreeId!),
    queryKey: ["codegraph", projectId, chat.activeWorktreeId],
    refetchInterval: (query) =>
      codeGraphChatRefreshIntervalMs(
        query.state.data,
        chatResourcesLive,
        Date.now() < codeGraphProbeDeadlineRef.current,
      ),
    retry: false,
  });
  const syncingCodeGraph =
    codeGraphStatus.data?.state === "indexing" ||
    codeGraphStatus.data?.state === "queued" ||
    codeGraphStatus.data?.state === "syncing";
  const inferenceProgress = useQuery<InferenceProgressSnapshot | null>({
    enabled: false,
    initialData: null,
    queryFn: async () => null,
    queryKey: ["inference-progress", chat.id],
    staleTime: Number.POSITIVE_INFINITY,
  });
  const inferenceProgressHistory = useQuery<InferenceProgressTrace[]>({
    enabled: false,
    initialData: [],
    queryFn: async () => [],
    queryKey: inferenceProgressHistoryQueryKey(chat.id),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const taskState = useQuery({
    enabled: inspectOnly && chat.experience === "task",
    queryFn: () => getTask(chat.id),
    queryKey: ["task", chat.id],
  });
  const effectiveInspectOnly =
    inspectOnly && taskChatIsInspectOnly(taskState.data);
  const messages = useChatMessageHistory({
    chatId: chat.id,
    refetchInterval: (loadedMessages) =>
      chatResourceRefreshIntervalMs(
        chat.status,
        chatResourcesLive,
        chatTranscriptNeedsFastRefresh(loadedMessages),
      ),
  });
  const turnPromptOverlay = useChatTurnPromptOverlay({
    chatId: chat.id,
    contentRef: transcriptContentRef,
    messages: messages.data ?? [],
    viewportRef: transcriptViewportRef,
  });
  const loadOlderMessages = useCallback(async () => {
    if (!messages.hasOlder || messages.isFetchingOlder) return;
    await preserveScrollDuringPrepend(messages.fetchOlder);
  }, [
    messages.fetchOlder,
    messages.hasOlder,
    messages.isFetchingOlder,
    preserveScrollDuringPrepend,
  ]);
  useEffect(() => {
    if (
      !messages.hasOlder ||
      messages.isFetchingOlder ||
      idleHistoryPrefetchChatRef.current === chat.id
    ) {
      return;
    }
    return scheduleWhenIdle(() => {
      idleHistoryPrefetchChatRef.current = chat.id;
      void loadOlderMessages();
    });
  }, [chat.id, loadOlderMessages, messages.hasOlder, messages.isFetchingOlder]);
  const handleChatTranscriptScroll = useCallback(() => {
    handleTranscriptScroll();
    const viewport = transcriptViewportRef.current;
    if (
      viewport &&
      viewport.scrollTop < 256 &&
      messages.hasOlder &&
      !messages.isFetchingOlder
    ) {
      void loadOlderMessages();
    }
  }, [
    handleTranscriptScroll,
    loadOlderMessages,
    messages.hasOlder,
    messages.isFetchingOlder,
    transcriptViewportRef,
  ]);
  const composerDraftState = useQuery({
    enabled: !initialComposerDraft.cached,
    queryFn: () => getChatComposerDraft(chat.id),
    queryKey: composerDraftQueryKey,
    retry: 3,
    staleTime: Number.POSITIVE_INFINITY,
  });
  useQuery({
    enabled: shouldSyncChatWithExternalConsole(
      capabilities.context,
      syncEnabled,
    ),
    queryFn: async () => {
      const result = await syncChat(chat.id);
      if (result.turns.length > 0) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
          queryClient.invalidateQueries({
            queryKey: projectChatQueryKey,
          }),
        ]);
      }
      return result;
    },
    queryKey: ["chat-sync", chat.id],
    refetchInterval: chatRefreshInterval,
    retry: false,
  });
  const queuedPrompts = useQuery({
    queryFn: () => getQueuedPrompts(chat.id),
    queryKey: ["prompt-queue", chat.id],
    refetchInterval: chatRefreshInterval,
  });
  const goalState = useQuery({
    enabled: capabilities.modes === "agent-modes",
    queryFn: () => getChatGoal(chat.id),
    queryKey: ["goal", chat.id],
    refetchInterval: chatRefreshInterval,
    retry: false,
  });
  const planState = useQuery({
    enabled: capabilities.modes === "agent-modes",
    queryFn: () => getChatPlan(chat.id),
    queryKey: ["plan", chat.id],
    refetchInterval: chatRefreshInterval,
    retry: false,
  });
  const interactionRequests = useQuery({
    queryFn: () =>
      getAgentInteractionRequests({ chatId: chat.id, status: "pending" }),
    queryKey: ["agent-requests", chat.id, "pending"],
    refetchInterval: chatRefreshInterval,
    retry: false,
  });
  const reasoningState = useQuery({
    enabled: Boolean(selectedModelId),
    queryFn: () => getChatReasoning(chat.id),
    queryKey: ["chat-reasoning", chat.id, selectedModelId],
    retry: false,
    staleTime: 30_000,
  });
  const loadModelReasoningState = useCallback(
    (modelId: string) => getChatReasoning(chat.id, modelId),
    [chat.id],
  );
  const permissionProfiles = useQuery({
    enabled: Boolean(selectedModelId),
    queryFn: () => getChatPermissionProfiles(chat.id),
    queryKey: ["permission-profiles", chat.id, selectedModelId],
    retry: false,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (composerDraftHydrated || !composerDraftState.isSuccess) return;
    const restored = composerDraftState.data;
    if (!composerDraftEditedRef.current) {
      composerDraftPersistence.markPersisted(restored);
      if (restored) {
        setDraft(restored.text);
        setComposerMode(
          capabilities.modes === "default-only" ? "default" : restored.mode,
        );
        setComposerReasoningEffort(restored.reasoningEffort);
      }
    }
    setComposerDraftHydrated(true);
  }, [
    composerDraftHydrated,
    composerDraftPersistence,
    composerDraftState.data,
    composerDraftState.isSuccess,
    capabilities.modes,
  ]);

  const stagePersistedComposerDraft = useCallback(
    (nextDraft: ChatComposerDraft | null) => {
      void queryClient.cancelQueries({ queryKey: composerDraftQueryKey });
      queryClient.setQueryData(composerDraftQueryKey, nextDraft);
      composerDraftPersistence.schedule(nextDraft);
    },
    [composerDraftPersistence, composerDraftQueryKey, queryClient],
  );

  useEffect(() => {
    if (!composerDraftHydrated || editingPrompt) return;
    const nextDraft: ChatComposerDraft | null = draft
      ? {
          text: draft,
          mode:
            capabilities.modes === "default-only" ? "default" : composerMode,
          reasoningEffort: composerReasoningEffort,
        }
      : null;
    stagePersistedComposerDraft(nextDraft);
  }, [
    composerDraftHydrated,
    capabilities.modes,
    composerMode,
    composerReasoningEffort,
    draft,
    editingPrompt,
    stagePersistedComposerDraft,
  ]);

  useEffect(
    () => () => {
      void composerDraftPersistence.flush().catch(() => undefined);
    },
    [composerDraftPersistence],
  );

  const clearPersistedComposerDraft = useCallback(() => {
    stagePersistedComposerDraft(null);
    return composerDraftPersistence.flush();
  }, [composerDraftPersistence, stagePersistedComposerDraft]);
  const githubMention = useMemo(
    () =>
      capabilities.projectReferences
        ? activeGithubMention(draft, composerCaret)
        : null,
    [capabilities.projectReferences, composerCaret, draft],
  );
  const skills = useQuery({
    enabled: Boolean(
      capabilities.skillPicker &&
      selectedModelId &&
      (draft.includes("$") || slashCommandQuery(draft) !== null),
    ),
    queryFn: () => getSkills(chat.id),
    queryKey: ["skills", chat.id, selectedModelId],
    retry: false,
    staleTime: 30_000,
  });
  const commandWorkflows = useQuery({
    enabled: capabilities.projectCommands && slashCommandQuery(draft) !== null,
    queryFn: () => getWorkflows({ limit: 500 }),
    queryKey: ["workflows"],
    retry: false,
    staleTime: 30_000,
  });
  const commandTriggers = useQuery({
    enabled: Boolean(
      capabilities.projectCommands &&
      projectId &&
      slashCommandQuery(draft) !== null,
    ),
    queryFn: () =>
      getWorkflowAutomationTriggers({
        projectId: projectId!,
        enabled: true,
        type: "saved-command",
        limit: 500,
      }),
    queryKey: ["workflow-triggers", projectId, "saved-command", true],
    retry: false,
    staleTime: 30_000,
  });
  const githubReferences = useQuery({
    enabled: Boolean(
      capabilities.projectReferences &&
      githubEnabled &&
      githubMention !== null &&
      projectId,
    ),
    queryFn: async () => {
      const lists = await Promise.all([
        getGithubIssues(projectId!, "issue", "open"),
        getGithubIssues(projectId!, "issue", "closed"),
        getGithubIssues(projectId!, "pull-request", "open"),
        getGithubIssues(projectId!, "pull-request", "closed"),
      ]);
      return lists.flatMap((list) =>
        list.issues.map((issue) => ({ ...issue, kind: list.kind })),
      );
    },
    queryKey: ["github-references", projectId],
    retry: false,
    staleTime: 60_000,
  });
  const agentProjection = useMemo(
    () => buildAgentTurnProjection(messages.data ?? []),
    [messages.data],
  );
  const timeline = useMemo(
    () => buildChatTimeline(agentProjection.rootMessages),
    [agentProjection],
  );
  const transcriptEntries = useMemo(
    () => mergeAgentCardsIntoTimeline(timeline, agentProjection.agents),
    [agentProjection.agents, timeline],
  );
  const hasStreamingResponse = useMemo(
    () =>
      agentProjection.rootMessages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (item) => item.type === "text" && item.streaming === true,
          ),
      ),
    [agentProjection.rootMessages],
  );
  const latestLiveActivityGroupKey = useMemo(
    () => findLatestLiveActivityGroupKey(timeline),
    [timeline],
  );
  const latestEditableMessage = useMemo(
    () =>
      effectiveInspectOnly ||
      relocationActive ||
      (queuedPrompts.data?.length ?? 0) > 0
        ? null
        : latestEditableUserMessage(
            messages.data ?? [],
            chat.status,
            chat.automationPaused,
          ),
    [
      chat.automationPaused,
      chat.status,
      effectiveInspectOnly,
      messages.data,
      queuedPrompts.data?.length,
      relocationActive,
    ],
  );
  const slashQuery = slashCommandQuery(draft);
  const slashSuggestions = useMemo(
    () =>
      slashQuery === null ||
      (!capabilities.projectCommands && !capabilities.skillPicker)
        ? []
        : filterCommandPalette(
            slashQuery,
            skills.data ?? [],
            commandWorkflows.data ?? [],
            projectId ?? "",
            commandTriggers.data ?? [],
          ),
    [
      capabilities.projectCommands,
      capabilities.skillPicker,
      projectId,
      commandTriggers.data,
      commandWorkflows.data,
      skills.data,
      slashQuery,
    ],
  );
  const slashMenuOpen =
    !slashMenuDismissed && slashQuery !== null && slashSuggestions.length > 0;
  const skillMention = useMemo(
    () =>
      capabilities.skillPicker
        ? activeSkillMention(draft, composerCaret)
        : null,
    [capabilities.skillPicker, composerCaret, draft],
  );
  const skillSuggestions = useMemo(
    () =>
      skillMention ? filterSkills(skills.data ?? [], skillMention.query) : [],
    [skillMention, skills.data],
  );
  const skillMenuOpen =
    !skillMenuDismissed && skillMention !== null && skillSuggestions.length > 0;
  const skillMenuLoading =
    !skillMenuDismissed && skillMention !== null && skills.isFetching;
  const skillMenuVisible = skillMenuOpen || skillMenuLoading;
  const githubSuggestions = useMemo(
    () =>
      githubMention
        ? filterGithubReferences(
            githubReferences.data ?? [],
            githubMention.query,
          )
        : [],
    [githubMention, githubReferences.data],
  );
  const githubMenuOpen =
    !githubMenuDismissed &&
    githubMention !== null &&
    githubSuggestions.length > 0;
  const highlightedDraft = useMemo(
    () =>
      capabilities.skillPicker
        ? skillMentionSegments(draft, skills.data ?? [])
        : [{ text: draft, skill: null }],
    [capabilities.skillPicker, draft, skills.data],
  );
  const latestAssistantText = useMemo(
    () =>
      [...agentProjection.rootMessages]
        .reverse()
        .find((message) => message.role === "assistant")
        ?.content.flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n\n") ?? "",
    [agentProjection.rootMessages],
  );
  const clearDraftAttachments = () => {
    setDraftAttachments((current) => {
      for (const item of current) {
        if (item.localPreview) URL.revokeObjectURL(item.contentUrl);
      }
      return [];
    });
  };
  const attachFiles = async (
    requestedFiles: File[],
    source: "file" | "paste" = "file",
  ) => {
    if (relocationActive) return;
    setAttachmentNotice(null);
    const slots = Math.max(
      0,
      MAX_COMPOSER_ATTACHMENTS - draftAttachments.length,
    );
    const accepted = requestedFiles
      .slice(0, slots)
      .filter((file) => file.size <= MAX_ATTACHMENT_BYTES);
    if (requestedFiles.length > slots) {
      setAttachmentNotice(
        `A prompt can include up to ${MAX_COMPOSER_ATTACHMENTS} attachments.`,
      );
    } else if (accepted.length !== requestedFiles.length) {
      setAttachmentNotice("Attachments must be 25 MB or smaller.");
    }
    const pending = await Promise.all(
      accepted.map(async (file): Promise<ComposerAttachmentState> => {
        const kind = attachmentKind(file.name, file.type);
        const previewText =
          kind === "text"
            ? (await file.slice(0, 16_000).text()).slice(0, 8_000)
            : null;
        return {
          attachment: {
            id: `local-${crypto.randomUUID()}`,
            chatId: chat.id,
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            kind,
            source,
            status: "ready",
            previewText,
            createdAt: new Date().toISOString(),
          },
          contentUrl: URL.createObjectURL(file),
          error: null,
          localPreview: true,
          uploading: true,
        };
      }),
    );
    setDraftAttachments((current) => [...current, ...pending]);
    await Promise.all(
      pending.map(async (pendingItem, index) => {
        const file = accepted[index]!;
        try {
          await ensureChatWorkerEncryption({
            worker: workers.data?.find(
              ({ workerId }) => workerId === chat.activeWorkerId,
            ),
          });
          const uploaded = await uploadChatAttachment(
            chat.id,
            file,
            pendingItem.attachment.kind,
            source,
          );
          URL.revokeObjectURL(pendingItem.contentUrl);
          setDraftAttachments((current) =>
            current.map((item) =>
              item.attachment.id === pendingItem.attachment.id
                ? {
                    attachment: uploaded,
                    contentUrl: chatAttachmentContentUrl(uploaded.id),
                    error: null,
                    localPreview: false,
                    uploading: false,
                  }
                : item,
            ),
          );
        } catch (error) {
          setDraftAttachments((current) =>
            current.map((item) =>
              item.attachment.id === pendingItem.attachment.id
                ? { ...item, error: errorText(error), uploading: false }
                : item,
            ),
          );
        }
      }),
    );
  };
  const removeDraftAttachment = (item: ComposerAttachmentState) => {
    setDraftAttachments((current) =>
      current.filter(({ attachment }) => attachment.id !== item.attachment.id),
    );
    if (item.localPreview) URL.revokeObjectURL(item.contentUrl);
    if (!item.attachment.id.startsWith("local-")) {
      void deleteChatAttachment(item.attachment.id).catch((error: unknown) =>
        setAttachmentNotice(errorText(error)),
      );
    }
  };
  const restoreDraftAttachmentText = async (item: ComposerAttachmentState) => {
    setAttachmentNotice(null);
    try {
      const pastedText = item.localPreview
        ? await fetch(item.contentUrl).then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.text();
          })
        : await loadChatAttachmentContent(item.attachment).then((blob) =>
            blob.text(),
          );
      const textarea = composerRef.current;
      const currentDraft = textarea?.value ?? draft;
      const selectionStart = textarea?.selectionStart ?? currentDraft.length;
      const selectionEnd = textarea?.selectionEnd ?? selectionStart;
      const inserted = insertComposerText(
        currentDraft,
        pastedText,
        selectionStart,
        selectionEnd,
      );
      setDraft(inserted.text);
      setComposerCaret(inserted.caret);
      setSlashMenuDismissed(false);
      setSkillMenuDismissed(false);
      removeDraftAttachment(item);
      window.requestAnimationFrame(() => {
        composerRef.current?.focus();
        composerRef.current?.setSelectionRange(inserted.caret, inserted.caret);
      });
    } catch (error) {
      setAttachmentNotice(`Could not restore pasted text: ${errorText(error)}`);
    }
  };
  const send = useMutation({
    mutationFn: async ({
      attachments,
      mode,
      reasoningEffort,
      text,
    }: {
      attachments: ChatAttachmentSummary[];
      mode: ChatTurnMode;
      reasoningEffort: ReasoningEffort | null;
      text: string;
    }) => {
      const startedAt = performance.now();
      clientLogger.info("Chat turn submission started", {
        chatId: chat.id,
        counts: { attachments: attachments.length },
        event: "chat.turn.submit.started",
        mode,
        operation: "submit-turn",
        projectId: chat.projectId,
        subsystem: "chat",
      });
      await ensureChatWorkerEncryption({
        worker: workers.data?.find(
          ({ workerId }) => workerId === chat.activeWorkerId,
        ),
      });
      return startTurn(
        chat.id,
        text,
        {
          ...currentModelConfiguration,
          modelId: selectedModelId,
          reasoningEffort,
        },
        attachments,
        mode,
      ).then(
        (result) => {
          clientLogger.info("Chat turn submission accepted", {
            chatId: chat.id,
            durationMs: Math.round(performance.now() - startedAt),
            event: "chat.turn.submit.completed",
            operation: "submit-turn",
            projectId: chat.projectId,
            status: "accepted",
            subsystem: "chat",
          });
          return result;
        },
        (error: unknown) => {
          clientLogger.error("Chat turn submission failed", {
            chatId: chat.id,
            durationMs: Math.round(performance.now() - startedAt),
            ...operationalErrorMetadata(error),
            event: "chat.turn.submit.failed",
            operation: "submit-turn",
            projectId: chat.projectId,
            reasonCode: "request-failed",
            status: "failed",
            subsystem: "chat",
          });
          throw error;
        },
      );
    },
    onSuccess: async () => {
      setDraft("");
      setSelectedGithubReferences([]);
      setComposerMode("default");
      clearDraftAttachments();
      await clearPersistedComposerDraft();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: projectChatQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["goal", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["plan", chat.id] }),
      ]);
    },
  });
  const retrySentMessage = useMutation({
    mutationFn: async ({
      message,
      text,
    }: {
      message: ChatMessage;
      text: string;
    }) => {
      const modelId = message.modelId;
      if (!modelId) {
        throw new Error("The original model is no longer available.");
      }
      await ensureChatWorkerEncryption({
        worker: workers.data?.find(
          ({ workerId }) => workerId === chat.activeWorkerId,
        ),
      });
      return retryChatTurn(
        chat.id,
        message.id,
        text,
        {
          ...currentModelConfiguration,
          modelId,
          reasoningEffort: message.reasoningEffort,
        },
        editableMessageAttachments(message),
        message.mode,
      );
    },
    onSuccess: async () => {
      setEditingSentMessage(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: projectChatQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["goal", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["plan", chat.id] }),
      ]);
    },
    onError: (error: unknown) => {
      setEditingSentMessage((current) =>
        current ? { ...current, error: errorText(error) } : current,
      );
    },
  });
  useEffect(() => {
    if (
      editingSentMessage &&
      !retrySentMessage.isPending &&
      editingSentMessage.id !== latestEditableMessage?.id
    ) {
      setEditingSentMessage(null);
    }
  }, [
    editingSentMessage,
    latestEditableMessage?.id,
    retrySentMessage.isPending,
  ]);
  useEffect(() => {
    if (!editingSentMessage) return;
    window.requestAnimationFrame(() => {
      const textarea = editedMessageRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }, [editingSentMessage?.id]);
  const updatePrompt = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: {
        attachments?: ChatAttachmentSummary[];
        text?: string;
        mode?: ChatTurnMode;
        reasoningEffort?: ReasoningEffort | null;
        frozen?: boolean;
      };
    }) => updateQueuedPrompt(chat.id, id, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
        queryClient.invalidateQueries({ queryKey: projectChatQueryKey }),
      ]);
    },
  });
  const removePrompt = useMutation({
    mutationFn: (id: string) => deleteQueuedPrompt(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
  });
  const steerPrompt = useMutation({
    mutationFn: (id: string) => steerQueuedPrompt(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: projectChatQueryKey }),
      ]);
    },
  });
  const reorderPrompts = useMutation({
    mutationFn: (ids: string[]) => reorderQueuedPrompts(chat.id, ids),
    onError: () =>
      queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
  });
  const selectModelConfiguration = useMutation({
    mutationFn: (configuration: ModelConfiguration) =>
      updateChatModelConfiguration(chat.id, configuration),
    onSuccess: async (updated) => {
      setComposerReasoningEffort(updated.reasoningEffort);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: projectChatQueryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: ["chat-reasoning", chat.id],
        }),
      ]);
    },
  });
  const selectPermissionProfile = useMutation({
    mutationFn: (id: string | null) => updateChatPermissionProfile(chat.id, id),
    onSuccess: async (state) => {
      queryClient.setQueryData(
        ["permission-profiles", chat.id, selectedModelId],
        state,
      );
      await queryClient.invalidateQueries({
        queryKey: projectChatQueryKey,
      });
    },
  });
  const fork = useMutation({
    mutationFn: (messageId?: string) =>
      forkChat(chat.id, chat.title, messageId),
    onSuccess: async (forked) => {
      await queryClient.invalidateQueries({
        queryKey: projectChatQueryKey,
      });
      onForked(forked);
    },
  });
  const compact = useMutation({
    mutationFn: () => compactChat(chat.id),
  });
  const updateGoal = useMutation({
    mutationFn: (status: "active" | "paused") =>
      updateChatGoal(chat.id, { status }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["goal", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: projectChatQueryKey }),
      ]);
    },
  });
  const clearGoal = useMutation({
    mutationFn: () => clearChatGoal(chat.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["goal", chat.id] });
    },
  });
  const setAutomationPaused = useMutation({
    mutationFn: (paused: boolean) => setChatPaused(chat.id, paused),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectChatQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["goal", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
      ]);
    },
  });
  const interrupt = useMutation({
    mutationFn: async () => {
      const startedAt = performance.now();
      clientLogger.info("Chat interruption requested", {
        chatId: chat.id,
        event: "chat.turn.interrupt.started",
        operation: "interrupt-turn",
        projectId: chat.projectId,
        subsystem: "chat",
      });
      try {
        const result = await interruptChat(chat.id);
        clientLogger.info("Chat interruption completed", {
          chatId: chat.id,
          durationMs: Math.round(performance.now() - startedAt),
          event: "chat.turn.interrupt.completed",
          operation: "interrupt-turn",
          projectId: chat.projectId,
          status: "completed",
          subsystem: "chat",
        });
        return result;
      } catch (error) {
        clientLogger.warn("Chat interruption failed", {
          chatId: chat.id,
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "chat.turn.interrupt.failed",
          operation: "interrupt-turn",
          projectId: chat.projectId,
          reasonCode: "request-failed",
          status: "failed",
          subsystem: "chat",
        });
        throw error;
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectChatQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
      ]);
    },
  });
  const [answerPlanPending, setAnswerPlanPending] = useState(false);
  const [answerPlanError, setAnswerPlanError] = useState<string | null>(null);
  const submitPlanAnswer = async (answers: ChatPlanAnswer["answers"]) => {
    setAnswerPlanPending(true);
    setAnswerPlanError(null);
    try {
      await answerChatPlan(chat.id, { answers });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["plan", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: projectChatQueryKey }),
      ]);
    } catch (error) {
      setAnswerPlanError(errorText(error));
    } finally {
      setAnswerPlanPending(false);
    }
  };
  const planImplementationDisabled =
    relocationActive ||
    !selectedModelId ||
    send.isPending ||
    selectModelConfiguration.isPending ||
    selectPermissionProfile.isPending ||
    updatePrompt.isPending;
  const startPlanImplementation = () => {
    if (planImplementationDisabled) return;
    send.mutate({
      attachments: [],
      mode: "default",
      reasoningEffort: composerReasoningEffort,
      text: "Implement the plan.",
    });
  };
  const revisePlan = () => {
    setComposerMode("plan");
    setCommandNotice("Continue refining the plan in the message box.");
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(
    null,
  );
  const [interactionResponseError, setInteractionResponseError] = useState<
    string | null
  >(null);
  const interactionIdempotencyKeys = useRef(new Map<string, string>());
  const submitInteractionResponse = async (
    requestId: string,
    response: AgentInteractionResponse,
  ) => {
    setRespondingRequestId(requestId);
    setInteractionResponseError(null);
    const idempotencyKey =
      interactionIdempotencyKeys.current.get(requestId) ?? crypto.randomUUID();
    interactionIdempotencyKeys.current.set(requestId, idempotencyKey);
    let delivered = false;
    try {
      await respondToAgentInteractionRequest(requestId, {
        idempotencyKey,
        response,
      });
      delivered = true;
    } catch (error) {
      setInteractionResponseError(errorText(error));
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-requests", chat.id],
        }),
        queryClient.invalidateQueries({ queryKey: ["plan", chat.id] }),
        queryClient.invalidateQueries({ queryKey: projectChatQueryKey }),
      ]);
      if (delivered) interactionIdempotencyKeys.current.delete(requestId);
      setRespondingRequestId(null);
    }
  };
  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (!editingPrompt) {
      setComposerReasoningEffort(chat.reasoningEffort);
    }
  }, [chat.id, chat.reasoningEffort, editingPrompt]);

  useEffect(() => {
    if (!editingPrompt && reasoningState.data) {
      setComposerReasoningEffort(reasoningState.data.reasoningEffort);
    }
  }, [editingPrompt, reasoningState.data]);

  useEffect(() => {
    setSelectedSkillIndex(0);
  }, [skillMention?.query]);

  useEffect(() => {
    setSelectedGithubIndex(0);
  }, [githubMention?.query]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    commandListRef.current
      ?.querySelector<HTMLElement>(
        `[data-command-index="${selectedCommandIndex}"]`,
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedCommandIndex, slashMenuOpen]);

  useEffect(() => {
    if (!skillMenuOpen) return;
    skillListRef.current
      ?.querySelector<HTMLElement>(`[data-skill-index="${selectedSkillIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedSkillIndex, skillMenuOpen]);

  useEffect(() => {
    if (!githubMenuOpen) return;
    githubListRef.current
      ?.querySelector<HTMLElement>(
        `[data-github-index="${selectedGithubIndex}"]`,
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [githubMenuOpen, selectedGithubIndex]);

  const submitEditedMessage = useCallback(
    (message: ChatMessage, event?: FormEvent) => {
      event?.preventDefault();
      if (
        retrySentMessage.isPending ||
        editingSentMessage?.id !== message.id ||
        latestEditableMessage?.id !== message.id
      ) {
        return;
      }
      const text = editingSentMessage.text.trim();
      if (!text && editableMessageAttachments(message).length === 0) return;
      setEditingSentMessage((current) =>
        current ? { ...current, error: null } : current,
      );
      retrySentMessage.mutate({ message, text });
    },
    [
      editingSentMessage,
      latestEditableMessage?.id,
      retrySentMessage.isPending,
      retrySentMessage.mutate,
    ],
  );
  const cancelEditingSentMessage = useCallback(
    () => setEditingSentMessage(null),
    [],
  );
  const changeEditingSentMessage = useCallback(
    (messageId: string, text: string) => {
      setEditingSentMessage((current) =>
        current?.id === messageId
          ? {
              ...current,
              error: null,
              text,
            }
          : current,
      );
    },
    [],
  );
  const copyResponse = useCallback(async (messageId: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedMessageId(messageId);
    window.setTimeout(() => setCopiedMessageId(null), 1_500);
  }, []);
  const editSentMessage = useCallback((message: ChatMessage) => {
    setEditingSentMessage({
      error: null,
      id: message.id,
      text: editableMessageText(message),
    });
  }, []);
  const forkFromMessage = useCallback(
    (messageId: string) => fork.mutate(messageId),
    [fork.mutate],
  );

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = capabilities.projectReferences
      ? expandGithubReferences(draft.trim(), selectedGithubReferences)
      : draft.trim();
    const submitMode =
      capabilities.modes === "default-only" ? "default" : composerMode;
    const readyAttachments = draftAttachments.filter(
      ({ error, uploading }) => !error && !uploading,
    );
    if (
      relocationActive ||
      (!text && readyAttachments.length === 0) ||
      !selectedModelId ||
      send.isPending ||
      selectModelConfiguration.isPending ||
      selectPermissionProfile.isPending ||
      updatePrompt.isPending ||
      draftAttachments.some(({ error, uploading }) => error || uploading)
    ) {
      return;
    }
    if (editingPrompt) {
      updatePrompt.mutate(
        {
          id: editingPrompt.id,
          input: {
            text,
            mode: submitMode,
            reasoningEffort: composerReasoningEffort,
            attachments: readyAttachments.map(({ attachment }) => attachment),
            frozen: editingPrompt.frozen,
          },
        },
        {
          onSuccess: () => {
            setEditingPrompt(null);
            setDraft("");
            setSelectedGithubReferences([]);
            setComposerMode("default");
            setComposerReasoningEffort(chat.reasoningEffort);
            clearDraftAttachments();
            void clearPersistedComposerDraft();
          },
        },
      );
      return;
    }
    send.mutate({
      text,
      mode: submitMode,
      reasoningEffort: composerReasoningEffort,
      attachments: readyAttachments.map(({ attachment }) => attachment),
    });
  };

  const executeSlashCommand = async ({ command }: SlashCommandSuggestion) => {
    if (!capabilities.projectCommands && !capabilities.skillPicker) return;
    const name = command.name;
    setDraft("");
    setSelectedGithubReferences([]);
    setSlashMenuDismissed(true);
    setCommandNotice(null);
    void clearPersistedComposerDraft();

    if (name === "compact") {
      compact.mutate();
    } else if (name === "goal" && capabilities.modes === "agent-modes") {
      setComposerMode("goal");
      setCommandNotice("Goal mode selected for the next message.");
    } else if (name === "plan" && capabilities.modes === "agent-modes") {
      setComposerMode("plan");
      setCommandNotice("Plan mode selected for the next message.");
    } else if (name === "pause") {
      setAutomationPaused.mutate(!chat.automationPaused);
    } else if (name === "copy") {
      if (!latestAssistantText) {
        setCommandNotice("There is no completed response to copy yet.");
      } else {
        await navigator.clipboard.writeText(latestAssistantText);
        setCommandNotice("Latest response copied.");
      }
    } else if (name === "fork") {
      fork.mutate(undefined);
    } else if (name === "new" || name === "clear") {
      onCreateChat();
    } else if (name === "rename") {
      const title = window.prompt("Rename agent", chat.title)?.trim();
      if (title) onRename(title);
    } else if (name === "delete") {
      if (chat.status === "running" || chat.status === "waiting-for-approval") {
        setCommandNotice("Stop the active agent before removing this tab.");
      } else if (
        window.confirm(
          `Remove “${chat.title}”? Agents with conversation history remain in Archive for 90 days.`,
        )
      ) {
        onDelete();
      }
    } else if (name === "status") {
      setCommandNotice(
        `${selectedModel ? modelDisplayName(selectedModel) : "No model selected"} · ${chat.status}`,
      );
    } else {
      const prompts: Record<string, string> = {
        diff: "Inspect the current Git working-tree diff and summarize every change. Do not modify files.",
        init: "Create an AGENTS.md scaffold for this repository, based on its existing conventions.",
        review:
          "Review the current working tree for defects, regressions, and missing tests. Do not modify files.",
      };
      const prompt = prompts[name];
      if (prompt) {
        send.mutate({
          text: prompt,
          attachments: [],
          mode:
            capabilities.modes === "default-only" ? "default" : composerMode,
          reasoningEffort: composerReasoningEffort,
        });
      }
    }
  };

  const chooseSkill = (skill: SkillSummary) => {
    if (!skillMention) return;
    const inserted = insertSkillMention(draft, skillMention, skill.name);
    setDraft(inserted.text);
    setComposerCaret(inserted.caret);
    setSkillMenuDismissed(true);
    setCommandNotice(null);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  const chooseGithubReference = (reference: GithubReference) => {
    if (!githubMention) return;
    const inserted = insertGithubMention(draft, githubMention, reference);
    setDraft(inserted.text);
    setComposerCaret(inserted.caret);
    setSelectedGithubReferences((current) => [
      ...current.filter(({ number }) => number !== reference.number),
      reference,
    ]);
    setGithubMenuDismissed(true);
    setCommandNotice(null);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  const executeCommandPalette = async (
    suggestion: CommandPaletteSuggestion,
  ) => {
    if (!capabilities.projectCommands && !capabilities.skillPicker) return;
    if (suggestion.kind === "builtin") {
      await executeSlashCommand(suggestion.command);
      return;
    }
    setSlashMenuDismissed(true);
    setCommandNotice(null);
    if (suggestion.kind === "workflow") {
      setDraft("");
      setSelectedGithubReferences([]);
      void clearPersistedComposerDraft();
      onOpenWorkflow(suggestion.workflow.id);
      return;
    }
    if (suggestion.kind === "saved-command") {
      setDraft("");
      setSelectedGithubReferences([]);
      void clearPersistedComposerDraft();
      try {
        const result = await invokeSavedWorkflowCommand(suggestion.trigger.id, {
          idempotencyKey: `saved-command-${crypto.randomUUID()}`,
          structuredInput: {},
        });
        setCommandNotice(
          `Started ${suggestion.label} as run ${result.run.run.id.slice(0, 8)}.`,
        );
        void queryClient.invalidateQueries({
          queryKey: ["workflow-runs", projectId],
        });
        onOpenWorkflow(suggestion.trigger.workflowId);
      } catch (error) {
        onToast({
          message: errorText(error),
          title: "Command failed",
          tone: "error",
        });
      }
      return;
    }
    const text = `$${suggestion.skill.name} `;
    setDraft(text);
    setComposerCaret(text.length);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(text.length, text.length);
    });
  };

  const chatActionError =
    send.error ??
    selectModelConfiguration.error ??
    selectPermissionProfile.error ??
    compact.error ??
    updatePrompt.error ??
    removePrompt.error ??
    steerPrompt.error ??
    reorderPrompts.error ??
    setAutomationPaused.error ??
    interrupt.error;
  useEffect(() => {
    if (!chatActionError) return;
    onToast({
      message: errorText(chatActionError),
      title: "Chat action failed",
      tone: "error",
    });
  }, [chatActionError, onToast]);

  useEffect(() => {
    if (!commandNotice) return;
    return scheduleChatComposerNoticeDismiss(() => setCommandNotice(null));
  }, [commandNotice]);

  useEffect(() => {
    if (!attachmentNotice) return;
    return scheduleChatComposerNoticeDismiss(() => setAttachmentNotice(null));
  }, [attachmentNotice]);

  let composerNotice:
    | {
        loading?: boolean;
        message: string;
        tone?: ChatComposerNoticeTone;
      }
    | undefined;
  if (compact.isPending) {
    composerNotice = {
      loading: true,
      message: "Compacting conversation context…",
    };
  } else if (attachmentNotice) {
    composerNotice = { message: attachmentNotice, tone: "error" };
  } else if (editingPrompt) {
    composerNotice = {
      message: "Enter re-queues this prompt in its original position",
    };
  } else if (imageCapabilityLoading && selectedModel) {
    composerNotice = {
      loading: true,
      message: `Checking whether ${selectedModel.name} accepts image input…`,
    };
  } else if (imageCapability && selectedModel) {
    composerNotice = {
      message: imageInputCapabilityMessage(selectedModel.name, imageCapability),
      tone: imageCapability.state === "supported" ? "success" : "warning",
    };
  } else if (commandNotice) {
    composerNotice = { message: commandNotice };
  }
  return {
    activeChatWorker,
    agentProjection,
    answerPlanError,
    answerPlanPending,
    attachFiles,
    cancelEditingSentMessage,
    capabilities,
    changeEditingSentMessage,
    chat,
    chooseGithubReference,
    chooseSkill,
    clearDraftAttachments,
    clearGoal,
    commandListRef,
    composerDraftEditedRef,
    composerDraftHydrated,
    composerMode,
    composerNotice,
    composerReasoningEffort,
    composerRef,
    composerScrollTop,
    copiedMessageId,
    copyResponse,
    currentModelConfiguration,
    desktopRuntime,
    draft,
    draftAttachments,
    draggingFiles,
    editSentMessage,
    editedMessageRef,
    editingPrompt,
    editingSentMessage,
    effectiveInspectOnly,
    executeCommandPalette,
    fileInputRef,
    filesOpen,
    filesRequestedPath,
    fork,
    forkFromMessage,
    githubListRef,
    githubMenuOpen,
    githubSuggestions,
    goalState,
    handleChatTranscriptScroll,
    handleInspectOpenChange,
    hasStreamingResponse,
    highlightedDraft,
    inferenceProgress,
    inferenceProgressHistory,
    inspectActive,
    inspectOpen,
    inspectOverlay,
    inspectTab,
    interactionRequests,
    interactionResponseError,
    interrupt,
    latestEditableMessage,
    latestLiveActivityGroupKey,
    loadModelReasoningState,
    loadOlderMessages,
    messages,
    onDelete,
    onFilesOpenChange,
    onOpenFile,
    onOpenRelocation,
    permissionProfiles,
    planImplementationDisabled,
    planState,
    queryClient,
    queuedPrompts,
    reasoningState,
    relocationActive,
    relocationJob,
    relocationNeedsAttention,
    removeDraftAttachment,
    removePrompt,
    reorderPrompts,
    respondingRequestId,
    restoreDraftAttachmentText,
    retrySentMessage,
    revisePlan,
    scrollTranscriptToBottom,
    selectModelConfiguration,
    selectPermissionProfile,
    selectedCommandIndex,
    selectedGithubIndex,
    selectedModel,
    selectedModelId,
    selectedSkillIndex,
    send,
    setAttachmentNotice,
    setAutomationPaused,
    setCommandNotice,
    setComposerCaret,
    setComposerDraftHydrated,
    setComposerMode,
    setComposerReasoningEffort,
    setComposerScrollTop,
    setDraft,
    setDraftAttachments,
    setDraggingFiles,
    setEditingPrompt,
    setFilesWidth,
    setGithubMenuDismissed,
    setInspectTab,
    setInspectWidth,
    setSelectedCommandIndex,
    setSelectedGithubIndex,
    setSelectedGithubReferences,
    setSelectedSkillIndex,
    setSkillMenuDismissed,
    setSlashMenuDismissed,
    setTrajectoryTargetKey,
    setViewingAttachment,
    settings,
    showScrollToBottom,
    sidePanelView,
    sidePanelWidth,
    skillListRef,
    skillMenuLoading,
    skillMenuOpen,
    skillMenuVisible,
    skillSuggestions,
    slashMenuOpen,
    slashSuggestions,
    stagePersistedComposerDraft,
    standaloneFilesVisible,
    startPlanImplementation,
    steerPrompt,
    subagentModelSummary,
    submit,
    submitEditedMessage,
    submitInteractionResponse,
    submitPlanAnswer,
    syncingCodeGraph,
    trajectoryTargetKey,
    transcriptContentRef,
    transcriptEntries,
    transcriptViewportRef,
    turnPromptOverlay,
    updateGoal,
    updatePrompt,
    viewSubagent,
    viewSubagentRoot,
    viewTurnTrajectory,
    viewingAttachment,
  } as const;
}

export type ChatTranscriptProps = Parameters<
  typeof useChatTranscriptController
>[0];
export type ChatTranscriptController = ReturnType<
  typeof useChatTranscriptController
>;
