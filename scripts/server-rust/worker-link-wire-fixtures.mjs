import fixture from "./worker-command-fixtures.json" with { type: "json" };
import { tunnelRecord } from "./tunnel-record-fixture.mjs";

const command = (type) =>
  fixture.commands.find((c) => c.type === type).input.command;
const session = command("worker-link.session.install").session;
const installed = command("worker-link.grant.install").grant;
const { peerSession, configuration } = command("worker-link.peer.install");
const envelope = command("worker-link.peer.signal").envelope;
export const workerLinkWireFixtures = {
  workerLinkTunnelGrantRequestSchema: [
    {},
    { diagnosticTraceId: "55555555-5555-4555-8555-555555555555" },
  ],
  workerLinkTunnelGrantSchema: [
    {
      grant: {
        binding: installed.binding,
        token: Buffer.alloc(32).toString("base64url"),
      },
      route: {
        tunnelId: "tunnel",
        attachmentId: "attachment",
        sourceEndpointId: "client",
        destinationEndpointId: "worker",
        target: {
          kind: "protected-tunnel",
          targetKind: "tcp",
          recordId: "tunnel",
          protectedRecord: tunnelRecord,
        },
      },
    },
  ],
  workerLinkRemoteSurfaceGrantRequestSchema: [
    { viewport: { width: 1024, height: 768, devicePixelRatio: 1 } },
    { viewport: { width: 1, height: 16384, devicePixelRatio: 0.25 } },
    { viewport: { width: 16384, height: 1, devicePixelRatio: 8 } },
  ],
  remoteSurfaceAttachResultSchema: [
    { accepted: true, transport: "websocket" },
    { accepted: true, transport: "webrtc" },
  ],
  workerLinkTerminalGrantRequestSchema: [
    { operationId: "55555555-5555-4555-8555-555555555555" },
  ],
  terminalOpenResultSchema: [
    { status: "detached" },
    { status: "exited", exitCode: 0, signal: null },
    { status: "exited", exitCode: 1, signal: 15 },
  ],
  workerLinkObservationGrantRequestSchema: [
    { topics: ["runtime"] },
    { topics: ["chat-progress", "filesystem", "worktree", "runtime"] },
  ],
  workerLinkFrameHeaderSchema: (() => {
    const base = {
      protocolVersion: 1,
      sessionId: session.sessionId,
      routeGeneration: 1,
      effectiveRoute: "relay",
      channel: {
        channelId: session.sessionId,
        connectionId: session.sessionId,
      },
      lane: "interactive",
      sequence: 0,
    };
    return [
      {
        kind: "open",
        openNonce: session.sessionId,
        channelKind: "reliable-stream",
        grant: {
          binding: installed.binding,
          token: Buffer.alloc(32).toString("base64url"),
        },
        initialCreditBytes: 65536,
      },
      { kind: "accept", initialCreditBytes: 65536 },
      { kind: "reject", code: "unauthorized" },
      { kind: "data", direction: "client-to-worker", payloadFormat: "raw" },
      { kind: "credit", direction: "worker-to-client", bytes: 65536 },
      { kind: "half-close", direction: "client-to-worker" },
      { kind: "close", code: "normal" },
      { kind: "error", code: "io-error" },
    ].map((value) => ({ ...base, ...value }));
  })(),
  workerLinkIdentityResolveResultSchema: [
    {
      serverId: "fixture",
      ownerId: "fixture",
      workerId: "fixture",
      workerProcessGeneration: "fixture",
    },
  ],
  workerLinkSessionOpenRequestSchema: [
    { clientInstanceId: "fixture" },
    { clientInstanceId: "🦀:a\ud800" },
  ],
  workerLinkSessionSchema: [session],
  workerLinkLeaseSchema: [session.lease],
  workerLinkGrantBindingSchema: [installed.binding],
  installedWorkerLinkGrantSchema: [installed],
  workerLinkResourceGrantSchema: [
    {
      binding: installed.binding,
      token: Buffer.alloc(32).toString("base64url"),
    },
  ],
  workerLinkPeerConfigurationSchema: [configuration],
  workerLinkPeerSessionOpenRequestSchema: [
    { routeGeneration: 1, route: "lan" },
    { routeGeneration: 1, route: "wan" },
  ],
  workerLinkPeerSessionSchema: [peerSession],
  workerLinkPeerSessionDescriptorSchema: [{ peerSession, configuration }],
  workerLinkPeerSignalEnvelopeSchema: [envelope],
  workerLinkPeerSignalBatchSchema: [{ signals: [envelope] }],
  workerLinkPeerMailboxReadRequestSchema: [
    {},
    { afterSignalSequence: 0, afterAdvertisementSequence: 0 },
  ],
  workerLinkPeerMailboxSchema: [
    {
      peerSessionId: peerSession.peerSessionId,
      sessionId: session.sessionId,
      routeGeneration: 1,
      route: "lan",
      signals: [envelope],
      candidateAdvertisements: [],
    },
  ],
  workerLinkRouteUpdateRequestSchema: [
    { preferredRoute: "relay" },
    { preferredRoute: "local" },
  ],
  workerLinkDirectActivationSchema: [{ capabilityId: session.sessionId }],
  workerLinkTelemetryBatchSchema: [
    {
      routeGeneration: 1,
      samples: [
        {
          occurredAt: session.lease.issuedAt,
          event: "route-selected",
          route: "relay",
          lane: "interactive",
          value: 0,
          latencyMs: null,
          reason: "none",
        },
      ],
    },
  ],
};
