import { createHash } from "node:crypto";
import {
  embeddingInputSchema,
  embeddingOutcomeSchema,
  modelOperationContentContext,
  protectedEmbeddingResponseSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import {
  openWorkerEndpointContent,
  protectWorkerEndpointContent,
} from "../endpoint-content-encryption.js";
import { openRuntimeProvider } from "../protected-secrets.js";
import { embed, ModelOperationError } from "../model-embedding.js";
import type { WorkerInferenceAdmission } from "../inference-admission.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";

type Command = Extract<WorkerCommand, { type: "model.embedding" }>;
type Cancellation = Extract<WorkerCommand, { type: "model.operation.cancel" }>;
const MAX_OPERATION_RECORDS = 10000;

/** Metadata-only replay protection survives result disposal for this worker
 * incarnation. Completed operations are never automatically submitted again. */
export class ModelEmbeddingCommands {
  private readonly active = new Map<
    string,
    { signature: string; controller: AbortController; result: Promise<unknown> }
  >();
  private readonly ended = new Map<string, "completed" | "cancelled">();
  constructor(
    private readonly ports: {
      scope(): { serverId: string; workerId: string };
      service: WorkerEncryptionService;
      admission(): WorkerInferenceAdmission;
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
        "The embedding operation was cancelled.",
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
  execute(command: Command): Promise<unknown> {
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
      return existing.result;
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
    return result;
  }
  private async perform(
    command: Command,
    signal: AbortSignal,
    ended?: "completed" | "cancelled",
  ) {
    const context = {
      serverId: command.serverId,
      operationId: command.operationId,
      scope: command.scope,
    };
    let outcome;
    try {
      const request = await openWorkerEndpointContent({
        context: modelOperationContentContext({
          ...context,
          direction: "request",
        }),
        opaque: command.protectedRequest,
        schema: embeddingInputSchema,
        service: this.ports.service,
      });
      if (ended)
        throw new ModelOperationError(
          ended === "cancelled" ? "cancelled" : "invalid-request",
          ended === "cancelled"
            ? "The embedding operation was cancelled."
            : "This embedding operation already completed and was not replayed.",
        );
      if (
        (command.scope.modelId &&
          command.scope.modelId !== command.route.modelId) ||
        (command.scope.routeId &&
          command.scope.routeId !== command.route.routeId)
      )
        throw new ModelOperationError(
          "invalid-request",
          "The selected embedding route does not match the protected request.",
        );
      const provider = await openRuntimeProvider({
        provider: command.route.provider,
        service: this.ports.service,
      });
      const value = await embed({
        request,
        route: { ...command.route, provider },
        admission: this.ports.admission(),
        signal,
      });
      outcome = embeddingOutcomeSchema.parse({ status: "succeeded", value });
    } catch (error) {
      outcome = embeddingOutcomeSchema.parse({
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
                  ? "The embedding operation was cancelled."
                  : "The protected embedding operation could not be completed.",
              },
      });
    }
    return protectedEmbeddingResponseSchema.parse({
      operationId: command.operationId,
      scope: command.scope,
      protectedResponse: await protectWorkerEndpointContent({
        context: modelOperationContentContext({
          ...context,
          direction: "response",
        }),
        content: outcome,
        schema: embeddingOutcomeSchema,
        service: this.ports.service,
      }),
    });
  }
}
