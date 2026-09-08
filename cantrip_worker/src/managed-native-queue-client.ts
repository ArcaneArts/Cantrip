import {
  managedQueueImportSchema,
  managedQueueImportResultSchema,
  managedQueueImportAckSchema,
  type ManagedQueueImport,
  type ManagedQueueImportAck,
  managedQueueLookupSchema,
  managedQueueLookupResultSchema,
  managedQueueReadSchema,
  managedQueueSnapshotSchema,
  managedQueueMutateSchema,
  managedQueueMutationResultSchema,
  managedQueueStartReceiptSchema,
  managedQueueStartReceiptResultSchema,
  type ManagedQueueRead,
  type ManagedQueueMutate,
  type ManagedQueueStartReceipt,
} from "@cantrip/protocol";
import { CantripServerRequestError } from "./cli-client.js";
import type { NativeCommandClientOptions } from "./native-command-client.js";

export class ManagedNativeQueueUncertainError extends Error {
  readonly code = "queue-operation-uncertain";
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

/** A lost response never causes a new operation ID or an automatic mutation replay. */
export class ManagedNativeQueueClient {
  constructor(private readonly options: NativeCommandClientOptions) {}

  private async post<T>(
    action: string,
    body: unknown,
    schema: { parse(value: unknown): T },
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        new URL(`/api/internal/native-queue/${action}`, this.options.serverUrl),
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            authorization: `Bearer ${this.options.token()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      throw new ManagedNativeQueueUncertainError(
        `The managed queue ${action} response was lost; reconcile the original operation.`,
        error,
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const record =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : null;
      if (response.status >= 500)
        throw new ManagedNativeQueueUncertainError(
          `The managed queue ${action} acknowledgment is uncertain (HTTP ${response.status}); reconcile the original operation.`,
        );
      throw new CantripServerRequestError(
        typeof record?.error === "string"
          ? record.error
          : `Managed queue ${action} failed with HTTP ${response.status}.`,
        response.status,
        typeof record?.code === "string" ? record.code : null,
      );
    }
    try {
      return schema.parse(payload);
    } catch (error) {
      throw new ManagedNativeQueueUncertainError(
        `The managed queue ${action} acknowledgment could not be verified; reconcile the original operation.`,
        error,
      );
    }
  }

  read(input: Omit<ManagedQueueRead, "workerId">, signal?: AbortSignal) {
    return this.post(
      "read",
      managedQueueReadSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      managedQueueSnapshotSchema,
      signal,
    );
  }

  async lookup(
    input: { admission: Omit<ManagedQueueMutate["admission"], "workerId"> },
    signal?: AbortSignal,
  ) {
    const { admission } = managedQueueLookupSchema.parse({
      admission: { ...input.admission, workerId: this.options.workerId },
    });
    const result = await this.post(
      "lookup",
      { admission },
      managedQueueLookupResultSchema,
      signal,
    );
    if (
      result.found &&
      (result.receipt.operationId !== admission.operationId ||
        result.receipt.payloadDigest !== admission.payloadDigest ||
        result.receipt.chatId !== admission.session.chatId ||
        result.receipt.threadId !== admission.session.threadId ||
        result.receipt.method !== admission.method ||
        result.receipt.startsExecution)
    )
      throw new ManagedNativeQueueUncertainError(
        "The canonical queue lookup returned another operation.",
      );
    return result;
  }

  async mutate(
    input: Omit<ManagedQueueMutate, "admission"> & {
      admission: Omit<ManagedQueueMutate["admission"], "workerId">;
    },
    signal?: AbortSignal,
  ) {
    const body = managedQueueMutateSchema.parse({
      ...input,
      admission: { ...input.admission, workerId: this.options.workerId },
    });
    const result = await this.post(
      "mutate",
      body,
      managedQueueMutationResultSchema,
      signal,
    );
    if (
      result.receipt.operationId !== body.admission.operationId ||
      result.receipt.payloadDigest !== body.admission.payloadDigest ||
      result.receipt.chatId !== body.admission.session.chatId ||
      result.receipt.threadId !== body.admission.session.threadId ||
      result.receipt.method !== body.admission.method ||
      result.receipt.startsExecution
    ) {
      throw new ManagedNativeQueueUncertainError(
        "The canonical queue receipt belongs to another operation.",
      );
    }
    return result;
  }

  import(input: Omit<ManagedQueueImport, "workerId">, signal?: AbortSignal) {
    return this.post(
      "import",
      managedQueueImportSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      managedQueueImportResultSchema,
      signal,
    );
  }

  acknowledgeImport(
    input: Omit<ManagedQueueImportAck, "workerId">,
    signal?: AbortSignal,
  ) {
    return this.post(
      "import-ack",
      managedQueueImportAckSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      managedQueueSnapshotSchema,
      signal,
    );
  }

  async startReceipt(
    input: Omit<ManagedQueueStartReceipt, "workerId">,
    signal?: AbortSignal,
  ) {
    const result = await this.post(
      "start-receipt",
      managedQueueStartReceiptSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      managedQueueStartReceiptResultSchema,
      signal,
    );
    if (
      result.claim.id !== input.claimId ||
      result.claim.chatId !== input.session.chatId ||
      result.receipt.chatId !== input.session.chatId ||
      result.receipt.threadId !== input.session.threadId ||
      result.claim.operationId !== result.receipt.operationId ||
      result.claim.operationGeneration !== result.receipt.operationGeneration ||
      ![
        "turn/start",
        "thread/shellCommand",
        "thread/settings/update",
        "thread/goal/set",
        "thread/goal/clear",
      ].includes(result.receipt.method) ||
      result.receipt.status !== "applied"
    ) {
      throw new ManagedNativeQueueUncertainError(
        "The canonical queue start receipt belongs to another claim.",
      );
    }
    return result;
  }
}
