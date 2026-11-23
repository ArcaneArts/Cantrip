import type {
  ActiveTurn,
  AgentNotificationTarget,
  AgentRuntimeState,
  AgentRuntimeStatus,
  ChildThreadMetadata,
  RootExecution,
  TurnCompletedParams,
} from "./runtime-types.js";
import type {
  AgentActivity,
  AgentCommunicationKind,
  AgentScope,
} from "@cantrip/protocol";
import {
  agentActivitySchema,
  normalizedAgentMessageSchema,
} from "@cantrip/protocol";
import {
  agentMessageFingerprint,
  boundedText,
  eventCorrelation,
  objectRecord,
  optionalDepth,
  optionalString,
} from "./event-values.js";
import type {
  CodexThreadItem,
  CodexThreadListResponse,
  CodexThreadReadResponse,
  CodexThreadTurn,
} from "./event-types.js";
import { workerLogError, workerLogger } from "../logger.js";
import { CodexExecutionLifetime } from "./execution-lifetime.js";
import type { CodexNativeHistorySnapshot } from "./native-history.js";
import { readCodexNativeHistory } from "./native-history.js";
import type { CodexComputerUseExecution } from "./execution-lifetime.js";
import {
  normalizeCodexThreadTurn,
  turnSummaryActivity,
} from "./event-normalization.js";
import {
  agentActivityDeliveryFingerprint,
  clearCommandFlush,
  clearTurnInspectionTelemetry,
  emitCommandTelemetry,
  emitTurnActivity,
  flushActiveAgentMessage,
  publishGoalCheckpoint,
  resetGoalSegment,
  scopedAgentActivity,
  settlePendingTurnActivities,
} from "./turn-streaming.js";
import {
  COMPLETED_TURN_RECONCILIATION_TIMEOUT_MS,
  MAX_AGENT_THREADS_PER_EXECUTION,
  MAX_KNOWN_AGENT_THREADS,
  MAX_ORPHAN_AGENT_THREADS,
  MAX_RECOVERED_AGENT_THREADS,
  MAX_RECOVERED_ITEMS_PER_TURN,
  MAX_RECOVERED_TURNS_PER_AGENT,
  RECOVERY_TURN_CLOCK_SLOP_MS,
} from "./runtime-limits.js";

interface ExecutionOwnershipPorts {
  methodAvailable(method: string): boolean;
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  canonicalHistory(threadId: string): boolean | undefined;
  clearInteractionsForTurn(active: ActiveTurn, reason: string): void;
}

export function agentPathSegments(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/[/.>]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(0, 32);
}

export function childThreadMetadataFromNotification(
  params: unknown,
): ChildThreadMetadata | null {
  const notification = objectRecord(params);
  const thread = objectRecord(notification?.thread);
  const threadId = optionalString(thread?.id);
  if (!threadId) return null;
  const source = objectRecord(thread?.source);
  const subagent = objectRecord(source?.subAgent ?? source?.subagent);
  const spawn = objectRecord(subagent?.thread_spawn ?? subagent?.threadSpawn);
  const parentThreadId =
    optionalString(thread?.parentThreadId) ??
    optionalString(spawn?.parent_thread_id ?? spawn?.parentThreadId);
  if (!parentThreadId) return null;
  return {
    threadId,
    parentThreadId,
    depth: optionalDepth(spawn?.depth),
    agentPath: optionalString(spawn?.agent_path ?? spawn?.agentPath),
    nickname:
      optionalString(thread?.agentNickname) ??
      optionalString(spawn?.agent_nickname ?? spawn?.agentNickname),
    role:
      optionalString(thread?.agentRole) ??
      optionalString(spawn?.agent_role ?? spawn?.agentRole),
  };
}

export function nativeAgentRuntimeStatus(
  status: { type?: string } | null | undefined,
): AgentRuntimeStatus {
  switch (status?.type) {
    case "active":
      return "running";
    case "idle":
      return "idle";
    case "notLoaded":
      return "completed";
    case "systemError":
      return "failed";
    default:
      return "starting";
  }
}

/** Owns live root/descendant identities and their cancellation lifetimes.
 * Read-only map views preserve the shared state objects used by event delivery. */
export class CodexExecutionOwnership {
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #activeTurnsByThread = new Map<string, ActiveTurn>();
  readonly #rootExecutionsByActive = new Map<ActiveTurn, RootExecution>();
  readonly #rootExecutionsByThread = new Map<string, RootExecution>();
  readonly #orphanAgentThreads = new Map<string, ChildThreadMetadata>();
  readonly #knownAgentThreads = new Map<string, ChildThreadMetadata>();
  readonly #unassociatedComputerUseTurns = new Map<
    string,
    {
      lifetime: CodexExecutionLifetime;
      roots: Map<RootExecution, AbortSignal>;
    }
  >();
  constructor(private readonly ports: ExecutionOwnershipPorts) {}

  get activeTurns(): ReadonlyMap<string, ActiveTurn> {
    return this.#activeTurns;
  }

  get activeTurnsByThread(): ReadonlyMap<string, ActiveTurn> {
    return this.#activeTurnsByThread;
  }

  get rootExecutionsByActive(): ReadonlyMap<ActiveTurn, RootExecution> {
    return this.#rootExecutionsByActive;
  }

  get rootExecutionsByThread(): ReadonlyMap<string, RootExecution> {
    return this.#rootExecutionsByThread;
  }

  trackActiveThread(threadId: string, active: ActiveTurn): void {
    this.#activeTurnsByThread.set(threadId, active);
  }

  deleteActiveTurn(turnId: string): void {
    this.#activeTurns.delete(turnId);
  }

  clearOwnership(): void {
    for (const execution of this.#rootExecutionsByActive.values()) {
      for (const state of execution.agents.values()) {
        clearTurnInspectionTelemetry(state);
      }
    }

    this.clearExecutionMaps();
  }

  failActiveTurns(error: Error): void {
    for (const active of this.#activeTurnsByThread.values()) {
      active.admission?.controller.abort();
      if (active.timeout) clearTimeout(active.timeout);
      flushActiveAgentMessage(active, false);
      clearTurnInspectionTelemetry(active);
      active.reject(error);
    }

    for (const execution of this.#rootExecutionsByActive.values()) {
      for (const state of execution.agents.values()) {
        flushActiveAgentMessage(state, false);
        clearTurnInspectionTelemetry(state);
      }
    }

    this.#activeTurns.clear();
    this.#activeTurnsByThread.clear();
    this.clearExecutionMaps();
  }

  private clearExecutionMaps(): void {
    this.#rootExecutionsByActive.clear();
    this.#rootExecutionsByThread.clear();
    for (const pending of this.#unassociatedComputerUseTurns.values())
      pending.lifetime.abort();
    this.#unassociatedComputerUseTurns.clear();
    this.#orphanAgentThreads.clear();
    this.#knownAgentThreads.clear();
  }

  hasActiveThread(threadId: string): boolean {
    return this.#rootExecutionsByThread.has(threadId);
  }

  /** Native root/child ownership for lifecycle cancellation, even before CUA is used. */
  ownsComputerUseThread(rootThreadId: string, threadId: string): boolean {
    return (
      this.#rootExecutionsByThread.get(threadId)?.rootThreadId === rootThreadId
    );
  }

  /** Resolve an exact observed native turn without creating or rebinding one.
   * The caller separately supplies trusted worker/account/lane authority. */
  resolveComputerUseExecution(input: {
    chatId: string;
    threadId: string;
    turnId: string;
  }): CodexComputerUseExecution | null {
    const execution = this.#rootExecutionsByThread.get(input.threadId);
    const rootTurnId = execution?.computerUseLifetime.turnId;
    if (
      !execution ||
      execution.active.executionKind !== "chat" ||
      execution.active.chatId !== input.chatId ||
      !rootTurnId ||
      !execution.computerUseLifetime.signal(rootTurnId)
    )
      return null;
    const child = execution.agents.get(input.threadId);
    const signal = child
      ? child.computerUseLifetime.signal(input.turnId)
      : input.threadId === execution.rootThreadId && input.turnId === rootTurnId
        ? execution.computerUseLifetime.signal(input.turnId)
        : null;
    if (!signal) return null;
    return {
      chatId: execution.active.chatId,
      ...(execution.active.admission
        ? {
            operationGeneration: execution.active.admission.operationGeneration,
          }
        : {}),
      threadId: input.threadId,
      turnId: input.turnId,
      rootThreadId: execution.rootThreadId,
      rootTurnId,
      parentThreadId: child?.parentThreadId ?? null,
      agentScope: this.agentScope(execution, child ?? null),
      signal,
    };
  }

  abortComputerUseExecution(execution: RootExecution, turnId?: string): void {
    if (!execution.computerUseLifetime.abort(turnId)) return;
    for (const state of execution.agents.values())
      state.computerUseLifetime.abort();
  }

  turnFinalizationCurrent(active: ActiveTurn, turnId: string): () => boolean {
    const execution = this.#rootExecutionsByActive.get(active);
    // Operation timeouts can release before entering their terminal handler.
    // Otherwise an awaited read belongs to this exact observed runtime turn.
    return () =>
      !execution ||
      (this.#rootExecutionsByActive.get(active) === execution &&
        execution.computerUseLifetime.turnId === turnId);
  }

  /** Native child turn/started can precede the parent's spawn result. Retain
   * the event, but grant nothing until runtime ancestry identifies its root. */
  unassociatedComputerUseTurn(threadId: string, turnId?: string) {
    const existing = this.#unassociatedComputerUseTurns.get(threadId);
    if (existing && (!turnId || existing.lifetime.turnId === turnId))
      return existing;
    // A genuine newer child start takes a new root snapshot; a duplicate start
    // retains its old (possibly aborted) lifetime and can never refresh it.
    existing?.lifetime.abort();
    this.#unassociatedComputerUseTurns.delete(threadId);
    const roots = new Map<RootExecution, AbortSignal>();
    for (const execution of this.#rootExecutionsByActive.values()) {
      const turnId = execution.computerUseLifetime.turnId;
      const signal = turnId && execution.computerUseLifetime.signal(turnId);
      if (signal) roots.set(execution, signal);
    }

    if (!roots.size) return null;
    if (this.#unassociatedComputerUseTurns.size >= MAX_ORPHAN_AGENT_THREADS) {
      const oldest = this.#unassociatedComputerUseTurns.keys().next().value;
      if (oldest !== undefined) {
        this.#unassociatedComputerUseTurns.get(oldest)?.lifetime.abort();
        this.#unassociatedComputerUseTurns.delete(oldest);
      }
    }

    const pending = { lifetime: new CodexExecutionLifetime(), roots };
    this.#unassociatedComputerUseTurns.set(threadId, pending);
    return pending;
  }

  private adoptComputerUseTurn(
    execution: RootExecution,
    state: AgentRuntimeState,
  ): void {
    const pending = this.#unassociatedComputerUseTurns.get(state.threadId);
    if (!pending) return;
    this.#unassociatedComputerUseTurns.delete(state.threadId);
    const turnId = execution.computerUseLifetime.turnId;
    const signal = turnId && execution.computerUseLifetime.signal(turnId);
    // A delayed spawn result cannot transfer an old child start into another
    // root turn, or revive authority after Stop/completion/replacement.
    if (!signal || pending.roots.get(execution) !== signal)
      pending.lifetime.abort();
    state.computerUseLifetime = pending.lifetime;
  }

  observeComputerUseTurnStart(threadId: string, turnId: string): void {
    const execution = this.#rootExecutionsByThread.get(threadId);
    if (!execution) {
      this.unassociatedComputerUseTurn(threadId, turnId)?.lifetime.observe(
        turnId,
      );
      return;
    }

    if (threadId === execution.rootThreadId) {
      if (execution.active.admission) {
        const admission = execution.active.admission;
        if (admission.initialTurnId && admission.initialTurnId !== turnId)
          return;
        admission.initialTurnId ??= turnId;
      }

      if (execution.computerUseLifetime.observe(turnId))
        for (const state of execution.agents.values())
          state.computerUseLifetime.abort();
    } else {
      const rootTurnId = execution.computerUseLifetime.turnId;
      if (rootTurnId && execution.computerUseLifetime.signal(rootTurnId))
        execution.agents.get(threadId)?.computerUseLifetime.observe(turnId);
    }
  }

  abortComputerUseThread(threadId: string, closed = true): void {
    const execution = this.#rootExecutionsByThread.get(threadId);
    if (!execution) {
      this.#unassociatedComputerUseTurns.get(threadId)?.lifetime.abort();
      return;
    }

    if (threadId === execution.rootThreadId) {
      this.abortComputerUseExecution(execution);
      if (closed && execution.active.admission) {
        this.releaseActiveTurn(execution.active);
        clearTurnInspectionTelemetry(execution.active);
        execution.active.reject(
          new Error("The admitted native execution's thread closed."),
        );
      }
    } else execution.agents.get(threadId)?.computerUseLifetime.abort();
  }

  private agentScope(
    execution: RootExecution,
    state: AgentRuntimeState | null,
  ): AgentScope | null {
    if (!execution.rootTurnId) return null;
    return {
      agentThreadId: state?.threadId ?? execution.rootThreadId,
      rootThreadId: execution.rootThreadId,
      parentThreadId: state?.parentThreadId ?? null,
      rootTurnId: execution.rootTurnId,
      agentPath: state?.agentPath ?? ["root"],
      nickname: state?.nickname ?? null,
      role: state?.role ?? null,
      depth: state?.depth ?? 0,
      isRoot: state === null,
    };
  }

  private refreshExecutionScopes(execution: RootExecution): void {
    execution.active.agentScope = this.agentScope(execution, null);
    for (const state of execution.agents.values()) {
      state.agentScope = this.agentScope(execution, state);
    }
  }

  registerRootExecution(active: ActiveTurn): RootExecution {
    const existing = this.#rootExecutionsByActive.get(active);
    if (existing) return existing;
    const execution: RootExecution = {
      computerUseLifetime: new CodexExecutionLifetime(),
      active,
      agents: new Map(),
      rootThreadId: active.threadId,
      rootTurnId: null,
    };
    this.#rootExecutionsByActive.set(active, execution);
    this.#rootExecutionsByThread.set(active.threadId, execution);
    this.associateWaitingAgentThreads(active.threadId);
    return execution;
  }

  private bindRootTurn(execution: RootExecution, turnId: string): void {
    const completed = execution.active.goalCompletion;
    const continuing =
      execution.rootTurnId !== turnId &&
      completed?.turnId === execution.rootTurnId &&
      !execution.active.admission;
    if (continuing) resetGoalSegment(execution.active);
    if (execution.rootTurnId !== turnId) {
      execution.rootTurnId = turnId;
      execution.active.observedActivityFingerprints.clear();
      for (const state of execution.agents.values()) {
        state.segmentTurnIds.clear();
        state.observedActivityFingerprints.clear();
        state.liveAgentMessageFingerprints.clear();
      }

      this.refreshExecutionScopes(execution);
    }

    for (const [knownTurnId, candidate] of this.#activeTurns) {
      if (candidate === execution.active && knownTurnId !== turnId) {
        this.#activeTurns.delete(knownTurnId);
      }
    }

    this.#activeTurns.set(turnId, execution.active);
    // A real next turn proves continuation even while the old completion is
    // awaiting filesystem/history reads. Never let those reads own the new turn.
    if (continuing) publishGoalCheckpoint(execution.active, completed!.turnId);
  }

  private childFallbackPath(
    execution: RootExecution,
    metadata: ChildThreadMetadata,
  ): string[] {
    const parent = execution.agents.get(metadata.parentThreadId);
    const parentPath = parent?.agentPath ?? ["root"];
    const label = metadata.nickname ?? `agent-${metadata.threadId.slice(-8)}`;
    return [...parentPath, label].slice(0, 32);
  }

  private createAgentRuntimeState(
    execution: RootExecution,
    metadata: ChildThreadMetadata,
  ): AgentRuntimeState {
    const active = execution.active;
    const parent = execution.agents.get(metadata.parentThreadId);
    const path = agentPathSegments(metadata.agentPath);
    const now = Date.now();
    const state: AgentRuntimeState = {
      computerUseLifetime: new CodexExecutionLifetime(),
      agentScope: null,
      agentPath:
        path.length > 0 ? path : this.childFallbackPath(execution, metadata),
      captureProtectedDiagnostics: active.captureProtectedDiagnostics,
      commandTelemetry: new Map(),
      completedCommandIds: new Set(),
      currentTurnId: null,
      cwd: active.cwd,
      delta: "",
      depth: metadata.depth ?? Math.min((parent?.depth ?? 0) + 1, 32),
      diffChanges: [],
      fileStartedAtMs: new Map(),
      finalText: null,
      itemStartedAtMs: new Map(),
      lastActiveAtMs: now,
      latestUsage: null,
      liveAgentMessageFingerprints: new Set(),
      observedActivityFingerprints: new Set(),
      nickname: metadata.nickname ?? null,
      onActivity: active.onActivity,
      onMessage: active.onMessage,
      parentThreadId: metadata.parentThreadId,
      pendingActivities: new Map(),
      pendingAgentMessage: null,
      reasoningSummaries: new Map(),
      role: metadata.role ?? null,
      segmentTurnIds: new Set(),
      startedAtMs: now,
      status: "starting",
      streamingAgentMessage: null,
      structuredChat: false,
      threadId: metadata.threadId,
    };
    state.agentScope = this.agentScope(execution, state);
    return state;
  }

  private rememberOrphanAgentThread(metadata: ChildThreadMetadata): void {
    if (
      !this.#orphanAgentThreads.has(metadata.threadId) &&
      this.#orphanAgentThreads.size >= MAX_ORPHAN_AGENT_THREADS
    ) {
      const oldest = this.#orphanAgentThreads.keys().next().value;
      if (oldest !== undefined) this.#orphanAgentThreads.delete(oldest);
    }

    this.#orphanAgentThreads.set(metadata.threadId, metadata);
  }

  private rememberKnownAgentThread(metadata: ChildThreadMetadata): void {
    if (
      !this.#knownAgentThreads.has(metadata.threadId) &&
      this.#knownAgentThreads.size >= MAX_KNOWN_AGENT_THREADS
    ) {
      const oldest = this.#knownAgentThreads.keys().next().value;
      if (oldest !== undefined) this.#knownAgentThreads.delete(oldest);
    }

    this.#knownAgentThreads.set(metadata.threadId, metadata);
  }

  associateAgentThread(input: ChildThreadMetadata): AgentRuntimeState | null {
    const remembered = this.#knownAgentThreads.get(input.threadId);
    const metadata: ChildThreadMetadata = {
      ...remembered,
      ...input,
      agentPath: input.agentPath ?? remembered?.agentPath,
      depth: input.depth ?? remembered?.depth,
      nickname: input.nickname ?? remembered?.nickname,
      role: input.role ?? remembered?.role,
    };
    const execution = this.#rootExecutionsByThread.get(metadata.parentThreadId);
    if (!execution) {
      this.rememberOrphanAgentThread(metadata);
      return null;
    }

    if (metadata.threadId === execution.rootThreadId) return null;
    const existing = execution.agents.get(metadata.threadId);
    if (existing) {
      existing.parentThreadId = metadata.parentThreadId;
      existing.nickname = metadata.nickname ?? existing.nickname;
      existing.role = metadata.role ?? existing.role;
      existing.depth =
        metadata.depth ??
        Math.min(
          (execution.agents.get(metadata.parentThreadId)?.depth ?? 0) + 1,
          32,
        );
      const path = agentPathSegments(metadata.agentPath);
      if (path.length > 0) existing.agentPath = path;
      existing.agentScope = this.agentScope(execution, existing);
      this.#orphanAgentThreads.delete(metadata.threadId);
      this.rememberKnownAgentThread(metadata);
      return existing;
    }

    if (execution.agents.size >= MAX_AGENT_THREADS_PER_EXECUTION) return null;
    const state = this.createAgentRuntimeState(execution, metadata);
    this.adoptComputerUseTurn(execution, state);
    execution.agents.set(metadata.threadId, state);
    this.#rootExecutionsByThread.set(metadata.threadId, execution);
    this.#orphanAgentThreads.delete(metadata.threadId);
    this.rememberKnownAgentThread(metadata);
    this.associateWaitingAgentThreads(metadata.threadId);
    return state;
  }

  private associateWaitingAgentThreads(parentThreadId: string): void {
    const waiting = [...this.#orphanAgentThreads.values()].filter(
      (candidate) => candidate.parentThreadId === parentThreadId,
    );
    for (const metadata of waiting) this.associateAgentThread(metadata);
  }

  updateAgentStatus(
    state: AgentRuntimeState,
    status: AgentRuntimeStatus,
  ): void {
    state.status = status;
    state.lastActiveAtMs = Date.now();
  }

  emitAgentCommunication(input: {
    diagnosticId: string | null;
    itemId?: string | null;
    kind: AgentCommunicationKind;
    message?: string | null;
    milestoneId?: string | null;
    sourceMethod: string;
    state: AgentRuntimeState;
    status: AgentActivity["status"];
    turnId?: string | null;
  }): void {
    if (!input.state.agentScope) return;
    const milestoneId =
      input.milestoneId ??
      ((input.kind === "returned" ||
        input.kind === "failed" ||
        input.kind === "interrupted") &&
      input.turnId
        ? `${input.kind}:${input.turnId}`
        : input.kind);
    emitTurnActivity(
      input.state,
      agentActivitySchema.parse({
        type: "agentCommunication",
        id: `agent:${input.state.agentScope.rootTurnId}:${input.state.threadId}:${milestoneId}`,
        kind: input.kind,
        senderThreadId:
          input.kind === "spawned" || input.kind === "followupSent"
            ? input.state.parentThreadId
            : input.state.threadId,
        receiverThreadIds:
          input.kind === "spawned" || input.kind === "followupSent"
            ? [input.state.threadId]
            : [input.state.parentThreadId],
        message: boundedText(input.message, 100_000),
        status: input.status,
        updatedAtMs: Date.now(),
        correlation: eventCorrelation(
          input.sourceMethod,
          input.diagnosticId,
          input.state.threadId,
          input.turnId ?? input.state.currentTurnId,
          input.itemId ?? null,
        ),
      }),
    );
  }

  private collaborationAgentStatus(value: string): AgentRuntimeStatus {
    const normalized = value.toLowerCase();
    if (normalized.includes("interrupt")) return "interrupted";
    if (
      normalized.includes("fail") ||
      normalized.includes("error") ||
      normalized.includes("notfound")
    ) {
      return "failed";
    }

    if (
      normalized.includes("complete") ||
      normalized.includes("done") ||
      normalized.includes("shutdown")
    ) {
      return "completed";
    }

    if (normalized.includes("idle") || normalized.includes("wait")) {
      return "idle";
    }

    return "running";
  }

  associateAgentsFromItem(
    item: CodexThreadItem,
    notificationThreadId: string,
    notificationTurnId: string,
    sourceMethod: string,
    diagnosticId: string | null,
  ): void {
    if (item.type === "collabAgentToolCall") {
      const parentThreadId = this.#rootExecutionsByThread.has(
        item.senderThreadId,
      )
        ? item.senderThreadId
        : notificationThreadId;
      const targetThreadIds = new Set([
        ...item.receiverThreadIds,
        ...Object.keys(item.agentsStates),
      ]);
      for (const threadId of targetThreadIds) {
        if (threadId === parentThreadId) continue;
        const state = this.associateAgentThread({
          threadId,
          parentThreadId,
        });
        const advertised = item.agentsStates[threadId];
        if (state && advertised?.status) {
          this.updateAgentStatus(
            state,
            this.collaborationAgentStatus(advertised.status),
          );
        }

        if (state) {
          const tool = item.tool.replaceAll("_", "").toLowerCase();
          const execution =
            this.#rootExecutionsByThread.get(notificationThreadId);
          if (
            tool === "closeagent" &&
            item.status === "completed" &&
            execution?.active.chatId &&
            this.#rootExecutionsByThread.get(threadId) === execution &&
            this.resolveComputerUseExecution({
              chatId: execution.active.chatId,
              threadId: notificationThreadId,
              turnId: notificationTurnId,
            })
          )
            state.computerUseLifetime.abort();
          const advertisedMessage = boundedText(advertised?.message, 100_000);
          const kind: AgentCommunicationKind =
            tool === "spawnagent"
              ? "spawned"
              : tool === "sendinput" || tool === "resumeagent"
                ? "followupSent"
                : tool === "wait" && advertisedMessage
                  ? "returned"
                  : tool === "wait"
                    ? "waiting"
                    : "statusChanged";
          this.emitAgentCommunication({
            diagnosticId,
            itemId: item.id,
            kind,
            message:
              kind === "returned" ? advertisedMessage : (item.prompt ?? null),
            milestoneId: kind === "spawned" ? "spawn" : `${kind}:${item.id}`,
            sourceMethod,
            state,
            status:
              item.status === "inProgress"
                ? "running"
                : item.status === "failed"
                  ? "failed"
                  : "completed",
            turnId: notificationTurnId,
          });
        }
      }

      return;
    }

    if (
      item.type === "subAgentActivity" &&
      item.agentThreadId !== notificationThreadId
    ) {
      const state = this.associateAgentThread({
        threadId: item.agentThreadId,
        parentThreadId: notificationThreadId,
        agentPath: item.agentPath,
      });
      if (state) {
        this.updateAgentStatus(
          state,
          item.kind === "interrupted"
            ? "interrupted"
            : item.kind === "interacted"
              ? "idle"
              : "running",
        );
      }
    }
  }

  private async discoverSubagentThreads(
    execution: RootExecution,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!this.ports.methodAvailable("thread/list")) return;
    let cursor: string | null = null;
    let discovered = 0;
    do {
      const response = (await this.ports.request(
        "thread/list",
        {
          ancestorThreadId: execution.rootThreadId,
          cursor,
          limit: Math.min(100, MAX_RECOVERED_AGENT_THREADS - discovered),
          sortKey: "created_at",
          sortDirection: "asc",
          useStateDbOnly: true,
        },
        COMPLETED_TURN_RECONCILIATION_TIMEOUT_MS,
      )) as CodexThreadListResponse;
      if (!isCurrent()) return;
      if (!Array.isArray(response.data)) {
        throw new Error("Codex returned an invalid descendant thread page.");
      }

      for (const thread of response.data) {
        const metadata = childThreadMetadataFromNotification({ thread });
        if (metadata) this.associateAgentThread(metadata);
      }

      discovered += response.data.length;
      cursor = optionalString(response.nextCursor);
    } while (cursor && discovered < MAX_RECOVERED_AGENT_THREADS);
  }

  private recoveredAgentTurns(
    response: CodexThreadReadResponse,
    state: AgentRuntimeState,
    executionStartedAtMs: number,
    executionCompletedAtMs: number,
    rootTurnId: string | null,
    history: CodexNativeHistorySnapshot["history"],
  ): CodexThreadTurn[] {
    const windowStart = executionStartedAtMs - RECOVERY_TURN_CLOCK_SLOP_MS;
    const windowEnd = executionCompletedAtMs + RECOVERY_TURN_CLOCK_SLOP_MS;
    return response.thread.turns
      .filter((turn) => {
        const retained = history?.turns.find(
          (entry) => entry.turnId === turn.id,
        );
        if (retained?.contexts !== undefined) {
          // Nearby timestamps do not establish child ownership. In particular,
          // a restart followed by a quick new root used to replay the old child
          // within the clock-slop window under the new root's scope.
          return (
            retained.contexts.length > 0 &&
            retained.contexts.every(
              (context) => context.rootTurnId === rootTurnId,
            )
          );
        }

        if (state.segmentTurnIds.has(turn.id)) return true;
        if (turn.startedAt === null) return false;
        const startedAtMs = turn.startedAt * 1_000;
        return startedAtMs >= windowStart && startedAtMs <= windowEnd;
      })
      .slice(-MAX_RECOVERED_TURNS_PER_AGENT)
      .map((turn) => ({
        ...turn,
        items: turn.items.slice(-MAX_RECOVERED_ITEMS_PER_TURN),
      }));
  }

  private async reconcileAgentThread(
    execution: RootExecution,
    state: AgentRuntimeState,
    executionCompletedAtMs: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    const snapshot = await readCodexNativeHistory(
      (method, params) =>
        this.ports.request(
          method,
          params,
          COMPLETED_TURN_RECONCILIATION_TIMEOUT_MS,
        ),
      state.threadId,
    );
    const response = snapshot as unknown as CodexThreadReadResponse;
    if (!isCurrent()) return;
    const metadata = childThreadMetadataFromNotification({
      thread: response.thread,
    });
    if (metadata) this.associateAgentThread(metadata);
    const turns = this.recoveredAgentTurns(
      response,
      state,
      execution.active.startedAtMs,
      executionCompletedAtMs,
      execution.rootTurnId,
      snapshot.history,
    );
    for (const turn of turns) {
      // Managed durable projection owns retained snapshots. Re-emitting these
      // as legacy thread/read events would assign another message identity.
      if (
        this.ports.canonicalHistory(execution.rootThreadId) &&
        snapshot.history?.turns.some(
          (entry) => entry.turnId === turn.id && entry.source === "canonical",
        )
      )
        continue;
      state.segmentTurnIds.add(turn.id);
      const normalized = normalizeCodexThreadTurn(
        turn,
        execution.active.cwd,
        state.threadId,
      );
      for (const item of normalized.items) {
        if (item.type === "userMessage") {
          this.emitAgentCommunication({
            diagnosticId: null,
            itemId: item.id,
            kind:
              response.thread.turns[0]?.id === turn.id
                ? "spawned"
                : "followupSent",
            message: item.text || null,
            milestoneId:
              response.thread.turns[0]?.id === turn.id
                ? "spawn"
                : `followupSent:${item.id}`,
            sourceMethod: "thread/read",
            state,
            status: "completed",
            turnId: turn.id,
          });
          continue;
        }

        if (item.type === "agentMessage") {
          const { type: _type, ...message } = item;
          const scoped = normalizedAgentMessageSchema.parse({
            ...message,
            agentScope: state.agentScope,
          });
          const fingerprint = agentMessageFingerprint(scoped);
          if (state.liveAgentMessageFingerprints.has(fingerprint)) continue;
          state.liveAgentMessageFingerprints.add(fingerprint);
          state.onMessage?.(scoped);
          continue;
        }

        const scoped = scopedAgentActivity(state, item.activity);
        if (
          state.observedActivityFingerprints.has(
            agentActivityDeliveryFingerprint(scoped),
          )
        ) {
          continue;
        }

        emitTurnActivity(state, item.activity);
      }

      if (turn.status !== "inProgress") {
        const status =
          turn.status === "completed"
            ? "completed"
            : turn.status === "interrupted"
              ? "interrupted"
              : "failed";
        this.updateAgentStatus(state, status);
        this.emitAgentCommunication({
          diagnosticId: null,
          kind:
            status === "completed"
              ? "returned"
              : status === "interrupted"
                ? "interrupted"
                : "failed",
          sourceMethod: "thread/read",
          state,
          status: status === "completed" ? "completed" : "failed",
          turnId: turn.id,
        });
      }
    }
  }

  async reconcileSubagentExecution(
    active: ActiveTurn,
    executionCompletedAtMs: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (active.executionKind !== "chat") return;
    const execution = this.#rootExecutionsByActive.get(active);
    if (!execution?.rootTurnId || (!active.onActivity && !active.onMessage)) {
      return;
    }

    try {
      await this.discoverSubagentThreads(execution, isCurrent);
    } catch (error) {
      workerLogger.event(
        "warn",
        "Could not discover descendant Codex threads",
        {
          event: "codex.subagent.reconciliation",
          subsystem: "codex",
          operation: "list-descendant-threads",
          status: "failed",
          chatId: active.chatId ?? undefined,
          threadId: execution.rootThreadId,
          turnId: execution.rootTurnId,
          error: workerLogError(error),
        },
      );
    }

    if (!isCurrent()) return;
    const states = [...execution.agents.values()]
      .sort((left, right) => left.depth - right.depth)
      .slice(0, MAX_RECOVERED_AGENT_THREADS);
    for (let offset = 0; offset < states.length; offset += 4) {
      if (!isCurrent()) return;
      await Promise.all(
        states.slice(offset, offset + 4).map(async (state) => {
          try {
            await this.reconcileAgentThread(
              execution,
              state,
              executionCompletedAtMs,
              isCurrent,
            );
          } catch (error) {
            workerLogger.event(
              "warn",
              "Could not reconcile a descendant Codex thread",
              {
                event: "codex.subagent.reconciliation",
                subsystem: "codex",
                operation: "read-descendant-thread",
                status: "failed",
                chatId: active.chatId ?? undefined,
                threadId: state.threadId,
                turnId: execution.rootTurnId ?? undefined,
                error: workerLogError(error),
              },
            );
          }
        }),
      );
    }
  }

  settleDescendantsAtRootBoundary(
    execution: RootExecution,
    rootStatus: TurnCompletedParams["turn"]["status"],
    observedAtMs: number,
    diagnosticId: string | null,
  ): void {
    for (const state of execution.agents.values()) {
      const runtimeStatus: AgentRuntimeStatus =
        state.status === "completed" || state.status === "idle"
          ? "completed"
          : state.status === "failed" || state.status === "interrupted"
            ? state.status
            : rootStatus === "failed"
              ? "failed"
              : "interrupted";
      const childCompleted = runtimeStatus === "completed";
      const settledStatus = childCompleted ? "completed" : "failed";
      const turnId = state.currentTurnId;
      if (turnId) {
        const correlation = eventCorrelation(
          "turn/completed",
          diagnosticId,
          state.threadId,
          turnId,
          null,
        );
        for (const telemetry of state.commandTelemetry.values()) {
          clearCommandFlush(telemetry);
          telemetry.updatedAtMs = observedAtMs;
          emitCommandTelemetry(state, telemetry, observedAtMs, settledStatus);
        }

        settlePendingTurnActivities(
          state,
          settledStatus,
          observedAtMs,
          correlation,
        );
        flushActiveAgentMessage(state, childCompleted);
        emitTurnActivity(
          state,
          turnSummaryActivity(
            {
              id: turnId,
              status: childCompleted ? "completed" : "interrupted",
              startedAt: Math.floor(state.startedAtMs / 1_000),
              completedAt: Math.floor(observedAtMs / 1_000),
              durationMs: Math.max(0, observedAtMs - state.startedAtMs),
            },
            correlation,
            state.initialSettings,
          ),
        );
      }

      state.currentTurnId = null;
      this.updateAgentStatus(state, runtimeStatus);
      this.emitAgentCommunication({
        diagnosticId,
        kind:
          runtimeStatus === "completed"
            ? "returned"
            : runtimeStatus === "failed"
              ? "failed"
              : "interrupted",
        sourceMethod: "turn/completed",
        state,
        status: runtimeStatus === "completed" ? "completed" : "failed",
        turnId,
      });
      clearTurnInspectionTelemetry(state);
    }
  }

  notificationTarget(
    threadId: string,
    turnId: string,
    startingTurn = false,
  ): AgentNotificationTarget | null {
    const execution = this.#rootExecutionsByThread.get(threadId);
    if (!execution) return null;
    const startedTurnId =
      threadId === execution.rootThreadId
        ? execution.computerUseLifetime.turnId
        : execution.agents.get(threadId)?.computerUseLifetime.turnId;
    if (execution.active.admission && !startedTurnId && !startingTurn)
      return null;
    if (startedTurnId && startedTurnId !== turnId && !startingTurn) return null;
    if (threadId === execution.rootThreadId) {
      const admittedTurnId = execution.active.admission?.initialTurnId;
      if (admittedTurnId && admittedTurnId !== turnId) return null;
      this.bindRootTurn(execution, turnId);
      return {
        active: execution.active,
        execution,
        isRoot: true,
        state: execution.active,
      };
    }

    const state = execution.agents.get(threadId);
    if (!state) return null;
    if (
      state.currentTurnId &&
      state.currentTurnId !== turnId &&
      state.status === "running" &&
      !startingTurn
    ) {
      return null;
    }

    if (state.currentTurnId !== turnId) {
      if (state.currentTurnId) {
        flushActiveAgentMessage(state, false);
        clearTurnInspectionTelemetry(state);
      }

      state.currentTurnId = turnId;
      state.delta = "";
      state.diffChanges = [];
      state.finalText = null;
      state.latestUsage = null;
      state.pendingAgentMessage = null;
      state.startedAtMs = Date.now();
      state.liveAgentMessageFingerprints.clear();
      state.observedActivityFingerprints.clear();
      state.reasoningSummaries.clear();
    }

    state.segmentTurnIds.add(turnId);
    state.status = "running";
    state.lastActiveAtMs = Date.now();
    state.agentScope = this.agentScope(execution, state);
    return {
      active: execution.active,
      execution,
      isRoot: false,
      state,
    };
  }

  activeTurnForNotification(
    threadId: string,
    turnId: string,
  ): ActiveTurn | undefined {
    return this.notificationTarget(threadId, turnId)?.active;
  }

  bindTurnStartResponse(turnId: string, active: ActiveTurn): void {
    const execution = this.#rootExecutionsByActive.get(active);
    if (!execution) return;
    // Notifications can precede this acknowledgement, including a native goal's
    // next turn. The response may initialize, but never roll that lifetime back.
    if (
      !execution.computerUseLifetime.turnId ||
      execution.computerUseLifetime.turnId === turnId
    ) {
      this.bindRootTurn(execution, turnId);
      this.observeComputerUseTurnStart(active.threadId, turnId);
    }
  }

  releaseActiveTurn(active: ActiveTurn, turnId?: string): boolean {
    const execution = this.#rootExecutionsByActive.get(active);
    if (
      turnId !== undefined &&
      execution?.computerUseLifetime.turnId &&
      execution.computerUseLifetime.turnId !== turnId
    )
      return false;
    if (this.#activeTurnsByThread.get(active.threadId) === active) {
      this.#activeTurnsByThread.delete(active.threadId);
    }

    for (const [turnId, candidate] of this.#activeTurns) {
      if (candidate === active) this.#activeTurns.delete(turnId);
    }

    this.ports.clearInteractionsForTurn(
      active,
      "The native execution ended before the interaction was answered.",
    );
    active.admission?.controller.abort();
    active.goalCompletion = undefined;
    if (!execution) return true;
    this.abortComputerUseExecution(execution);
    const releasedThreadIds = new Set([
      execution.rootThreadId,
      ...execution.agents.keys(),
    ]);
    for (const state of execution.agents.values()) {
      clearTurnInspectionTelemetry(state);
      if (this.#rootExecutionsByThread.get(state.threadId) === execution)
        this.#rootExecutionsByThread.delete(state.threadId);
    }

    if (this.#rootExecutionsByThread.get(execution.rootThreadId) === execution)
      this.#rootExecutionsByThread.delete(execution.rootThreadId);
    this.#rootExecutionsByActive.delete(active);
    for (const [threadId, pending] of this.#unassociatedComputerUseTurns) {
      pending.roots.delete(execution);
      if (!pending.roots.size) {
        pending.lifetime.abort();
        this.#unassociatedComputerUseTurns.delete(threadId);
      }
    }

    for (const [threadId, metadata] of this.#orphanAgentThreads) {
      if (
        releasedThreadIds.has(threadId) ||
        releasedThreadIds.has(metadata.parentThreadId)
      ) {
        this.#orphanAgentThreads.delete(threadId);
      }
    }

    return true;
  }
}
