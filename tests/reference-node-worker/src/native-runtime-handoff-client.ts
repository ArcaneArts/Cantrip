import {
  nativeRuntimeHandoffStateSchema,
  nativeRuntimeHandoffConfigurationRequestSchema,
  nativeRuntimeHandoffConfigurationSchema,
  type NativeRuntimeHandoffConfigurationRequest,
  nativeRuntimeHandoffWorkerRequestSchema,
  type NativeRuntimeHandoffWorkerRequest,
} from "@cantrip/protocol";
import { setTimeout as delay } from "node:timers/promises";
import type { NativeCommandClientOptions } from "./native-command-client.js";
import { CantripServerRequestError } from "./cli-client.js";

const handoffEndpoint = "/api/internal/native-runtime-handoffs";
const settlementRetryWindowMs = 60_000;
const settlementAttemptTimeoutMs = 15_000;

type WorkerAction = NativeRuntimeHandoffWorkerRequest extends infer Request
  ? Request extends NativeRuntimeHandoffWorkerRequest
    ? Omit<Request, "workerId">
    : never
  : never;

/** Recovery queries the durable operation before advancing it. An HTTP failure
 * never implies rollback and never authorizes a new transfer identity. */
export class NativeRuntimeHandoffClient {
  constructor(private readonly options: NativeCommandClientOptions) {}

  async request(action: WorkerAction, signal?: AbortSignal) {
    const input = nativeRuntimeHandoffWorkerRequestSchema.parse({
      ...action,
      workerId: this.options.workerId,
    });
    const body =
      input.action === "commit" ||
      (input.action === "finish" && input.outcome === "completed")
        ? await this.sendSettlement(input, signal)
        : await this.send(handoffEndpoint, input, signal);
    const result = nativeRuntimeHandoffStateSchema.parse(body);
    if (
      result.operationId !== input.operationId ||
      result.chatId !== input.chatId ||
      result.workerId !== input.workerId
    )
      throw new Error(
        "Native runtime handoff response belongs to another operation.",
      );
    return result;
  }
  async configuration(
    action: Omit<NativeRuntimeHandoffConfigurationRequest, "workerId">,
    signal?: AbortSignal,
  ) {
    const input = nativeRuntimeHandoffConfigurationRequestSchema.parse({
      ...action,
      workerId: this.options.workerId,
    });
    const result = nativeRuntimeHandoffConfigurationSchema.parse(
      await this.send(
        "/api/internal/native-runtime-handoffs/configuration",
        input,
        signal,
      ),
    );
    if (
      result.state.operationId !== input.operationId ||
      result.state.chatId !== input.chatId ||
      result.state.workerId !== input.workerId ||
      result.side !== input.side ||
      ("session" in result.configuration
        ? result.configuration.session.chatId
        : result.configuration.task.chatId) !== input.chatId ||
      result.configuration.threadId !== result.state.source.threadId
    )
      throw new Error("Handoff configuration belongs to another operation.");
    return result;
  }

  private async sendSettlement(
    input: NativeRuntimeHandoffWorkerRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const deadline = performance.now() + settlementRetryWindowMs;
    let backoff = 500;
    for (;;) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(
        Math.min(
          settlementAttemptTimeoutMs,
          Math.max(1, Math.ceil(deadline - performance.now())),
        ),
      );
      try {
        return await this.send(
          handoffEndpoint,
          input,
          signal ? AbortSignal.any([signal, timeout]) : timeout,
        );
      } catch (error) {
        signal?.throwIfAborted();
        const retryable =
          timeout.aborted ||
          error instanceof TypeError ||
          (error instanceof CantripServerRequestError &&
            (error.status >= 500 ||
              error.status === 408 ||
              error.status === 429));
        const remaining = deadline - performance.now();
        if (!retryable || remaining <= 0) throw error;
        // Commit and completed finish replay the same durable operation. Keep
        // its staging hold while PostgreSQL or the HTTP response is unavailable.
        await delay(Math.min(remaining, backoff), undefined, {
          signal,
          ref: false,
        });
        backoff = Math.min(backoff * 2, 5_000);
      }
    }
  }

  private async send(
    endpoint: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(
      new URL(endpoint, this.options.serverUrl),
      {
        method: "POST",
        redirect: "error",
        ...(signal ? { signal } : {}),
        headers: {
          authorization: `Bearer ${this.options.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    const body: unknown = await response.json().catch((error) => {
      if (response.ok && (error instanceof TypeError || signal?.aborted))
        throw error;
      return null;
    });
    if (!response.ok) {
      const failure =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      throw new CantripServerRequestError(
        typeof failure.error === "string"
          ? failure.error
          : `Native runtime handoff failed with HTTP ${response.status}.`,
        response.status,
        typeof failure.code === "string" ? failure.code : null,
      );
    }
    return body;
  }
}
