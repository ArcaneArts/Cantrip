// Private sidecar protocol v1. Public encrypted routing schemas belong to
// @cantrip/protocol; this module validates the actual child-process boundary.
import { z } from "zod";

const boundedText = (bytes: number) =>
  z.string().refine((value) => Buffer.byteLength(value) <= bytes);
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
  }),
  observationRevision: counter,
});
export const cuaCapabilitiesSchema = z.strictObject({
  protocolVersion: z.literal(1),
  runtimeVersion: z.string().min(1).max(64),
  backend: z.string().min(1).max(64),
  capture: z.boolean(),
  nativeInput: z.literal(false),
  javascript: z.boolean(),
  cursorAppearanceVersion: z.literal(1),
  operations: z.array(z.string().min(1).max(64)).max(32),
  maxSessions: z.number().int().min(1).max(16),
  maxImageBytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1024 * 1024),
});
export const cuaInventorySchema = z.strictObject({
  targets: z
    .array(cuaTargetSchema)
    .max(256)
    .refine(
      (targets) =>
        new Set(targets.map((target) => target.id)).size === targets.length,
    ),
});
export const cuaSessionResultSchema = z.strictObject({
  session: cuaSessionSchema,
});
export const cuaSnapshotSchema = cuaSessionResultSchema.extend({
  image: z
    .strictObject({
      mediaType: z.literal("image/png"),
      width: z.number().int().positive().max(4_194_304),
      height: z.number().int().positive().max(4_194_304),
      byteCount: z
        .number()
        .int()
        .positive()
        .max(16 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      cursorIncluded: z.literal(true),
    })
    .refine((image) => image.width * image.height <= 4_194_304),
});
export type CuaScope = z.infer<typeof cuaScopeSchema>;
export type CuaBinding = z.infer<typeof cuaBindingSchema>;
export type CuaSession = z.infer<typeof cuaSessionSchema>;
export type CuaTargetReference = z.infer<typeof cuaTargetReferenceSchema>;
export type CuaCursorAppearance = z.infer<typeof cuaCursorAppearanceSchema>;
export type CuaPoint = z.infer<typeof cuaPointSchema>;
export type CuaCapabilities = z.infer<typeof cuaCapabilitiesSchema>;
export type CuaSnapshot = z.infer<typeof cuaSnapshotSchema> & {
  payload: Buffer;
};

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
