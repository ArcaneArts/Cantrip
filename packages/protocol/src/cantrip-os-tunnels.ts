import { z } from "zod";

/** Canonical source identities only. Guest transport and paths stay on the Worker. */
export const cantripOsTunnelSourceSchema = z.strictObject({
  bindingId: z.uuid(),
  worktreeId: z.string().min(1).max(200),
  bindingGeneration: z.uuid(),
  attachmentGeneration: z.uuid(),
  runtimeGeneration: z.uuid(),
});

export const cantripOsTcpDestinationSchema = z.strictObject({
  kind: z.literal("worker-os-tcp"),
  workerId: z.string().trim().min(1).max(200),
  port: z.number().int().min(1).max(65_535),
  source: cantripOsTunnelSourceSchema,
});

export type CantripOsTunnelSource = z.infer<typeof cantripOsTunnelSourceSchema>;

// Public-key material only. The guest also decodes and validates the SSH blob.
export const cantripOsSshPublicKeySchema = z
  .string()
  .regex(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/u);
export const cantripOsSshDestinationSchema = z.strictObject({
  kind: z.literal("worker-os-ssh"),
  workerId: z.string().trim().min(1).max(200),
  source: cantripOsTunnelSourceSchema,
  publicKey: cantripOsSshPublicKeySchema,
});

export const tunnelSshConnectionInfoSchema = z.strictObject({
  user: z.string().regex(/^[a-z_][a-z0-9_-]{0,63}$/u),
  hostAlias: z.string().regex(/^cantrip-os-[0-9a-f-]{36}$/u),
  hostKey: cantripOsSshPublicKeySchema,
});

export const cantripOsVncDestinationSchema = z.strictObject({
  kind: z.literal("worker-os-vnc"),
  workerId: z.string().trim().min(1).max(200),
  source: cantripOsTunnelSourceSchema,
});

export const cantripOsListenerSourceSchema = z.strictObject({
  kind: z.literal("worker-os-listener"),
  workerId: z.string().trim().min(1).max(200),
  port: z.number().int().min(1).max(65_535),
  source: cantripOsTunnelSourceSchema,
});
