import { z } from "zod";
import { workerCommandSchema } from "./worker-commands.js";

export const PROJECT_SOURCE_UNAVAILABLE_CODE = "project-source-unavailable";

const workerCommandErrorCodeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

export const workerRequestEnvelopeSchema = z.object({
  kind: z.literal("request"),
  requestId: z.string().min(1),
  command: workerCommandSchema,
});

export const WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL = "cantrip-worker-legacy";
export const WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL =
  "cantrip-worker-auth-ready-v1";
export const WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL =
  "cantrip-worker-auth-ready-v2";
export const WORKER_WEBSOCKET_SUBPROTOCOLS = [
  WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL,
  WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL,
  WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL,
] as const;

const workerConnectionEnvelopeV1Schema = z
  .object({
    kind: z.literal("connection"),
    state: z.enum(["pending", "ready"]),
    protocolVersion: z.literal(1),
    connectionGeneration: z.string().uuid(),
  })
  .strict();

const workerConnectionEnvelopeV2Schema = z
  .object({
    kind: z.literal("connection"),
    state: z.enum(["pending", "ready"]),
    protocolVersion: z.literal(2),
    connectionGeneration: z.string().uuid(),
    serverControlPlaneGeneration: z.string().uuid(),
  })
  .strict();

export const workerConnectionEnvelopeSchema = z.discriminatedUnion(
  "protocolVersion",
  [workerConnectionEnvelopeV1Schema, workerConnectionEnvelopeV2Schema],
);

export const workerResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    kind: z.literal("response"),
    requestId: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal("response"),
    requestId: z.string().min(1),
    ok: z.literal(false),
    error: z.object({
      code: workerCommandErrorCodeSchema.optional(),
      message: z.string().min(1),
    }),
  }),
]);

export type WorkerRequestEnvelope = z.infer<typeof workerRequestEnvelopeSchema>;
export type WorkerConnectionEnvelope = z.infer<
  typeof workerConnectionEnvelopeSchema
>;
export type WorkerResponseEnvelope = z.infer<
  typeof workerResponseEnvelopeSchema
>;
