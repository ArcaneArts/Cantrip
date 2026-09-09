import { z } from "zod";
import { isDeepStrictEqual } from "node:util";

export const nativeSettingsVersionSchema = z
  .object({
    epoch: z.string().min(1),
    revision: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,19})$/u)
      .refine(
        (value) =>
          /^(0|[1-9][0-9]{0,19})$/u.test(value) &&
          BigInt(value) <= 18_446_744_073_709_551_615n,
      ),
  })
  .strict();

// Preserve native security/profile material and future fields verbatim. Mapping
// these values to authorized Cantrip profiles belongs to the managed controller.
export const nativeThreadSettingsSchema = z
  .object({
    settingsVersion: nativeSettingsVersionSchema.optional(),
    cwd: z.string(),
    approvalPolicy: z.union([z.string(), z.record(z.string(), z.json())]),
    approvalsReviewer: z.string(),
    sandboxPolicy: z.record(z.string(), z.json()),
    activePermissionProfile: z.json(),
    model: z.string(),
    modelProvider: z.string(),
    effort: z.string().nullable(),
    serviceTier: z.string().nullable(),
    summary: z.string().nullable(),
    collaborationMode: z
      .object({
        mode: z.enum(["default", "plan"]),
        settings: z.record(z.string(), z.json()),
      })
      .catchall(z.json()),
    multiAgentMode: z.string().optional(),
    personality: z.string().nullable(),
  })
  .catchall(z.json());

export type NativeThreadSettings = z.infer<typeof nativeThreadSettingsSchema>;
export interface NativeSettingsObservation {
  /** Local observation order only; never a durable settings revision. */
  sequence: number;
  operationId: string | null;
  submissionId: string | null;
  settings: NativeThreadSettings;
}
export interface NativeSettingsRequest {
  operationId: string;
  submissionId: string | null;
  patch: Record<string, unknown>;
  status: "requesting" | "queued" | "applied" | "rejected" | "uncertain";
  applied: NativeSettingsObservation | null;
  error: Record<string, unknown> | null;
}

const notificationSchema = z.object({
  threadId: z.string().min(1),
  operationId: z.string().optional(),
  submissionId: z.string().optional(),
  threadSettings: nativeThreadSettingsSchema,
});
const acknowledgmentSchema = z.object({
  operationId: z.string(),
  submissionId: z.string().min(1),
});

/** Transport-local evidence. The server still owns durable revisions/admission. */
export class NativeThreadSettingsState {
  private sequence = 0;
  private readonly inFlight = new WeakSet<NativeSettingsRequest>();
  private readonly confirmed = new Map<string, NativeSettingsObservation>();
  private readonly requests = new Map<
    string,
    Map<string, NativeSettingsRequest>
  >();
  private readonly earlyErrors = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();

  confirmedPlanMode(threadId: string): "default" | "plan" | null {
    return (
      this.confirmed.get(threadId)?.settings.collaborationMode.mode ?? null
    );
  }

  read(threadId: string): {
    confirmed: NativeSettingsObservation | null;
    requests: NativeSettingsRequest[];
  } {
    return structuredClone({
      confirmed: this.confirmed.get(threadId) ?? null,
      requests: [...(this.requests.get(threadId)?.values() ?? [])],
    });
  }

  /** Pending intent is useful for deduplication, but is never confirmed state. */
  selectedPlanMode(threadId: string): "default" | "plan" | null {
    const requests = [...(this.requests.get(threadId)?.values() ?? [])];
    for (const request of requests.reverse()) {
      if (
        request.applied ||
        (request.status !== "requesting" && request.status !== "queued")
      )
        continue;
      const mode = (
        request.patch.collaborationMode as { mode?: unknown } | undefined
      )?.mode;
      if (mode === "default" || mode === "plan") return mode;
    }
    return (
      this.confirmed.get(threadId)?.settings.collaborationMode.mode ?? null
    );
  }

  begin(
    threadId: string,
    operationId: string,
    patch: Record<string, unknown>,
  ): NativeSettingsRequest {
    let requests = this.requests.get(threadId);
    if (!requests) this.requests.set(threadId, (requests = new Map()));
    if (requests.has(operationId))
      throw new Error("Native settings operation identity was reused.");
    // Terminal results are available until the next request. Do not retain an
    // unbounded lifetime log or remove unresolved requests while acks are pending.
    for (const [id, request] of requests) {
      if (
        !this.inFlight.has(request) &&
        (request.status === "applied" || request.status === "rejected")
      )
        requests.delete(id);
    }
    const request: NativeSettingsRequest = {
      operationId,
      submissionId: null,
      patch: structuredClone(patch),
      status: "requesting",
      applied: null,
      error: null,
    };
    requests.set(operationId, request);
    this.inFlight.add(request);
    return request;
  }

  acknowledge(
    threadId: string,
    request: NativeSettingsRequest,
    value: unknown,
  ): void {
    this.assertCurrent(threadId, request);
    this.inFlight.delete(request);
    const parsed = acknowledgmentSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.operationId !== request.operationId ||
      (request.submissionId &&
        request.submissionId !== parsed.data.submissionId) ||
      (request.applied &&
        request.applied.submissionId !== parsed.data.submissionId)
    ) {
      request.status = "uncertain";
      throw new Error(
        "Native settings acknowledgment is not correlated; application is unconfirmed.",
      );
    }
    request.submissionId = parsed.data.submissionId;
    request.error ??=
      this.earlyErrors.get(threadId)?.get(request.submissionId) ?? null;
    request.status =
      request.applied && request.error
        ? "uncertain"
        : request.applied
          ? "applied"
          : request.error
            ? "rejected"
            : "queued";
    if (
      ![...(this.requests.get(threadId)?.values() ?? [])].some(
        (pending) => pending.status === "requesting",
      )
    )
      this.earlyErrors.delete(threadId);
  }

  failed(
    threadId: string,
    request: NativeSettingsRequest,
    rejected: boolean,
  ): void {
    this.inFlight.delete(request);
    if (this.requests.get(threadId)?.get(request.operationId) !== request)
      return;
    // A lost RPC response cannot erase actual applied evidence.
    if (request.status === "uncertain" || request.status === "rejected") return;
    request.status = request.applied
      ? "applied"
      : rejected
        ? "rejected"
        : "uncertain";
  }

  observe(value: unknown): {
    threadId: string;
    observation: NativeSettingsObservation;
  } {
    const params = notificationSchema.parse(value);
    const observation: NativeSettingsObservation = {
      sequence: ++this.sequence,
      operationId: params.operationId ?? null,
      submissionId: params.submissionId ?? null,
      settings: params.threadSettings,
    };
    const previous = this.confirmed.get(params.threadId);
    const previousVersion = previous?.settings.settingsVersion;
    const version = observation.settings.settingsVersion;
    let replace = true;
    if (previousVersion) {
      if (!version)
        replace = false; // An older unversioned sample cannot roll back a known version.
      else if (previousVersion.epoch !== version.epoch)
        throw new Error(
          "Native settings epoch changed without retiring the thread observation.",
        );
      else if (BigInt(version.revision) < BigInt(previousVersion.revision))
        replace = false;
      else if (
        version.revision === previousVersion.revision &&
        !isDeepStrictEqual(previous.settings, observation.settings)
      )
        throw new Error(
          "Native settings version was reused with different settings.",
        );
    }
    if (replace) this.confirmed.set(params.threadId, observation);
    const request = params.operationId
      ? this.requests.get(params.threadId)?.get(params.operationId)
      : undefined;
    if (request && params.submissionId) {
      if (
        request.submissionId &&
        request.submissionId !== params.submissionId
      ) {
        request.status = "uncertain";
      } else {
        request.applied = observation;
        // Keep the request registered until its RPC response is checked too.
        if (request.error) request.status = "uncertain";
        else if (request.submissionId) request.status = "applied";
      }
    }
    return structuredClone({ threadId: params.threadId, observation });
  }

  /** Native asynchronous settings errors use the submission ID as turnId. */
  observeError(value: unknown): boolean {
    const parsed = z
      .object({
        threadId: z.string(),
        turnId: z.string(),
        error: z.object({ message: z.string() }).catchall(z.unknown()),
        willRetry: z.boolean(),
      })
      .safeParse(value);
    if (!parsed.success || parsed.data.willRetry) return false;
    const { threadId, turnId, error } = parsed.data;
    const pending = [...(this.requests.get(threadId)?.values() ?? [])];
    const scoped = z
      .object({
        threadSettingsUpdateFailed: z.object({
          operationId: z.string().nullable(),
        }),
      })
      .safeParse(error.codexErrorInfo);
    const operationId = scoped.success
      ? scoped.data.threadSettingsUpdateFailed.operationId
      : null;
    const request =
      operationId !== null
        ? pending.find((candidate) => candidate.operationId === operationId)
        : pending.find((candidate) => candidate.submissionId === turnId);
    if (request) {
      if (request.submissionId && request.submissionId !== turnId) {
        request.status = "uncertain";
        return false;
      }
      request.submissionId = turnId;
      request.error = structuredClone(error);
      request.status = request.applied ? "uncertain" : "rejected";
      return true;
    }
    // An error can precede its queue acknowledgment. Do not attribute it to any
    // request until the native submission ID arrives, or consume a turn error.
    if (
      operationId === null &&
      pending.some((candidate) => candidate.status === "requesting")
    ) {
      let errors = this.earlyErrors.get(threadId);
      if (!errors) this.earlyErrors.set(threadId, (errors = new Map()));
      errors.set(turnId, structuredClone(error));
    }
    return false;
  }

  forget(threadId: string): void {
    this.confirmed.delete(threadId);
    this.requests.delete(threadId);
    this.earlyErrors.delete(threadId);
  }

  clear(): void {
    this.confirmed.clear();
    this.requests.clear();
    this.earlyErrors.clear();
  }

  private assertCurrent(
    threadId: string,
    request: NativeSettingsRequest,
  ): void {
    if (this.requests.get(threadId)?.get(request.operationId) !== request)
      throw new Error(
        "Native settings thread closed or changed before acknowledgment.",
      );
  }
}
