import { z } from "zod";
import { remoteCursorSpriteSchema } from "@cantrip/protocol";
import { CuaProcessError } from "./errors.js";
import { waitBeforeCuaSend } from "./cancellation.js";
import type { CuaTransport } from "./transport.js";
import {
  cuaIdSchema,
  cuaInventorySchema,
  cuaTargetReferenceSchema,
  cuaTargetSchema,
  cuaSessionSchema,
  type CuaPoint,
  type CuaTargetReference,
} from "./types.js";

const bindingSchema = z.strictObject({
  workerId: cuaIdSchema,
  surfaceId: cuaIdSchema,
  attachmentId: cuaIdSchema,
  participantId: cuaIdSchema,
});
export type InteractionBinding = z.infer<typeof bindingSchema>;
type Modifier = "Shift" | "Control" | "Alt" | "Meta";
type Button = "left" | "middle" | "right" | "back" | "forward";
/** Shared Rust InputEvent encoding. Native validation remains authoritative. */
export type InteractionEvent =
  | { type: "pointerMove"; data: { point: CuaPoint; modifiers: Modifier[] } }
  | {
      type: "pointerDown";
      data: { point: CuaPoint; button: Button; modifiers: Modifier[] };
    }
  | { type: "pointerUp"; data: { point: CuaPoint; button: Button } }
  | {
      type: "keyDown";
      data: { key: string; modifiers: Modifier[]; repeat: boolean };
    }
  | { type: "keyUp"; data: { key: string } }
  | {
      type: "scroll";
      data: {
        point: CuaPoint;
        deltaX: number;
        deltaY: number;
        modifiers: Modifier[];
      };
    }
  | { type: "text"; data: { type: "commit"; data: string } }
  | { type: "prepareSurface" };
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const cursorSchema = cuaSessionSchema.shape.cursor.extend({
  action: z
    .strictObject({
      method: z.literal("remote-pointer"),
      outcome: z.literal("dispatched"),
      atMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .optional(),
});
const spriteSchema = remoteCursorSpriteSchema
  .extend({
    hotspot: remoteCursorSpriteSchema.shape.hotspot.strict(),
  })
  .strict();
export type InteractionSprite = z.infer<typeof spriteSchema>;
const openedSchema = z.strictObject({
  sprite: spriteSchema.nullable().optional(),
  handle: integer,
  target: cuaTargetSchema,
  cursor: cursorSchema,
});
const receiptSchema = z.strictObject({
  handle: integer,
  sequence: integer,
  outcome: z.literal("dispatched"),
  windowDelivery: z.literal("unverified"),
  cursor: cursorSchema,
});
export type InteractionReceipt = z.infer<typeof receiptSchema>;
export interface InteractionParticipant {
  readonly initial: z.infer<typeof openedSchema>;
  send(
    sequence: number,
    event: InteractionEvent,
    signal?: AbortSignal,
  ): Promise<InteractionReceipt>;
  close(): Promise<void>;
}
interface Runtime {
  transport: CuaTransport;
}
interface Owner {
  runtime(signal: AbortSignal): Promise<Runtime>;
  isCurrent(runtime: Runtime): boolean;
  authorize(binding: InteractionBinding): void;
  background(work: Promise<void>): void;
}
interface Record {
  binding: InteractionBinding;
  identity: string;
  controller: AbortController;
  runtime: Runtime | null;
  starting: Promise<z.infer<typeof openedSchema>>;
  queue: Promise<unknown>;
  closing: Promise<void> | null;
  retired: boolean;
  lastSequence: number;
}

/** Worker-only adapter. Callers derive bindings from authorized remote attachments.
 * Never exposed as agent tools or to arbitrary client-supplied native handles. */
export class WorkerInputParticipants {
  private readonly records = new Set<Record>();
  constructor(private readonly owner: Owner) {}

  async open(
    input: InteractionBinding,
    targetInput: CuaTargetReference | string,
    signal?: AbortSignal,
  ): Promise<InteractionParticipant> {
    const binding = bindingSchema.parse(input);
    const requested =
      typeof targetInput === "string"
        ? cuaIdSchema.parse(targetInput)
        : cuaTargetReferenceSchema.parse(targetInput);
    this.owner.authorize(binding);
    if (signal?.aborted) throw new CuaProcessError("cancelled", "not-sent");
    const identity = JSON.stringify(binding);
    if ([...this.records].some((record) => record.identity === identity))
      throw new CuaProcessError("invalid-request", "not-sent");
    if (this.records.size >= 16)
      throw new CuaProcessError("capacity", "not-sent");
    const record: Record = {
      binding,
      identity,
      controller: new AbortController(),
      runtime: null,
      starting: Promise.resolve(null!),
      queue: Promise.resolve(),
      closing: null,
      retired: false,
      lastSequence: 0,
    };
    this.records.add(record);
    const abort = () => record.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    record.starting = (async () => {
      const runtime = await this.owner.runtime(record.controller.signal);
      record.runtime = runtime;
      this.assertLive(record);
      let target = typeof requested === "string" ? null : requested;
      let after: string | undefined;
      while (!target) {
        const inventory = await runtime.transport.request(
          { operation: "targets.list", ...(after ? { after } : {}) },
          { signal: record.controller.signal },
        );
        if (inventory.payload.length)
          throw new CuaProcessError("protocol-error", "unknown");
        const page = cuaInventorySchema.parse(inventory.data);
        const selected = page.targets.find(
          (candidate) => candidate.id === requested,
        );
        if (selected)
          target = {
            targetId: selected.id,
            targetGeneration: selected.generation,
          };
        else if (!page.nextCursor || (after && page.nextCursor <= after))
          throw new CuaProcessError("invalid-request", "not-sent");
        else after = page.nextCursor;
        this.assertLive(record);
      }
      const result = await runtime.transport.request(
        {
          operation: "interaction.request",
          request: {
            type: "open",
            binding,
            targetId: target.targetId,
            targetGeneration: target.targetGeneration,
          },
        },
        { signal: record.controller.signal },
      );
      const opened = openedSchema.parse(result.data);
      if (
        result.payload.length ||
        opened.target.id !== target.targetId ||
        opened.target.generation !== target.targetGeneration ||
        opened.target.kind !== "window"
      )
        throw new CuaProcessError("protocol-error", "unknown");
      this.assertLive(record, "unknown");
      return opened;
    })();
    try {
      const initial = await record.starting;
      const handle = initial.handle;
      return {
        initial,
        send: (sequence, event, operationSignal) =>
          this.send(record, handle, sequence, event, operationSignal),
        close: () => this.retire(record),
      };
    } catch (error) {
      await this.retire(record);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  private assertLive(
    record: Record,
    outcome: "not-sent" | "unknown" = "not-sent",
  ): void {
    if (record.retired || record.controller.signal.aborted)
      throw new CuaProcessError("cancelled", outcome);
    if (!record.runtime || !this.owner.isCurrent(record.runtime))
      throw new CuaProcessError("process-exited", outcome);
  }
  private async send(
    record: Record,
    handle: number,
    sequence: number,
    event: InteractionEvent,
    signal?: AbortSignal,
  ): Promise<InteractionReceipt> {
    this.assertLive(record);
    if (
      !Number.isSafeInteger(sequence) ||
      sequence <= record.lastSequence ||
      sequence <= 0
    )
      throw new CuaProcessError("invalid-request", "not-sent");
    record.lastSequence = sequence;
    // Capture input now: callers may reuse or mutate event objects while queued.
    const submitted = structuredClone(event);
    const operationSignal = AbortSignal.any([
      record.controller.signal,
      ...(signal ? [signal] : []),
    ]);
    const previous = record.queue;
    const operation = (async () => {
      try {
        await waitBeforeCuaSend(
          previous.catch(() => {}),
          operationSignal,
        );
        this.assertLive(record);
        const result = await record.runtime!.transport.request(
          {
            operation: "interaction.request",
            request: {
              type: "input",
              binding: record.binding,
              handle,
              sequence,
              event: submitted,
            },
          },
          { signal: operationSignal },
        );
        const receipt = receiptSchema.parse(result.data);
        if (
          result.payload.length ||
          receipt.handle !== handle ||
          receipt.sequence !== sequence
        )
          throw new CuaProcessError("protocol-error", "unknown");
        if (operationSignal.aborted)
          throw new CuaProcessError("cancelled", "unknown");
        this.assertLive(record, "unknown");
        return receipt;
      } catch (error) {
        await this.retire(record);
        throw error;
      }
    })();
    record.queue = operation;
    return operation;
  }
  private retire(record: Record): Promise<void> {
    if (record.closing) return record.closing;
    record.retired = true;
    record.controller.abort();
    record.closing = (async () => {
      await record.starting.catch(() => {});
      const runtime = record.runtime;
      // Never reacquire a runtime to clean up an old handle. This also releases
      // native opens whose response was lost before the worker knew their handle.
      if (runtime && !runtime.transport.closed) {
        await runtime.transport.request(
          {
            operation: "interaction.request",
            request: { type: "closeBinding", binding: record.binding },
          },
          { lifecycle: true },
        );
      }
    })().finally(() => this.records.delete(record));
    this.owner.background(record.closing);
    return record.closing;
  }
  runtimeFailed(runtime: Runtime): void {
    for (const record of this.records)
      if (record.runtime === runtime)
        this.owner.background(this.retire(record));
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.records].map((record) => this.retire(record)));
  }
}
