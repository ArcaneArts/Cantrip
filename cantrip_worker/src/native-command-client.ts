import {
  nativeCommandAdmissionSchema,
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
  type NativeCommandReceipt,
  type NativeCommandDispatch,
  type NativeCommandContinuation,
  type NativeCommandSettlement,
  type NativePendingRequest,
} from "@cantrip/protocol";
import { z } from "zod";
import { CantripServerRequestError } from "./cli-client.js";

export interface NativeCommandClientOptions {
  serverUrl: string;
  workerId: string;
  token(): string;
  fetch?: typeof fetch;
}

/** Short admission transactions only; never hold a request open for a model turn. */
export class NativeCommandClient {
  constructor(private readonly options: NativeCommandClientOptions) {}

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

  async admit(input: Omit<NativeCommandAdmission, "workerId">) {
    const result = await this.post(
      "admit",
      nativeCommandAdmissionSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      nativeCommandAdmissionResultSchema,
    );
    this.correlate(result.receipt, input);
    return result;
  }

  async dispatch(input: Omit<NativeCommandDispatch, "workerId">) {
    const result = await this.post(
      "dispatch",
      nativeCommandDispatchSchema.parse({
        ...input,
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

  async settle(input: Omit<NativeCommandSettlement, "workerId">) {
    const result = await this.post(
      "receipt",
      nativeCommandSettlementSchema.parse({
        ...input,
        workerId: this.options.workerId,
      }),
      nativeCommandSettlementResultSchema,
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
