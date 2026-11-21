import { createHash } from "node:crypto";
import {
  embeddingInputSchema,
  embeddingOutcomeSchema,
  decisionInputSchema,
  decisionOutcomeSchema,
  modelOperationContentContext,
  protectedEmbeddingResponseSchema,
  type ModelOperationUsage,
  type WorkerCommand,
} from "@cantrip/protocol";
import {
  openWorkerEndpointContent,
  protectWorkerEndpointContent,
} from "../endpoint-content-encryption.js";
import { openRuntimeProvider } from "../protected-secrets.js";
import { embed, ModelOperationError } from "../model-embedding.js";
import { decide } from "../model-decision.js";
import { ModelOperationUsageCollector } from "../model-operation-usage.js";
import type { WorkerInferenceAdmission } from "../inference-admission.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";

type Command = Extract<
  WorkerCommand,
  { type: "model.embedding" | "model.decision" }
>;
type Cancellation = Extract<WorkerCommand, { type: "model.operation.cancel" }>;
const MAX_OPERATION_RECORDS = 10000;
type ExecutionResult = {
  response: ReturnType<typeof protectedEmbeddingResponseSchema.parse>;
  usageReceipt?: ModelOperationUsage;
};

/** Metadata-only replay protection survives result disposal for this worker
 * incarnation. Completed operations are never automatically submitted again. */
export class ModelOperationCommands {
  private readonly active = new Map<
    string,
    {
      signature: string;
      controller: AbortController;
      result: Promise<ExecutionResult>;
    }
  >();
  private readonly ended = new Map<string, "completed" | "cancelled">();
  constructor(
    private readonly ports: {
      scope(): { serverId: string; workerId: string };
      service: WorkerEncryptionService;
      admission(): WorkerInferenceAdmission;
      workerVersion?: string;
    },
  ) {}
  private key(command: Command | Cancellation) {
    const scope = this.ports.scope();
    if (
      command.serverId !== scope.serverId ||
      command.scope.workerId !== scope.workerId
    )
      throw new Error("The model operation targets another worker scope.");
    return JSON.stringify([
      scope.serverId,
      this.ports.service.ownerId(),
      scope.workerId,
      command.operationId,
    ]);
  }
  cancel(command: Cancellation) {
    const key = this.key(command);
    const active = this.active.get(key);
    active?.controller.abort(
      new ModelOperationError(
        "cancelled",
        "The model operation was cancelled.",
      ),
    );
    if (
      active ||
      this.ended.has(key) ||
      this.active.size + this.ended.size < MAX_OPERATION_RECORDS
    )
      if (!this.ended.has(key)) this.ended.set(key, "cancelled");
    return {
      operationId: command.operationId,
      cancelled: Boolean(active) || this.ended.get(key) === "cancelled",
    };
  }
  execute(command: Command, collectUsage = false): Promise<unknown> {
    const expose = (value: ExecutionResult) =>
      collectUsage && value.usageReceipt
        ? { ...value.response, usageReceipt: value.usageReceipt }
        : value.response;
    const key = this.key(command);
    const signature = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    const existing = this.active.get(key);
    if (existing) {
      if (existing.signature !== signature)
        return Promise.reject(
          new Error("The model operation cannot change during redelivery."),
        );
      return existing.result.then(expose);
    }
    const ended = this.ended.get(key);
    if (!ended && this.active.size + this.ended.size >= MAX_OPERATION_RECORDS)
      return Promise.reject(
        new Error(
          "The worker model-operation replay ledger is full. Reconnect with a new worker incarnation before submitting more operations.",
        ),
      );
    const controller = new AbortController();
    const result = this.perform(command, controller.signal, ended).finally(
      () => {
        this.active.delete(key);
        if (!this.ended.has(key)) this.ended.set(key, "completed");
      },
    );
    this.active.set(key, { signature, controller, result });
    return result.then(expose);
  }
  private async perform(
    command: Command,
    signal: AbortSignal,
    ended?: "completed" | "cancelled",
  ): Promise<ExecutionResult> {
    const context = {
      serverId: command.serverId,
      operationId: command.operationId,
      scope: command.scope,
      operation:
        command.type === "model.decision"
          ? ("decision" as const)
          : ("embedding" as const),
    };
    const schema: { parse(value: unknown): unknown } =
      command.type === "model.decision"
        ? decisionOutcomeSchema
        : embeddingOutcomeSchema;
    let outcome: unknown;
    let status: ModelOperationUsage["status"] = "failed";
    const usageCollector = new ModelOperationUsageCollector({
      operation: context.operation,
      modelId: command.route.modelId,
      routeId: command.route.routeId,
      providerId: command.route.provider.id,
      workerVersion: this.ports.workerVersion ?? null,
    });
    try {
      if (ended)
        throw new ModelOperationError(
          ended === "cancelled" ? "cancelled" : "invalid-request",
          ended === "cancelled"
            ? "The model operation was cancelled."
            : "This model operation already completed and was not replayed.",
        );
      if (
        (command.scope.modelId &&
          command.scope.modelId !== command.route.modelId) ||
        (command.scope.routeId &&
          command.scope.routeId !== command.route.routeId)
      )
        throw new ModelOperationError(
          "invalid-request",
          "The selected model route does not match the protected request.",
        );
      const provider = await openRuntimeProvider({
        provider: command.route.provider,
        service: this.ports.service,
      });
      const ports = {
        route: { ...command.route, provider },
        admission: this.ports.admission(),
        signal,
        usageCollector,
      };
      const open = {
        context: modelOperationContentContext({
          ...context,
          direction: "request",
        }),
        opaque: command.protectedRequest,
        service: this.ports.service,
      };
      const value =
        command.type === "model.decision"
          ? await decide({
              ...ports,
              request: await openWorkerEndpointContent({
                ...open,
                schema: decisionInputSchema,
              }),
            })
          : await embed({
              ...ports,
              request: await openWorkerEndpointContent({
                ...open,
                schema: embeddingInputSchema,
              }),
            });
      outcome = schema.parse({ status: "succeeded", value });
      status = "completed";
    } catch (error) {
      status = signal.aborted ? "cancelled" : "failed";
      outcome = schema.parse({
        status: "failed",
        error:
          error instanceof ModelOperationError
            ? {
                code: error.code,
                message: error.message,
                httpStatus: error.httpStatus ?? null,
              }
            : {
                code: signal.aborted ? "cancelled" : "invalid-request",
                message: signal.aborted
                  ? "The model operation was cancelled."
                  : "The protected model operation could not be completed.",
              },
      });
    }
    const response = protectedEmbeddingResponseSchema.parse({
      operationId: command.operationId,
      scope: command.scope,
      protectedResponse: await protectWorkerEndpointContent({
        context: modelOperationContentContext({
          ...context,
          direction: "response",
        }),
        content: outcome,
        schema,
        service: this.ports.service,
      }),
    });
    let usageReceipt: ModelOperationUsage | undefined;
    // Rejected replay does not describe the original operation's usage. Missing
    // observation remains unknown, and telemetry cannot fail a completed result.
    if (!ended) {
      try {
        usageReceipt = usageCollector.finish(status);
      } catch {}
    }
    return { response, ...(usageReceipt ? { usageReceipt } : {}) };
  }
}
