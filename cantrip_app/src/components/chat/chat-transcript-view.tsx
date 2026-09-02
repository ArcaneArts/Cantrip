import type { QueuedPrompt } from "@cantrip/protocol";
import {
  ArrowDown,
  FilePlus2,
  FolderOpen,
  Loader2,
  Pause,
  Plus,
  WandSparkles,
} from "lucide-react";
import {
  AttachmentPreview,
  AttachmentViewerDialog,
} from "@/components/chat/attachment-preview";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_COMPOSER_ATTACHMENTS,
  largePasteFileName,
  shouldAttachPastedText,
} from "@/components/chat/attachment-utils";
import { AgentInteractionPanel } from "@/components/chat/agent-interaction-panel";
import { AgentInspectContent } from "@/components/chat/agent-inspect-content";
import { AgentInspectPanelShell } from "@/components/chat/agent-inspect-panel";
import { GoalPanel } from "@/components/chat/goal-panel";
import { ChatModeControl } from "@/components/chat/chat-mode-control";
import { ChatComposerPrimaryActions } from "@/components/chat/chat-composer-primary-actions";
import { ChatTranscriptEntries } from "@/components/chat/chat-transcript-entries";
import { StandaloneChatFilesPanel } from "@/components/chat/standalone-chat-files-panel";
import { resolveRunningAgentStartedAtMs } from "@/components/chat/chat-run-duration";
import { ChatComposerNotice } from "@/components/chat/chat-composer-notice";
import { ChatPlanProgress } from "@/components/chat/chat-plan-progress";
import { ContextUsageRing } from "@/components/chat/context-usage-ring";
import { ChatHistoryRail } from "@/components/chat/chat-history-rail";
import { ChatTurnPromptOverlay } from "@/components/chat/chat-turn-prompt-overlay";
import { ChatRunStatus } from "@/components/chat/chat-run-status";
import { ModelReasoningPicker } from "@/components/chat/model-reasoning-picker";
import { PermissionProfileControl } from "@/components/chat/permission-profile-control";
import { ChatRelocationStatus } from "@/components/chat/chat-relocation-dialog";
import { PlanPanel } from "@/components/chat/plan-panel";
import { SubagentTranscriptPanel } from "@/components/chat/subagent-transcript-panel";
import { containsGithubReference } from "@/components/chat/github-mentions";
import { PromptQueue } from "@/components/chat/prompt-queue";
import { errorMessage as errorText } from "@/lib/error-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { chatAttachmentContentUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ChatTranscriptController } from "@/components/chat/use-chat-transcript-controller";

export function ChatTranscriptView({
  controller,
}: {
  controller: ChatTranscriptController;
}) {
  const {
    activeChatWorker,
    agentProjection,
    answerPlanError,
    answerPlanPending,
    attachFiles,
    cancelEditingSentMessage,
    capabilities,
    changeEditingSentMessage,
    chat,
    chatGptAvailableResetCredits,
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
    runtimeSelection,
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
  } = controller;
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-visible transition-[padding-right] duration-150 ease-out motion-reduce:transition-none"
      style={{
        paddingRight: sidePanelWidth,
      }}
      onDragEnter={(event) => {
        if (
          !effectiveInspectOnly &&
          !relocationActive &&
          event.dataTransfer.types.includes("Files")
        ) {
          event.preventDefault();
          setDraggingFiles(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDraggingFiles(false);
        }
      }}
      onDragOver={(event) => {
        if (
          !effectiveInspectOnly &&
          !relocationActive &&
          event.dataTransfer.types.includes("Files")
        ) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        const droppedFiles = [...event.dataTransfer.files];
        if (droppedFiles.length === 0) return;
        event.preventDefault();
        setDraggingFiles(false);
        if (!effectiveInspectOnly && !relocationActive) {
          void attachFiles(droppedFiles);
        }
      }}
    >
      {draggingFiles ? (
        <div
          role="status"
          className="pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-2xl border-2 border-dashed border-primary bg-background/90 backdrop-blur"
        >
          <div className="text-center">
            <FilePlus2 className="mx-auto size-6 text-primary" />
            <p className="mt-2 text-sm font-medium">
              Attach files to the next message
            </p>
          </div>
        </div>
      ) : null}
      <ChatTurnPromptOverlay
        eliteModeEnabled={settings?.preferences.eliteMode ?? false}
        message={turnPromptOverlay.message}
        visible={turnPromptOverlay.visible}
      />
      <div
        ref={transcriptViewportRef}
        className={cn(
          "chat-message-scroll flex-1 overflow-y-auto px-4 pt-6 sm:px-8 md:px-10",
          effectiveInspectOnly ? "pb-10" : "pb-60",
        )}
        onScroll={handleChatTranscriptScroll}
      >
        <div
          ref={transcriptContentRef}
          className="flex w-full flex-col gap-5"
          data-content-gutter="chat"
        >
          {messages.hasOlder ? (
            <div className="flex justify-center">
              <Button
                disabled={messages.isFetchingOlder}
                onClick={() => void loadOlderMessages()}
                size="sm"
                type="button"
                variant="ghost"
              >
                {messages.isFetchingOlder ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                Load earlier messages
              </Button>
            </div>
          ) : null}
          {messages.data?.length === 0 ? (
            <EmptyState className="min-h-[45vh] flex-none p-0">
              <EmptyStateContent>
                <EmptyStateIcon>
                  <WandSparkles className="size-5" />
                </EmptyStateIcon>
                <EmptyStateTitle>
                  {capabilities.context === "standalone"
                    ? "Start a conversation"
                    : "Start working"}
                </EmptyStateTitle>
                <EmptyStateDescription>
                  {capabilities.context === "standalone"
                    ? "Ask Cantrip anything, or attach material to work with in this chat."
                    : "Ask Cantrip to inspect, explain, or change this repository."}
                </EmptyStateDescription>
              </EmptyStateContent>
            </EmptyState>
          ) : null}

          <ChatTranscriptEntries
            copiedMessageId={copiedMessageId}
            editedMessageRef={editedMessageRef}
            editingSentMessage={editingSentMessage}
            entries={transcriptEntries}
            forkPending={fork.isPending}
            latestEditableMessageId={latestEditableMessage?.id ?? null}
            latestLiveActivityGroupKey={latestLiveActivityGroupKey}
            retryPending={retrySentMessage.isPending}
            onCancelEditingMessage={cancelEditingSentMessage}
            onChangeEditingMessage={changeEditingSentMessage}
            onCopyResponse={copyResponse}
            onEditMessage={editSentMessage}
            onForkMessage={forkFromMessage}
            onOpenFile={onOpenFile}
            onSubmitEditedMessage={submitEditedMessage}
            onViewSubagent={capabilities.subagents ? viewSubagent : undefined}
            onViewTrajectory={
              capabilities.inspect ? viewTurnTrajectory : undefined
            }
          />

          <ChatRunStatus
            automationPaused={chat.automationPaused}
            hasLiveActivity={latestLiveActivityGroupKey !== null}
            hasStreamingResponse={hasStreamingResponse}
            inferenceProgress={inferenceProgress.data}
            syncingCodeGraph={syncingCodeGraph}
            status={chat.status}
            waitingForPlanAnswer={
              capabilities.modes === "agent-modes" &&
              Boolean(planState.data?.question)
            }
          />
        </div>
      </div>

      <ChatHistoryRail
        messages={messages.data ?? []}
        viewportRef={transcriptViewportRef}
        withComposer={!effectiveInspectOnly}
      />

      <div
        aria-hidden="true"
        className={cn(
          "chat-composer-fade pointer-events-none absolute bottom-0 left-0 z-10 h-48 transition-[right] duration-150 ease-out motion-reduce:transition-none",
          effectiveInspectOnly && "hidden",
        )}
        style={{ right: sidePanelWidth }}
      />
      <form
        onSubmit={submit}
        className={cn(
          "pointer-events-none absolute bottom-0 left-0 z-20 px-4 pb-3 transition-[right] duration-150 ease-out motion-reduce:transition-none sm:px-8 sm:pb-4 md:px-10",
          effectiveInspectOnly && "hidden",
        )}
        style={{ right: sidePanelWidth }}
      >
        <div
          className="pointer-events-auto relative w-full"
          data-content-gutter="chat"
        >
          {composerNotice ? <ChatComposerNotice {...composerNotice} /> : null}
          {showScrollToBottom ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="absolute bottom-[calc(100%+0.75rem)] left-1/2 z-30 size-9 -translate-x-1/2 rounded-full bg-popover text-popover-foreground shadow-lg backdrop-blur-xl"
              title="Scroll to latest message"
              aria-label="Scroll to latest message"
              onClick={scrollTranscriptToBottom}
            >
              <ArrowDown className="size-4" />
            </Button>
          ) : null}
          {githubMenuOpen ? (
            <div
              id="github-reference-menu"
              ref={githubListRef}
              role="listbox"
              aria-label="GitHub issues and pull requests"
              className="chat-composer-surface absolute inset-x-0 bottom-[calc(100%+0.5rem)] max-h-72 overflow-y-auto rounded-xl border p-1.5 shadow-2xl"
            >
              {githubSuggestions.map((reference, index) => (
                <button
                  key={`${reference.kind}:${reference.number}`}
                  id={`github-reference-${index}`}
                  data-github-index={index}
                  role="option"
                  aria-selected={index === selectedGithubIndex}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left",
                    index === selectedGithubIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/60",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSelectedGithubIndex(index)}
                  onClick={() => chooseGithubReference(reference)}
                >
                  <span className="w-16 shrink-0 font-mono text-sm font-medium text-sky-600 dark:text-sky-400">
                    #{reference.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {reference.title}
                  </span>
                  <Badge
                    variant="outline"
                    className="hidden shrink-0 capitalize sm:inline-flex"
                  >
                    {reference.kind === "pull-request" ? "PR" : "Issue"}
                    {reference.state === "closed" ? " · Closed" : ""}
                  </Badge>
                </button>
              ))}
            </div>
          ) : null}
          {slashMenuOpen ? (
            <div
              id="slash-command-menu"
              ref={commandListRef}
              role="listbox"
              aria-label="Commands, workflows, and skills"
              className="chat-composer-surface absolute inset-x-0 bottom-[calc(100%+0.5rem)] max-h-72 overflow-y-auto rounded-xl border p-1.5 shadow-2xl"
            >
              {slashSuggestions.map((suggestion, index) => (
                <button
                  key={`${suggestion.kind}:${
                    suggestion.kind === "saved-command"
                      ? suggestion.trigger.id
                      : suggestion.invocation
                  }`}
                  id={`slash-command-${index}`}
                  data-command-index={index}
                  role="option"
                  aria-selected={index === selectedCommandIndex}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left",
                    index === selectedCommandIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/60",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSelectedCommandIndex(index)}
                  onClick={() => void executeCommandPalette(suggestion)}
                >
                  <span
                    className="w-36 shrink-0 truncate font-mono text-sm font-medium"
                    title={suggestion.invocation}
                  >
                    {suggestion.invocation}
                  </span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {suggestion.description}
                  </span>
                  <Badge
                    variant="outline"
                    className="ml-auto hidden capitalize sm:inline-flex"
                  >
                    {suggestion.kind}
                  </Badge>
                </button>
              ))}
            </div>
          ) : null}
          {skillMenuVisible ? (
            <div
              id="skill-mention-menu"
              ref={skillListRef}
              role="listbox"
              aria-label="Skills"
              className="chat-composer-surface absolute inset-x-0 bottom-[calc(100%+0.5rem)] max-h-72 overflow-y-auto rounded-xl border p-1.5 shadow-2xl"
            >
              {skillMenuLoading && skillSuggestions.length === 0 ? (
                <div
                  role="status"
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
                >
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading project skills…
                </div>
              ) : null}
              {skillSuggestions.map((skill, index) => (
                <button
                  key={skill.name}
                  id={`skill-mention-${index}`}
                  data-skill-index={index}
                  role="option"
                  aria-selected={index === selectedSkillIndex}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left",
                    index === selectedSkillIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/60",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSelectedSkillIndex(index)}
                  onClick={() => chooseSkill(skill)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate font-mono text-sm font-medium text-violet-500 dark:text-violet-400">
                        ${skill.name}
                      </span>
                      {skill.displayName && skill.displayName !== skill.name ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {skill.displayName}
                        </span>
                      ) : null}
                    </span>
                    {skill.description ? (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {skill.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {chat.automationPaused ? (
            <div
              role="status"
              className="mb-2 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
            >
              <Pause className="size-3.5 shrink-0" />
              <span>
                {chat.status === "running"
                  ? "Paused. The current step will finish, then Codex will wait here until Resume."
                  : "Paused. Queued prompts, goals, and automatic continuations will wait for Resume."}
              </span>
            </div>
          ) : null}
          {capabilities.context === "project" &&
          relocationJob &&
          (relocationActive || relocationNeedsAttention) ? (
            <ChatRelocationStatus
              job={relocationJob}
              onOpen={onOpenRelocation}
            />
          ) : null}
          {capabilities.modes === "agent-modes" && planState.data ? (
            <ChatPlanProgress
              explanation={planState.data.explanation}
              loading={chat.status === "running" && !interrupt.isPending}
              steps={planState.data.steps}
            />
          ) : null}
          {capabilities.modes === "agent-modes" ? (
            <GoalPanel
              error={
                updateGoal.isError
                  ? errorText(updateGoal.error)
                  : clearGoal.isError
                    ? errorText(clearGoal.error)
                    : null
              }
              goal={goalState.data?.goal ?? null}
              pending={updateGoal.isPending || clearGoal.isPending}
              onClear={() => clearGoal.mutate()}
              onUpdate={(status) => updateGoal.mutate(status)}
            />
          ) : null}
          <AgentInteractionPanel
            requests={interactionRequests.data ?? []}
            pendingRequestId={respondingRequestId}
            planQuestionId={planState.data?.question?.id}
            error={
              interactionResponseError ??
              (interactionRequests.isError
                ? errorText(interactionRequests.error)
                : null)
            }
            onRespond={(requestId, response) =>
              void submitInteractionResponse(requestId, response)
            }
          />
          {capabilities.modes === "agent-modes" && planState.data ? (
            <PlanPanel
              active={
                chat.status === "running" ||
                chat.status === "waiting-for-approval"
              }
              implementDisabled={planImplementationDisabled}
              implementPending={send.isPending}
              ready={
                chat.status === "idle" &&
                !interrupt.isPending &&
                composerMode !== "plan"
              }
              state={planState.data}
              pending={answerPlanPending}
              error={answerPlanError}
              onAnswer={(answers) => void submitPlanAnswer(answers)}
              onImplement={startPlanImplementation}
              onRevise={revisePlan}
            />
          ) : null}
          <PromptQueue
            prompts={queuedPrompts.data ?? []}
            editingPromptId={editingPrompt?.id ?? null}
            executing={
              chat.status === "running" ||
              chat.status === "waiting-for-approval"
            }
            disabled={
              relocationActive ||
              updatePrompt.isPending ||
              removePrompt.isPending ||
              steerPrompt.isPending ||
              reorderPrompts.isPending
            }
            onDelete={(prompt) => removePrompt.mutate(prompt.id)}
            onEdit={(prompt) => {
              setEditingPrompt({ id: prompt.id, frozen: prompt.frozen });
              setDraft(prompt.text);
              setSelectedGithubReferences([]);
              setComposerMode(prompt.mode);
              setComposerReasoningEffort(prompt.reasoningEffort);
              clearDraftAttachments();
              setDraftAttachments(
                prompt.attachments.map((attachment) => ({
                  attachment,
                  contentUrl: chatAttachmentContentUrl(attachment.id),
                  error: null,
                  localPreview: false,
                  uploading: false,
                })),
              );
              updatePrompt.mutate({
                id: prompt.id,
                input: { frozen: true },
              });
            }}
            onFreeze={(prompt) =>
              updatePrompt.mutate({
                id: prompt.id,
                input: { frozen: !prompt.frozen },
              })
            }
            onSteer={(prompt) => steerPrompt.mutate(prompt.id)}
            onReorder={(ids) => {
              const current = queuedPrompts.data ?? [];
              const byId = new Map(
                current.map((prompt) => [prompt.id, prompt]),
              );
              queryClient.setQueryData<QueuedPrompt[]>(
                ["prompt-queue", chat.id],
                ids.flatMap((id, position) => {
                  const prompt = byId.get(id);
                  return prompt ? [{ ...prompt, position }] : [];
                }),
              );
              reorderPrompts.mutate(ids);
            }}
          />
          <div className="chat-composer-surface relative flex items-end gap-2 rounded-2xl border p-2 shadow-xl shadow-background/20 focus-within:ring-2 focus-within:ring-ring">
            <div className="min-w-0 flex-1">
              {draftAttachments.length > 0 ? (
                <div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto px-1 pb-2">
                  {draftAttachments.map((item) => (
                    <AttachmentPreview
                      key={item.attachment.id}
                      attachment={item.attachment}
                      contentUrl={item.contentUrl}
                      error={item.error}
                      uploading={item.uploading}
                      onOpen={() => {
                        if (!item.uploading && !item.error) {
                          setViewingAttachment(item.attachment);
                        }
                      }}
                      onRemove={() => removeDraftAttachment(item)}
                      onRestoreText={
                        item.attachment.source === "paste"
                          ? () => restoreDraftAttachmentText(item)
                          : undefined
                      }
                    />
                  ))}
                </div>
              ) : null}
              <div className="relative min-h-10 overflow-hidden">
                {draft ? (
                  <div
                    aria-hidden="true"
                    data-slot="chat-composer-highlight"
                    className="pointer-events-none absolute inset-0 overflow-hidden px-2 py-2 text-sm leading-5 text-foreground whitespace-pre-wrap break-words [scrollbar-gutter:stable]"
                  >
                    <div
                      style={{
                        transform: `translateY(-${composerScrollTop}px)`,
                      }}
                    >
                      {highlightedDraft.map((segment, index) =>
                        segment.skill ? (
                          <span
                            key={`${index}:${segment.text}`}
                            className="rounded-sm bg-violet-500/15 text-violet-600 dark:text-violet-400"
                          >
                            {segment.text}
                          </span>
                        ) : (
                          <span key={`${index}:${segment.text}`}>
                            {segment.text}
                          </span>
                        ),
                      )}
                      {draft.endsWith("\n") ? "\u00a0" : null}
                    </div>
                  </div>
                ) : null}
                <textarea
                  ref={composerRef}
                  rows={1}
                  value={draft}
                  disabled={relocationActive}
                  aria-autocomplete="list"
                  aria-controls={
                    githubMenuOpen
                      ? "github-reference-menu"
                      : skillMenuVisible
                        ? "skill-mention-menu"
                        : slashMenuOpen
                          ? "slash-command-menu"
                          : undefined
                  }
                  aria-activedescendant={
                    githubMenuOpen
                      ? `github-reference-${selectedGithubIndex}`
                      : skillMenuOpen
                        ? `skill-mention-${selectedSkillIndex}`
                        : slashMenuOpen
                          ? `slash-command-${selectedCommandIndex}`
                          : undefined
                  }
                  onPaste={(event) => {
                    const files = [...event.clipboardData.files];
                    if (files.length > 0) {
                      event.preventDefault();
                      void attachFiles(files);
                      return;
                    }
                    const pastedText =
                      event.clipboardData.getData("text/plain");
                    if (!shouldAttachPastedText(pastedText)) return;
                    const fileName = largePasteFileName();
                    const file = new File([pastedText], fileName, {
                      type: "text/plain",
                    });
                    if (
                      draftAttachments.length >= MAX_COMPOSER_ATTACHMENTS ||
                      file.size > MAX_ATTACHMENT_BYTES
                    ) {
                      setAttachmentNotice(
                        draftAttachments.length >= MAX_COMPOSER_ATTACHMENTS
                          ? `A prompt can include up to ${MAX_COMPOSER_ATTACHMENTS} attachments. The pasted text was kept in the message.`
                          : "The paste is too large to attach, so it was kept in the message.",
                      );
                      return;
                    }
                    event.preventDefault();
                    void attachFiles([file], "paste");
                  }}
                  onChange={(event) => {
                    const nextDraft = event.target.value;
                    composerDraftEditedRef.current = true;
                    if (!editingPrompt) {
                      stagePersistedComposerDraft(
                        nextDraft
                          ? {
                              text: nextDraft,
                              mode: composerMode,
                              reasoningEffort: composerReasoningEffort,
                            }
                          : null,
                      );
                      if (!composerDraftHydrated) {
                        setComposerDraftHydrated(true);
                      }
                    }
                    setDraft(nextDraft);
                    setComposerCaret(event.target.selectionStart);
                    setSlashMenuDismissed(false);
                    setSkillMenuDismissed(false);
                    setGithubMenuDismissed(false);
                    setSelectedGithubReferences((current) =>
                      current.filter((reference) =>
                        containsGithubReference(nextDraft, reference),
                      ),
                    );
                    setCommandNotice(null);
                  }}
                  onSelect={(event) => {
                    setComposerCaret(event.currentTarget.selectionStart);
                  }}
                  onScroll={(event) => {
                    setComposerScrollTop(event.currentTarget.scrollTop);
                  }}
                  onKeyDown={(event) => {
                    if (githubMenuOpen && event.key === "ArrowDown") {
                      event.preventDefault();
                      setSelectedGithubIndex((index) =>
                        Math.min(index + 1, githubSuggestions.length - 1),
                      );
                      return;
                    }
                    if (githubMenuOpen && event.key === "ArrowUp") {
                      event.preventDefault();
                      setSelectedGithubIndex((index) => Math.max(index - 1, 0));
                      return;
                    }
                    if (githubMenuOpen && event.key === "Escape") {
                      event.preventDefault();
                      setGithubMenuDismissed(true);
                      return;
                    }
                    if (
                      githubMenuOpen &&
                      (event.key === "Tab" ||
                        (event.key === "Enter" && !event.shiftKey))
                    ) {
                      event.preventDefault();
                      const reference = githubSuggestions[selectedGithubIndex];
                      if (reference) chooseGithubReference(reference);
                      return;
                    }
                    if (skillMenuOpen && event.key === "ArrowDown") {
                      event.preventDefault();
                      setSelectedSkillIndex((index) =>
                        Math.min(index + 1, skillSuggestions.length - 1),
                      );
                      return;
                    }
                    if (skillMenuOpen && event.key === "ArrowUp") {
                      event.preventDefault();
                      setSelectedSkillIndex((index) => Math.max(index - 1, 0));
                      return;
                    }
                    if (skillMenuOpen && event.key === "Escape") {
                      event.preventDefault();
                      setSkillMenuDismissed(true);
                      return;
                    }
                    if (
                      skillMenuOpen &&
                      (event.key === "Tab" ||
                        (event.key === "Enter" && !event.shiftKey))
                    ) {
                      event.preventDefault();
                      const skill = skillSuggestions[selectedSkillIndex];
                      if (skill) chooseSkill(skill);
                      return;
                    }
                    if (slashMenuOpen && event.key === "ArrowDown") {
                      event.preventDefault();
                      setSelectedCommandIndex((index) =>
                        Math.min(index + 1, slashSuggestions.length - 1),
                      );
                      return;
                    }
                    if (slashMenuOpen && event.key === "ArrowUp") {
                      event.preventDefault();
                      setSelectedCommandIndex((index) =>
                        Math.max(index - 1, 0),
                      );
                      return;
                    }
                    if (slashMenuOpen && event.key === "Escape") {
                      event.preventDefault();
                      setSlashMenuDismissed(true);
                      return;
                    }
                    if (
                      slashMenuOpen &&
                      (event.key === "Tab" ||
                        (event.key === "Enter" && !event.shiftKey))
                    ) {
                      event.preventDefault();
                      const suggestion = slashSuggestions[selectedCommandIndex];
                      if (suggestion) void executeCommandPalette(suggestion);
                      return;
                    }
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={
                    relocationActive
                      ? "Agent relocation is in progress…"
                      : editingPrompt
                        ? "Edit queued prompt…"
                        : composerMode === "goal"
                          ? "Describe the goal Codex should pursue…"
                          : composerMode === "plan"
                            ? "Describe what Codex should plan…"
                            : chat.automationPaused
                              ? "Queue a prompt while paused…"
                              : chat.status === "running"
                                ? "Queue a follow-up…"
                                : capabilities.context === "standalone"
                                  ? "Message Cantrip…"
                                  : "Ask Cantrip to work on this repository…"
                  }
                  className={cn(
                    "relative max-h-48 min-h-10 w-full field-sizing-content resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground [scrollbar-gutter:stable]",
                    draft && "text-transparent caret-foreground",
                  )}
                />
              </div>
              <div className="flex min-w-0 items-center gap-1 px-1 pt-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  disabled={relocationActive}
                  className="hidden"
                  onChange={(event) => {
                    if (event.target.files?.length) {
                      void attachFiles([...event.target.files]);
                    }
                    event.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 text-muted-foreground"
                  disabled={relocationActive}
                  title="Attach files"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Plus className="size-4" />
                  <span className="sr-only">Attach files</span>
                </Button>
                <ModelReasoningPicker
                  configuration={currentModelConfiguration}
                  disabled={relocationActive}
                  loadReasoningState={loadModelReasoningState}
                  models={settings?.models ?? []}
                  pending={selectModelConfiguration.isPending}
                  readOnly={
                    chat.status === "running" ||
                    chat.status === "waiting-for-approval"
                  }
                  reasoningState={reasoningState.data}
                  subagentCapability={
                    capabilities.subagents
                      ? activeChatWorker?.codexRuntime.nativeSubagents
                      : undefined
                  }
                  subagents={capabilities.subagents}
                  onSave={(configuration) =>
                    selectModelConfiguration.mutateAsync(configuration)
                  }
                />
                <PermissionProfileControl
                  pending={
                    permissionProfiles.isLoading ||
                    selectPermissionProfile.isPending
                  }
                  state={permissionProfiles.data}
                  onChange={(id) => selectPermissionProfile.mutate(id)}
                />
                {capabilities.modes === "agent-modes" ? (
                  <ChatModeControl
                    mode={composerMode}
                    disabled={relocationActive}
                    onChange={setComposerMode}
                  />
                ) : null}
                <ContextUsageRing
                  availableResetCredits={chatGptAvailableResetCredits}
                  messages={messages.data ?? []}
                  model={selectedModel}
                  modelRouteId={runtimeSelection.data?.modelRouteId}
                  providerAccountId={runtimeSelection.data?.providerAccountId}
                  providers={settings?.providers ?? []}
                />
              </div>
            </div>
            <ChatComposerPrimaryActions
              active={
                chat.status === "running" ||
                chat.status === "waiting-for-approval"
              }
              agentStartedAtMs={resolveRunningAgentStartedAtMs(
                messages.data ?? [],
                chat.updatedAt,
              )}
              paused={chat.automationPaused}
              pausePending={setAutomationPaused.isPending}
              pauseDisabled={relocationActive || setAutomationPaused.isPending}
              stopPending={interrupt.isPending}
              stopDisabled={relocationActive || interrupt.isPending}
              sendPending={send.isPending}
              sendDisabled={
                relocationActive ||
                (!draft.trim() &&
                  !draftAttachments.some(
                    ({ error, uploading }) => !error && !uploading,
                  )) ||
                draftAttachments.some(
                  ({ error, uploading }) => Boolean(error) || uploading,
                ) ||
                !selectedModelId ||
                send.isPending ||
                selectModelConfiguration.isPending ||
                selectPermissionProfile.isPending ||
                updatePrompt.isPending
              }
              onPauseChange={(paused) => setAutomationPaused.mutate(paused)}
              onStop={() => interrupt.mutate()}
            />
          </div>
          <AttachmentViewerDialog
            attachment={viewingAttachment}
            contentUrl={
              viewingAttachment
                ? (draftAttachments.find(
                    ({ attachment }) => attachment.id === viewingAttachment.id,
                  )?.contentUrl ??
                  chatAttachmentContentUrl(viewingAttachment.id))
                : null
            }
            open={viewingAttachment !== null}
            onOpenChange={(open) => {
              if (!open) setViewingAttachment(null);
            }}
          />
        </div>
      </form>
      {effectiveInspectOnly ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 border-t bg-background/95 px-4 py-2 text-center text-[11px] text-muted-foreground backdrop-blur">
          Task planning controls are available in Task view.
        </div>
      ) : null}
      {capabilities.inspect ? (
        <AgentInspectPanelShell
          ariaLabel={
            sidePanelView.type !== "inspect"
              ? "Subagent transcript"
              : "Agent activity inspector"
          }
          className="absolute bottom-0 right-0 z-30"
          extendIntoProjectTabBar
          onOpenChange={handleInspectOpenChange}
          onWidthChange={setInspectWidth}
          open={inspectOpen}
          overlay={inspectOverlay}
          panelTitle={sidePanelView.type !== "inspect" ? "Subagent" : "Inspect"}
        >
          {sidePanelView.type !== "inspect" ? (
            <SubagentTranscriptPanel
              focusItemKey={
                sidePanelView.type === "subagent"
                  ? sidePanelView.focusItemKey
                  : null
              }
              modelSummary={subagentModelSummary}
              onOpenFile={onOpenFile}
              onSelectAgent={viewSubagent}
              onSelectRoot={viewSubagentRoot}
              projection={agentProjection}
              rootTurnId={
                sidePanelView.type === "subagent-root"
                  ? sidePanelView.rootTurnId
                  : (agentProjection.byKey.get(sidePanelView.agentKey)?.scope
                      .rootTurnId ?? null)
              }
              selectedAgentKey={
                sidePanelView.type === "subagent"
                  ? sidePanelView.agentKey
                  : null
              }
            />
          ) : (
            <AgentInspectContent
              active={inspectActive}
              agentProjection={agentProjection}
              inferenceProgress={inferenceProgress.data}
              inferenceProgressHistory={inferenceProgressHistory.data}
              integratedPanelHeader
              messages={messages.data ?? []}
              onOpenSubagent={viewSubagent}
              onTabChange={setInspectTab}
              tab={inspectTab}
              trajectoryTargetKey={trajectoryTargetKey}
              visible={inspectOpen}
              onBackToCurrent={() => setTrajectoryTargetKey(null)}
            />
          )}
        </AgentInspectPanelShell>
      ) : null}
      {standaloneFilesVisible && chat.contextKind === "standalone" ? (
        <AgentInspectPanelShell
          ariaLabel="Chat scratch files"
          className="absolute inset-y-0 right-0 z-30"
          headerIcon={<FolderOpen className="size-4 text-muted-foreground" />}
          onOpenChange={onFilesOpenChange}
          onWidthChange={setFilesWidth}
          open={filesOpen}
          overlay={inspectOverlay}
          panelTitle="Files"
        >
          <StandaloneChatFilesPanel
            chat={chat}
            desktopRuntime={desktopRuntime}
            requestedPath={filesRequestedPath}
          />
        </AgentInspectPanelShell>
      ) : null}
    </div>
  );
}
