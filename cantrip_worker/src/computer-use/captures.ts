import { z } from "zod";
import { CuaProcessError } from "./errors.js";
import type { CuaTransport } from "./transport.js";
import type { InteractionBinding } from "./participants.js";
import {
  cuaTargetSchema,
  cuaInventorySchema,
  cuaIdSchema,
  type CuaTargetReference,
} from "./types.js";

interface Runtime {
  transport: CuaTransport;
}
export interface CaptureOwner {
  runtime(signal: AbortSignal): Promise<Runtime>;
  isCurrent(runtime: Runtime): boolean;
  authorize(binding: InteractionBinding): void;
  background(work: Promise<void>): void;
}
const bindingSchema = z.strictObject({
  workerId: cuaIdSchema,
  surfaceId: cuaIdSchema,
  attachmentId: cuaIdSchema,
  participantId: cuaIdSchema,
});
const openedSchema = z.strictObject({
  handle: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  target: cuaTargetSchema,
});
const frameSchema = openedSchema.extend({
  image: z.strictObject({
    mediaType: z.literal("image/png"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    cursorIncluded: z.literal(false),
  }),
});
export interface RemoteCapture {
  readonly initial: z.infer<typeof openedSchema>;
  frame(
    signal?: AbortSignal,
  ): Promise<{
    target: z.infer<typeof cuaTargetSchema>;
    png: Buffer;
    width: number;
    height: number;
  }>;
  close(): Promise<void>;
}
interface Record {
  binding: InteractionBinding;
  controller: AbortController;
  runtime: Runtime | null;
  starting: Promise<z.infer<typeof openedSchema>>;
  closing: Promise<void> | null;
  retired: boolean;
}
/** Capture-only worker lifetimes. Never represented as fake agent sessions. */
export class WorkerCaptures {
  private readonly records = new Set<Record>();
  constructor(private readonly owner: CaptureOwner) {}
  async open(
    input: InteractionBinding,
    target: CuaTargetReference,
    signal?: AbortSignal,
  ): Promise<RemoteCapture> {
    const binding = bindingSchema.parse(input);
    this.owner.authorize(binding);
    if (signal?.aborted) throw new CuaProcessError("cancelled", "not-sent");
    if (
      [...this.records].some(
        (r) => JSON.stringify(r.binding) === JSON.stringify(binding),
      )
    )
      throw new CuaProcessError("invalid-request", "not-sent");
    const record: Record = {
      binding,
      controller: new AbortController(),
      runtime: null,
      starting: Promise.resolve(null!),
      closing: null,
      retired: false,
    };
    this.records.add(record);
    const abort = () => record.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const requested = structuredClone(target);
    record.starting = (async () => {
      const runtime = await this.owner.runtime(record.controller.signal);
      record.runtime = runtime;
      this.assertLive(record);
      const response = await runtime.transport.request(
        {
          operation: "capture.request",
          request: { type: "open", binding, ...requested },
        },
        { signal: record.controller.signal },
      );
      const initial = openedSchema.parse(response.data);
      if (
        response.payload.length ||
        initial.target.id !== requested.targetId ||
        initial.target.generation !== requested.targetGeneration
      )
        throw new CuaProcessError("protocol-error", "unknown");
      this.assertLive(record);
      return initial;
    })();
    try {
      const initial = await record.starting;
      return {
        initial,
        frame: (signal) => this.frame(record, initial.handle, signal),
        close: () => this.retire(record),
      };
    } catch (error) {
      await this.retire(record);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async inventory(
    binding: InteractionBinding,
    signal = new AbortController().signal,
  ) {
    this.owner.authorize(bindingSchema.parse(binding));
    const runtime = await this.owner.runtime(signal);
    const targets: z.infer<typeof cuaTargetSchema>[] = [];
    let after: string | undefined;
    do {
      const response = await runtime.transport.request(
        { operation: "targets.list", ...(after ? { after } : {}) },
        { signal },
      );
      if (response.payload.length)
        throw new CuaProcessError("protocol-error", "unknown");
      const page = cuaInventorySchema.parse(response.data);
      targets.push(...page.targets);
      if (page.nextCursor && after && page.nextCursor <= after)
        throw new CuaProcessError("protocol-error", "unknown");
      after = page.nextCursor ?? undefined;
    } while (after);
    if (!this.owner.isCurrent(runtime))
      throw new CuaProcessError("process-exited", "not-sent");
    return targets;
  }
  private assertLive(record: Record) {
    if (record.retired || record.controller.signal.aborted)
      throw new CuaProcessError("cancelled", "not-sent");
    if (!record.runtime || !this.owner.isCurrent(record.runtime))
      throw new CuaProcessError("process-exited", "not-sent");
  }
  private async frame(record: Record, handle: number, signal?: AbortSignal) {
    this.assertLive(record);
    const combined = AbortSignal.any([
      record.controller.signal,
      ...(signal ? [signal] : []),
    ]);
    // Observation failure does not revoke input or replay any application action.
    const response = await record.runtime!.transport.request(
      {
        operation: "capture.request",
        request: { type: "frame", binding: record.binding, handle },
      },
      { signal: combined },
    );
    const result = frameSchema.parse(response.data);
    const initial = await record.starting;
    if (
      result.handle !== handle ||
      result.target.id !== initial.target.id ||
      result.target.generation !== initial.target.generation ||
      !response.payload.length
    )
      throw new CuaProcessError("protocol-error", "unknown");
    this.assertLive(record);
    if (combined.aborted) throw new CuaProcessError("cancelled", "unknown");
    return {
      target: result.target,
      png: response.payload,
      width: result.image.width,
      height: result.image.height,
    };
  }
  private retire(record: Record): Promise<void> {
    if (record.closing) return record.closing;
    record.retired = true;
    record.controller.abort();
    record.closing = (async () => {
      await record.starting.catch(() => {});
      const runtime = record.runtime;
      if (runtime && !runtime.transport.closed)
        await runtime.transport.request(
          {
            operation: "capture.request",
            request: { type: "closeBinding", binding: record.binding },
          },
          { lifecycle: true },
        );
    })().finally(() => this.records.delete(record));
    this.owner.background(record.closing);
    return record.closing;
  }
  runtimeFailed(runtime: Runtime) {
    for (const record of this.records)
      if (record.runtime === runtime)
        this.owner.background(this.retire(record));
  }
  async closeAll() {
    await Promise.all([...this.records].map((record) => this.retire(record)));
  }
}
