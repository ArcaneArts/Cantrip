import {
  nativeRuntimeHandoffStateSchema,
  nativeRuntimeHandoffWorkerRequestSchema,
  type NativeRuntimeHandoffWorkerRequest,
} from "@cantrip/protocol";
import type { NativeCommandClientOptions } from "./native-command-client.js";
import { CantripServerRequestError } from "./cli-client.js";

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
    const response = await (this.options.fetch ?? fetch)(
      new URL("/api/internal/native-runtime-handoffs", this.options.serverUrl),
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
    const body: unknown = await response.json().catch(() => null);
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
}
