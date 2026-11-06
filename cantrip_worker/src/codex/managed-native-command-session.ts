import type { InferenceOperationSource } from "../inference-admission.js";
import {
  InferenceWithdrawalError,
  UnstartedInferenceUnavailableError,
} from "../inference-withdrawal.js";
import { ManagedNativeSettings } from "./managed-native-settings.js";
import {
  isNativePermissionDeferred,
  NativePermissionDeferredError,
  NativePermissionRetentionError,
} from "./native-permission-deferred.js";
import {
  applyNativePermissionTransition,
  hasNativePermissionUpdate,
  requestedNativePermissionProfile,
  nativePermissionPatch,
} from "./managed-native-permissions.js";
import type { NativeSettingsDelivery } from "../native-settings-delivery.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  managedNativeMethods,
  nativeTurnSuspensionSchema,
  nativeSuspensionEvidenceSchema,
  type NativeTurnSuspension,
} from "@cantrip/protocol";
import {
  CodexNativeRpcError,
  CodexTurnFailureError,
  type ManagedNativeGuiCommand,
  type ManagedExecutionAttempt,
  type ManagedExecutionDeclined,
} from "./app-server.js";
import type { ManagedSessionIdentity } from "./managed-session.js";
import type {
  AgentTurnResult,
  NativeCommandAdmissionResult,
  NativeCommandAdmission,
  NativeCommandReceipt,
  NativeCommandSession,
  NativeCommandSettlement,
  PermissionTransition,
  NativeThreadSettings,
  InferenceJournalRecord,
  NativeRuntimeHandoffQueuedSource,
  NativeAutonomousAttempt,
  NativeGoalRecoverySource,
  NativeGoalRecoveryAdmission,
  NativeGoalRecovery,
  NativeGoalClaimRecovery,
} from "@cantrip/protocol";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import { NativeCommandClient } from "../native-command-client.js";
import { protectNativeCommandContent } from "../native-command-content.js";
import { CantripServerRequestError } from "../cli-client.js";
import type {
  AdmittedNativeExecution,
  PrepareAdmittedNativeExecutionOptions,
} from "./app-server.js";
import type { CodexAppServer } from "./app-server.js";
import type {
  ManagedNativeAdmission,
  ManagedNativeOperation,
  NativeRpcFrame,
} from "./managed-native-gateway.js";
import {
  managedNativeCommandIntent,
  assertManagedAutonomousInput,
  type ManagedNativePolicyContext,
} from "./managed-native-policy.js";

interface Execution {
  inferenceSource: InferenceOperationSource;
  inferenceAbort: AbortController;
  inferenceForwarded?: boolean;
  receipt: NativeCommandReceipt;
  session: NativeCommandSession;
  handle?: AdmittedNativeExecution;
  nativeTurnId?: string;
  nativeTerminalStatus?: "completed" | "failed" | "interrupted";
  nativeDeferred?: boolean;
  durableSuspension?: true;
  suspensionEvidence?: NativeCommandSettlement["suspensionEvidence"];
  retainedDeferred?: Pick<
    NonNullable<NativeCommandSettlement["deferred"]>,
    "retainedPrompt" | "attachments"
  >;
  goalEpoch?: string;
  nativeDecline?: ManagedExecutionDeclined;
  expectedTurnId?: string;
  autonomousAttempt?: NativeAutonomousAttempt;
  goalRecovery?: NativeGoalRecoverySource;
  goalQueueHandoff?: NativeCommandAdmission["goalQueueHandoff"];
  inferenceQueued?: boolean;
  guiPreparation?: boolean;
  logicalRoot?: Pick<
    NativeCommandReceipt,
    "operationId" | "operationGeneration"
  >;
  guiFinished?: boolean;
  logicalFinished?: boolean;
  removeBridgeListener?: () => void;
  released: Promise<void>;
  markReleased(): void;
  routeWithdrawal?: {
    handoffOperationId: string;
    reason: InferenceWithdrawalError;
    proof: Promise<InferenceJournalRecord>;
  };
}
export interface ManagedNativeExecutionPublication {
  options: Omit<
    PrepareAdmittedNativeExecutionOptions,
    "operationGeneration" | "threadId"
  >;
  complete(result: AgentTurnResult): Promise<void>;
  failed(error: unknown): Promise<void>;
  release(): Promise<void>;
}
export interface ManagedNativeCommandSessionOptions {
  identity: ManagedSessionIdentity;
  runtime: Pick<
    CodexAppServer,
    | "prepareAdmittedNativeExecution"
    | "awaitPendingAdmittedNativeReply"
    | "resolveAdmittedNativeReply"
    | "transportGeneration"
    | "resolveManagedExecution"
    | "observeNativeHistory"
    | "withdrawUnstartedInference"
  >;
  client: NativeCommandClient;
  settingsDelivery?: Pick<NativeSettingsDelivery, "track" | "record"> &
    Partial<
      Pick<
        NativeSettingsDelivery,
        "subscribePublished" | "permissionRegistrations"
      >
    >;
  onPermissionApplied?(
    transition: PermissionTransition,
    settings: NativeThreadSettings,
  ): Promise<void> | void;
  onPermissionRejected?(): Promise<void> | void;
  /** Canonical late settlement made deferred input eligible; refresh native
   * permission evidence before the existing publication callback wakes it. */
  onDeferredReady?(): void;
  /** A Goal's canonical reply and physical owner have both finished locally. */
  onGoalSourceSettled?(): void;
  /** Capture and deliver the exact encrypted deferral independently of runtime lifetime. */
  settleDeferred?: NativeCommandClient["settle"];
  /** Commit native continuation and its worker-local source before confirming
   * the existing Pause RPC to either GUI or terminal. No replay on failure. */
  captureSuspension?(input: {
    session: NativeCommandSession;
    turnId: string;
    suspension: NativeTurnSuspension;
  }): Promise<unknown>;
  /** Encrypt the exact unconsumed direct terminal input for the canonical queue. */
  retainDeferredInput?(
    operation: ManagedNativeOperation,
  ): Promise<NonNullable<Execution["retainedDeferred"]>>;
  encryption: Pick<
    WorkerEncryptionService,
    "ownerId" | "serverIdentity" | "componentKey"
  >;
  policy: ManagedNativePolicyContext;
  /** Registers protected publication, interactions, MCP binding and CUA for this exact grant. */
  beginExecution(
    grant: NativeCommandAdmissionResult,
    session: NativeCommandSession,
  ): Promise<ManagedNativeExecutionPublication>;
  /** Runs after durable dispatch and before the exact native mutation, e.g. cancelling an autonomous gate before Stop. */
  beforeNativeDispatch?(
    method: string,
    session: NativeCommandSession,
    intent?: {
      resumeAutonomy?: boolean;
      goalStatus?: "active" | "paused";
      paused?: boolean;
    },
  ): Promise<void>;
  /** Correlation-only diagnostics. Never log native frames or protected plaintext here. */
  onError(error: unknown, operationId: string): void;
}

const object = (value: unknown): value is NativeRpcFrame =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Shares the current admitted root across GUI and all attached terminal views. */
export class ManagedNativeCommandSession {
  private active: Execution | null = null;
  private readonly goalRecoveryObservers = new Set<() => void>();
  private readonly pendingGoalOperations = new Map<string, Promise<void>>();
  private revoked = false;
  private goalMutationSettlement: Promise<void> | null = null;
  private goalMutationResponse: Promise<void> | null = null;
  private readonly expectedActivation = new AsyncLocalStorage<{
    generation: string | null;
  }>();

  get currentActivationGeneration(): string | null {
    return this.active?.receipt.activationGeneration ?? null;
  }

  isGoalOperationSettling(
    operationId: string,
    operationGeneration: string,
  ): boolean {
    return this.pendingGoalOperations.has(
      JSON.stringify([operationId, operationGeneration]),
    );
  }

  private async awaitGoalSettlements(signal: AbortSignal): Promise<void> {
    while (this.pendingGoalOperations.size) {
      signal.throwIfAborted();
      let aborted!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
      try {
        await Promise.race([
          Promise.all(this.pendingGoalOperations.values()),
          cancelled,
        ]);
      } finally {
        signal.removeEventListener("abort", aborted);
      }
    }
    signal.throwIfAborted();
  }

  goalRecoveryAdmission(
    source: NativeGoalRecoverySource,
  ): Omit<NativeGoalRecoveryAdmission, "workerGeneration"> | null {
    const execution = this.active;
    if (
      this.revoked ||
      !execution ||
      execution.inferenceAbort.signal.aborted ||
      execution.session.runtimeGeneration !==
        this.options.runtime.transportGeneration ||
      !isDeepStrictEqual(execution.goalRecovery, source)
    )
      return null;
    return {
      operationId: execution.receipt.operationId,
      operationGeneration: execution.receipt.operationGeneration,
    };
  }

  /** Observe actual canonical ownership before waiting for capacity. This
   * deadline removes only the control observer, never the durable Goal source. */
  waitForGoalRecoveryAdmission(
    source: NativeGoalRecoverySource,
    signal?: AbortSignal,
  ) {
    return this.waitForGoalAdmission(
      () => this.goalRecoveryAdmission(source),
      signal,
    );
  }

  goalClaimAdmission(
    claim: NativeGoalClaimRecovery,
  ): Omit<NativeGoalRecoveryAdmission, "workerGeneration"> | null {
    const execution = this.active;
    const handoff = execution?.goalQueueHandoff;
    if (
      this.revoked ||
      !execution?.inferenceQueued ||
      !handoff ||
      execution.inferenceAbort.signal.aborted ||
      execution.session.runtimeGeneration !==
        this.options.runtime.transportGeneration ||
      handoff.claimId !== claim.claimId ||
      handoff.operationId !== claim.operationId ||
      handoff.operationGeneration !== claim.operationGeneration ||
      handoff.goalEpoch !== claim.goalEpoch
    )
      return null;
    return {
      operationId: execution.receipt.operationId,
      operationGeneration: execution.receipt.operationGeneration,
    };
  }

  waitForGoalClaimAdmission(
    claim: NativeGoalClaimRecovery,
    signal?: AbortSignal,
  ) {
    return this.waitForGoalAdmission(
      () => this.goalClaimAdmission(claim),
      signal,
    );
  }

  private waitForGoalAdmission(
    read: () => Omit<NativeGoalRecoveryAdmission, "workerGeneration"> | null,
    signal?: AbortSignal,
  ) {
    return new Promise<Omit<NativeGoalRecoveryAdmission, "workerGeneration">>(
      (resolve, reject) => {
        const cleanup = () => {
          clearTimeout(deadline);
          this.goalRecoveryObservers.delete(observe);
          signal?.removeEventListener("abort", aborted);
        };
        const aborted = () => {
          cleanup();
          reject(
            signal?.reason ??
              new Error("Goal recovery observation was cancelled."),
          );
        };
        const observe = () => {
          const admitted = read();
          if (admitted) {
            cleanup();
            resolve(admitted);
          } else if (this.revoked) {
            cleanup();
            reject(new Error("The native resource was removed."));
          }
        };
        const deadline = setTimeout(() => {
          cleanup();
          reject(new Error("Goal recovery admission remains unconfirmed."));
        }, 8_000);
        deadline.unref();
        this.goalRecoveryObservers.add(observe);
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
        else observe();
      },
    );
  }

  /** Seal admission without claiming that its native execution has stopped. */
  revoke(): void {
    this.revoked = true;
    for (const observe of this.goalRecoveryObservers) observe();
    this.active?.inferenceAbort.abort(
      new Error("The native resource was removed."),
    );
  }

  assertActivationGeneration(expected: string | null): void {
    if (this.currentActivationGeneration !== expected)
      throw new Error("The native control belongs to a replaced activation.");
  }

  withExpectedActivationGeneration<T>(
    expected: string | null,
    dispatch: () => Promise<T>,
  ): Promise<T> {
    this.assertActivationGeneration(expected);
    return this.expectedActivation.run({ generation: expected }, dispatch);
  }
  private readonly settings: ManagedNativeSettings | null;
  constructor(private readonly options: ManagedNativeCommandSessionOptions) {
    this.settings = options.settingsDelivery
      ? new ManagedNativeSettings({
          runtime: options.runtime,
          delivery: options.settingsDelivery,
          onError: options.onError,
          onPermissionApplied: async (scope, transition, settings) => {
            if (options.runtime.transportGeneration !== scope.runtimeGeneration)
              return;
            options.policy.permissionProfileId = transition.effectiveId;
            options.policy.security = {
              ...nativePermissionPatch(transition.effectiveId),
              sandboxPolicy: settings.sandboxPolicy,
            };
            await options.onPermissionApplied?.(transition, settings);
          },
          onPermissionRejected: async (scope) => {
            if (options.runtime.transportGeneration !== scope.runtimeGeneration)
              return;
            await options.onPermissionRejected?.();
          },
        })
      : null;
  }

  async recoverPermissions(
    input: Parameters<ManagedNativeSettings["recoverPermissions"]>[0],
  ): Promise<void> {
    if (!this.settings)
      throw new Error("Managed permission recovery is unavailable.");
    await this.settings.recoverPermissions(input);
  }

  private createExecution(
    receipt: NativeCommandReceipt,
    session: NativeCommandSession,
  ): Execution {
    let markReleased!: () => void;
    const released = new Promise<void>((resolve) => {
      markReleased = resolve;
    });
    const inferenceAbort = new AbortController();
    const execution: Execution = {
      receipt,
      session,
      released,
      markReleased,
      inferenceAbort,
      inferenceSource: Object.freeze({
        operationId: receipt.operationGeneration,
        nativeTransportGeneration: session.runtimeGeneration,
        signal: inferenceAbort.signal,
        released,
        assertCurrent: () => {
          if (
            this.active !== execution ||
            execution.guiFinished ||
            execution.logicalFinished ||
            execution.receipt.operationGeneration !==
              receipt.operationGeneration
          )
            throw new Error(
              "The canonical native execution no longer owns inference preparation.",
            );
          execution.inferenceAbort.signal.throwIfAborted();
          this.assertTransport(session);
        },
      }),
    };
    return execution;
  }

  /** Waits for the actual current publication/lane cleanup, without serializing controls. */
  async awaitExecutionReleased(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    for (;;) {
      const execution = this.active;
      if (!execution) return;
      if (!signal) await execution.released;
      else
        await new Promise<void>((resolve, reject) => {
          const aborted = () => {
            cleanup();
            reject(
              signal.reason ?? new Error("The native runner was invalidated."),
            );
          };
          const cleanup = () => signal.removeEventListener("abort", aborted);
          signal.addEventListener("abort", aborted, { once: true });
          void execution.released.then(
            () => {
              cleanup();
              resolve();
            },
            (error) => {
              cleanup();
              reject(error);
            },
          );
          if (signal.aborted) aborted();
        });
      signal?.throwIfAborted();
      // A GUI retry may have synchronously joined its next admitted attempt.
      // Follow that actual release promise rather than waking against its lane.
    }
  }

  /** Waits for the actual goal/set RPC receipt to be durably settled before correlating its first native attempt. */
  async awaitGoalMutationSettled(signal: AbortSignal): Promise<void> {
    const pending = this.goalMutationSettlement;
    signal.throwIfAborted();
    if (!pending) return;
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => signal.removeEventListener("abort", aborted);
      signal.addEventListener("abort", aborted, { once: true });
      void pending.then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
      if (signal.aborted) aborted();
    });
    signal.throwIfAborted();
  }

  private clearExecution(execution: Execution): void {
    if (this.active === execution) this.active = null;
    execution.removeBridgeListener?.();
    execution.removeBridgeListener = undefined;
    execution.inferenceAbort.abort(
      new Error("Canonical inference ownership ended."),
    );
    execution.markReleased();
  }

  private assertTransport(session: NativeCommandSession) {
    if (this.revoked) throw new Error("The native resource was removed.");
    if (
      !session.runtimeGeneration ||
      this.options.runtime.transportGeneration !== session.runtimeGeneration
    ) {
      throw new Error(
        "The native transport was replaced before command dispatch.",
      );
    }
  }

  private protected(
    receipt: NativeCommandReceipt,
    content: unknown,
    direction: "request" | "result" | "terminal-result",
    chatId: string,
  ) {
    return protectNativeCommandContent({
      service: this.options.encryption,
      context: { chatId, operationId: receipt.operationId, direction },
      content,
    });
  }

  private async persistResult(
    execution: Execution,
    content: unknown,
    status: "applied" | "rejected" | "uncertain",
    complete = false,
    executionStatus: "idle" | "failed" = "idle",
    terminal = false,
  ) {
    const protectedContent =
      content === null
        ? null
        : await this.protected(
            execution.receipt,
            content,
            terminal ? "terminal-result" : "result",
            execution.session.chatId,
          );
    const settlementInput: Omit<NativeCommandSettlement, "workerId"> = {
      operationId: execution.receipt.operationId,
      operationGeneration: execution.receipt.operationGeneration,
      status,
      ...(execution.durableSuspension
        ? { durableSuspension: true as const }
        : {}),
      ...(execution.suspensionEvidence
        ? { suspensionEvidence: execution.suspensionEvidence }
        : {}),
      resultDigest: terminal ? null : (protectedContent?.digest ?? null),
      protectedResult: terminal ? null : (protectedContent?.envelope ?? null),
      ...(terminal
        ? {
            terminalResult: {
              resultDigest: protectedContent?.digest ?? null,
              protectedResult: protectedContent?.envelope ?? null,
            },
          }
        : {}),
      rejectionCode:
        status === "rejected"
          ? execution.nativeDeferred
            ? "native-settings-pending"
            : "native-request-rejected"
          : null,
      executionComplete: complete,
      ...(!terminal && execution.goalEpoch
        ? { goalEpoch: execution.goalEpoch }
        : {}),
      ...(complete ? { executionStatus } : {}),
      ...(execution.nativeDeferred && complete && !terminal
        ? {
            deferred: {
              reason: "pendingSettings" as const,
              inputConsumed: false as const,
              threadId: execution.session.threadId!,
              runtimeGeneration: execution.session.runtimeGeneration!,
              ...execution.retainedDeferred,
            },
          }
        : {}),
      ...(terminal &&
      execution.nativeDecline &&
      execution.session.runtimeGeneration
        ? {
            decline: {
              nativeTurnId: execution.nativeDecline.turnId,
              runtimeGeneration: execution.session.runtimeGeneration,
              runnerGeneration: execution.nativeDecline.runnerGeneration,
              attemptId: execution.nativeDecline.attemptId,
            },
          }
        : execution.receipt.startsExecution &&
            execution.nativeTurnId &&
            execution.session.runtimeGeneration
          ? {
              reconciliation: {
                nativeTurnId: execution.nativeTurnId,
                runtimeGeneration: execution.session.runtimeGeneration,
                ...(execution.nativeTerminalStatus
                  ? { terminalStatus: execution.nativeTerminalStatus }
                  : {}),
              },
            }
          : {}),
    };
    const settlement = await (settlementInput.deferred &&
    this.options.settleDeferred
      ? this.options.settleDeferred(settlementInput)
      : this.options.client.settle(settlementInput));
    if (
      execution.nativeDeferred &&
      complete &&
      settlement?.receipt?.resumeQueue
    ) {
      try {
        this.options.onDeferredReady?.();
      } catch (error) {
        this.options.onError(error, execution.receipt.operationId);
      }
    }
  }

  private async bindGuiPreparation(
    receipt: NativeCommandReceipt,
    session: NativeCommandSession,
  ): Promise<{ execution: Execution; created: boolean }> {
    this.assertTransport(session);
    if (session.connectionId !== `gui:${receipt.operationGeneration}`)
      throw new Error(
        "GUI preparation must use its eventual dispatch connection identity.",
      );
    const previous = this.active;
    if (
      previous &&
      previous.receipt.operationGeneration !== receipt.operationGeneration
    )
      throw new Error("Another native execution owns this managed session.");
    const bound = await this.options.client.bindPreparation({
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      payloadDigest: receipt.payloadDigest,
      session,
    });
    this.assertTransport(session);
    if (
      this.active !== previous ||
      bound.receipt.operationGeneration !== receipt.operationGeneration
    )
      throw new Error("The GUI preparation belongs to a replaced execution.");
    const execution = previous ?? this.createExecution(bound.receipt, session);
    if (!previous) execution.guiPreparation = true;
    this.active = execution;
    return { execution, created: !previous };
  }

  /** Metadata-only preparation releases a temporary owner when it finishes. */
  async withGuiPreparation<T>(
    receipt: NativeCommandReceipt,
    session: NativeCommandSession,
    callback: () => Promise<T>,
  ): Promise<T> {
    const { execution, created } = await this.bindGuiPreparation(
      receipt,
      session,
    );
    try {
      return await this.withExpectedActivationGeneration(
        execution.receipt.activationGeneration,
        callback,
      );
    } finally {
      if (created && execution.guiPreparation) this.clearExecution(execution);
    }
  }

  /** Retain the exact source while the existing handoff records its deferral. */
  withdrawQueuedInference(
    handoffOperationId: string,
    expected: Pick<
      NativeRuntimeHandoffQueuedSource,
      "operationId" | "operationGeneration" | "autonomousAttempt"
    >,
    existingOnly = false,
  ): Promise<InferenceJournalRecord> {
    const execution = this.active;
    if (
      !execution ||
      execution.receipt.operationId !== expected.operationId ||
      execution.receipt.operationGeneration !== expected.operationGeneration ||
      (expected.autonomousAttempt
        ? !isDeepStrictEqual(
            execution.autonomousAttempt,
            expected.autonomousAttempt,
          )
        : execution.logicalRoot?.operationId !== expected.operationId ||
          execution.logicalRoot.operationGeneration !==
            expected.operationGeneration)
    )
      throw new UnstartedInferenceUnavailableError(
        "The reserved queued input is no longer owned by this session.",
      );
    if (execution.routeWithdrawal) {
      if (execution.routeWithdrawal.handoffOperationId !== handoffOperationId)
        throw new Error("Another handoff owns this input's withdrawal.");
      return execution.routeWithdrawal.proof;
    }
    if (existingOnly)
      throw new UnstartedInferenceUnavailableError(
        "This handoff has not withdrawn the current input.",
      );
    if (execution.inferenceForwarded)
      throw new UnstartedInferenceUnavailableError(
        "The reserved input has already been forwarded.",
      );
    this.assertTransport(execution.session);
    const reason = new InferenceWithdrawalError();
    const proof = this.options.runtime.withdrawUnstartedInference(
      execution.inferenceSource,
      reason,
    );
    execution.routeWithdrawal = { handoffOperationId, reason, proof };
    return proof;
  }

  withdrawGuiInference(
    handoffOperationId: string,
    expected: { operationId: string; operationGeneration: string },
    existingOnly = false,
  ): Promise<InferenceJournalRecord> {
    return this.withdrawQueuedInference(
      handoffOperationId,
      expected,
      existingOnly,
    );
  }

  acknowledgeQueuedWithdrawal(handoffOperationId: string): void {
    const withdrawal = this.active?.routeWithdrawal;
    if (withdrawal?.handoffOperationId === handoffOperationId)
      withdrawal.reason.acknowledge();
  }

  acknowledgeGuiWithdrawal(handoffOperationId: string): void {
    this.acknowledgeQueuedWithdrawal(handoffOperationId);
  }

  /** Bind the actual accepted GUI command before it competes for capacity. */
  async prepareGuiInference(
    receipt: NativeCommandReceipt,
    session: NativeCommandSession,
    logicalRoot: Pick<
      NativeCommandReceipt,
      "operationId" | "operationGeneration"
    > = receipt,
    bridgeSignal?: AbortSignal,
  ): Promise<InferenceOperationSource> {
    bridgeSignal?.throwIfAborted();
    const { execution } = await this.bindGuiPreparation(receipt, session);
    if (
      execution.logicalRoot &&
      (execution.logicalRoot.operationId !== logicalRoot.operationId ||
        execution.logicalRoot.operationGeneration !==
          logicalRoot.operationGeneration)
    )
      throw new Error(
        "The GUI preparation belongs to another logical command.",
      );
    execution.logicalRoot = { ...logicalRoot };
    // Transfer a temporary preparation owner to the complete GUI operation.
    // A concurrent metadata helper must not release it in its finally block.
    execution.guiPreparation = false;
    this.bindGuiBridge(execution, bridgeSignal);
    execution.inferenceSource.assertCurrent();
    return execution.inferenceSource;
  }

  /** GUI admission already occurred on the server; join the same local generation. */
  async dispatchGui(
    receipt: NativeCommandReceipt,
    session: NativeCommandSession,
    logicalRoot: Pick<
      NativeCommandReceipt,
      "operationId" | "operationGeneration"
    > = receipt,
    bridgeSignal?: AbortSignal,
  ): Promise<void> {
    bridgeSignal?.throwIfAborted();
    this.assertTransport(session);
    if (
      this.active &&
      this.active.receipt.operationGeneration !== receipt.operationGeneration
    ) {
      throw new Error("Another native execution owns this managed session.");
    }
    const execution = this.active ?? this.createExecution(receipt, session);
    execution.guiPreparation = false;
    execution.logicalRoot = {
      operationId: logicalRoot.operationId,
      operationGeneration: logicalRoot.operationGeneration,
    };
    this.active = execution;
    this.bindGuiBridge(execution, bridgeSignal);
    // A transport failure may follow a dispatch commit. Retain the owner until
    // normal physical/logical settlement or an authorized continuation replaces it.
    await this.options.client.dispatch({
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      payloadDigest: receipt.payloadDigest,
      session,
    });
    bridgeSignal?.throwIfAborted();
  }

  private bindGuiBridge(
    execution: Execution,
    bridgeSignal?: AbortSignal,
  ): void {
    if (bridgeSignal) {
      execution.removeBridgeListener?.();
      const aborted = () => this.clearExecution(execution);
      bridgeSignal.addEventListener("abort", aborted, { once: true });
      execution.removeBridgeListener = () =>
        bridgeSignal.removeEventListener("abort", aborted);
      if (bridgeSignal.aborted) aborted();
    }
  }

  /** Adopts an already admitted continuation without forwarding its native turn. */
  adoptGuiContinuation(
    previousGeneration: string | null,
    receipt: NativeCommandReceipt,
    session: NativeCommandSession,
    logicalRoot: Pick<
      NativeCommandReceipt,
      "operationId" | "operationGeneration"
    >,
    bridgeSignal?: AbortSignal,
  ): InferenceOperationSource {
    bridgeSignal?.throwIfAborted();
    this.assertTransport(session);
    const previous = this.active;
    if (
      (previous?.receipt.operationGeneration ?? null) !== previousGeneration ||
      (previous &&
        (previous.logicalRoot?.operationId !== logicalRoot.operationId ||
          previous.logicalRoot.operationGeneration !==
            logicalRoot.operationGeneration)) ||
      receipt.operationGeneration === previousGeneration ||
      receipt.status !== "accepted" ||
      !receipt.startsExecution
    )
      throw new Error(
        "The GUI continuation no longer owns its previous logical attempt.",
      );
    const execution = this.createExecution(receipt, session);
    execution.logicalRoot = { ...logicalRoot };
    this.active = execution;
    this.bindGuiBridge(execution, bridgeSignal);
    if (previous) this.clearExecution(previous);
    return execution.inferenceSource;
  }

  /** Local CUA/publication cleanup is finished; the server still owns logical persistence. */
  markGuiFinished(
    rootOperationId: string,
    rootOperationGeneration: string,
  ): void {
    this.finishGui(rootOperationId, rootOperationGeneration, "physical");
  }

  /** Called only for the authenticated server acknowledgment after logical lane finish commits. */
  completeGuiLogical(
    rootOperationId: string,
    rootOperationGeneration: string,
  ): void {
    this.finishGui(rootOperationId, rootOperationGeneration, "logical");
  }

  private finishGui(
    rootOperationId: string,
    rootOperationGeneration: string,
    phase: "physical" | "logical",
  ): void {
    const execution = this.active;
    if (
      !execution ||
      execution.logicalRoot?.operationId !== rootOperationId ||
      execution.logicalRoot.operationGeneration !== rootOperationGeneration
    )
      return;
    if (phase === "physical") execution.guiFinished = true;
    else execution.logicalFinished = true;
    // Canonical or physical completion ends new preparation immediately. Keep
    // the owner itself until both phases settle, so redelivery cannot remint it.
    execution.inferenceAbort.abort(
      new Error("The GUI inference operation has finished."),
    );
    if (execution.guiFinished && execution.logicalFinished)
      this.clearExecution(execution);
  }

  async guiReceipt(
    receipt: NativeCommandReceipt,
    session: NativeCommandSession,
    result: unknown,
  ) {
    const execution =
      this.active?.receipt.operationGeneration === receipt.operationGeneration
        ? this.active
        : this.createExecution(receipt, session);
    if (
      object(result) &&
      object(result.turn) &&
      typeof result.turn.id === "string"
    )
      execution.nativeTurnId = result.turn.id;
    await this.persistResult(execution, result, "applied");
  }

  /** Native terminal proof precedes the GUI's separate logical/publication
   * cleanup. A transport failure must never call this with an invented status. */
  async guiTerminal(
    receipt: NativeCommandReceipt,
    session: NativeCommandSession,
    turnId: string,
    terminalStatus: "completed" | "failed" | "interrupted",
  ): Promise<void> {
    this.assertTransport(session);
    await this.options.client.settle({
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      status: "applied",
      resultDigest: null,
      protectedResult: null,
      rejectionCode: null,
      executionComplete: false,
      reconciliation: {
        nativeTurnId: turnId,
        runtimeGeneration: session.runtimeGeneration!,
        terminalStatus,
      },
    });
  }

  /** A rejected physical attempt can retain the logical GUI message only when
   * native explicitly proves that no input was consumed. Never infer from a
   * timeout, a status label, or the absence of a turn-start notification. */
  async guiDeferred(
    receipt: NativeCommandReceipt,
    session: NativeCommandSession,
    frame: unknown,
    retained: Pick<
      NonNullable<NativeCommandSettlement["deferred"]>,
      "retainedPrompt" | "attachments"
    >,
  ): Promise<void> {
    const execution = this.active;
    if (
      !execution ||
      execution.receipt.operationId !== receipt.operationId ||
      execution.receipt.operationGeneration !== receipt.operationGeneration ||
      execution.session.threadId !== session.threadId ||
      execution.session.runtimeGeneration !== session.runtimeGeneration ||
      execution.nativeTurnId ||
      !session.threadId ||
      !session.runtimeGeneration ||
      !isNativePermissionDeferred(receipt.method, frame)
    )
      throw new Error(
        "The GUI input has no matching native deferral evidence.",
      );
    execution.nativeDeferred = true;
    execution.retainedDeferred = retained;
    await this.persistResult(execution, frame, "rejected", true, "idle");
  }

  releaseGui(operationGeneration: string) {
    if (this.active?.receipt.operationGeneration === operationGeneration)
      this.clearExecution(this.active);
  }

  async admitAutonomousAttempt(
    attempt: ManagedExecutionAttempt,
    session: NativeCommandSession,
    signal: AbortSignal,
    goalQueueHandoff?: NativeCommandAdmission["goalQueueHandoff"],
    goalRecovery?: NativeGoalRecovery,
  ): Promise<void> {
    if (
      session.threadId !== attempt.threadId ||
      !session.runtimeGeneration ||
      attempt.trigger !== "goal"
    )
      throw new Error(
        "The native attempt does not belong to this managed session.",
      );
    await this.awaitExecutionReleased(signal);
    // Physical release can precede the canonical negative receipt. A fresh
    // cycle must let that receipt preserve its original FIFO identity first;
    // unrelated chats and control commands remain free to proceed.
    await this.awaitGoalSettlements(signal);
    signal.throwIfAborted();
    this.assertTransport(session);
    const operation: ManagedNativeOperation = {
      operationId: `native:${attempt.runnerGeneration}:${attempt.attemptId}`,
      origin: "autonomous",
      identity: {
        ...this.options.identity,
        threadId: attempt.threadId,
        runtimeGeneration: session.runtimeGeneration,
        modelRouteId: session.modelRouteId,
        providerAccountId: session.providerAccountId,
      },
      connectionId: session.connectionId,
      kind: "start",
      method: "turn/start",
      expectedTurnId: attempt.turnId,
      autonomousAttempt: {
        runnerGeneration: attempt.runnerGeneration,
        attemptId: attempt.attemptId,
        turnId: attempt.turnId,
        trigger: "goal",
        ...(attempt.goalEpoch ? { goalEpoch: attempt.goalEpoch } : {}),
      },
      ...(goalQueueHandoff ? { goalQueueHandoff } : {}),
      ...(goalRecovery
        ? {
            goalRecovery: goalRecovery.source,
            goalRecoveryOrderEpoch: goalRecovery.orderEpoch ?? 0,
          }
        : {}),
      frame: {
        method: "turn/start",
        params: { threadId: attempt.threadId },
        nativeAttempt: attempt,
      },
    };
    await assertManagedAutonomousInput(
      attempt.input,
      operation,
      this.options.policy,
    );
    const admission = await this.admit(operation, signal);
    try {
      signal.throwIfAborted();
      await admission.beforeForward();
      signal.throwIfAborted();
    } catch (error) {
      await admission.settle({
        error: {
          code: -32000,
          message: "The native attempt was not dispatched.",
        },
      });
      // The actual native gate was fenced before canonical deferral. There is
      // no turn to fail or replay, and the Goal remains eligible after transfer.
      if (error instanceof InferenceWithdrawalError) return;
      throw error;
    }
    let result: unknown;
    try {
      result = await this.options.runtime.resolveManagedExecution(
        {
          threadId: attempt.threadId,
          runnerGeneration: attempt.runnerGeneration,
          attemptId: attempt.attemptId,
          operationGeneration: admission.operationGeneration,
          allow: true,
        },
        session.runtimeGeneration,
      );
    } catch (error) {
      await admission.settle(
        error instanceof CodexNativeRpcError
          ? { error: error.nativeError }
          : null,
      );
      throw error;
    }
    await admission.settle({ result });
  }

  declineAutonomousAttempt(event: ManagedExecutionDeclined): void {
    const execution = this.active;
    if (
      !execution ||
      execution.receipt.operationGeneration !== event.operationGeneration ||
      execution.session.threadId !== event.threadId ||
      execution.expectedTurnId !== event.turnId ||
      execution.receipt.operationId !==
        `native:${event.runnerGeneration}:${event.attemptId}`
    )
      return;
    if (execution.routeWithdrawal) return;
    execution.nativeDecline = { ...event };
    execution.handle?.rejectInference?.();
    execution.handle?.fail(new Error(event.reason));
  }

  async executeGuiCommand(
    session: NativeCommandSession,
    command: ManagedNativeGuiCommand,
  ): Promise<unknown> {
    if (!session.threadId || !session.runtimeGeneration)
      throw new Error("The GUI command has no native session identity.");
    const kind = command.reply
      ? "reply"
      : managedNativeMethods.get(command.method);
    if (!kind || kind === "read")
      throw new Error("The GUI command is not an admitted native mutation.");
    const operationId = command.operationId ?? randomUUID();
    const operation: ManagedNativeOperation = {
      operationId,
      ...(command.goalObjectiveOnly ? { goalObjectiveOnly: true } : {}),
      ...(command.settingsBindingId === undefined
        ? {}
        : { settingsBindingId: command.settingsBindingId }),
      ...(command.permissionTransition
        ? { permissionTransition: command.permissionTransition }
        : {}),
      ...(command.queueClaim ? { queueClaim: command.queueClaim } : {}),
      origin: "gui",
      identity: {
        ...this.options.identity,
        threadId: session.threadId,
        runtimeGeneration: session.runtimeGeneration,
        modelRouteId: session.modelRouteId,
        providerAccountId: session.providerAccountId,
      },
      connectionId: session.connectionId,
      kind,
      method: command.method,
      frame: command.reply
        ? { id: command.reply.requestId, ...command.params }
        : { id: operationId, method: command.method, params: command.params },
      ...(command.reply
        ? {
            reply: {
              nativeRequestId: command.reply.requestId,
              requestMethod: command.reply.requestMethod,
              turnId: command.reply.turnId,
            },
          }
        : {}),
    };
    const admission = await this.admit(operation);
    try {
      await admission.beforeForward();
    } catch (error) {
      await admission.settle({
        error: { code: -32000, message: "Native dispatch did not complete." },
      });
      throw error;
    }
    let result: unknown;
    try {
      result = await command.dispatch(admission.forward);
    } catch (error) {
      await admission.settle(
        error instanceof CodexNativeRpcError
          ? { error: error.nativeError }
          : null,
      );
      throw error;
    }
    await admission.settle({ result });
    return result;
  }

  async admit(
    operation: ManagedNativeOperation,
    inferenceSignal?: AbortSignal,
  ): Promise<ManagedNativeAdmission> {
    let forward: ManagedNativeAdmission["forward"];
    if (
      operation.method === "thread/settings/update" &&
      object(operation.frame.params) &&
      operation.frame.params.operationId === undefined
    ) {
      forward = {
        method: operation.method,
        params: {
          ...operation.frame.params,
          operationId: operation.operationId,
        },
      };
      // Admit and encrypt the exact normalized frame that will reach native.
      operation = { ...operation, frame: { ...operation.frame, ...forward } };
    }
    const session: NativeCommandSession = {
      chatId: operation.identity.chatId,
      threadId: operation.identity.threadId,
      contextKind: operation.identity.contextKind,
      projectId: operation.identity.projectId,
      placementId: operation.identity.placementId,
      runtimeGeneration: operation.identity.runtimeGeneration,
      modelRouteId: operation.identity.modelRouteId,
      providerAccountId: operation.identity.providerAccountId,
      connectionId: operation.connectionId,
    };
    this.assertTransport(session);
    if (
      operation.method === "thread/settings/update" &&
      object(operation.frame.params) &&
      hasNativePermissionUpdate(operation.frame.params)
    ) {
      if (!operation.permissionTransition) {
        const selectedId = requestedNativePermissionProfile(
          operation.frame.params,
          this.options.policy.security,
        );
        const resolved = await this.options.client
          .resolvePermissionTransition(session, selectedId)
          .catch(async (error) => {
            if (
              !(error instanceof CantripServerRequestError) ||
              error.code !== "permission-binding-required"
            )
              throw error;
            // Establish the missing source from an actual native settings read.
            // No request has been admitted or dispatched, so keep its identity.
            await this.options.client.refreshSettings(session.chatId);
            this.assertTransport(session);
            return this.options.client.resolvePermissionTransition(
              session,
              selectedId,
            );
          });
        this.assertTransport(session);
        operation = {
          ...operation,
          permissionTransition: resolved.permissionTransition,
          ...(resolved.bindingId
            ? { settingsBindingId: resolved.bindingId }
            : {}),
        };
      }
      forward = {
        method: operation.method,
        params: applyNativePermissionTransition(
          operation.frame.params as Record<string, unknown>,
          operation.permissionTransition!,
        ),
      };
      operation = { ...operation, frame: { ...operation.frame, ...forward } };
    }
    const intent = await managedNativeCommandIntent(
      operation,
      this.options.policy,
    );
    if (operation.expectedTurnId)
      intent.expectedTurnId = operation.expectedTurnId;
    if (
      this.options.captureSuspension &&
      ["turn/pause", "turn/interrupt"].includes(operation.method)
    ) {
      const params = object(operation.frame.params)
        ? operation.frame.params
        : null;
      if (typeof params?.turnId !== "string")
        throw new Error("The controlled native turn identity is missing.");
      intent.durableSuspension = true;
      intent.expectedTurnId = params.turnId;
    }
    if (operation.autonomousAttempt)
      intent.autonomousAttempt = operation.autonomousAttempt;
    if (operation.goalRecovery) {
      intent.goalRecovery = operation.goalRecovery;
      intent.goalRecoveryOrderEpoch = operation.goalRecoveryOrderEpoch ?? 0;
    }
    if (operation.settingsBindingId !== undefined)
      intent.settingsBindingId = operation.settingsBindingId;
    const protectedContent = await protectNativeCommandContent({
      service: this.options.encryption,
      context: {
        chatId: session.chatId,
        operationId: operation.operationId,
        direction: "request",
      },
      content: operation.frame,
    });
    const root = this.active;
    const expected = this.expectedActivation.getStore();
    if (expected) this.assertActivationGeneration(expected.generation);
    if (operation.reply) {
      if (!root)
        throw new Error("The native reply has no active admitted execution.");
      const pending =
        await this.options.runtime.awaitPendingAdmittedNativeReply({
          operationGeneration: root.receipt.operationGeneration,
          rootThreadId: operation.identity.threadId,
          requestId: operation.reply.nativeRequestId,
        });
      if (this.active !== root || !root.receipt.activationGeneration)
        throw new Error("The native reply belongs to a replaced execution.");
      await this.options.client.pending({
        session,
        activationGeneration: root.receipt.activationGeneration,
        nativeRequestId: `${typeof operation.reply.nativeRequestId}:${operation.reply.nativeRequestId}`,
        requestMethod: operation.reply.requestMethod,
        turnId: pending.turnId,
      });
    }
    const grant = await this.options.client.admit(
      {
        operationId: operation.operationId,
        origin: operation.origin,
        session,
        method: operation.reply ? "serverRequest/reply" : operation.method,
        intent,
        protectedPayload: protectedContent.envelope,
        payloadDigest: protectedContent.digest,
        ...(operation.queueClaim ? { queueClaim: operation.queueClaim } : {}),
        ...(operation.goalQueueHandoff
          ? { goalQueueHandoff: operation.goalQueueHandoff }
          : {}),
        expectedActivationGeneration:
          root?.receipt.activationGeneration ?? null,
        ...(operation.reply
          ? {
              reply: {
                ...operation.reply,
                nativeRequestId: `${typeof operation.reply.nativeRequestId}:${operation.reply.nativeRequestId}`,
              },
            }
          : {}),
      },
      operation.origin === "autonomous" &&
        operation.autonomousAttempt?.goalEpoch
        ? { continueUnobservedGoalAdmission: true }
        : undefined,
    );
    if (grant.replayed && !grant.continuedAdmission)
      throw new Error(
        `Native command ${grant.receipt.operationId} is already ${grant.receipt.status}; its mutation will not be replayed.`,
      );
    if (grant.receipt.status !== "accepted")
      throw new Error(
        `Native command admission rejected: ${grant.receipt.rejectionCode ?? grant.receipt.status}`,
      );
    if (
      operation.method === "turn/pause" &&
      intent.paused === true &&
      this.options.captureSuspension
    ) {
      const params = object(operation.frame.params)
        ? operation.frame.params
        : null;
      if (!session.threadId || typeof params?.turnId !== "string")
        throw new Error("The paused native turn identity is missing.");
      forward = {
        method: "turn/suspension",
        params: {
          threadId: session.threadId,
          operation: { type: "pause", turnId: params.turnId },
        },
      };
    }
    const execution = this.createExecution(grant.receipt, session);
    execution.durableSuspension = intent.durableSuspension;
    execution.expectedTurnId = operation.expectedTurnId;
    execution.autonomousAttempt = operation.autonomousAttempt;
    execution.goalRecovery = operation.goalRecovery;
    execution.goalQueueHandoff = operation.goalQueueHandoff;
    let publication: ManagedNativeExecutionPublication | null = null;
    let acceptance: Promise<void> = Promise.resolve();
    let resolveReceipt!: () => void;
    const receiptObserved = new Promise<void>((resolve) => {
      resolveReceipt = resolve;
    });
    if (
      operation.origin === "autonomous" &&
      operation.autonomousAttempt?.goalEpoch
    ) {
      const key = JSON.stringify([
        grant.receipt.operationId,
        grant.receipt.operationGeneration,
      ]);
      const completion = Promise.all([receiptObserved, execution.released])
        .then(() => {})
        .finally(() => {
          this.pendingGoalOperations.delete(key);
          this.options.onGoalSourceSettled?.();
        })
        .catch(() => {});
      this.pendingGoalOperations.set(key, completion);
    }
    let resolveNativeResponse!: () => void;
    const nativeResponseObserved = new Promise<void>((resolve) => {
      resolveNativeResponse = resolve;
    });
    let nativeAcceptance: "applied" | "rejected" | "uncertain" = "rejected";
    const start = grant.receipt.startsExecution;
    let released: Promise<void> | undefined;
    const releasePublication = () =>
      (released ??= publication?.release() ?? Promise.resolve());
    let settlement: Promise<void> | undefined;
    let cancelledWaitingRoot: Execution | null = null;
    const assertRootCurrent = () => {
      if (expected) this.assertActivationGeneration(expected.generation);
      if (
        !start &&
        root &&
        this.active !== root &&
        !(cancelledWaitingRoot === root && this.active === null)
      )
        throw new Error("The native mutation belongs to a replaced execution.");
    };
    const awaitWithdrawal = async (): Promise<never> => {
      const { reason } = execution.routeWithdrawal!;
      try {
        // Native gate invalidation may retire its pending request. Only this
        // exact source's explicit cancellation can interrupt its ACK barrier.
        await reason.wait(execution.inferenceAbort.signal);
      } catch (error) {
        if (!execution.inferenceAbort.signal.aborted) throw error;
      }
      throw reason;
    };

    const finish = async (result: AgentTurnResult | null, error?: unknown) => {
      try {
        await receiptObserved;
        await acceptance;
        // The exact rejected RPC already settled this unconsumed attempt idle.
        // Releasing its local handle is not a failed model turn or user message.
        if (execution.nativeDeferred || execution.routeWithdrawal) return;
        if (result) {
          execution.nativeTerminalStatus = "completed";
          execution.nativeTurnId ??= result.turnId;
          await publication?.complete(result);
          await releasePublication();
          await this.persistResult(
            execution,
            result,
            "applied",
            true,
            "idle",
            true,
          );
        } else {
          if (
            error instanceof CodexTurnFailureError &&
            !execution.nativeDecline
          ) {
            execution.nativeTurnId = error.turnId;
            execution.nativeTerminalStatus = error.terminalStatus;
            nativeAcceptance = "applied";
          }
          await publication?.failed(error);
          await releasePublication();
          // Stop ends a turn without leaving the chat failed. Use the native
          // outcome, not error text that a real provider failure may also contain.
          const interrupted =
            error instanceof CodexTurnFailureError &&
            error.terminalStatus === "interrupted";
          await this.persistResult(
            execution,
            interrupted ? { interrupted: true } : { failed: true },
            execution.nativeDecline ? "rejected" : nativeAcceptance,
            true,
            interrupted ? "idle" : "failed",
            true,
          );
        }
      } finally {
        try {
          await releasePublication();
        } finally {
          this.clearExecution(execution);
        }
      }
    };
    return {
      operationGeneration: grant.receipt.operationGeneration,
      ...(forward ? { forward } : {}),
      beforeForward: async () => {
        if (
          operation.method === "turn/interrupt" ||
          operation.method === "thread/goal/clear" ||
          (operation.method === "thread/goal/set" &&
            intent.goalStatus === "paused")
        ) {
          if (this.active && !this.active.inferenceForwarded)
            cancelledWaitingRoot = this.active;
          this.active?.inferenceAbort.abort(
            new Error(
              "Native execution was stopped while waiting for capacity.",
            ),
          );
        }
        // Pause retains this exact execution source. Native suspension releases
        // its inference lease without terminal cancellation and resumes with
        // fresh capacity; aborting the source here makes that impossible.
        const priorGoalResponse =
          operation.method === "thread/goal/clear" ||
          (operation.method === "thread/goal/set" &&
            intent.goalStatus === "paused")
            ? this.goalMutationResponse
            : null;
        this.assertTransport(session);
        assertRootCurrent();
        if (start) {
          if (this.active)
            throw new Error(
              "Another native execution owns this managed session.",
            );
          this.active = execution;
          for (const observe of this.goalRecoveryObservers) observe();
          try {
            publication = await this.options.beginExecution(grant, session);
            execution.handle =
              await this.options.runtime.prepareAdmittedNativeExecution({
                ...publication.options,
                operationGeneration: grant.receipt.operationGeneration,
                inferenceSource: execution.inferenceSource,
                recoveryKey: `native-command:${grant.receipt.operationId}`,
                recovery: {
                  commandId: grant.receipt.operationId,
                  commandGeneration: grant.receipt.operationGeneration,
                  threadId: session.threadId,
                  turnId: operation.expectedTurnId,
                  ...(operation.origin === "autonomous" &&
                  operation.method === "turn/start" &&
                  operation.autonomousAttempt?.goalEpoch
                    ? {
                        autonomousGoal: {
                          goalEpoch: operation.autonomousAttempt.goalEpoch,
                          orderEpoch: operation.goalRecoveryOrderEpoch ?? 0,
                        },
                      }
                    : {}),
                },
                threadId: session.threadId!,
                expectedTurnId: operation.expectedTurnId,
                onInferenceQueued: async () => {
                  execution.inferenceQueued = true;
                  for (const observe of this.goalRecoveryObservers) observe();
                },
                inferenceSignal: inferenceSignal
                  ? AbortSignal.any([
                      inferenceSignal,
                      execution.inferenceAbort.signal,
                    ])
                  : execution.inferenceAbort.signal,
              });
            void execution.handle.completion
              .then(
                (result) => finish(result),
                (error: unknown) => finish(null, error),
              )
              .catch((error: unknown) =>
                this.options.onError(error, operation.operationId),
              );
          } catch (error) {
            // Keep the canonical source/publication until the handoff records
            // its no-start proof, including when native invalidation is retried.
            if (execution.routeWithdrawal) return awaitWithdrawal();
            try {
              await releasePublication();
            } finally {
              this.clearExecution(execution);
            }
            throw error;
          }
        }
        try {
          await this.options.client.dispatch({
            operationId: operation.operationId,
            operationGeneration: grant.receipt.operationGeneration,
            payloadDigest: grant.receipt.payloadDigest,
            session,
          });
          assertRootCurrent();
          this.assertTransport(session);
          execution.handle?.assertCurrent();
          if (
            operation.method === "thread/goal/set" &&
            operation.queueClaim &&
            intent.resumeAutonomy
          ) {
            this.goalMutationResponse = nativeResponseObserved;
            void nativeResponseObserved.then(() => {
              if (this.goalMutationResponse === nativeResponseObserved)
                this.goalMutationResponse = null;
            });
            const pending = receiptObserved.then(() => acceptance);
            this.goalMutationSettlement = pending;
            void pending
              .finally(() => {
                if (this.goalMutationSettlement === pending)
                  this.goalMutationSettlement = null;
              })
              .catch(() => {});
          }
          await this.options.beforeNativeDispatch?.(operation.method, session, {
            resumeAutonomy: intent.resumeAutonomy === true,
            ...(intent.paused === undefined ? {} : { paused: intent.paused }),
            ...(intent.goalStatus ? { goalStatus: intent.goalStatus } : {}),
          });
          // Gate invalidation above releases a setter waiting on its first goal attempt.
          // Order this clear/pause after that exact older native response, never after model work.
          await priorGoalResponse;
          assertRootCurrent();
          this.assertTransport(session);
          execution.handle?.assertCurrent();
          if (intent.nativeSettingsOperationId && this.settings) {
            await this.settings.track(
              {
                chatId: session.chatId,
                operationId: operation.operationId,
                operationGeneration: grant.receipt.operationGeneration,
                threadId: session.threadId!,
                runtimeGeneration: session.runtimeGeneration!,
                nativeOperationId: intent.nativeSettingsOperationId,
              },
              intent.permissionTransition,
              intent.permissionTransition
                ? {
                    chatId: session.chatId,
                    workerId: this.options.identity.workerId,
                    threadId: session.threadId!,
                    contextKind: session.contextKind,
                    projectId: session.projectId,
                    placementId: session.placementId,
                    modelRouteId: session.modelRouteId,
                    providerAccountId: session.providerAccountId,
                    runtimeGeneration: session.runtimeGeneration!,
                  }
                : undefined,
            );
            assertRootCurrent();
            this.assertTransport(session);
            execution.handle?.assertCurrent();
          }
          if (start) {
            execution.handle?.dispatchInference?.();
            execution.inferenceForwarded = true;
          }
        } catch (error) {
          if (execution.routeWithdrawal) return awaitWithdrawal();
          execution.handle?.fail(
            error instanceof Error
              ? error
              : new Error("Native dispatch failed."),
          );
          throw error;
        }
      },
      settle: (frame) =>
        (settlement ??= (async () => {
          resolveNativeResponse();
          if (execution.routeWithdrawal) {
            // The handoff/Stop transaction owns durable settlement. Do not
            // overwrite its deferral with a generic rejected native response.
            resolveReceipt();
            if (execution.handle) {
              execution.handle.rejectInference?.();
              execution.handle.fail(execution.routeWithdrawal.reason);
            } else {
              try {
                await releasePublication();
              } finally {
                this.clearExecution(execution);
              }
            }
            return;
          }
          if (intent.nativeSettingsOperationId && this.settings) {
            try {
              await this.settings.acknowledge(
                intent.nativeSettingsOperationId,
                frame,
              );
            } catch (error) {
              this.options.onError(error, operation.operationId);
            }
          }
          const rejected = frame !== null && "error" in frame;
          if (rejected && start) execution.handle?.rejectInference?.();
          const deferred =
            start &&
            !execution.nativeTurnId &&
            isNativePermissionDeferred(operation.method, frame);
          if (deferred) execution.nativeDeferred = true;
          nativeAcceptance = rejected
            ? "rejected"
            : frame === null || operation.origin === "autonomous"
              ? "uncertain"
              : "applied";
          try {
            if (rejected)
              execution.handle?.fail(
                deferred
                  ? new NativePermissionDeferredError()
                  : new Error("Native request was rejected."),
              );
            if (frame && !rejected && object(frame.result)) {
              if (
                operation.method === "thread/goal/set" &&
                operation.queueClaim &&
                intent.resumeAutonomy &&
                typeof frame.result.goalEpoch === "string" &&
                frame.result.goalEpoch.length > 0
              )
                execution.goalEpoch = frame.result.goalEpoch;
              if (
                start &&
                object(frame.result.turn) &&
                typeof frame.result.turn.id === "string"
              )
                execution.nativeTurnId = frame.result.turn.id;
            }
            if (deferred) {
              await releasePublication();
              if (!operation.queueClaim && operation.origin === "terminal") {
                if (!this.options.retainDeferredInput)
                  throw new NativePermissionRetentionError(
                    "notRetained",
                    intent.nativeClientUserMessageId,
                    new Error(
                      "Deferred native input retention is unavailable.",
                    ),
                  );
                try {
                  execution.retainedDeferred =
                    await this.options.retainDeferredInput(operation);
                } catch (error) {
                  throw new NativePermissionRetentionError(
                    "notRetained",
                    intent.nativeClientUserMessageId,
                    error,
                  );
                }
              }
            }
            if (
              frame &&
              !rejected &&
              operation.method === "turn/pause" &&
              intent.paused === true &&
              this.options.captureSuspension
            ) {
              const params = object(operation.frame.params)
                ? operation.frame.params
                : null;
              const turnId =
                typeof params?.turnId === "string"
                  ? params.turnId
                  : root?.nativeTurnId;
              if (!turnId || !session.threadId)
                throw new Error("The paused native turn identity is missing.");
              assertRootCurrent();
              this.assertTransport(session);
              const result = object(frame.result) ? frame.result : null;
              const suspension = nativeTurnSuspensionSchema.parse(
                result?.suspension,
              );
              if (
                result?.paused !== true ||
                suspension.threadId !== session.threadId ||
                suspension.turnId !== turnId
              )
                throw new Error("The native turn was not durably suspended.");
              try {
                execution.suspensionEvidence =
                  nativeSuspensionEvidenceSchema.parse(
                    await this.options.captureSuspension({
                      session,
                      turnId,
                      suspension,
                    }),
                  );
              } catch (error) {
                // Preserve an uncertain native checkpoint while reporting the
                // actual persistence failure through this exact control epoch.
                await this.persistResult(execution, null, "uncertain").catch(
                  (settlementError) => {
                    this.options.onError(
                      settlementError,
                      operation.operationId,
                    );
                  },
                );
                throw error;
              }
              assertRootCurrent();
              this.assertTransport(session);
            }
            acceptance = this.persistResult(
              execution,
              frame,
              nativeAcceptance,
              deferred || (start && !execution.handle),
              rejected && !deferred ? "failed" : "idle",
            );
            try {
              await acceptance;
            } catch (error) {
              if (deferred)
                throw new NativePermissionRetentionError(
                  "uncertain",
                  intent.nativeClientUserMessageId ??
                    execution.retainedDeferred?.retainedPrompt
                      ?.nativeClientUserMessageId ??
                    undefined,
                  error,
                );
              throw error;
            }
            // This flag describes durable canonical ownership, not merely a
            // native no-consumption receipt. Never expose it before settlement.
            if (
              deferred &&
              frame &&
              object(frame.error) &&
              object(frame.error.data) &&
              (operation.queueClaim ||
                execution.retainedDeferred?.retainedPrompt)
            )
              frame.error.data = { ...frame.error.data, queueRetained: true };
            if (
              frame &&
              !rejected &&
              object(frame.result) &&
              operation.origin !== "autonomous"
            )
              execution.handle?.bindReceipt(frame.result);
          } finally {
            // Completion may arrive before the RPC response; only settle it after
            // the corresponding acceptance write, without holding admission open.
            resolveReceipt();
            if (start && !execution.handle) {
              try {
                await releasePublication();
              } finally {
                this.clearExecution(execution);
              }
            }
          }
        })()),
    };
  }

  async resolveReply(
    operation: ManagedNativeOperation,
    frame: NativeRpcFrame,
  ): Promise<void> {
    const root = this.active;
    if (!root || !operation.reply)
      throw new Error("The native interaction has no active execution.");
    this.assertTransport(root.session);
    const input = {
      operationGeneration: root.receipt.operationGeneration,
      rootThreadId: operation.identity.threadId,
      requestId: operation.reply.nativeRequestId,
    };
    await this.options.runtime.awaitPendingAdmittedNativeReply(input);
    if (this.active !== root)
      throw new Error(
        "The native interaction belongs to a replaced execution.",
      );
    const response =
      "error" in frame ? { error: frame.error } : { result: frame.result };
    await this.options.runtime.resolveAdmittedNativeReply({
      ...input,
      response,
    } as Parameters<CodexAppServer["resolveAdmittedNativeReply"]>[0]);
  }
}
