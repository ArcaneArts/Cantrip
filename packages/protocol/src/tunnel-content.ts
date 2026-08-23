import { z } from "zod";

import { endpointContentOpaqueSchema } from "./endpoint-content.js";

const tunnelContentIdSchema = z.string().trim().min(1).max(200);
const tunnelContentHostSchema = z.enum(["127.0.0.1", "localhost", "::1"]);

export const tunnelContentErrorCodeSchema = z.enum([
  "attachment-disconnected",
  "attachment-expired",
  "destination-offline",
  "server-restarted",
  "target-rejected",
  "transport-failed",
]);

export const tunnelContentSourceEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("desktop-loopback") }).strict(),
  z
    .object({
      kind: z.literal("server-http"),
      adapter: z.enum(["code", "project-share"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("worker-listener"),
      workerId: tunnelContentIdSchema,
      host: tunnelContentHostSchema,
      port: z.number().int().min(1).max(65_535),
    })
    .strict(),
]);

export const tunnelContentDestinationEndpointSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("worker-tcp"),
        workerId: tunnelContentIdSchema,
        host: tunnelContentHostSchema,
        port: z.number().int().min(1).max(65_535),
      })
      .strict(),
    z
      .object({
        kind: z.literal("worker-adapter"),
        workerId: tunnelContentIdSchema,
        adapter: z.enum(["code", "project-share"]),
        resourceId: tunnelContentIdSchema,
      })
      .strict(),
  ],
);

/** Semantic tunnel state that only an unlocked client or assigned worker opens. */
export const tunnelContentRecordSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1_000).nullable(),
    source: tunnelContentSourceEndpointSchema,
    destination: tunnelContentDestinationEndpointSchema,
  })
  .strict();

/**
 * Public authenticated context retained beside an opaque stored record. The
 * operation id changes on every mutation and the monotonic revision prevents
 * a stale record from silently replacing a newer tunnel configuration.
 */
export const protectedTunnelContentRecordSchema = z
  .object({
    operationId: z.string().uuid(),
    revision: z.number().int().positive().safe(),
    protectedContent: endpointContentOpaqueSchema,
  })
  .strict()
  .refine(
    ({ protectedContent }) => protectedContent.domain === "tunnel-content",
    "Tunnel records require tunnel-content ciphertext.",
  );

export const tunnelPublicSourceEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("desktop-loopback") }).strict(),
  z
    .object({
      kind: z.literal("server-http"),
      adapter: z.enum(["code", "project-share"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("worker-listener"),
      workerId: tunnelContentIdSchema,
    })
    .strict(),
]);

export const tunnelPublicDestinationEndpointSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("worker-tcp"),
        workerId: tunnelContentIdSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("worker-adapter"),
        workerId: tunnelContentIdSchema,
        adapter: z.enum(["code", "project-share"]),
        resourceId: tunnelContentIdSchema,
      })
      .strict(),
  ],
);

export function tunnelPublicSourceEndpoint(
  source: TunnelContentSourceEndpoint,
): TunnelPublicSourceEndpoint {
  if (source.kind === "worker-listener") {
    return { kind: source.kind, workerId: source.workerId };
  }
  return source;
}

export function tunnelPublicDestinationEndpoint(
  destination: TunnelContentDestinationEndpoint,
): TunnelPublicDestinationEndpoint {
  if (destination.kind === "worker-tcp") {
    return { kind: destination.kind, workerId: destination.workerId };
  }
  return destination;
}

export type ProtectedTunnelContentRecord = z.infer<
  typeof protectedTunnelContentRecordSchema
>;
export type TunnelContentDestinationEndpoint = z.infer<
  typeof tunnelContentDestinationEndpointSchema
>;
export type TunnelContentErrorCode = z.infer<
  typeof tunnelContentErrorCodeSchema
>;
export type TunnelContentRecord = z.infer<typeof tunnelContentRecordSchema>;
export type TunnelContentSourceEndpoint = z.infer<
  typeof tunnelContentSourceEndpointSchema
>;
export type TunnelPublicDestinationEndpoint = z.infer<
  typeof tunnelPublicDestinationEndpointSchema
>;
export type TunnelPublicSourceEndpoint = z.infer<
  typeof tunnelPublicSourceEndpointSchema
>;
