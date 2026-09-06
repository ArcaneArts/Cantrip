import { z } from "zod";

import { endpointContentOpaqueSchema } from "./endpoint-content.js";

export const CUA_CHUNK_BYTES = 256 * 1024;
export const CUA_MAX_CHUNKS = 64;
export const CUA_CONTROL_BYTES = 16 * 1024 * 1024;
export const CUA_MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
export const CUA_MAX_TIMELINE_FRAMES = 131072;
export const CUA_MAX_TIMELINE_MS = 7_200_000;

// Shared with native boundary validation. No Node globals are required by the
// browser/client schema: these limits count UTF-8 bytes, not UTF-16 code units.
const utf8 = new TextEncoder();
const boundedText = (bytes: number) =>
  z.string().refine((value) => utf8.encode(value).byteLength <= bytes);
export const cuaIdSchema = boundedText(256).refine(
  (value) => value.length > 0 && !/\p{Cc}/u.test(value),
);
const sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const cuaPointSchema = z.strictObject({ x: z.number(), y: z.number() });
export const cuaTargetReferenceSchema = z.strictObject({
  targetId: cuaIdSchema,
  targetGeneration: sequence,
});
export const cuaTargetSchema = z.strictObject({
  id: cuaIdSchema,
  generation: sequence,
  kind: z.enum(["monitor", "window"]),
  title: boundedText(4096).nullable(),
  application: boundedText(1024).nullable(),
  processId: z.number().int().min(0).max(0xffff_ffff).nullable(),
  bounds: z.strictObject({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  pixelWidth: z.number().int().positive().max(0xffff_ffff),
  pixelHeight: z.number().int().positive().max(0xffff_ffff),
  scaleFactor: z.number().positive(),
  focused: z.boolean().nullable(),
  minimized: z.boolean().nullable(),
});
export const cuaCursorAppearanceSchema = z.strictObject({
  version: z.literal(1),
  style: z.enum(["arrow", "dot", "ring", "crosshair"]),
  color: z.string().regex(/^#[\da-f]{6}(?:[\da-f]{2})?$/iu),
  size: z.number().int().min(8).max(96),
  label: boundedText(256)
    .refine((value) => [...value].length <= 64 && !/\p{Cc}/u.test(value))
    .nullable(),
  trail: z.boolean(),
  visible: z.boolean(),
});
export const cuaScopeSchema = z.strictObject({
  serverId: cuaIdSchema,
  ownerId: cuaIdSchema,
  workerId: cuaIdSchema,
  chatId: cuaIdSchema,
  taskId: cuaIdSchema.nullable(),
  threadId: cuaIdSchema.nullable(),
  turnId: cuaIdSchema.nullable(),
});
export const cuaBindingSchema = cuaScopeSchema
  .omit({ serverId: true, ownerId: true })
  .extend({ sessionId: cuaIdSchema });
export const cuaSessionSchema = z.strictObject({
  binding: cuaBindingSchema,
  target: cuaTargetSchema.nullable(),
  cursor: z.strictObject({
    appearance: cuaCursorAppearanceSchema,
    position: cuaPointSchema,
    trailPoints: z.array(cuaPointSchema).max(24),
    updatedAtMs: counter,
    revision: sequence,
    action: z
      .strictObject({
        method: z.enum([
          "accessibility",
          "coordinate",
          "process-coordinate",
          "background-coordinate",
          "background-text",
          "background-key",
          "background-drag",
          "background-scroll",
          "background-timeline",
          "focus",
          "window-input",
        ]),
        outcome: z.enum([
          "dispatched",
          "failed",
          "cancelled",
          "unsupported",
          "unknown",
        ]),
        atMs: counter,
      })
      .optional(),
  }),
  observationRevision: counter,
});
export const cuaCapabilitiesSchema = z.strictObject({
  protocolVersion: z.literal(1),
  runtimeVersion: z.string().min(1).max(64),
  backend: z.string().min(1).max(64),
  capture: z.boolean(),
  nativeInput: z.boolean(),
  javascript: z.boolean(),
  cursorAppearanceVersion: z.literal(1),
  operations: z.array(z.string().min(1).max(64)).max(32),
  maxSessions: z.number().int().min(1).max(16),
  maxImageBytes: z
    .number()
    .int()
    .min(1)
    .max(CUA_CHUNK_BYTES * CUA_MAX_CHUNKS),
});
export const cuaInventorySchema = z
  .strictObject({
    // Older/fake helpers omit this; a bounded native list must disclose omission.
    truncated: z.boolean().optional(),
    nextCursor: cuaIdSchema.optional(),
    targets: z
      .array(cuaTargetSchema)
      .max(256)
      .refine(
        (targets) =>
          new Set(targets.map((target) => target.id)).size === targets.length,
      ),
  })
  .refine(
    (page) =>
      page.nextCursor === undefined ||
      (page.truncated === true &&
        page.targets.length > 0 &&
        page.nextCursor === page.targets.at(-1)?.id &&
        page.targets.every(
          (target, index) =>
            index === 0 || page.targets[index - 1]!.id < target.id,
        )),
  );
export const cuaSessionResultSchema = z.strictObject({
  session: cuaSessionSchema,
});
export const cuaImageSchema = z
  .strictObject({
    mediaType: z.literal("image/png"),
    width: z.number().int().positive().max(4_194_304),
    height: z.number().int().positive().max(4_194_304),
    byteCount: z
      .number()
      .int()
      .positive()
      .max(CUA_CHUNK_BYTES * CUA_MAX_CHUNKS),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    cursorIncluded: z.literal(true),
  })
  .refine((image) => image.width * image.height <= 4_194_304);
export const cuaSnapshotSchema = cuaSessionResultSchema.extend({
  image: cuaImageSchema,
});

/** Transient, protected attribution for one completed agent observation. */
export const cuaAgentSourceSchema = z.strictObject({
  sourceId: z.string().uuid(),
  rootThreadId: cuaIdSchema,
  binding: cuaBindingSchema.extend({
    threadId: cuaIdSchema,
    turnId: cuaIdSchema,
  }),
  target: cuaTargetSchema,
  cursorRevision: sequence,
  observationRevision: sequence,
  observedAtMs: counter,
});
export const cuaAgentSourcesSchema = z.strictObject({
  sources: z
    .array(cuaAgentSourceSchema)
    .max(4)
    .refine(
      (sources) =>
        new Set(sources.map((source) => source.sourceId)).size ===
        sources.length,
    ),
});
export const cuaAgentObservationSchema = z
  .strictObject({
    source: cuaAgentSourceSchema,
    session: cuaSessionSchema,
    // The exact model rendition is shared; original capture geometry is retained
    // separately and the already-baked cursor is never drawn a second time.
    image: cuaImageSchema.refine(
      (image) => image.byteCount <= 2.5 * 1024 * 1024,
    ),
    nativeImage: cuaImageSchema,
  })
  .refine(
    ({ source, session, image, nativeImage }) =>
      JSON.stringify(source.binding) === JSON.stringify(session.binding) &&
      JSON.stringify(source.target) === JSON.stringify(session.target) &&
      source.cursorRevision === session.cursor.revision &&
      source.observationRevision === session.observationRevision &&
      image.width <= nativeImage.width &&
      image.height <= nativeImage.height,
    "Agent observation attribution and rendition must match the captured session.",
  );

const cuaControlSchema = z.strictObject({
  reference: cuaIdSchema,
  role: z.string().max(64),
  label: z.string().max(320).nullable(),
  bounds: cuaTargetSchema.shape.bounds.nullable(),
  actions: z.array(z.literal("press")).max(1),
});
export const cuaControlsResultSchema = z.strictObject({
  session: cuaSessionSchema,
  inspection: z.strictObject({
    controls: z.array(cuaControlSchema).max(32),
    truncated: z.boolean(),
  }),
});
const cuaTimelineFrameSchema = z.strictObject({
  atMs: z.number().int().min(0).max(CUA_MAX_TIMELINE_MS),
  keyDown: z.array(z.string().max(16)).max(16).default([]),
  keyUp: z.array(z.string().max(16)).max(16).default([]),
  pointerDown: cuaPointSchema.optional(),
  pointerUp: z.boolean().default(false),
  pointerModifiers: z
    .array(z.enum(["Shift", "Control", "Alt", "Meta"]))
    .max(4)
    .refine((items) => new Set(items).size === items.length)
    .default([]),
});
const cuaTimelineSchema = z
  .array(cuaTimelineFrameSchema)
  .min(1)
  .max(CUA_MAX_TIMELINE_FRAMES)
  .refine((frames) => {
    const held = new Set<string>();
    let pointer = false;
    let at = 0;
    const keys = new Set([
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Space",
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ]);
    for (const frame of frames) {
      if (frame.atMs < at) return false;
      if (frame.pointerModifiers.length && !frame.pointerDown) return false;
      at = frame.atMs;
      for (const key of frame.keyUp) {
        if (!held.delete(key)) return false;
      }
      for (const key of frame.keyDown) {
        if (!keys.has(key) || held.has(key)) return false;
        held.add(key);
      }
      if (held.size > 16) return false;
      if (frame.pointerUp) {
        if (!pointer) return false;
        pointer = false;
      }
      if (frame.pointerDown) {
        if (pointer) return false;
        pointer = true;
      }
    }
    return held.size === 0 && !pointer;
  }, "Timeline downs and ups must balance, with ordered times and at most 16 held keys.");

/** One bounded native macro; no raw key-down/up is exposed to agents. */
export const cuaInputCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("focus") }),
  z.strictObject({ kind: z.literal("window-input") }),
  z.strictObject({ kind: z.literal("timeline"), frames: cuaTimelineSchema }),
  z.strictObject({
    kind: z.literal("text"),
    text: z
      .string()
      .min(1)
      .max(8192)
      .refine(
        (value) =>
          new TextEncoder().encode(value).length <= 8192 &&
          !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) &&
          ![...value].some((char) => {
            const code = char.codePointAt(0)!;
            return code >= 0xd800 && code <= 0xdfff;
          }),
      ),
  }),
  z.strictObject({
    kind: z.literal("key"),
    key: z.enum([
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Space",
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
    ]),
    modifiers: z
      .array(z.enum(["Shift", "Control", "Alt", "Meta"]))
      .max(4)
      .refine((value) => new Set(value).size === value.length)
      .default([]),
  }),
  z.strictObject({
    kind: z.literal("drag"),
    start: cuaPointSchema,
    end: cuaPointSchema,
    durationMs: z.number().int().min(50).max(2000).default(200),
  }),
  z.strictObject({
    kind: z.literal("scroll"),
    deltaX: z.number().int().min(-10000).max(10000).default(0),
    deltaY: z.number().int().min(-10000).max(10000),
    point: cuaPointSchema.optional(),
  }),
]);
export type CuaInputCommand = z.infer<typeof cuaInputCommandSchema>;

export const cuaInputReceiptSchema = z.strictObject({
  control: cuaControlSchema.optional(),
  method: z.enum([
    "accessibility",
    "coordinate",
    "process-coordinate",
    "background-coordinate",
    "background-text",
    "background-key",
    "background-drag",
    "background-scroll",
    "background-timeline",
    "focus",
    "window-input",
  ]),
  activation: z.boolean(),
  outcome: z.enum(["dispatched", "unknown"]),
  windowDelivery: z.literal("unverified").optional(),
  position: cuaPointSchema.optional(),
  globalPosition: cuaPointSchema.optional(),
  effects: z
    .strictObject({
      sampling: z.literal("before-after-dispatch"),
      beforeAtMs: counter,
      afterAtMs: counter,
      pointer: z.enum(["unchanged", "changed", "unknown"]),
      foregroundApplication: z.enum(["unchanged", "changed", "unknown"]),
      foregroundWindow: z.enum(["unchanged", "changed", "unknown"]),
      windowOrder: z.enum(["unchanged", "changed", "unknown"]),
    })
    .optional(),
});
export const cuaInputResultSchema = z.strictObject({
  session: cuaSessionSchema,
  input: cuaInputReceiptSchema,
});
export type CuaControlsResult = z.infer<typeof cuaControlsResultSchema>;
export type CuaInputReceipt = z.infer<typeof cuaInputReceiptSchema>;
export type CuaInputResult = z.infer<typeof cuaInputResultSchema>;

export const CUA_REQUIRED_OPERATIONS = [
  "capabilities.get",
  "targets.list",
  "target.attach",
  "target.detach",
  "observation.snapshot",
  "cursor.configure",
  "cursor.move",
  "session.close",
] as const;

export const computerUseOperationSchema = z.enum([
  "capabilities.get",
  "controls.inspect",
  "input.press",
  "input.click",
  "input.perform",
  "agent.sources.list",
  "agent.observation.get",
  "targets.list",
  "session.open",
  "session.state",
  "target.attach",
  "target.detach",
  "cursor.configure",
  "cursor.move",
  "observation.snapshot",
  "session.close",
]);
const targetFields = cuaTargetReferenceSchema.shape;
const sessionFields = { sessionId: cuaIdSchema };

/** Decrypted action only. Execution authority is supplied separately by the server. */
export const computerUseActionSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("capabilities.get") }),
  z.strictObject({ operation: z.literal("agent.sources.list") }),
  z.strictObject({
    operation: z.literal("agent.observation.get"),
    sourceId: z.string().uuid(),
  }),
  z.strictObject({
    operation: z.literal("targets.list"),
    after: cuaIdSchema.optional(),
  }),
  z.strictObject({ operation: z.literal("session.open"), ...targetFields }),
  z.strictObject({ operation: z.literal("session.state"), ...sessionFields }),
  z.strictObject({
    operation: z.literal("target.attach"),
    ...sessionFields,
    ...targetFields,
  }),
  z.strictObject({ operation: z.literal("target.detach"), ...sessionFields }),
  z.strictObject({
    operation: z.literal("cursor.configure"),
    ...sessionFields,
    ...targetFields,
    appearance: cuaCursorAppearanceSchema,
  }),
  z.strictObject({
    operation: z.literal("cursor.move"),
    ...sessionFields,
    ...targetFields,
    position: cuaPointSchema,
  }),
  z.strictObject({
    operation: z.literal("observation.snapshot"),
    ...sessionFields,
    ...targetFields,
  }),
  z.strictObject({
    operation: z.literal("controls.inspect"),
    ...sessionFields,
    ...targetFields,
    position: cuaPointSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal("input.press"),
    ...sessionFields,
    ...targetFields,
    reference: cuaIdSchema,
  }),
  z.strictObject({
    operation: z.literal("input.click"),
    ...sessionFields,
    ...targetFields,
    position: cuaPointSchema.optional(),
    globalInput: z.boolean().optional(),
    delivery: z.enum(["process", "background"]).optional(),
  }),
  z.strictObject({
    operation: z.literal("input.perform"),
    ...sessionFields,
    ...targetFields,
    command: cuaInputCommandSchema,
  }),
  z.strictObject({ operation: z.literal("session.close"), ...sessionFields }),
]);

const opaqueContent = (plaintextBytes: number) =>
  endpointContentOpaqueSchema.refine(
    ({ domain, envelope }) =>
      domain === "client-control-content" &&
      envelope.ciphertext.length <= Math.ceil(((plaintextBytes + 16) * 4) / 3),
    "CUA content requires bounded client-control-content ciphertext.",
  );
const controlContentSchema = opaqueContent(CUA_CONTROL_BYTES);
const chunkContentSchema = opaqueContent(CUA_CHUNK_BYTES);

/** The relay sees routing/correlation only, never targets, input, or image bytes. */
export const computerUseRequestSchema = z.strictObject({
  operationId: z.string().uuid(),
  operation: computerUseOperationSchema,
  protectedContent: controlContentSchema,
  previewLeaseId: z.string().uuid().optional(),
});
export const computerUseChunkEventSchema = z.strictObject({
  type: z.literal("computer-use.snapshot.chunk"),
  operationId: z.string().uuid(),
  sequence: z
    .number()
    .int()
    .min(0)
    .max(CUA_MAX_CHUNKS - 1),
  protectedContent: chunkContentSchema,
});
export const computerUseResponseSchema = z.strictObject({
  operationId: z.string().uuid(),
  protectedContent: controlContentSchema,
});
export const computerUseHttpResultSchema = z.strictObject({
  response: computerUseResponseSchema,
  chunks: z.array(computerUseChunkEventSchema).max(CUA_MAX_CHUNKS),
});

const closedSchema = z.strictObject({ closed: z.literal(true) });
const resultDataSchemas = {
  "capabilities.get": cuaCapabilitiesSchema,
  "agent.sources.list": cuaAgentSourcesSchema,
  "agent.observation.get": cuaAgentObservationSchema,
  "targets.list": cuaInventorySchema,
  "session.open": cuaSessionResultSchema,
  "session.state": cuaSessionResultSchema,
  "target.attach": cuaSessionResultSchema,
  "target.detach": cuaSessionResultSchema,
  "cursor.configure": cuaSessionResultSchema,
  "cursor.move": cuaSessionResultSchema,
  "controls.inspect": cuaControlsResultSchema,
  "input.press": cuaInputResultSchema,
  "input.click": cuaInputResultSchema,
  "input.perform": cuaInputResultSchema,
  "observation.snapshot": cuaSnapshotSchema,
  "session.close": closedSchema,
} as const;

/** Decrypted result metadata. PNG bytes remain separate bounded encrypted chunks. */
export const computerUseResultContentSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("ok"),
      operation: computerUseOperationSchema,
      data: z.union([
        cuaCapabilitiesSchema,
        cuaInventorySchema,
        cuaControlsResultSchema,
        cuaInputResultSchema,
        cuaSessionResultSchema,
        cuaSnapshotSchema,
        cuaAgentSourcesSchema,
        cuaAgentObservationSchema,
        closedSchema,
      ]),
      chunkCount: z.number().int().min(0).max(CUA_MAX_CHUNKS),
    }),
    z.strictObject({
      status: z.literal("error"),
      operation: computerUseOperationSchema,
      code: z.string().min(1).max(80),
      message: z.string().min(1).max(512),
      outcome: z.enum(["not-sent", "unknown", "rejected"]),
    }),
  ])
  .superRefine((result, context) => {
    if (result.status === "error") return;
    const expected = resultDataSchemas[result.operation];
    if (!expected.safeParse(result.data).success) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "CUA result data does not match its operation.",
      });
      return;
    }
    const chunkCount =
      "image" in result.data
        ? Math.ceil(result.data.image.byteCount / CUA_CHUNK_BYTES)
        : 0;
    if (result.chunkCount !== chunkCount) {
      context.addIssue({
        code: "custom",
        path: ["chunkCount"],
        message: "CUA result chunk count does not match its image metadata.",
      });
    }
  });

export type CuaScope = z.infer<typeof cuaScopeSchema>;
export type CuaBinding = z.infer<typeof cuaBindingSchema>;
export type CuaSession = z.infer<typeof cuaSessionSchema>;
export type CuaTargetReference = z.infer<typeof cuaTargetReferenceSchema>;
export type CuaTarget = z.infer<typeof cuaTargetSchema>;
export type CuaCursorAppearance = z.infer<typeof cuaCursorAppearanceSchema>;
export type CuaPoint = z.infer<typeof cuaPointSchema>;
export type CuaCapabilities = z.infer<typeof cuaCapabilitiesSchema>;
export type CuaInventory = z.infer<typeof cuaInventorySchema>;
export type CuaSessionResult = z.infer<typeof cuaSessionResultSchema>;
export type CuaImage = z.infer<typeof cuaImageSchema>;
export type CuaSnapshot = z.infer<typeof cuaSnapshotSchema>;
export type CuaAgentSource = z.infer<typeof cuaAgentSourceSchema>;
export type CuaAgentSources = z.infer<typeof cuaAgentSourcesSchema>;
export type CuaAgentObservation = z.infer<typeof cuaAgentObservationSchema>;
export type ComputerUseOperation = z.infer<typeof computerUseOperationSchema>;
export type ComputerUseAction = z.infer<typeof computerUseActionSchema>;
export type ComputerUseRequest = z.infer<typeof computerUseRequestSchema>;
export type ComputerUseChunkEvent = z.infer<typeof computerUseChunkEventSchema>;
export type ComputerUseResponse = z.infer<typeof computerUseResponseSchema>;
export type ComputerUseHttpResult = z.infer<typeof computerUseHttpResultSchema>;
export type ComputerUseResultContent = z.infer<
  typeof computerUseResultContentSchema
>;
