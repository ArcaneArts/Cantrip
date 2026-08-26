import { z } from "zod";

import {
  TUNNEL_DATA_PLANE_MAX_HEADER_BYTES,
  TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES,
  tunnelDataPlaneTargetSchema,
} from "./tunnel-data-plane.js";

export const WORKER_LINK_PROTOCOL_VERSION = 1;
export const WORKER_LINK_MAX_HEADER_BYTES = 8 * 1_024;
export const WORKER_LINK_MAX_PAYLOAD_BYTES =
  8 + TUNNEL_DATA_PLANE_MAX_HEADER_BYTES + TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES;
export const WORKER_LINK_MAX_CREDIT_BYTES = 8 * 1_024 * 1_024;
export const WORKER_LINK_MAX_CHANNELS_PER_GRANT = 64;
export const WORKER_LINK_MAX_GRANTS_PER_SESSION = 128;
export const WORKER_LINK_MAX_TELEMETRY_SAMPLES = 128;
export const WORKER_LINK_MAX_PEER_CANDIDATES = 64;
export const WORKER_LINK_MAX_PEER_SIGNALS = 256;
export const WORKER_LINK_MAX_PEER_SIGNALING_BYTES = 4 * 1_024 * 1_024;
export const WORKER_LINK_MAX_STUN_URLS = 8;
export const WORKER_LINK_MAX_INTERFACE_RULES = 64;
export const WORKER_LINK_PEER_CONTROL_CHANNEL =
  "cantrip-worker-link-v1:control";
export const WORKER_LINK_PEER_LANE_CHANNEL_PREFIX =
  "cantrip-worker-link-v1:lane:";

const FRAME_MAGIC = new Uint8Array([0x43, 0x57, 0x4c, 0x4b]);

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const generationSchema = z.number().int().positive().safe();
const sequenceSchema = z.number().int().nonnegative().safe();
const timestampSchema = z.string().datetime();
const counterSchema = z.number().int().nonnegative().safe();
const creditSchema = z
  .number()
  .int()
  .positive()
  .max(WORKER_LINK_MAX_CREDIT_BYTES);

export const workerLinkRouteSchema = z.enum(["local", "lan", "wan", "relay"]);

export const workerLinkOperationalRouteSchema = workerLinkRouteSchema;

export const workerLinkPeerRouteSchema = z.enum(["lan", "wan"]);

export const workerLinkPeerSignalSenderSchema = z.enum(["client", "worker"]);

export const workerLinkQosLaneSchema = z.enum([
  "events",
  "interactive",
  "stream",
  "realtime",
  "bulk",
]);

export const workerLinkChannelKindSchema = z.enum([
  "reliable-stream",
  "event-subscription",
  "datagram",
]);

export const workerLinkResourceKindSchema = z.enum([
  "terminal",
  "tunnel",
  "project-share",
  "code",
  "browser",
  "remote-desktop",
  "observations",
]);

export const workerLinkGrantOperationSchema = z.enum([
  "stream:open",
  "stream:read",
  "stream:write",
  "stream:half-close",
  "events:subscribe",
  "datagram:send",
]);

export const workerLinkRevokeReasonSchema = z.enum([
  "released",
  "account-session-ended",
  "resource-stopped",
  "resource-deleted",
  "worker-disconnected",
  "worker-generation-changed",
  "server-generation-changed",
  "route-replaced",
  "lease-expired",
  "server-shutdown",
  "worker-shutdown",
  "protocol-violation",
]);

export const workerLinkFallbackReasonSchema = z.enum([
  "local-unsupported",
  "local-unavailable",
  "local-identity-mismatch",
  "local-capability-expired",
  "local-capability-rejected",
  "local-connect-timeout",
  "local-disconnected",
  "policy-relay-only",
  "route-replaced",
]);

export const workerLinkLeaseSchema = z
  .object({
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    absoluteExpiresAt: timestampSchema,
  })
  .strict()
  .superRefine((lease, context) => {
    const issuedAt = Date.parse(lease.issuedAt);
    const expiresAt = Date.parse(lease.expiresAt);
    const absoluteExpiresAt = Date.parse(lease.absoluteExpiresAt);
    if (expiresAt <= issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Lease expiry must be later than issuance.",
      });
    }
    if (absoluteExpiresAt < expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["absoluteExpiresAt"],
        message: "Absolute expiry cannot precede lease expiry.",
      });
    }
  });

export const workerLinkSessionIdentitySchema = z
  .object({
    serverId: idSchema,
    serverGeneration: idSchema,
    ownerId: idSchema,
    accountSessionId: idSchema,
    clientInstanceId: idSchema,
    workerId: idSchema,
    workerProcessGeneration: idSchema,
  })
  .strict();

export const workerLinkRoutePolicySchema = z
  .object({
    priority: z
      .tuple([
        z.literal("local"),
        z.literal("lan"),
        z.literal("wan"),
        z.literal("relay"),
      ])
      .readonly(),
    enabled: z
      .array(workerLinkRouteSchema)
      .min(1)
      .max(workerLinkRouteSchema.options.length)
      .refine((routes) => new Set(routes).size === routes.length, {
        message: "Enabled routes must be unique.",
      }),
  })
  .strict();

const workerLinkStunUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => /^stuns?:[^\s]+$/u.test(value), {
    message: "WorkerLink STUN URLs must use stun: or stuns:.",
  });

const workerLinkInterfaceRuleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);

export const workerLinkPeerLaneLimitSchema = z
  .object({
    maxChannels: z.number().int().positive().max(4_096),
    maxQueuedFrames: z.number().int().positive().max(4_096),
    maxQueuedBytes: z
      .number()
      .int()
      .min(64 * 1_024)
      .max(64 * 1_024 * 1_024),
    maxBytesPerSecond: z
      .number()
      .int()
      .min(64 * 1_024)
      .max(1_024 * 1_024 * 1_024),
  })
  .strict();

export const workerLinkPeerLaneLimitsSchema = z
  .object({
    events: workerLinkPeerLaneLimitSchema,
    interactive: workerLinkPeerLaneLimitSchema,
    stream: workerLinkPeerLaneLimitSchema,
    realtime: workerLinkPeerLaneLimitSchema,
    bulk: workerLinkPeerLaneLimitSchema,
  })
  .strict();

export const workerLinkPeerConfigurationSchema = z
  .object({
    directRoutes: z
      .object({
        local: z.boolean(),
        lan: z.boolean(),
        wan: z.boolean(),
      })
      .strict(),
    relayOnly: z.boolean(),
    stunUrls: z
      .array(workerLinkStunUrlSchema)
      .max(WORKER_LINK_MAX_STUN_URLS)
      .refine((urls) => new Set(urls).size === urls.length, {
        message: "WorkerLink STUN URLs must be unique.",
      }),
    interfacePolicy: z.discriminatedUnion("mode", [
      z
        .object({ mode: z.literal("default"), interfaces: z.tuple([]) })
        .strict(),
      z
        .object({
          mode: z.literal("allowlist"),
          interfaces: z
            .array(workerLinkInterfaceRuleSchema)
            .min(1)
            .max(WORKER_LINK_MAX_INTERFACE_RULES),
        })
        .strict(),
      z
        .object({
          mode: z.literal("denylist"),
          interfaces: z
            .array(workerLinkInterfaceRuleSchema)
            .min(1)
            .max(WORKER_LINK_MAX_INTERFACE_RULES),
        })
        .strict(),
    ]),
    vpnPolicy: z
      .object({
        defaultRoute: z.literal("wan"),
        lanAllowlist: z
          .array(workerLinkInterfaceRuleSchema)
          .max(WORKER_LINK_MAX_INTERFACE_RULES),
      })
      .strict(),
    negotiationTimeoutMs: z.number().int().min(1_000).max(30_000),
    upgradeProbeTimeoutMs: z.number().int().min(1_000).max(300_000),
    maxPeerSessionsPerClient: z.number().int().positive().max(256),
    maxPeerSessionsPerWorker: z.number().int().positive().max(4_096),
    invalidHandshakeRatePerMinute: z.number().int().positive().max(10_000),
    laneLimits: workerLinkPeerLaneLimitsSchema,
  })
  .strict()
  .superRefine((configuration, context) => {
    if (
      configuration.relayOnly &&
      Object.values(configuration.directRoutes).some(Boolean)
    ) {
      context.addIssue({
        code: "custom",
        path: ["directRoutes"],
        message: "Relay-only WorkerLink policy cannot enable a direct route.",
      });
    }
    if (!configuration.directRoutes.wan && configuration.stunUrls.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["stunUrls"],
        message: "WorkerLink STUN URLs require the WAN route.",
      });
    }
  });

export const workerLinkSessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    identity: workerLinkSessionIdentitySchema,
    lease: workerLinkLeaseSchema,
    routePolicy: workerLinkRoutePolicySchema,
    routeGeneration: generationSchema,
    preferredRoute: workerLinkRouteSchema,
  })
  .strict()
  .superRefine((session, context) => {
    if (!session.routePolicy.enabled.includes(session.preferredRoute)) {
      context.addIssue({
        code: "custom",
        path: ["preferredRoute"],
        message: "Preferred route must be enabled by the session policy.",
      });
    }
  });

export const workerLinkSessionOpenRequestSchema = z
  .object({
    clientInstanceId: idSchema,
  })
  .strict();

export const workerLinkPeerSessionSchema = z
  .object({
    peerSessionId: z.string().uuid(),
    sessionId: z.string().uuid(),
    identity: workerLinkSessionIdentitySchema,
    routeGeneration: generationSchema,
    route: workerLinkPeerRouteSchema,
    lease: workerLinkLeaseSchema,
  })
  .strict();

export const workerLinkPeerSessionOpenRequestSchema = z
  .object({
    routeGeneration: generationSchema,
    route: workerLinkPeerRouteSchema,
  })
  .strict();

export const workerLinkPeerSessionDescriptorSchema = z
  .object({
    peerSession: workerLinkPeerSessionSchema,
    configuration: workerLinkPeerConfigurationSchema,
  })
  .strict();

export const workerLinkPeerCandidateSchema = z
  .object({
    candidate: z.string().trim().min(1).max(16_384),
    sdpMid: z.string().max(1_024).nullable(),
    sdpMLineIndex: z.number().int().nonnegative().max(65_535).nullable(),
    usernameFragment: z.string().max(1_024).nullable(),
  })
  .strict();

export const workerLinkPeerCandidateAdvertisementSchema = z
  .object({
    peerSessionId: z.string().uuid(),
    sessionId: z.string().uuid(),
    routeGeneration: generationSchema,
    route: workerLinkPeerRouteSchema,
    advertisementSequence: sequenceSchema,
    candidates: z
      .array(workerLinkPeerCandidateSchema)
      .max(WORKER_LINK_MAX_PEER_CANDIDATES),
    complete: z.boolean(),
  })
  .strict()
  .superRefine((advertisement, context) => {
    if (!advertisement.complete && advertisement.candidates.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "An incomplete candidate advertisement cannot be empty.",
      });
    }
  });

export const workerLinkPeerHandshakeSchema = z
  .object({
    type: z.literal("worker-link-peer-handshake"),
    protocolVersion: z.literal(WORKER_LINK_PROTOCOL_VERSION),
    role: z.enum(["client", "worker"]),
    peerSessionId: z.string().uuid(),
    sessionId: z.string().uuid(),
    routeGeneration: generationSchema,
    route: workerLinkPeerRouteSchema,
    identity: workerLinkSessionIdentitySchema,
    challenge: z
      .string()
      .min(43)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();

export const workerLinkPeerSignalSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("offer"),
      sdp: z.string().min(1).max(1_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("answer"),
      sdp: z.string().min(1).max(1_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("candidate"),
      candidate: workerLinkPeerCandidateSchema,
    })
    .strict(),
  z.object({ type: z.literal("end-of-candidates") }).strict(),
  z
    .object({
      type: z.literal("transport-state"),
      state: z.enum(["connected", "failed", "closed"]),
      message: z.string().max(2_048).nullable(),
    })
    .strict(),
]);

export const workerLinkPeerSignalEnvelopeSchema = z
  .object({
    peerSessionId: z.string().uuid(),
    sessionId: z.string().uuid(),
    routeGeneration: generationSchema,
    route: workerLinkPeerRouteSchema,
    sender: workerLinkPeerSignalSenderSchema,
    signalSequence: sequenceSchema,
    signal: workerLinkPeerSignalSchema,
  })
  .strict();

export const workerLinkPeerSignalBatchSchema = z
  .object({
    signals: z
      .array(workerLinkPeerSignalEnvelopeSchema)
      .min(1)
      .max(WORKER_LINK_MAX_PEER_SIGNALS),
  })
  .strict()
  .superRefine((batch, context) => {
    if (jsonBytes(batch) > WORKER_LINK_MAX_PEER_SIGNALING_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["signals"],
        message: "WorkerLink peer signaling exceeds the byte limit.",
      });
    }
  });

export const workerLinkPeerMailboxReadRequestSchema = z
  .object({
    afterSignalSequence: sequenceSchema.nullable().default(null),
    afterAdvertisementSequence: sequenceSchema.nullable().default(null),
  })
  .strict();

export const workerLinkPeerMailboxSchema = z
  .object({
    peerSessionId: z.string().uuid(),
    sessionId: z.string().uuid(),
    routeGeneration: generationSchema,
    route: workerLinkPeerRouteSchema,
    signals: z
      .array(workerLinkPeerSignalEnvelopeSchema)
      .max(WORKER_LINK_MAX_PEER_SIGNALS),
    candidateAdvertisements: z
      .array(workerLinkPeerCandidateAdvertisementSchema)
      .max(WORKER_LINK_MAX_PEER_SIGNALS),
  })
  .strict()
  .superRefine((mailbox, context) => {
    if (jsonBytes(mailbox) > WORKER_LINK_MAX_PEER_SIGNALING_BYTES) {
      context.addIssue({
        code: "custom",
        message: "WorkerLink peer mailbox exceeds the byte limit.",
      });
    }
  });

export const workerLinkRouteUpdateRequestSchema = z
  .object({
    preferredRoute: workerLinkOperationalRouteSchema,
  })
  .strict();

export const workerLinkTerminalGrantRequestSchema = z
  .object({
    operationId: z.string().uuid(),
  })
  .strict();

export const workerLinkTunnelGrantRequestSchema = z
  .object({
    diagnosticTraceId: z.string().uuid().optional(),
  })
  .strict()
  .default({});

export const workerLinkTunnelRouteSchema = z
  .object({
    tunnelId: idSchema,
    attachmentId: idSchema,
    sourceEndpointId: idSchema,
    destinationEndpointId: idSchema,
    target: tunnelDataPlaneTargetSchema,
  })
  .strict();

export const workerLinkResourceSchema = z
  .object({
    kind: workerLinkResourceKindSchema,
    resourceId: idSchema,
    attachmentId: idSchema.nullable(),
  })
  .strict();

const uniqueQosLanesSchema = z
  .array(workerLinkQosLaneSchema)
  .min(1)
  .max(workerLinkQosLaneSchema.options.length)
  .refine((lanes) => new Set(lanes).size === lanes.length, {
    message: "Grant lanes must be unique.",
  });
const uniqueOperationsSchema = z
  .array(workerLinkGrantOperationSchema)
  .min(1)
  .max(workerLinkGrantOperationSchema.options.length)
  .refine((operations) => new Set(operations).size === operations.length, {
    message: "Grant operations must be unique.",
  });

export const workerLinkGrantBindingSchema = z
  .object({
    grantId: z.string().uuid(),
    grantGeneration: generationSchema,
    sessionId: z.string().uuid(),
    identity: workerLinkSessionIdentitySchema,
    resource: workerLinkResourceSchema,
    lanes: uniqueQosLanesSchema,
    operations: uniqueOperationsSchema,
    maxChannels: z
      .number()
      .int()
      .positive()
      .max(WORKER_LINK_MAX_CHANNELS_PER_GRANT),
    lease: workerLinkLeaseSchema,
  })
  .strict();

export const workerLinkGrantTokenSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const workerLinkGrantTokenHashSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/u);

export const workerLinkResourceGrantSchema = z
  .object({
    binding: workerLinkGrantBindingSchema,
    token: workerLinkGrantTokenSchema,
  })
  .strict();

export const workerLinkTunnelGrantSchema = z
  .object({
    grant: workerLinkResourceGrantSchema,
    route: workerLinkTunnelRouteSchema,
  })
  .strict();

export const installedWorkerLinkGrantSchema = z
  .object({
    binding: workerLinkGrantBindingSchema,
    tokenHash: workerLinkGrantTokenHashSchema,
  })
  .strict();

export const workerLinkRevocationSchema = z
  .object({
    reason: workerLinkRevokeReasonSchema,
    revokedAt: timestampSchema,
  })
  .strict();

export const workerLinkPeerSessionInstallCommandSchema = z
  .object({
    type: z.literal("worker-link.peer.install"),
    peerSession: workerLinkPeerSessionSchema,
    configuration: workerLinkPeerConfigurationSchema,
  })
  .strict();

export const workerLinkPeerSessionRevokeCommandSchema = z
  .object({
    type: z.literal("worker-link.peer.revoke"),
    peerSessionId: z.string().uuid(),
    sessionId: z.string().uuid(),
    revocation: workerLinkRevocationSchema,
  })
  .strict();

export const workerLinkPeerSessionRenewCommandSchema = z
  .object({
    type: z.literal("worker-link.peer.renew"),
    peerSessionId: z.string().uuid(),
    sessionId: z.string().uuid(),
    lease: workerLinkLeaseSchema,
  })
  .strict();

export const workerLinkPeerSignalCommandSchema = z
  .object({
    type: z.literal("worker-link.peer.signal"),
    envelope: workerLinkPeerSignalEnvelopeSchema,
  })
  .strict();

export const workerLinkPeerCoordinatorCommandSchema = z.discriminatedUnion(
  "type",
  [
    workerLinkPeerSessionInstallCommandSchema,
    workerLinkPeerSessionRenewCommandSchema,
    workerLinkPeerSessionRevokeCommandSchema,
    workerLinkPeerSignalCommandSchema,
  ],
);

export const workerLinkPeerSignalNotificationSchema = z
  .object({
    type: z.literal("worker-link.peer.signal"),
    envelope: workerLinkPeerSignalEnvelopeSchema,
  })
  .strict()
  .superRefine((notification, context) => {
    if (notification.envelope.sender !== "worker") {
      context.addIssue({
        code: "custom",
        path: ["envelope", "sender"],
        message: "Worker peer notifications must be worker-authored.",
      });
    }
  });

export const workerLinkPeerCandidateNotificationSchema = z
  .object({
    type: z.literal("worker-link.peer.candidates"),
    advertisement: workerLinkPeerCandidateAdvertisementSchema,
  })
  .strict();

export const workerLinkRouteStatusSchema = z
  .object({
    preferredRoute: workerLinkRouteSchema,
    effectiveRoute: workerLinkRouteSchema,
    routeGeneration: generationSchema,
    latencyMs: z.number().nonnegative().finite().max(300_000).nullable(),
    fallbackReason: workerLinkFallbackReasonSchema.nullable(),
    changedAt: timestampSchema,
  })
  .strict();

export const workerLinkChannelIdentitySchema = z
  .object({
    channelId: z.string().uuid(),
    connectionId: z.string().uuid(),
  })
  .strict();

export const workerLinkDirectionSchema = z.enum([
  "client-to-worker",
  "worker-to-client",
]);

export const workerLinkPayloadFormatSchema = z.enum([
  "raw",
  "tunnel-data-plane-v1",
]);

export const workerLinkChannelRejectCodeSchema = z.enum([
  "unauthorized",
  "grant-expired",
  "grant-revoked",
  "grant-replayed",
  "wrong-account-session",
  "wrong-worker-generation",
  "wrong-server-generation",
  "route-generation-stale",
  "unsupported-channel",
  "resource-unavailable",
  "limit-exceeded",
  "protocol-error",
]);

export const workerLinkChannelCloseCodeSchema = z.enum([
  "normal",
  "revoked",
  "route-replaced",
  "endpoint-disconnected",
  "idle-timeout",
  "lifetime-expired",
  "congested",
  "protocol-error",
]);

export const workerLinkChannelErrorCodeSchema = z.enum([
  "connection-failed",
  "io-error",
  "credit-exceeded",
  "sequence-invalid",
  "payload-invalid",
  "protocol-error",
]);

const frameBaseSchema = z
  .object({
    protocolVersion: z.literal(WORKER_LINK_PROTOCOL_VERSION),
    sessionId: z.string().uuid(),
    routeGeneration: generationSchema,
    effectiveRoute: workerLinkRouteSchema,
    channel: workerLinkChannelIdentitySchema,
    lane: workerLinkQosLaneSchema,
    sequence: sequenceSchema,
  })
  .strict();

export const workerLinkFrameHeaderSchema = z.discriminatedUnion("kind", [
  frameBaseSchema.extend({
    kind: z.literal("open"),
    openNonce: z.string().uuid(),
    channelKind: workerLinkChannelKindSchema,
    grant: workerLinkResourceGrantSchema,
    initialCreditBytes: creditSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("accept"),
    initialCreditBytes: creditSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("reject"),
    code: workerLinkChannelRejectCodeSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("data"),
    direction: workerLinkDirectionSchema,
    payloadFormat: workerLinkPayloadFormatSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("credit"),
    direction: workerLinkDirectionSchema,
    bytes: creditSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("half-close"),
    direction: workerLinkDirectionSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("close"),
    code: workerLinkChannelCloseCodeSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("error"),
    code: workerLinkChannelErrorCodeSchema,
  }),
]);

export const workerLinkSessionInstallCommandSchema = z
  .object({
    type: z.literal("worker-link.session.install"),
    session: workerLinkSessionSchema,
  })
  .strict();

export const workerLinkSessionRenewCommandSchema = z
  .object({
    type: z.literal("worker-link.session.renew"),
    sessionId: z.string().uuid(),
    lease: workerLinkLeaseSchema,
  })
  .strict();

export const workerLinkSessionRouteCommandSchema = z
  .object({
    type: z.literal("worker-link.session.route"),
    sessionId: z.string().uuid(),
    routeGeneration: generationSchema,
    preferredRoute: workerLinkOperationalRouteSchema,
  })
  .strict();

export const workerLinkSessionRevokeCommandSchema = z
  .object({
    type: z.literal("worker-link.session.revoke"),
    sessionId: z.string().uuid(),
    revocation: workerLinkRevocationSchema,
  })
  .strict();

export const workerLinkGrantInstallCommandSchema = z
  .object({
    type: z.literal("worker-link.grant.install"),
    sessionId: z.string().uuid(),
    grant: installedWorkerLinkGrantSchema,
  })
  .strict();

export const workerLinkGrantRenewCommandSchema = z
  .object({
    type: z.literal("worker-link.grant.renew"),
    sessionId: z.string().uuid(),
    grantId: z.string().uuid(),
    grantGeneration: generationSchema,
    lease: workerLinkLeaseSchema,
  })
  .strict();

export const workerLinkGrantRevokeCommandSchema = z
  .object({
    type: z.literal("worker-link.grant.revoke"),
    sessionId: z.string().uuid(),
    grantId: z.string().uuid(),
    grantGeneration: generationSchema,
    revocation: workerLinkRevocationSchema,
  })
  .strict();

export const workerLinkIdentityResolveCommandSchema = z
  .object({
    type: z.literal("worker-link.identity.resolve"),
  })
  .strict();

export const workerLinkIdentityResolveResultSchema = z
  .object({
    serverId: idSchema,
    ownerId: idSchema,
    workerId: idSchema,
    workerProcessGeneration: idSchema,
  })
  .strict();

export const workerLinkCoordinatorCommandSchema = z.discriminatedUnion("type", [
  workerLinkSessionInstallCommandSchema,
  workerLinkSessionRenewCommandSchema,
  workerLinkSessionRouteCommandSchema,
  workerLinkSessionRevokeCommandSchema,
  workerLinkGrantInstallCommandSchema,
  workerLinkGrantRenewCommandSchema,
  workerLinkGrantRevokeCommandSchema,
]);

export const workerLinkTelemetryEventSchema = z.enum([
  "session-opened",
  "session-closed",
  "channel-opened",
  "channel-closed",
  "channel-rejected",
  "channel-revoked",
  "bytes-sent",
  "bytes-received",
  "route-selected",
  "route-fallback",
  "reconnect-attempt",
  "queue-pressure",
]);

export const workerLinkTelemetryReasonSchema = z.enum([
  "none",
  ...workerLinkFallbackReasonSchema.options,
  ...workerLinkChannelRejectCodeSchema.options,
  ...workerLinkChannelCloseCodeSchema.options,
]);

export const workerLinkTelemetrySampleSchema = z
  .object({
    occurredAt: timestampSchema,
    event: workerLinkTelemetryEventSchema,
    route: workerLinkRouteSchema.nullable(),
    lane: workerLinkQosLaneSchema.nullable(),
    value: counterSchema,
    latencyMs: z.number().nonnegative().finite().max(300_000).nullable(),
    reason: workerLinkTelemetryReasonSchema,
  })
  .strict();

export const workerLinkTelemetryBatchSchema = z
  .object({
    routeGeneration: generationSchema,
    samples: z
      .array(workerLinkTelemetrySampleSchema)
      .min(1)
      .max(WORKER_LINK_MAX_TELEMETRY_SAMPLES),
  })
  .strict();

function validatePayload(
  header: WorkerLinkFrameHeader,
  payload: Uint8Array,
): void {
  if (payload.byteLength > WORKER_LINK_MAX_PAYLOAD_BYTES) {
    throw new Error("WorkerLink payload exceeds the protocol limit.");
  }
  if (header.kind === "data" && payload.byteLength === 0) {
    throw new Error("WorkerLink data frames require a payload.");
  }
  if (header.kind !== "data" && payload.byteLength !== 0) {
    throw new Error("WorkerLink control frames cannot contain a payload.");
  }
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export type WorkerLinkPeerAddressKind =
  | "private"
  | "link-local"
  | "cgnat"
  | "public"
  | "mdns"
  | "loopback"
  | "invalid";

export interface ParsedWorkerLinkPeerCandidate {
  address: string;
  relatedAddress: string | null;
  transport: string;
  type: "host" | "srflx" | "prflx" | "relay" | "unknown";
}

export interface WorkerLinkPeerCandidateRouteContext {
  vpn?: boolean;
  vpnLanAllowed?: boolean;
}

export function parseWorkerLinkPeerCandidate(
  value: string,
): ParsedWorkerLinkPeerCandidate | null {
  const candidate = value.trim().replace(/^a=/u, "");
  const fields = candidate.split(/\s+/u);
  if (
    fields.length < 8 ||
    !fields[0]?.startsWith("candidate:") ||
    fields[6]?.toLowerCase() !== "typ"
  ) {
    return null;
  }
  const rawType = fields[7]?.toLowerCase();
  const type = ["host", "srflx", "prflx", "relay"].includes(rawType ?? "")
    ? (rawType as ParsedWorkerLinkPeerCandidate["type"])
    : "unknown";
  const relatedIndex = fields.findIndex(
    (field) => field.toLowerCase() === "raddr",
  );
  return {
    address: fields[4]!,
    relatedAddress:
      relatedIndex >= 0 && fields[relatedIndex + 1]
        ? fields[relatedIndex + 1]!
        : null,
    transport: fields[2]!.toLowerCase(),
    type,
  };
}

export function classifyWorkerLinkPeerAddress(
  input: string,
): WorkerLinkPeerAddressKind {
  const address = input
    .trim()
    .replace(/^\[|\]$/gu, "")
    .split("%", 1)[0]!;
  if (/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.local\.?$/iu.test(address)) {
    return "mdns";
  }
  const ipv4 = parseIpv4(address);
  if (ipv4) return classifyIpv4(ipv4);
  const ipv6 = parseIpv6(address);
  if (!ipv6) return "invalid";
  if (ipv6.every((word) => word === 0)) return "invalid";
  if (ipv6.slice(0, 7).every((word) => word === 0) && ipv6[7] === 1) {
    return "loopback";
  }
  if (ipv6.slice(0, 5).every((word) => word === 0) && ipv6[5] === 0xffff) {
    return classifyIpv4([
      ipv6[6]! >> 8,
      ipv6[6]! & 0xff,
      ipv6[7]! >> 8,
      ipv6[7]! & 0xff,
    ]);
  }
  const firstIpv6 = ipv6[0]!;
  if ((firstIpv6 & 0xffc0) === 0xfe80) return "link-local";
  if ((firstIpv6 & 0xfe00) === 0xfc00) return "private";
  if ((firstIpv6 & 0xe000) === 0x2000) return "public";
  return "invalid";
}

export function workerLinkPeerCandidateAllowed(
  candidate: WorkerLinkPeerCandidate,
  route: WorkerLinkPeerRoute,
  context: WorkerLinkPeerCandidateRouteContext = {},
): boolean {
  const parsed = parseWorkerLinkPeerCandidate(candidate.candidate);
  if (!parsed || parsed.type === "unknown" || parsed.type === "relay") {
    return false;
  }
  const addressKind = classifyWorkerLinkPeerAddress(parsed.address);
  if (addressKind === "invalid" || addressKind === "loopback") return false;
  const vpn = context.vpn === true || addressKind === "cgnat";
  if (route === "lan") {
    if (vpn && !context.vpnLanAllowed) return false;
    return (
      (parsed.type === "host" || parsed.type === "prflx") &&
      ["private", "link-local", "mdns", "cgnat"].includes(addressKind)
    );
  }
  if (vpn) return parsed.type === "host" || parsed.type === "prflx";
  if (parsed.type === "srflx" || parsed.type === "prflx") {
    return addressKind === "public";
  }
  return parsed.type === "host" && addressKind === "public";
}

export function filterWorkerLinkPeerSdp(
  sdp: string,
  route: WorkerLinkPeerRoute,
  contextForAddress: (
    address: string,
    candidate: ParsedWorkerLinkPeerCandidate,
  ) => WorkerLinkPeerCandidateRouteContext = () => ({}),
): { removedCandidates: number; sdp: string } {
  const newline = sdp.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = sdp.endsWith(newline);
  let removedCandidates = 0;
  const lines = sdp.split(/\r?\n/u).filter((line) => {
    const raw = line.startsWith("a=candidate:")
      ? line.slice(2)
      : line.startsWith("candidate:")
        ? line
        : null;
    if (raw === null) return true;
    const parsed = parseWorkerLinkPeerCandidate(raw);
    if (
      parsed &&
      workerLinkPeerCandidateAllowed(
        {
          candidate: raw,
          sdpMid: null,
          sdpMLineIndex: null,
          usernameFragment: null,
        },
        route,
        contextForAddress(parsed.address, parsed),
      )
    ) {
      return true;
    }
    removedCandidates += 1;
    return false;
  });
  if (lines.at(-1) === "") lines.pop();
  return {
    removedCandidates,
    sdp: `${lines.join(newline)}${trailingNewline ? newline : ""}`,
  };
}

export function workerLinkPeerInterfaceAllowed(
  interfaceName: string,
  configuration: WorkerLinkPeerConfiguration,
): boolean {
  const normalized = interfaceName.toLowerCase();
  const configured = configuration.interfacePolicy.interfaces.map((value) =>
    value.toLowerCase(),
  );
  return configuration.interfacePolicy.mode === "allowlist"
    ? configured.includes(normalized)
    : configuration.interfacePolicy.mode === "denylist"
      ? !configured.includes(normalized)
      : true;
}

export function workerLinkPeerInterfaceIsVpn(interfaceName: string): boolean {
  return /^(?:utun|tun|tap|tailscale|zt|zerotier|wg|wireguard|ppp|ipsec|vpn)/iu.test(
    interfaceName,
  );
}

export function workerLinkPeerLaneChannelLabel(
  lane: WorkerLinkQosLane,
): string {
  return `${WORKER_LINK_PEER_LANE_CHANNEL_PREFIX}${workerLinkQosLaneSchema.parse(lane)}`;
}

function parseIpv4(address: string): readonly number[] | null {
  const fields = address.split(".");
  if (fields.length !== 4) return null;
  const values = fields.map((field) =>
    /^\d{1,3}$/u.test(field) ? Number(field) : Number.NaN,
  );
  return values.every((value) => Number.isInteger(value) && value <= 255)
    ? values
    : null;
}

function classifyIpv4(values: readonly number[]): WorkerLinkPeerAddressKind {
  const [first, second, third, fourth] = values;
  if (first === 0 || first === undefined || second === undefined) {
    return "invalid";
  }
  if (first === 127) return "loopback";
  if (first >= 224 || first === 255) return "invalid";
  if (first === 169 && second === 254) return "link-local";
  if (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  ) {
    return "private";
  }
  if (first === 100 && second >= 64 && second <= 127) return "cgnat";
  if (first === 192 && second === 0 && third === 0) return "invalid";
  if (first === 198 && [18, 19].includes(second)) return "invalid";
  if (first === 198 && second === 51 && third === 100) return "invalid";
  if (first === 203 && second === 0 && third === 113) return "invalid";
  if (first >= 240 || fourth === undefined) return "invalid";
  return "public";
}

function parseIpv6(address: string): readonly number[] | null {
  if (!address.includes(":")) return null;
  const compressed = address.split("::");
  if (compressed.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const fields = side.split(":");
    const words: number[] = [];
    for (const [index, field] of fields.entries()) {
      if (field.includes(".")) {
        if (index !== fields.length - 1) return null;
        const ipv4 = parseIpv4(field);
        if (!ipv4) return null;
        words.push(ipv4[0]! * 256 + ipv4[1]!, ipv4[2]! * 256 + ipv4[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/iu.test(field)) return null;
        words.push(Number.parseInt(field, 16));
      }
    }
    return words;
  };
  const left = parseSide(compressed[0] ?? "");
  const right = parseSide(compressed[1] ?? "");
  if (!left || !right) return null;
  const wordCount = left.length + right.length;
  if (compressed.length === 1) return wordCount === 8 ? left : null;
  if (wordCount >= 8) return null;
  return [...left, ...Array<number>(8 - wordCount).fill(0), ...right];
}

export function isWorkerLinkFrame(frame: Uint8Array): boolean {
  return (
    frame.byteLength >= FRAME_MAGIC.byteLength &&
    FRAME_MAGIC.every((value, index) => frame[index] === value)
  );
}

export function encodeWorkerLinkFrame(
  header: WorkerLinkFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  const parsedHeader = workerLinkFrameHeaderSchema.parse(header);
  validatePayload(parsedHeader, payload);
  const encodedHeader = new TextEncoder().encode(JSON.stringify(parsedHeader));
  if (encodedHeader.byteLength > WORKER_LINK_MAX_HEADER_BYTES) {
    throw new Error("WorkerLink header exceeds the protocol limit.");
  }
  const frame = new Uint8Array(
    8 + encodedHeader.byteLength + payload.byteLength,
  );
  frame.set(FRAME_MAGIC, 0);
  new DataView(frame.buffer).setUint32(4, encodedHeader.byteLength, false);
  frame.set(encodedHeader, 8);
  frame.set(payload, 8 + encodedHeader.byteLength);
  return frame;
}

export function decodeWorkerLinkFrame(frame: Uint8Array): {
  header: WorkerLinkFrameHeader;
  payload: Uint8Array;
} {
  if (frame.byteLength < 8 || !isWorkerLinkFrame(frame)) {
    throw new Error("WorkerLink frame has an invalid magic value.");
  }
  const headerLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  ).getUint32(4, false);
  if (headerLength < 1 || headerLength > WORKER_LINK_MAX_HEADER_BYTES) {
    throw new Error("WorkerLink frame header length is invalid.");
  }
  const payloadOffset = 8 + headerLength;
  if (payloadOffset > frame.byteLength) {
    throw new Error("WorkerLink frame header is truncated.");
  }
  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(
      new TextDecoder().decode(frame.subarray(8, payloadOffset)),
    );
  } catch {
    throw new Error("WorkerLink frame header is not valid JSON.");
  }
  const header = workerLinkFrameHeaderSchema.parse(rawHeader);
  const payload = frame.subarray(payloadOffset);
  validatePayload(header, payload);
  return { header, payload };
}

export type WorkerLinkRoute = z.infer<typeof workerLinkRouteSchema>;
export type WorkerLinkOperationalRoute = z.infer<
  typeof workerLinkOperationalRouteSchema
>;
export type WorkerLinkQosLane = z.infer<typeof workerLinkQosLaneSchema>;
export type WorkerLinkPeerRoute = z.infer<typeof workerLinkPeerRouteSchema>;
export type WorkerLinkPeerConfiguration = z.infer<
  typeof workerLinkPeerConfigurationSchema
>;
export type WorkerLinkPeerLaneLimits = z.infer<
  typeof workerLinkPeerLaneLimitsSchema
>;
export type WorkerLinkPeerSession = z.infer<typeof workerLinkPeerSessionSchema>;
export type WorkerLinkPeerSessionOpenRequest = z.infer<
  typeof workerLinkPeerSessionOpenRequestSchema
>;
export type WorkerLinkPeerSessionDescriptor = z.infer<
  typeof workerLinkPeerSessionDescriptorSchema
>;
export type WorkerLinkPeerCandidate = z.infer<
  typeof workerLinkPeerCandidateSchema
>;
export type WorkerLinkPeerCandidateAdvertisement = z.infer<
  typeof workerLinkPeerCandidateAdvertisementSchema
>;
export type WorkerLinkPeerSignal = z.infer<typeof workerLinkPeerSignalSchema>;
export type WorkerLinkPeerSignalEnvelope = z.infer<
  typeof workerLinkPeerSignalEnvelopeSchema
>;
export type WorkerLinkPeerMailboxReadRequest = z.infer<
  typeof workerLinkPeerMailboxReadRequestSchema
>;
export type WorkerLinkPeerMailbox = z.infer<typeof workerLinkPeerMailboxSchema>;
export type WorkerLinkPeerHandshake = z.infer<
  typeof workerLinkPeerHandshakeSchema
>;
export type WorkerLinkPeerCoordinatorCommand = z.infer<
  typeof workerLinkPeerCoordinatorCommandSchema
>;
export type WorkerLinkChannelKind = z.infer<typeof workerLinkChannelKindSchema>;
export type WorkerLinkPayloadFormat = z.infer<
  typeof workerLinkPayloadFormatSchema
>;
export type WorkerLinkResourceKind = z.infer<
  typeof workerLinkResourceKindSchema
>;
export type WorkerLinkGrantOperation = z.infer<
  typeof workerLinkGrantOperationSchema
>;
export type WorkerLinkRevokeReason = z.infer<
  typeof workerLinkRevokeReasonSchema
>;
export type WorkerLinkLease = z.infer<typeof workerLinkLeaseSchema>;
export type WorkerLinkSessionIdentity = z.infer<
  typeof workerLinkSessionIdentitySchema
>;
export type WorkerLinkSession = z.infer<typeof workerLinkSessionSchema>;
export type WorkerLinkSessionOpenRequest = z.infer<
  typeof workerLinkSessionOpenRequestSchema
>;
export type WorkerLinkRouteUpdateRequest = z.infer<
  typeof workerLinkRouteUpdateRequestSchema
>;
export type WorkerLinkTerminalGrantRequest = z.infer<
  typeof workerLinkTerminalGrantRequestSchema
>;
export type WorkerLinkTunnelGrantRequest = z.infer<
  typeof workerLinkTunnelGrantRequestSchema
>;
export type WorkerLinkTunnelRoute = z.infer<typeof workerLinkTunnelRouteSchema>;
export type WorkerLinkTunnelGrant = z.infer<typeof workerLinkTunnelGrantSchema>;
export type WorkerLinkGrantBinding = z.infer<
  typeof workerLinkGrantBindingSchema
>;
export type WorkerLinkResourceGrant = z.infer<
  typeof workerLinkResourceGrantSchema
>;
export type InstalledWorkerLinkGrant = z.infer<
  typeof installedWorkerLinkGrantSchema
>;
export type WorkerLinkRouteStatus = z.infer<typeof workerLinkRouteStatusSchema>;
export type WorkerLinkChannelIdentity = z.infer<
  typeof workerLinkChannelIdentitySchema
>;
export type WorkerLinkFrameHeader = z.infer<typeof workerLinkFrameHeaderSchema>;
export type WorkerLinkChannelRejectCode = z.infer<
  typeof workerLinkChannelRejectCodeSchema
>;
export type WorkerLinkChannelCloseCode = z.infer<
  typeof workerLinkChannelCloseCodeSchema
>;
export type WorkerLinkChannelErrorCode = z.infer<
  typeof workerLinkChannelErrorCodeSchema
>;
export type WorkerLinkCoordinatorCommand = z.infer<
  typeof workerLinkCoordinatorCommandSchema
>;
export type WorkerLinkIdentityResolveResult = z.infer<
  typeof workerLinkIdentityResolveResultSchema
>;
export type WorkerLinkTelemetrySample = z.infer<
  typeof workerLinkTelemetrySampleSchema
>;
