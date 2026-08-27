import { describe, expect, it } from "vitest";

import {
  decodeTunnelDataPlaneFrame,
  decodeWorkerLinkFrame,
  decodeWorkerLinkRemoteSurfaceChunk,
  encodeTunnelDataPlaneFrame,
  encodeWorkerLinkFrame,
  encodeWorkerLinkRemoteSurfaceChunk,
  classifyWorkerLinkPeerAddress,
  filterWorkerLinkPeerSdp,
  isWorkerLinkFrame,
  installedWorkerLinkGrantSchema,
  WORKER_LINK_MAX_CREDIT_BYTES,
  WORKER_LINK_MAX_PAYLOAD_BYTES,
  WORKER_LINK_MAX_PEER_CANDIDATES,
  WORKER_LINK_MAX_PEER_SIGNALS,
  WORKER_LINK_MAX_TELEMETRY_SAMPLES,
  WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES,
  WorkerLinkRemoteSurfaceFrameAssembler,
  workerLinkCoordinatorCommandSchema,
  workerLinkDirectActivationSchema,
  workerLinkFrameHeaderSchema,
  workerLinkGrantBindingSchema,
  workerLinkIdentityResolveResultSchema,
  workerLinkLeaseSchema,
  workerLinkObservationGrantRequestSchema,
  workerLinkPeerCandidateAdvertisementSchema,
  workerLinkPeerCandidateAllowed,
  workerLinkPeerConfigurationSchema,
  workerLinkPeerMailboxReadRequestSchema,
  workerLinkPeerMailboxSchema,
  workerLinkPeerHandshakeSchema,
  workerLinkPeerInterfaceAllowed,
  workerLinkPeerInterfaceIsVpn,
  workerLinkPeerSessionDescriptorSchema,
  workerLinkPeerSessionSchema,
  workerLinkPeerSignalBatchSchema,
  workerLinkPeerSignalEnvelopeSchema,
  workerLinkQosLaneSchema,
  workerLinkRemoteSurfaceGrantRequestSchema,
  workerLinkResourceGrantSchema,
  workerLinkRoutePolicySchema,
  workerLinkRouteUpdateRequestSchema,
  workerLinkSessionOpenRequestSchema,
  workerLinkRouteSchema,
  workerLinkSessionSchema,
  workerLinkSessionIdentitySchema,
  workerLinkTelemetryBatchSchema,
  workerLinkTerminalGrantRequestSchema,
  workerLinkTunnelGrantRequestSchema,
  workerLinkTunnelGrantSchema,
  workerCommandSchema,
  workerNotificationSchema,
  workerObservationEnvelopeSchema,
  type WorkerLinkFrameHeader,
  type WorkerLinkGrantBinding,
} from "../src/index.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const grantId = "22222222-2222-4222-8222-222222222222";
const channelId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";
const openNonce = "55555555-5555-4555-8555-555555555555";
const peerSessionId = "66666666-6666-4666-8666-666666666666";

const now = new Date("2026-08-26T12:00:00.000Z").toISOString();
const expiresAt = new Date("2026-08-26T12:15:00.000Z").toISOString();
const absoluteExpiresAt = new Date("2026-08-27T00:00:00.000Z").toISOString();

const identity = {
  serverId: "server-primary",
  serverGeneration: "server-generation-1",
  ownerId: "owner-1",
  accountSessionId: "account-session-1",
  clientInstanceId: "client-instance-1",
  workerId: "worker-1",
  workerProcessGeneration: "worker-process-1",
};

const lease = { issuedAt: now, expiresAt, absoluteExpiresAt };

const binding: WorkerLinkGrantBinding = {
  grantId,
  grantGeneration: 1,
  sessionId,
  identity,
  resource: {
    kind: "terminal",
    resourceId: "terminal-1",
    attachmentId: "attachment-1",
  },
  lanes: ["interactive", "stream"],
  operations: [
    "stream:open",
    "stream:read",
    "stream:write",
    "stream:half-close",
  ],
  maxChannels: 4,
  lease,
};

const grant = {
  binding,
  token: "a".repeat(43),
};

const peerCandidate = {
  candidate:
    "candidate:1 1 UDP 2122260223 192.168.1.20 43123 typ host generation 0",
  sdpMid: "0",
  sdpMLineIndex: 0,
  usernameFragment: "peer-fragment",
};

const peerLaneLimit = {
  maxChannels: 64,
  maxQueuedFrames: 128,
  maxQueuedBytes: 4 * 1_024 * 1_024,
  maxBytesPerSecond: 16 * 1_024 * 1_024,
};

const peerConfiguration = {
  directRoutes: { local: true, lan: true, wan: true },
  relayOnly: false,
  stunUrls: ["stun:stun.cloudflare.com:3478"],
  interfacePolicy: { mode: "default" as const, interfaces: [] as [] },
  vpnPolicy: { defaultRoute: "wan" as const, lanAllowlist: [] },
  negotiationTimeoutMs: 8_000,
  upgradeProbeTimeoutMs: 15_000,
  maxPeerSessionsPerClient: 4,
  maxPeerSessionsPerWorker: 32,
  invalidHandshakeRatePerMinute: 60,
  laneLimits: {
    events: peerLaneLimit,
    interactive: peerLaneLimit,
    stream: peerLaneLimit,
    realtime: peerLaneLimit,
    bulk: peerLaneLimit,
  },
};

const peerSignalEnvelope = {
  peerSessionId,
  sessionId,
  routeGeneration: 2,
  route: "lan" as const,
  sender: "worker" as const,
  signalSequence: 0,
  signal: { type: "candidate" as const, candidate: peerCandidate },
};

const frameBase = {
  protocolVersion: 1 as const,
  sessionId,
  routeGeneration: 1,
  effectiveRoute: "local" as const,
  channel: { channelId, connectionId },
  lane: "interactive" as const,
  sequence: 0,
};

describe("WorkerLink protocol", () => {
  it("binds LOCAL activation to one exact direct capability", () => {
    expect(
      workerLinkDirectActivationSchema.parse({ capabilityId: channelId }),
    ).toEqual({ capabilityId: channelId });
    expect(
      workerLinkDirectActivationSchema.safeParse({
        capabilityId: channelId,
        attachmentId: "unexpected",
      }).success,
    ).toBe(false);
  });

  it("binds sessions to the exact server, account, client, and worker process", () => {
    expect(workerLinkSessionIdentitySchema.parse(identity)).toEqual(identity);
    expect(
      workerLinkSessionIdentitySchema.safeParse({
        ...identity,
        workerProcessGeneration: undefined,
      }).success,
    ).toBe(false);
    expect(
      workerLinkSessionIdentitySchema.safeParse({
        ...identity,
        destination: "127.0.0.1:43123",
      }).success,
    ).toBe(false);
  });

  it("defines the operational four-route priority", () => {
    expect(workerLinkRouteSchema.options).toEqual([
      "local",
      "lan",
      "wan",
      "relay",
    ]);
    expect(workerLinkQosLaneSchema.options).toEqual([
      "events",
      "interactive",
      "stream",
      "realtime",
      "bulk",
    ]);
    expect(
      workerLinkRoutePolicySchema.parse({
        priority: ["local", "lan", "wan", "relay"],
        enabled: ["local", "relay"],
      }).enabled,
    ).toEqual(["local", "relay"]);
    expect(
      workerLinkRoutePolicySchema.safeParse({
        priority: ["local", "lan", "relay", "wan"],
        enabled: ["local", "relay"],
      }).success,
    ).toBe(false);
    expect(
      workerLinkRoutePolicySchema.safeParse({
        priority: ["local", "lan", "wan", "relay"],
        enabled: ["relay", "relay"],
      }).success,
    ).toBe(false);
    expect(
      workerLinkSessionSchema.safeParse({
        sessionId,
        identity,
        lease,
        routePolicy: {
          priority: ["local", "lan", "wan", "relay"],
          enabled: ["local", "relay"],
        },
        routeGeneration: 1,
        preferredRoute: "wan",
      }).success,
    ).toBe(false);
  });

  it("requires ordered, bounded leases and exact resource grants", () => {
    expect(workerLinkLeaseSchema.parse(lease)).toEqual(lease);
    expect(
      workerLinkLeaseSchema.safeParse({
        issuedAt: expiresAt,
        expiresAt: now,
        absoluteExpiresAt,
      }).success,
    ).toBe(false);
    expect(workerLinkGrantBindingSchema.parse(binding)).toEqual(binding);
    expect(workerLinkResourceGrantSchema.parse(grant)).toEqual(grant);
    expect(
      workerLinkGrantBindingSchema.safeParse({
        ...binding,
        lanes: ["interactive", "interactive"],
      }).success,
    ).toBe(false);
    expect(
      workerLinkResourceGrantSchema.safeParse({
        binding,
        token: "too-short",
      }).success,
    ).toBe(false);
  });

  it("binds bounded observation topics to an exact installed attachment", () => {
    const subscriptionId = "77777777-7777-4777-8777-777777777777";
    const observationBinding: WorkerLinkGrantBinding = {
      ...binding,
      resource: {
        kind: "observations",
        resourceId: identity.workerId,
        attachmentId: subscriptionId,
      },
      lanes: ["events"],
      operations: ["events:subscribe"],
      maxChannels: 1,
    };
    expect(
      workerLinkObservationGrantRequestSchema.parse({
        topics: ["chat-progress", "filesystem", "worktree", "runtime"],
      }),
    ).toMatchObject({
      topics: ["chat-progress", "filesystem", "worktree", "runtime"],
    });
    expect(
      installedWorkerLinkGrantSchema.parse({
        binding: observationBinding,
        observation: {
          subscriptionId,
          topics: ["chat-progress", "filesystem"],
        },
        tokenHash: "a".repeat(64),
      }).observation,
    ).toMatchObject({ subscriptionId });
    expect(
      installedWorkerLinkGrantSchema.safeParse({
        binding: observationBinding,
        observation: {
          subscriptionId: "88888888-8888-4888-8888-888888888888",
          topics: ["chat-progress"],
        },
        tokenHash: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      installedWorkerLinkGrantSchema.safeParse({
        binding,
        observation: {
          subscriptionId,
          topics: ["chat-progress"],
        },
        tokenHash: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("allows only provisional direct observations with stable identities", () => {
    const base = {
      protocolVersion: 1 as const,
      subscriptionId: "77777777-7777-4777-8777-777777777777",
      continuitySequence: 0,
      observedAt: now,
      identity: {
        operationId: "client-message-1",
        turnId: "turn-1",
        messageId: "message-1",
        sequence: 3,
      },
    };
    expect(
      workerObservationEnvelopeSchema.parse({
        ...base,
        payload: {
          topic: "chat-progress",
          chatId: "chat-1",
          clientMessageId: "client-message-1",
          executionLaneId: "lane-1",
          contextKind: "project",
          worktreeId: "worktree-1",
          scratchRootId: null,
          event: {
            type: "agent.message",
            message: {
              id: "message-1",
              text: "still working",
              phase: "commentary",
              streaming: true,
            },
          },
        },
      }).identity,
    ).toEqual(base.identity);
    expect(
      workerObservationEnvelopeSchema.safeParse({
        ...base,
        payload: {
          topic: "chat-progress",
          chatId: "chat-1",
          clientMessageId: "client-message-1",
          executionLaneId: "lane-1",
          contextKind: "project",
          worktreeId: "worktree-1",
          scratchRootId: null,
          event: {
            type: "agent.message",
            message: {
              id: "message-1",
              text: "done",
              phase: "final_answer",
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      workerObservationEnvelopeSchema.safeParse({
        ...base,
        payload: {
          topic: "runtime",
          notification: {
            type: "chat.turn.outcome",
            chatId: "chat-1",
            clientMessageId: "client-message-1",
            executionLaneId: "lane-1",
            contextKind: "project",
            worktreeId: "worktree-1",
            scratchRootId: null,
            outcome: {
              ok: true,
              result: {
                threadId: "thread-1",
                text: "done",
                status: "completed",
              },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("bounds direct-route deployment policy", () => {
    expect(workerLinkPeerConfigurationSchema.parse(peerConfiguration)).toEqual(
      peerConfiguration,
    );
    expect(
      workerLinkPeerConfigurationSchema.safeParse({
        ...peerConfiguration,
        relayOnly: true,
      }).success,
    ).toBe(false);
    expect(
      workerLinkPeerConfigurationSchema.safeParse({
        ...peerConfiguration,
        directRoutes: { local: true, lan: true, wan: false },
      }).success,
    ).toBe(false);
    expect(
      workerLinkPeerConfigurationSchema.safeParse({
        ...peerConfiguration,
        stunUrls: ["turn:relay.example.test:3478"],
      }).success,
    ).toBe(false);
    expect(
      workerLinkPeerConfigurationSchema.safeParse({
        ...peerConfiguration,
        invalidHandshakeRatePerMinute: 0,
      }).success,
    ).toBe(false);
  });

  it("fences and bounds peer sessions, candidates, and signaling", () => {
    const peerSession = {
      peerSessionId,
      sessionId,
      identity,
      routeGeneration: 2,
      route: "lan" as const,
      lease,
    };
    expect(workerLinkPeerSessionSchema.parse(peerSession)).toMatchObject({
      peerSessionId,
      route: "lan",
      routeGeneration: 2,
    });
    expect(
      workerLinkPeerSessionDescriptorSchema.parse({
        peerSession,
        configuration: peerConfiguration,
      }),
    ).toMatchObject({ peerSession: { peerSessionId } });
    expect(
      workerLinkPeerHandshakeSchema.parse({
        type: "worker-link-peer-handshake",
        protocolVersion: 1,
        role: "worker",
        peerSessionId,
        sessionId,
        routeGeneration: 2,
        route: "lan",
        identity,
        challenge: "a".repeat(43),
      }),
    ).toMatchObject({ role: "worker", peerSessionId });
    expect(
      workerLinkPeerCandidateAdvertisementSchema.parse({
        peerSessionId,
        sessionId,
        routeGeneration: 2,
        route: "lan",
        advertisementSequence: 0,
        candidates: [peerCandidate],
        complete: false,
      }).candidates,
    ).toEqual([peerCandidate]);
    expect(
      workerLinkPeerSignalEnvelopeSchema.parse(peerSignalEnvelope),
    ).toEqual(peerSignalEnvelope);
    expect(
      workerLinkPeerCandidateAdvertisementSchema.safeParse({
        peerSessionId,
        sessionId,
        routeGeneration: 2,
        route: "lan",
        advertisementSequence: 0,
        candidates: Array.from(
          { length: WORKER_LINK_MAX_PEER_CANDIDATES + 1 },
          () => peerCandidate,
        ),
        complete: true,
      }).success,
    ).toBe(false);
    expect(
      workerLinkPeerSignalBatchSchema.safeParse({
        signals: Array.from(
          { length: WORKER_LINK_MAX_PEER_SIGNALS + 1 },
          (_, signalSequence) => ({
            ...peerSignalEnvelope,
            signalSequence,
          }),
        ),
      }).success,
    ).toBe(false);
    expect(
      workerLinkPeerSignalBatchSchema.safeParse({
        signals: Array.from({ length: 5 }, (_, signalSequence) => ({
          ...peerSignalEnvelope,
          signalSequence,
          signal: { type: "offer", sdp: "s".repeat(900_000) },
        })),
      }).success,
    ).toBe(false);
    expect(
      workerLinkPeerSignalEnvelopeSchema.safeParse({
        ...peerSignalEnvelope,
        candidateAddress: "192.168.1.20",
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.parse({
        type: "worker-link.peer.install",
        peerSession,
        configuration: peerConfiguration,
      }),
    ).toMatchObject({ type: "worker-link.peer.install", peerSession });
    expect(
      workerCommandSchema.parse({
        type: "worker-link.peer.signal",
        envelope: { ...peerSignalEnvelope, sender: "client" },
      }),
    ).toMatchObject({ type: "worker-link.peer.signal" });
    expect(
      workerNotificationSchema.parse({
        type: "worker-link.peer.signal",
        envelope: peerSignalEnvelope,
      }),
    ).toMatchObject({ type: "worker-link.peer.signal" });
    expect(
      workerNotificationSchema.safeParse({
        type: "worker-link.peer.signal",
        envelope: { ...peerSignalEnvelope, sender: "client" },
      }).success,
    ).toBe(false);
    expect(
      workerNotificationSchema.parse({
        type: "worker-link.peer.candidates",
        advertisement: {
          peerSessionId,
          sessionId,
          routeGeneration: 2,
          route: "lan",
          advertisementSequence: 0,
          candidates: [peerCandidate],
          complete: true,
        },
      }),
    ).toMatchObject({ type: "worker-link.peer.candidates" });
    expect(workerLinkPeerMailboxReadRequestSchema.parse({})).toEqual({
      afterSignalSequence: null,
      afterAdvertisementSequence: null,
    });
    expect(
      workerLinkPeerMailboxSchema.parse({
        peerSessionId,
        sessionId,
        routeGeneration: 2,
        route: "lan",
        signals: [peerSignalEnvelope],
        candidateAdvertisements: [
          {
            peerSessionId,
            sessionId,
            routeGeneration: 2,
            route: "lan",
            advertisementSequence: 0,
            candidates: [peerCandidate],
            complete: true,
          },
        ],
      }),
    ).toMatchObject({ peerSessionId, route: "lan" });
    expect(
      workerLinkPeerMailboxReadRequestSchema.safeParse({
        afterSignalSequence: -1,
      }).success,
    ).toBe(false);
  });

  it("classifies LAN, WAN, VPN, and forbidden ICE candidates", () => {
    const candidate = (address: string, type: string = "host") => ({
      candidate: `candidate:1 1 udp 2122260223 ${address} 43123 typ ${type}`,
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: null,
    });
    expect(classifyWorkerLinkPeerAddress("192.168.1.20")).toBe("private");
    expect(classifyWorkerLinkPeerAddress("fe80::1")).toBe("link-local");
    expect(classifyWorkerLinkPeerAddress("fd00::1")).toBe("private");
    expect(classifyWorkerLinkPeerAddress("2001:db8::1")).toBe("public");
    expect(classifyWorkerLinkPeerAddress("2001:not-an-address")).toBe(
      "invalid",
    );
    expect(classifyWorkerLinkPeerAddress("::ffff:192.168.1.20")).toBe(
      "private",
    );
    expect(classifyWorkerLinkPeerAddress("100.100.12.1")).toBe("cgnat");
    expect(classifyWorkerLinkPeerAddress("1.1.1.1")).toBe("public");
    expect(classifyWorkerLinkPeerAddress("host.local")).toBe("mdns");
    expect(
      workerLinkPeerCandidateAllowed(candidate("192.168.1.20"), "lan"),
    ).toBe(true);
    expect(workerLinkPeerCandidateAllowed(candidate("1.1.1.1"), "lan")).toBe(
      false,
    );
    expect(
      workerLinkPeerCandidateAllowed(candidate("1.1.1.1", "srflx"), "wan"),
    ).toBe(true);
    expect(
      workerLinkPeerCandidateAllowed(candidate("100.100.12.1"), "wan"),
    ).toBe(true);
    expect(
      workerLinkPeerCandidateAllowed(candidate("10.0.0.2"), "wan", {
        vpn: true,
      }),
    ).toBe(true);
    expect(
      workerLinkPeerCandidateAllowed(candidate("1.1.1.1", "relay"), "wan"),
    ).toBe(false);
    expect(workerLinkPeerCandidateAllowed(candidate("127.0.0.1"), "lan")).toBe(
      false,
    );
  });

  it("filters SDP and applies interface and VPN policy without scanning", () => {
    const sdp = [
      "v=0",
      "a=candidate:1 1 udp 1 192.168.1.20 43123 typ host",
      "a=candidate:2 1 udp 1 203.0.113.20 43124 typ host",
      "a=end-of-candidates",
      "",
    ].join("\r\n");
    const filtered = filterWorkerLinkPeerSdp(sdp, "lan");
    expect(filtered.removedCandidates).toBe(1);
    expect(filtered.sdp).toContain("192.168.1.20");
    expect(filtered.sdp).not.toContain("203.0.113.20");
    expect(
      workerLinkPeerInterfaceAllowed("en0", {
        ...peerConfiguration,
        interfacePolicy: { mode: "denylist", interfaces: ["EN0"] },
      }),
    ).toBe(false);
    expect(workerLinkPeerInterfaceIsVpn("utun4")).toBe(true);
    expect(workerLinkPeerInterfaceIsVpn("tailscale0")).toBe(true);
    expect(workerLinkPeerInterfaceIsVpn("ztabcdef12")).toBe(true);
    expect(workerLinkPeerInterfaceIsVpn("zerotier-one")).toBe(true);
    expect(workerLinkPeerInterfaceIsVpn("en0")).toBe(false);
  });

  it("keeps worker-installed token hashes separate from client bearer grants", () => {
    const command = {
      type: "worker-link.grant.install" as const,
      sessionId,
      grant: {
        binding,
        tokenHash: "b".repeat(64),
      },
    };
    expect(
      workerLinkCoordinatorCommandSchema.parse(command),
    ).not.toHaveProperty("grant.token");
    expect(workerCommandSchema.parse(command)).toEqual(command);
    expect(
      workerCommandSchema.parse({
        type: "worker-link.session.route",
        sessionId,
        routeGeneration: 2,
        preferredRoute: "relay",
      }),
    ).toMatchObject({ preferredRoute: "relay", routeGeneration: 2 });
    expect(
      workerLinkCoordinatorCommandSchema.safeParse({
        type: "worker-link.grant.install",
        sessionId,
        grant: {
          binding,
          tokenHash: "b".repeat(64),
          token: grant.token,
        },
      }).success,
    ).toBe(false);
  });

  it("strictly validates client session APIs and authoritative worker identity resolution", () => {
    expect(
      workerLinkSessionOpenRequestSchema.parse({
        clientInstanceId: identity.clientInstanceId,
      }),
    ).toEqual({ clientInstanceId: identity.clientInstanceId });
    expect(
      workerLinkSessionOpenRequestSchema.safeParse({
        clientInstanceId: identity.clientInstanceId,
        workerProcessGeneration: identity.workerProcessGeneration,
      }).success,
    ).toBe(false);
    expect(
      workerLinkRouteUpdateRequestSchema.safeParse({ preferredRoute: "lan" })
        .success,
    ).toBe(true);
    expect(
      workerLinkRouteUpdateRequestSchema.safeParse({ preferredRoute: "turn" })
        .success,
    ).toBe(false);
    expect(
      workerLinkTerminalGrantRequestSchema.parse({ operationId: openNonce }),
    ).toEqual({ operationId: openNonce });
    expect(
      workerLinkRemoteSurfaceGrantRequestSchema.parse({
        viewport: { width: 1_280, height: 720, devicePixelRatio: 2 },
      }),
    ).toEqual({
      viewport: { width: 1_280, height: 720, devicePixelRatio: 2 },
    });
    expect(
      workerLinkRemoteSurfaceGrantRequestSchema.safeParse({
        viewport: { width: 0, height: 720, devicePixelRatio: 2 },
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.parse({ type: "worker-link.identity.resolve" }),
    ).toEqual({ type: "worker-link.identity.resolve" });
    expect(
      workerLinkIdentityResolveResultSchema.parse({
        serverId: identity.serverId,
        ownerId: identity.ownerId,
        workerId: identity.workerId,
        workerProcessGeneration: identity.workerProcessGeneration,
      }),
    ).toMatchObject({ workerProcessGeneration: "worker-process-1" });
    expect(
      workerNotificationSchema.parse({
        type: "terminal.runtime.observed",
        terminalId: "terminal-1",
        workerProcessGeneration: identity.workerProcessGeneration,
        status: "exited",
        exitCode: 0,
        signal: null,
      }),
    ).toMatchObject({ type: "terminal.runtime.observed", status: "exited" });
  });

  it("binds generic tunnel grants to one attachment route", () => {
    const tunnelBinding: WorkerLinkGrantBinding = {
      ...binding,
      resource: {
        kind: "tunnel",
        resourceId: "tunnel-1",
        attachmentId: "attachment-1",
      },
      lanes: ["stream"],
    };
    expect(
      workerLinkTunnelGrantRequestSchema.parse({
        diagnosticTraceId: openNonce,
      }),
    ).toEqual({ diagnosticTraceId: openNonce });
    expect(
      workerLinkTunnelGrantSchema.parse({
        grant: { binding: tunnelBinding, token: grant.token },
        route: {
          tunnelId: "tunnel-1",
          attachmentId: "attachment-1",
          sourceEndpointId: `worker-link-client:${grantId}`,
          destinationEndpointId: "worker-link-worker:worker-1",
          target: { kind: "tcp", host: "127.0.0.1", port: 4321 },
        },
      }),
    ).toMatchObject({
      grant: { binding: { resource: { kind: "tunnel" } } },
      route: { attachmentId: "attachment-1" },
    });
  });

  it("round-trips every reliable channel operation", () => {
    const headers: WorkerLinkFrameHeader[] = [
      {
        ...frameBase,
        kind: "open",
        openNonce,
        channelKind: "reliable-stream",
        grant,
        initialCreditBytes: 256 * 1_024,
      },
      { ...frameBase, kind: "accept", initialCreditBytes: 256 * 1_024 },
      { ...frameBase, kind: "reject", code: "unauthorized" },
      {
        ...frameBase,
        kind: "credit",
        direction: "worker-to-client",
        bytes: 64 * 1_024,
      },
      {
        ...frameBase,
        kind: "half-close",
        direction: "client-to-worker",
      },
      { ...frameBase, kind: "close", code: "normal" },
      { ...frameBase, kind: "error", code: "io-error" },
    ];
    for (const header of headers) {
      const encoded = encodeWorkerLinkFrame(header, new Uint8Array());
      expect(isWorkerLinkFrame(encoded)).toBe(true);
      expect(decodeWorkerLinkFrame(encoded)).toEqual({
        header,
        payload: new Uint8Array(),
      });
    }

    const dataHeader: WorkerLinkFrameHeader = {
      ...frameBase,
      kind: "data",
      direction: "client-to-worker",
      payloadFormat: "raw",
    };
    const payload = new Uint8Array([0, 1, 2, 255]);
    expect(
      decodeWorkerLinkFrame(encodeWorkerLinkFrame(dataHeader, payload)),
    ).toEqual({ header: dataHeader, payload });
  });

  it("can encapsulate the existing tunnel frame without rewriting it", () => {
    const tunnelFrame = encodeTunnelDataPlaneFrame(
      {
        protocolVersion: 1,
        tunnelId: "tunnel-1",
        attachmentId: "attachment-1",
        sourceEndpointId: "desktop-a",
        destinationEndpointId: "worker-b",
        connectionId: "connection-1",
        sequence: 0,
        kind: "open",
        initialCreditBytes: 256 * 1_024,
      },
      new Uint8Array(),
    );
    const header: WorkerLinkFrameHeader = {
      ...frameBase,
      lane: "stream",
      kind: "data",
      direction: "client-to-worker",
      payloadFormat: "tunnel-data-plane-v1",
    };
    const decoded = decodeWorkerLinkFrame(
      encodeWorkerLinkFrame(header, tunnelFrame),
    );
    expect(decodeTunnelDataPlaneFrame(decoded.payload).header.kind).toBe(
      "open",
    );
  });

  it("fragments and reassembles bounded Remote Surface frames", () => {
    const frame = Uint8Array.from(
      {
        length: WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES + 17,
      },
      (_, index) => index % 251,
    );
    const assembler = new WorkerLinkRemoteSurfaceFrameAssembler();
    const first = encodeWorkerLinkRemoteSurfaceChunk({
      frameId: 7,
      frameLength: frame.byteLength,
      offset: 0,
      payload: frame.subarray(
        0,
        WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES,
      ),
    });
    const second = encodeWorkerLinkRemoteSurfaceChunk({
      frameId: 7,
      frameLength: frame.byteLength,
      offset: WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES,
      payload: frame.subarray(WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES),
    });
    expect(first.byteLength).toBe(WORKER_LINK_MAX_PAYLOAD_BYTES);
    expect(decodeWorkerLinkRemoteSurfaceChunk(second)).toMatchObject({
      frameId: 7,
      frameLength: frame.byteLength,
      offset: WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES,
    });
    expect(assembler.push(first)).toBeNull();
    expect(assembler.push(second)).toEqual(frame);
  });

  it("rejects interrupted reliable frames but lets realtime restart", () => {
    const first = encodeWorkerLinkRemoteSurfaceChunk({
      frameId: 1,
      frameLength: 4,
      offset: 0,
      payload: new Uint8Array([1, 2]),
    });
    const replacement = encodeWorkerLinkRemoteSurfaceChunk({
      frameId: 2,
      frameLength: 2,
      offset: 0,
      payload: new Uint8Array([3, 4]),
    });
    const reliable = new WorkerLinkRemoteSurfaceFrameAssembler();
    expect(reliable.push(first)).toBeNull();
    expect(() => reliable.push(replacement)).toThrow(/restarted/i);
    const realtime = new WorkerLinkRemoteSurfaceFrameAssembler(true);
    expect(realtime.push(first)).toBeNull();
    expect(realtime.push(replacement)).toEqual(new Uint8Array([3, 4]));
  });

  it("rejects unknown fields, oversized payloads, and credit overflow", () => {
    expect(
      workerLinkFrameHeaderSchema.safeParse({
        ...frameBase,
        kind: "close",
        code: "normal",
        accountId: "sensitive-label",
      }).success,
    ).toBe(false);
    expect(() =>
      encodeWorkerLinkFrame(
        {
          ...frameBase,
          kind: "accept",
          initialCreditBytes: WORKER_LINK_MAX_CREDIT_BYTES + 1,
        },
        new Uint8Array(),
      ),
    ).toThrow();
    expect(() =>
      encodeWorkerLinkFrame(
        {
          ...frameBase,
          kind: "data",
          direction: "client-to-worker",
          payloadFormat: "raw",
        },
        new Uint8Array(WORKER_LINK_MAX_PAYLOAD_BYTES + 1),
      ),
    ).toThrow(/payload exceeds/i);
    expect(() =>
      encodeWorkerLinkFrame(
        { ...frameBase, kind: "close", code: "normal" },
        new Uint8Array([1]),
      ),
    ).toThrow(/control frames/i);
  });

  it("bounds low-cardinality telemetry batches", () => {
    const sample = {
      occurredAt: now,
      event: "route-fallback" as const,
      route: "relay" as const,
      lane: "stream" as const,
      value: 1,
      latencyMs: 12.5,
      reason: "local-unavailable" as const,
    };
    expect(
      workerLinkTelemetryBatchSchema.parse({
        routeGeneration: 2,
        samples: [sample],
      }).samples,
    ).toEqual([sample]);
    expect(
      workerLinkTelemetryBatchSchema.safeParse({
        routeGeneration: 2,
        samples: Array.from(
          { length: WORKER_LINK_MAX_TELEMETRY_SAMPLES + 1 },
          () => sample,
        ),
      }).success,
    ).toBe(false);
    expect(
      workerLinkTelemetryBatchSchema.safeParse({
        routeGeneration: 2,
        samples: [{ ...sample, projectId: "project-1" }],
      }).success,
    ).toBe(false);
  });
});
