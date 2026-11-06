import {
  nativeCommandAdmissionSchema,
  nativeSuspensionExecutionAdmissionSchema,
  nativeSuspensionExecutionAdmissionResultSchema,
  type NativeSuspensionExecutionAdmission,
  nativePermissionTransitionResolveSchema,
  nativePermissionTransitionResolutionSchema,
  type NativeCommandSession,
  nativeSettingsStateSchema,
  nativeSettingsRefreshRequestSchema,
  nativeSettingsObservationRequestSchema,
  nativeSettingsObservationReceiptSchema,
  type NativeSettingsObservationRequest,
  nativeSettingsEvidenceSchema,
  nativeSettingsEvidenceResultSchema,
  type NativeSettingsEvidence,
  nativeCommandAdmissionResultSchema,
  nativeCommandDispatchSchema,
  nativeCommandContinuationSchema,
  nativeCommandSettlementSchema,
  nativeCommandSettlementResultSchema,
  nativeCommandEventSchema,
  nativePendingRequestSchema,
  type NativeCommandAdmission,
  type NativeCommandAdmissionResult,
  type NativeGoalRecoveryFence,
  nativeGoalRecoveryFenceSchema,
  nativeGoalRecoveryFenceResultSchema,
  type NativeCommandReceipt,
  type NativeCommandDispatch,
  type NativeCommandContinuation,
  type NativeCommandSettlement,
  type NativePendingRequest,
  nativeInferenceRecoverySchema,
  nativeInferenceRecoveryResultSchema,
  nativeInferenceResourceAuthorizationSchema,
  nativeInferenceResourceAuthorizationResultSchema,
  type NativeInferenceResourceAuthorization,
  type NativeInferenceRecovery,
  taskInferenceInputDispatchSchema,
  taskInferenceInputDispatchResultSchema,
  taskInferenceInputReceiptSchema,
  type TaskInferenceInputDispatch,
  type TaskGoalCycleDispatch,
  taskGoalCycleDispatchSchema,
  taskGoalCycleDispatchResultSchema,
  taskGoalOutcomeDeliverySchema,
  taskGoalOutcomeCommitSchema,
  type TaskGoalOutcomeDelivery,
} from "@cantrip/protocol";
import { z } from "zod";
import { CantripServerRequestError } from "./cli-client.js";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

export interface NativeCommandClientOptions {
  serverUrl: string;
  workerId: string;
  workerGeneration?: string;
  token(): string;
  fetch?: typeof fetch;
}

/** Short admission transactions only; never hold a request open for a model turn. */
export class NativeCommandClient {
  constructor(private readonly options: NativeCommandClientOptions) {}

  async admitSuspendedExecution(
    input: Omit<
      NativeSuspensionExecutionAdmission,
      "workerId" | "workerGeneration"
    >,
    signal?: AbortSignal,
  ) {
    const body = nativeSuspensionExecutionAdmissionSchema.parse({
      ...input,
      workerId: this.options.workerId,
      workerGeneration: this.options.workerGeneration,
    });
    const result = await this.post(
      "suspension-execution",
      body,
      nativeSuspensionExecutionAdmissionResultSchema,
      signal,
    );
    const owner = result.suspension.executionOwner;
    const action = input.action ?? "resume";
    if (
      result.suspension.controlId !== input.controlId ||
      result.suspension.action !== action ||
      result.suspension.phase !==
        (action === "stop" ? "stopping" : "resuming") ||
      result.suspension.target.workerId !== body.workerId ||
      result.suspension.target.contextKind !== input.session.contextKind ||
      result.suspension.target.projectId !== input.session.projectId ||
      result.suspension.target.placementId !== input.session.placementId ||
      result.suspension.target.modelRouteId !== input.session.modelRouteId ||
      result.suspension.target.providerAccountId !==
        input.session.providerAccountId ||
      result.suspension.active?.threadId !== input.session.threadId ||
      result.receipt.chatId !== input.session.chatId ||
      !isDeepStrictEqual(result.suspension.checkpoint, body.checkpoint) ||
      result.suspension.active?.turnId !== input.checkpoint.suspension.turnId ||
      result.suspension.target.originalOperationId !==
        result.source.operationId ||
      owner?.workerGeneration !== body.workerGeneration ||
      owner.runtimeGeneration !== input.session.runtimeGeneration ||
      owner.operationId !== result.receipt.operationId ||
      owner.operationGeneration !== result.receipt.operationGeneration ||
      result.receipt.threadId !== input.session.threadId ||
      result.receipt.method !== "thread/resume" ||
      !result.execution ||
      result.execution.chatId !== input.session.chatId ||
      result.execution.workerId !== body.workerId ||
      result.execution.threadId !== input.session.threadId ||
      result.execution.executionLaneId !== result.receipt.executionLaneId ||
      result.suspension.target.executionLaneId !==
        result.receipt.executionLaneId ||
      !result.receipt.startsExecution ||
      result.receipt.payloadDigest !== input.payloadDigest ||
      (result.receipt.logicalOperationId ?? null) !==
        (result.logicalRoot?.operationId ?? null)
    )
      throw new Error(
        "Native suspension admission returned another observer owner.",
      );
    return result;
  }

  async fenceGoalRecoveryAdmission(
    input: Omit<NativeGoalRecoveryFence, "workerId">,
    signal?: AbortSignal,
  ) {
    return this.post(
      "goal-recovery-fence",
      nativeGoalRecoveryFenceSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      nativeGoalRecoveryFenceResultSchema,
      signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    );
  }

  private async post<T>(
    action: string,
    body: unknown,
    schema: { parse(value: unknown): T },
    signal?: AbortSignal,
  ): Promise<T> {
    // A transport failure can follow a committed admission/dispatch. Leave its
    // identity intact for reconciliation; never mint a new ID or replay input.
    const response = await (this.options.fetch ?? fetch)(
      new URL(
        `/api/internal/native-commands/${action}`,
        this.options.serverUrl,
      ),
      {
        method: "POST",
        redirect: "error",
        ...(signal ? { signal } : {}),
        headers: {
          authorization: `Bearer ${this.options.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const record =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : null;
      throw new CantripServerRequestError(
        typeof record?.error === "string"
          ? record.error
          : `Native command ${action} failed with HTTP ${response.status}.`,
        response.status,
        typeof record?.code === "string" ? record.code : null,
      );
    }
    return schema.parse(payload);
  }

  async refreshSettings(chatId: string, signal?: AbortSignal) {
    return this.post(
      "settings-refresh",
      nativeSettingsRefreshRequestSchema.parse({
        chatId,
        workerId: this.options.workerId,
      }),
      nativeSettingsStateSchema,
      signal,
    );
  }

  async reconcileInference(
    input: Omit<NativeInferenceRecovery, "workerId">,
    signal?: AbortSignal,
  ) {
    const result = await this.post(
      "inference-recovery",
      nativeInferenceRecoverySchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      nativeInferenceRecoveryResultSchema,
      signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    );
    if (result.key !== input.record.key)
      throw new Error(
        "Inference recovery returned another operation's receipt.",
      );
    return result;
  }

  async authorizeInferenceResource(
    input: Omit<NativeInferenceResourceAuthorization, "workerId">,
    signal?: AbortSignal,
  ) {
    const scope = nativeInferenceResourceAuthorizationSchema.parse({
      ...input,
      workerId: this.options.workerId,
    });
    const result = await this.post(
      "inference-resource-authorize",
      scope,
      nativeInferenceResourceAuthorizationResultSchema,
      signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    );
    if (
      result.serverId !== scope.serverId ||
      result.ownerId !== scope.ownerId ||
      result.workerId !== scope.workerId ||
      result.workerGeneration !== scope.workerGeneration ||
      JSON.stringify(result.target) !== JSON.stringify(scope.target)
    )
      throw new Error(
        "Inference resource authorization returned another worker or resource scope.",
      );
    signal?.throwIfAborted();
    return result;
  }

  resolvePermissionTransition(
    session: NativeCommandSession,
    selectedId: string | null,
  ) {
    return this.post(
      "permission-transition",
      nativePermissionTransitionResolveSchema.parse({
        workerId: this.options.workerId,
        session,
        selectedId,
      }),
      nativePermissionTransitionResolutionSchema,
    );
  }

  async dispatchTaskInput(
    input: Omit<TaskInferenceInputDispatch, "workerId">,
    signal?: AbortSignal,
  ) {
    const result = await this.post(
      "task-input-dispatch",
      taskInferenceInputDispatchSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      taskInferenceInputDispatchResultSchema,
      signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    );
    if (
      JSON.stringify(result.receipt) !==
      JSON.stringify(taskInferenceInputReceiptSchema.parse(input.receipt))
    )
      throw new Error(
        "Task input dispatch returned another operation's receipt.",
      );
    if (
      input.phase === "native" &&
      (result.nativeExecution?.threadId !== input.nativeExecution?.threadId ||
        result.nativeExecution?.turnId !== input.nativeExecution?.turnId ||
        result.nativeExecution?.scopeId !== input.nativeExecution?.scopeId ||
        result.nativeRuntimeGeneration !== input.nativeRuntimeGeneration)
    )
      throw new Error(
        "Task native binding returned another execution's acknowledgement.",
      );
    return result;
  }

  async dispatchTaskGoalCycle(
    input: Omit<TaskGoalCycleDispatch, "workerId">,
    signal: AbortSignal,
  ) {
    return this.post(
      "task-goal-cycle-dispatch",
      taskGoalCycleDispatchSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      taskGoalCycleDispatchResultSchema,
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    );
  }

  async commitGoalOutcome(input: TaskGoalOutcomeDelivery, signal: AbortSignal) {
    const result = await this.post(
      "task-goal-outcome",
      taskGoalOutcomeDeliverySchema.parse(input),
      taskGoalOutcomeCommitSchema,
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    );
    if (
      (!result.committed && !result.retiredReason) ||
      result.deliveryId !== input.deliveryId ||
      result.taskInferenceInputOperationId !==
        input.notification.taskInferenceInputOperationId
    )
      throw new Error(
        "Task outcome has no matching canonical commit or retirement receipt.",
      );
  }

  async observeSettings(
    input: Omit<NativeSettingsObservationRequest, "workerId">,
    signal?: AbortSignal,
  ) {
    const result = await this.post(
      "settings-observation",
      nativeSettingsObservationRequestSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      nativeSettingsObservationReceiptSchema,
      signal,
    );
    if (result.bindingId !== input.bindingId)
      throw new Error(
        "The settings receipt belongs to another observation binding.",
      );
    return result;
  }

  async admit(
    input: Omit<NativeCommandAdmission, "workerId">,
    options?: { continueUnobservedGoalAdmission: true },
  ): Promise<NativeCommandAdmissionResult & { continuedAdmission?: boolean }> {
    const body = nativeCommandAdmissionSchema.parse({
      ...input,
      intent: {
        ...input.intent,
        ...((input.origin === "autonomous" || input.intent.durableSuspension) &&
        this.options.workerGeneration
          ? { workerGeneration: this.options.workerGeneration }
          : {}),
      },
      workerId: this.options.workerId,
    });
    const recoverUnobserved =
      options?.continueUnobservedGoalAdmission === true &&
      input.origin === "autonomous" &&
      Boolean(input.intent.autonomousAttempt?.goalEpoch);
    let retried = false;
    let retryDelay = 1000;
    for (;;) {
      let result;
      try {
        result = await this.post(
          "admit",
          body,
          nativeCommandAdmissionResultSchema,
          recoverUnobserved ? AbortSignal.timeout(15_000) : undefined,
        );
      } catch (error) {
        if (
          !recoverUnobserved ||
          (error instanceof CantripServerRequestError &&
            error.status < 500 &&
            error.status !== 408 &&
            error.status !== 429)
        )
          throw error;
        // This invocation has never forwarded native input. Resolve its exact
        // immutable admission, even after native cancellation, so the caller
        // can settle that receipt. Cancellation is checked before forwarding;
        // cancelling this metadata retry would strand an accepted marker.
        retried = true;
        await delay(retryDelay, undefined, { ref: false });
        retryDelay = Math.min(retryDelay * 2, 30_000);
        continue;
      }
      this.correlate(result.receipt, input);
      return {
        ...result,
        // Only a response lost inside THIS invocation can continue acceptance.
        // Dispatched, replaced or settled commands still cannot be replayed.
        continuedAdmission:
          retried &&
          result.replayed &&
          result.receipt.status === "accepted" &&
          result.execution !== null,
      };
    }
  }

  async dispatch(input: Omit<NativeCommandDispatch, "workerId">) {
    const result = await this.post(
      "dispatch",
      nativeCommandDispatchSchema.parse({
        ...input,
        ...(this.options.workerGeneration
          ? { workerGeneration: this.options.workerGeneration }
          : {}),
        workerId: this.options.workerId,
      }),
      nativeCommandAdmissionResultSchema,
    );
    this.correlate(result.receipt, input);
    return result;
  }

  async bindPreparation(input: Omit<NativeCommandDispatch, "workerId">) {
    const result = await this.post(
      "bind-preparation",
      nativeCommandDispatchSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      nativeCommandSettlementResultSchema,
    );
    this.correlate(result.receipt, input);
    return result;
  }

  async continueExecution(input: Omit<NativeCommandContinuation, "workerId">) {
    const result = await this.post(
      "continue",
      nativeCommandContinuationSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      nativeCommandAdmissionResultSchema,
    );
    this.correlate(result.receipt, input);
    if (
      result.receipt.logicalOperationId !== input.rootOperationId ||
      result.receipt.previousOperationId !== input.previousOperationId ||
      result.receipt.operationGeneration === input.previousOperationGeneration
    ) {
      throw new Error(
        "Native continuation returned an uncorrelated retry lineage.",
      );
    }
    return result;
  }

  async settle(
    input: Omit<NativeCommandSettlement, "workerId">,
    signal?: AbortSignal,
  ) {
    const result = await this.post(
      "receipt",
      nativeCommandSettlementSchema.parse({
        ...input,
        ...(input.durableSuspension && this.options.workerGeneration
          ? { workerGeneration: this.options.workerGeneration }
          : {}),
        workerId: this.options.workerId,
      }),
      nativeCommandSettlementResultSchema,
      signal,
    );
    this.correlate(result.receipt, input);
    return result;
  }

  async settingsEvidence(
    input: Omit<NativeSettingsEvidence, "workerId">,
    signal?: AbortSignal,
  ) {
    const result = await this.post(
      "settings-evidence",
      nativeSettingsEvidenceSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      nativeSettingsEvidenceResultSchema,
      signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    );
    if (
      result.operationId !== input.operationId ||
      result.operationGeneration !== input.operationGeneration ||
      result.eventId !== input.eventId ||
      result.application.nativeOperationId !== input.nativeOperationId
    )
      throw new Error(
        "Native settings returned uncorrelated evidence acknowledgment.",
      );
    return result;
  }

  pending(input: Omit<NativePendingRequest, "workerId">) {
    return this.post(
      "pending",
      nativePendingRequestSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      z.object({ registered: z.literal(true) }).strict(),
    );
  }

  event(input: Omit<z.infer<typeof nativeCommandEventSchema>, "workerId">) {
    return this.post(
      "events",
      nativeCommandEventSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      z.object({ applied: z.literal(true) }).strict(),
    );
  }

  private correlate(
    receipt: NativeCommandReceipt,
    expected: {
      operationId: string;
      operationGeneration?: string;
      payloadDigest?: string;
    },
  ) {
    if (
      receipt.operationId !== expected.operationId ||
      (expected.operationGeneration !== undefined &&
        receipt.operationGeneration !== expected.operationGeneration) ||
      (expected.payloadDigest !== undefined &&
        receipt.payloadDigest !== expected.payloadDigest)
    ) {
      throw new Error(
        "Native admission returned an uncorrelated operation receipt.",
      );
    }
  }
}
