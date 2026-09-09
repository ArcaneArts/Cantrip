import { ManagedNativeSettings } from "./managed-native-settings.js";
import type { NativeSettingsDelivery } from "../native-settings-delivery.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { managedNativeMethods } from "@cantrip/protocol";
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
} from "@cantrip/protocol";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import { NativeCommandClient } from "../native-command-client.js";
import { protectNativeCommandContent } from "../native-command-content.js";
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
  receipt: NativeCommandReceipt;
  session: NativeCommandSession;
  handle?: AdmittedNativeExecution;
  nativeTurnId?: string;
  goalEpoch?: string;
  nativeDecline?: ManagedExecutionDeclined;
  expectedTurnId?: string;
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
  >;
  client: NativeCommandClient;
  settingsDelivery?: Pick<NativeSettingsDelivery, "track" | "record">;
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
    intent?: { resumeAutonomy?: boolean; goalStatus?: "active" | "paused" },
  ): Promise<void>;
  /** Correlation-only diagnostics. Never log native frames or protected plaintext here. */
  onError(error: unknown, operationId: string): void;
}

const object = (value: unknown): value is NativeRpcFrame =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Shares the current admitted root across GUI and all attached terminal views. */
export class ManagedNativeCommandSession {
  private active: Execution | null = null;
  private goalMutationSettlement: Promise<void> | null = null;
  private goalMutationResponse: Promise<void> | null = null;
  private readonly expectedActivation = new AsyncLocalStorage<{
    generation: string | null;
  }>();

  get currentActivationGeneration(): string | null {
    return this.active?.receipt.activationGeneration ?? null;
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
        })
      : null;
  }

  private createExecution(
    receipt: NativeCommandReceipt,
    session: NativeCommandSession,
  ): Execution {
    let markReleased!: () => void;
    const released = new Promise<void>((resolve) => {
      markReleased = resolve;
    });
    return { receipt, session, released, markReleased };
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
    execution.markReleased();
  }

  private assertTransport(session: NativeCommandSession) {
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
    await this.options.client.settle({
      operationId: execution.receipt.operationId,
      operationGeneration: execution.receipt.operationGeneration,
      status,
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
      rejectionCode: status === "rejected" ? "native-request-rejected" : null,
      executionComplete: complete,
      ...(!terminal && execution.goalEpoch
        ? { goalEpoch: execution.goalEpoch }
        : {}),
      ...(complete ? { executionStatus } : {}),
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
              },
            }
          : {}),
    });
  }

  /** Joins an accepted GUI parent for mediated preparation without dispatching a model turn. */
  async withGuiPreparation<T>(
    receipt: NativeCommandReceipt,
    session: NativeCommandSession,
    callback: () => Promise<T>,
  ): Promise<T> {
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
    try {
      return await this.withExpectedActivationGeneration(
        execution.receipt.activationGeneration,
        callback,
      );
    } finally {
      if (!previous && execution.guiPreparation) this.clearExecution(execution);
    }
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
    try {
      await this.options.client.dispatch({
        operationId: receipt.operationId,
        operationGeneration: receipt.operationGeneration,
        payloadDigest: receipt.payloadDigest,
        session,
      });
      bridgeSignal?.throwIfAborted();
    } catch (error) {
      this.clearExecution(execution);
      throw error;
    }
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
  ): void {
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

  releaseGui(operationGeneration: string) {
    if (this.active?.receipt.operationGeneration === operationGeneration)
      this.clearExecution(this.active);
  }

  async admitAutonomousAttempt(
    attempt: ManagedExecutionAttempt,
    session: NativeCommandSession,
    signal: AbortSignal,
    goalQueueHandoff?: NativeCommandAdmission["goalQueueHandoff"],
  ): Promise<void> {
    if (session.threadId !== attempt.threadId || !session.runtimeGeneration)
      throw new Error(
        "The native attempt does not belong to this managed session.",
      );
    await this.awaitExecutionReleased(signal);
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
      ...(goalQueueHandoff ? { goalQueueHandoff } : {}),
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
    const admission = await this.admit(operation);
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
    execution.nativeDecline = { ...event };
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
      ...(command.settingsBindingId === undefined
        ? {}
        : { settingsBindingId: command.settingsBindingId }),
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
    const intent = await managedNativeCommandIntent(
      operation,
      this.options.policy,
    );
    if (operation.expectedTurnId)
      intent.expectedTurnId = operation.expectedTurnId;
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
    const grant = await this.options.client.admit({
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
      expectedActivationGeneration: root?.receipt.activationGeneration ?? null,
      ...(operation.reply
        ? {
            reply: {
              ...operation.reply,
              nativeRequestId: `${typeof operation.reply.nativeRequestId}:${operation.reply.nativeRequestId}`,
            },
          }
        : {}),
    });
    if (grant.replayed)
      throw new Error(
        `Native command ${grant.receipt.operationId} is already ${grant.receipt.status}; its mutation will not be replayed.`,
      );
    if (grant.receipt.status !== "accepted")
      throw new Error(
        `Native command admission rejected: ${grant.receipt.rejectionCode ?? grant.receipt.status}`,
      );
    const execution = this.createExecution(grant.receipt, session);
    execution.expectedTurnId = operation.expectedTurnId;
    let publication: ManagedNativeExecutionPublication | null = null;
    let acceptance: Promise<void> = Promise.resolve();
    let resolveReceipt!: () => void;
    const receiptObserved = new Promise<void>((resolve) => {
      resolveReceipt = resolve;
    });
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
    const assertRootCurrent = () => {
      if (expected) this.assertActivationGeneration(expected.generation);
      if (!start && root && this.active !== root)
        throw new Error("The native mutation belongs to a replaced execution.");
    };

    const finish = async (result: AgentTurnResult | null, error?: unknown) => {
      try {
        await receiptObserved;
        await acceptance;
        if (result) {
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
            nativeAcceptance = "applied";
          }
          await publication?.failed(error);
          await releasePublication();
          // An observed model failure is separate from whether start was accepted.
          await this.persistResult(
            execution,
            { failed: true },
            execution.nativeDecline ? "rejected" : nativeAcceptance,
            true,
            "failed",
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
          try {
            publication = await this.options.beginExecution(grant, session);
            execution.handle =
              await this.options.runtime.prepareAdmittedNativeExecution({
                ...publication.options,
                operationGeneration: grant.receipt.operationGeneration,
                threadId: session.threadId!,
                expectedTurnId: operation.expectedTurnId,
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
            ...(intent.goalStatus ? { goalStatus: intent.goalStatus } : {}),
          });
          // Gate invalidation above releases a setter waiting on its first goal attempt.
          // Order this clear/pause after that exact older native response, never after model work.
          await priorGoalResponse;
          assertRootCurrent();
          this.assertTransport(session);
          execution.handle?.assertCurrent();
          if (intent.nativeSettingsOperationId && this.settings) {
            await this.settings.track({
              chatId: session.chatId,
              operationId: operation.operationId,
              operationGeneration: grant.receipt.operationGeneration,
              threadId: session.threadId!,
              runtimeGeneration: session.runtimeGeneration!,
              nativeOperationId: intent.nativeSettingsOperationId,
            });
            assertRootCurrent();
            this.assertTransport(session);
            execution.handle?.assertCurrent();
          }
        } catch (error) {
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
          nativeAcceptance = rejected
            ? "rejected"
            : frame === null || operation.origin === "autonomous"
              ? "uncertain"
              : "applied";
          try {
            if (rejected)
              execution.handle?.fail(new Error("Native request was rejected."));
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
            acceptance = this.persistResult(
              execution,
              frame,
              nativeAcceptance,
              start && !execution.handle,
              rejected ? "failed" : "idle",
            );
            await acceptance;
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
