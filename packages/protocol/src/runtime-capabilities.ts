import { z } from "zod";

export const remoteSurfaceProtocolVersionSchema = z.literal(1);
export const remoteSurfaceKindSchema = z.enum(["browser", "desktop"]);

export type RemoteSurfaceKind = z.infer<typeof remoteSurfaceKindSchema>;
export const remoteSurfaceTransportSchema = z.enum(["websocket", "webrtc"]);

export type RemoteSurfaceTransport = z.infer<
  typeof remoteSurfaceTransportSchema
>;
export const remoteSurfaceIceTransportPolicySchema = z.enum(["all", "relay"]);
export const remoteSurfaceStatusSchema = z.enum([
  "idle",
  "connecting",
  "active",
  "suspended",
  "offline",
  "error",
]);

export type RemoteSurfaceStatus = z.infer<typeof remoteSurfaceStatusSchema>;
export const remoteSurfaceChannelSchema = z.enum([
  "control",
  "frame",
  "cursor",
  "clipboard",
  "webrtc-signal",
]);

export type RemoteSurfaceChannel = z.infer<typeof remoteSurfaceChannelSchema>;

export const remoteSurfaceCapabilitiesSchema = z.object({
  browser: z.boolean().default(false),
  desktop: z.boolean().default(false),
  transports: z.array(remoteSurfaceTransportSchema).min(1),
  iceTransportPolicies: z
    .array(remoteSurfaceIceTransportPolicySchema)
    .min(1)
    .default(["relay"]),
  maxSessions: z.number().int().positive(),
});

export type RemoteSurfaceCapabilities = z.infer<
  typeof remoteSurfaceCapabilitiesSchema
>;

export const codeTransportSchema = z.literal("web-proxy");

export type CodeTransport = z.infer<typeof codeTransportSchema>;
export const codeSharedTransportProtocolVersionSchema = z.union([
  z.literal(1),
  z.literal(2),
]);

export type CodeSharedTransportProtocolVersion = z.infer<
  typeof codeSharedTransportProtocolVersionSchema
>;
export const codeCapabilitiesSchema = z.object({
  available: z.boolean(),
  version: z.string().min(1).nullable(),
  upstreamRevision: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .nullable(),
  patchset: z.number().int().nonnegative(),
  transport: codeTransportSchema,
  sharedTransportProtocolVersion:
    codeSharedTransportProtocolVersionSchema.default(1),
  maxSessions: z.number().int().positive(),
  reason: z.string().min(1).nullable(),
});

export type CodeCapabilities = z.infer<typeof codeCapabilitiesSchema>;

export const unavailableCodeCapabilities = codeCapabilitiesSchema.parse({
  available: false,
  version: null,
  upstreamRevision: null,
  patchset: 0,
  transport: "web-proxy",
  sharedTransportProtocolVersion: 1,
  maxSessions: 1,
  reason: "This worker has not reported a Cantrip Code runtime.",
});

export const remoteSurfaceIceServerSchema = z.object({
  urls: z.array(z.string().min(1)).min(1),
  username: z.string().min(1).optional(),
  credential: z.string().min(1).optional(),
});

export type RemoteSurfaceIceServer = z.infer<
  typeof remoteSurfaceIceServerSchema
>;

export const remoteSurfaceWebRtcConfigurationSchema = z.object({
  iceServers: z.array(remoteSurfaceIceServerSchema).max(16),
  iceTransportPolicy: remoteSurfaceIceTransportPolicySchema,
  negotiationTimeoutMs: z.number().int().min(1_000).max(30_000),
});

export type RemoteSurfaceWebRtcConfiguration = z.infer<
  typeof remoteSurfaceWebRtcConfigurationSchema
>;

export const remoteSurfaceWebRtcSignalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer"), sdp: z.string().min(1).max(1_000_000) }),
  z.object({
    type: z.literal("answer"),
    sdp: z.string().min(1).max(1_000_000),
  }),
  z.object({
    type: z.literal("candidate"),
    candidate: z.string().min(1).max(16_384),
    sdpMid: z.string().max(1_024).nullable(),
    sdpMLineIndex: z.number().int().nonnegative().nullable(),
    usernameFragment: z.string().max(1_024).nullable(),
  }),
  z.object({ type: z.literal("end-of-candidates") }),
  z.object({
    type: z.literal("transport-state"),
    state: z.enum(["connected", "failed", "closed"]),
    message: z.string().max(2_048).nullable(),
  }),
]);

export type RemoteSurfaceWebRtcSignal = z.infer<
  typeof remoteSurfaceWebRtcSignalSchema
>;

export function defaultRemoteSurfaceCapabilities(): z.infer<
  typeof remoteSurfaceCapabilitiesSchema
> {
  return {
    browser: false,
    desktop: false,
    transports: ["websocket"],
    iceTransportPolicies: ["relay"],
    maxSessions: 4,
  };
}

export const codexRuntimeMethodStateSchema = z.enum([
  "available",
  "unavailable",
  "unknown",
]);

export type CodexRuntimeMethodState = z.infer<
  typeof codexRuntimeMethodStateSchema
>;

export const codexRuntimeFeatureStageSchema = z.enum([
  "beta",
  "underDevelopment",
  "stable",
  "deprecated",
  "removed",
]);

export type CodexRuntimeFeatureStage = z.infer<
  typeof codexRuntimeFeatureStageSchema
>;

export const codexRuntimeFeatureSchema = z.object({
  name: z.string().min(1),
  stage: codexRuntimeFeatureStageSchema,
  enabled: z.boolean(),
  defaultEnabled: z.boolean(),
});

export type CodexRuntimeFeature = z.infer<typeof codexRuntimeFeatureSchema>;

export const NATIVE_SUBAGENT_PROTOCOL_VERSION = 1 as const;

export const nativeSubagentRuntimeCapabilitySchema = z
  .object({
    available: z.boolean(),
    protocolVersion: z.number().int().positive().nullable(),
    reason: z.string().min(1).nullable(),
  })
  .strict();

export type NativeSubagentRuntimeCapability = z.infer<
  typeof nativeSubagentRuntimeCapabilitySchema
>;

export function nativeSubagentCapabilityCompatible(
  capability: z.infer<typeof nativeSubagentRuntimeCapabilitySchema>,
): boolean {
  return (
    capability.available &&
    capability.protocolVersion === NATIVE_SUBAGENT_PROTOCOL_VERSION
  );
}

export const unavailableNativeSubagentRuntimeCapability =
  nativeSubagentRuntimeCapabilitySchema.parse({
    available: false,
    protocolVersion: null,
    reason: "This worker has not reported native subagent support.",
  });

export const codexRuntimeReportSchema = z.object({
  adapter: z.literal("app-server"),
  compatibility: z.enum(["compatible", "partial", "incompatible", "missing"]),
  version: z
    .object({
      raw: z.string().min(1),
      semantic: z.string().regex(/^\d+\.\d+\.\d+$/u),
    })
    .nullable(),
  testedRange: z.string().min(1),
  initialize: z
    .object({
      userAgent: z.string().min(1),
      platformFamily: z.string().min(1),
      platformOs: z.string().min(1),
      experimentalApi: z.boolean(),
    })
    .nullable(),
  methods: z.record(z.string().min(1), codexRuntimeMethodStateSchema),
  features: z.array(codexRuntimeFeatureSchema),
  nativeSubagents: nativeSubagentRuntimeCapabilitySchema.default(
    unavailableNativeSubagentRuntimeCapability,
  ),
  degradedReasons: z.array(z.string().min(1)),
});

export type CodexRuntimeReport = z.infer<typeof codexRuntimeReportSchema>;

export const unprobedCodexRuntimeReport = codexRuntimeReportSchema.parse({
  adapter: "app-server",
  compatibility: "missing",
  version: null,
  testedRange: ">=0.150.0 <0.151.0",
  initialize: null,
  methods: {},
  features: [],
  degradedReasons: ["This worker has not reported runtime compatibility."],
});
