import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  type InstalledWorkerLinkGrant,
  type TunnelDataPlaneFrameHeader,
  type WorkerLinkSession,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { TunnelDestinationRouter } from "./tunnel-destination-router.js";
import { TunnelWorkerLinkAdapter } from "./tunnel-worker-link-adapter.js";
import type { WorkerLinkAdapterEmitter } from "./worker-link-gateway.js";

const tunnelId = "55555555-5555-4555-8555-555555555555";
const attachmentId = "attachment-1";
const grantId = "11111111-1111-4111-8111-111111111111";

function authority(): {
  grant: InstalledWorkerLinkGrant;
  session: WorkerLinkSession;
} {
  const identity = {
    serverId: "server-1",
    serverGeneration: "server-generation-1",
    ownerId: "owner-1",
    accountSessionId: "account-session-1",
    clientInstanceId: "client-instance-1",
    workerId: "worker-1",
    workerProcessGeneration: "worker-generation-1",
  };
  const lease = {
    issuedAt: "2026-08-26T12:00:00.000Z",
    expiresAt: "2026-08-26T12:01:00.000Z",
    absoluteExpiresAt: "2026-08-26T13:00:00.000Z",
  };
  const session: WorkerLinkSession = {
    sessionId: "22222222-2222-4222-8222-222222222222",
    identity,
    lease,
    routePolicy: {
      priority: ["local", "lan", "wan", "relay"],
      enabled: ["local", "relay"],
    },
    routeGeneration: 1,
    preferredRoute: "local",
  };
  return {
    session,
    grant: {
      binding: {
        grantId,
        grantGeneration: 1,
        sessionId: session.sessionId,
        identity,
        resource: { kind: "tunnel", resourceId: tunnelId, attachmentId },
        lanes: ["stream"],
        operations: [
          "stream:open",
          "stream:read",
          "stream:write",
          "stream:half-close",
        ],
        maxChannels: 1,
        lease,
      },
      tokenHash: "a".repeat(64),
    },
  };
}

function base(sequence = 0) {
  return {
    protocolVersion: 1 as const,
    tunnelId,
    attachmentId,
    sourceEndpointId: `worker-link-client:${grantId}`,
    destinationEndpointId: "worker-link-worker:worker-1",
    connectionId: "connection-1",
    sequence,
  };
}

function protectedTarget() {
  return {
    kind: "protected-tunnel" as const,
    targetKind: "tcp" as const,
    recordId: tunnelId,
    protectedRecord: {
      operationId: tunnelId,
      revision: 1,
      protectedContent: {
        formatVersion: 1 as const,
        domain: "tunnel-content" as const,
        keyRevision: 1,
        envelope: {
          version: 1 as const,
          algorithm: "AES-256-GCM" as const,
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    },
  };
}

describe("TunnelWorkerLinkAdapter", () => {
  it("routes exact nested tunnel frames and releases attachment streams", async () => {
    const destinations = {
      handleFrame: vi.fn(),
      revokeAttachment: vi.fn(() => 1),
    };
    const emitted: Uint8Array[] = [];
    const emittedFormats: string[] = [];
    const emitter: WorkerLinkAdapterEmitter = {
      close: vi.fn(async () => true),
      data: vi.fn((payload, payloadFormat = "raw") => {
        emitted.push(payload.slice());
        emittedFormats.push(payloadFormat);
        return true;
      }),
      error: vi.fn(() => true),
      halfClose: vi.fn(() => true),
    };
    const adapter = new TunnelWorkerLinkAdapter(
      destinations as unknown as TunnelDestinationRouter,
    );
    const { grant, session } = authority();
    const channel = await adapter.open({
      channel: {
        channelId: "33333333-3333-4333-8333-333333333333",
        connectionId: "44444444-4444-4444-8444-444444444444",
      },
      grant,
      lane: "stream",
      emit: emitter,
      session,
    });
    const connect: TunnelDataPlaneFrameHeader = {
      ...base(),
      kind: "connect",
      target: protectedTarget(),
      initialCreditBytes: 1024,
    };
    await channel.write?.(
      encodeTunnelDataPlaneFrame(connect, new Uint8Array()),
    );
    expect(destinations.handleFrame).toHaveBeenCalledWith(
      connect,
      expect.any(Uint8Array),
      { diagnosticTraceId: undefined },
    );

    const accepted: TunnelDataPlaneFrameHeader = {
      ...base(),
      kind: "accepted",
      initialCreditBytes: 1024,
    };
    expect(adapter.routeFrame(accepted, new Uint8Array())).toBe(true);
    expect(decodeTunnelDataPlaneFrame(emitted[0]!).header).toEqual(accepted);
    expect(emittedFormats).toEqual(["tunnel-data-plane-v1"]);
    const capacity = adapter.waitForCapacity(attachmentId)!;
    let settled = false;
    void capacity.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await channel.credit?.(emitted[0]!.byteLength);
    await expect(capacity).resolves.toBe(true);

    await channel.close?.("normal");
    expect(destinations.revokeAttachment).toHaveBeenCalledWith(attachmentId);
    expect(adapter.routeFrame(accepted, new Uint8Array())).toBeNull();
  });

  it("rejects nested frames outside the exact grant identity", async () => {
    const adapter = new TunnelWorkerLinkAdapter({
      handleFrame: vi.fn(),
      revokeAttachment: vi.fn(() => 0),
    } as unknown as TunnelDestinationRouter);
    const { grant, session } = authority();
    const channel = await adapter.open({
      channel: {
        channelId: "33333333-3333-4333-8333-333333333333",
        connectionId: "44444444-4444-4444-8444-444444444444",
      },
      grant,
      lane: "stream",
      emit: {
        close: vi.fn(async () => true),
        data: vi.fn(() => true),
        error: vi.fn(() => true),
        halfClose: vi.fn(() => true),
      },
      session,
    });
    const escaped: TunnelDataPlaneFrameHeader = {
      ...base(),
      tunnelId: "another-tunnel",
      kind: "connect",
      target: protectedTarget(),
      initialCreditBytes: 1024,
    };
    expect(() =>
      channel.write?.(encodeTunnelDataPlaneFrame(escaped, new Uint8Array())),
    ).toThrow("escaped its grant binding");
    const unprotected: TunnelDataPlaneFrameHeader = {
      ...base(),
      kind: "connect",
      target: { kind: "tcp", host: "127.0.0.1", port: 4321 },
      initialCreditBytes: 1024,
    };
    expect(() =>
      channel.write?.(
        encodeTunnelDataPlaneFrame(unprotected, new Uint8Array()),
      ),
    ).toThrow("escaped its grant binding");
  });
});
