import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  type InstalledWorkerLinkGrant,
  type RemoteSurfaceFrameHeader,
  type WorkerLinkSession,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { RemoteSurfaceWorkerLinkAdapter } from "./remote-surface-worker-link-adapter.js";
import type { WorkerLinkAdapterEmitter } from "./worker-link-gateway.js";

type FrameEmitter = (
  header: RemoteSurfaceFrameHeader,
  payload: Uint8Array,
) => boolean;

const now = Date.parse("2026-08-26T12:00:00.000Z");
const session: WorkerLinkSession = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  identity: {
    serverId: "server-1",
    serverGeneration: "server-generation-1",
    ownerId: "owner-1",
    accountSessionId: "account-session-1",
    clientInstanceId: "client-instance-1",
    workerId: "worker-1",
    workerProcessGeneration: "worker-generation-1",
  },
  lease: {
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    absoluteExpiresAt: new Date(now + 120_000).toISOString(),
  },
  routePolicy: {
    priority: ["local", "lan", "wan", "relay"],
    enabled: ["local", "lan", "wan", "relay"],
  },
  routeGeneration: 1,
  preferredRoute: "local",
};
const grant: InstalledWorkerLinkGrant = {
  binding: {
    grantId: "22222222-2222-4222-8222-222222222222",
    grantGeneration: 1,
    sessionId: session.sessionId,
    identity: session.identity,
    resource: {
      kind: "browser",
      resourceId: "browser-1",
      attachmentId: "attachment-1",
    },
    lanes: ["interactive", "realtime"],
    operations: ["stream:open", "stream:read", "stream:write"],
    maxChannels: 2,
    lease: session.lease,
  },
  tokenHash: "a".repeat(64),
};

function emitter(
  send: WorkerLinkAdapterEmitter["data"] = vi.fn(() => true),
): WorkerLinkAdapterEmitter {
  return {
    close: vi.fn(async () => true),
    data: send,
    error: vi.fn(() => true),
    halfClose: vi.fn(() => true),
  };
}

function header(
  channel: RemoteSurfaceFrameHeader["channel"],
  sequence: number,
): RemoteSurfaceFrameHeader {
  return {
    protocolVersion: 1,
    surfaceId: "browser-1",
    attachmentId: "attachment-1",
    sequence,
    channel,
  };
}

describe("RemoteSurfaceWorkerLinkAdapter", () => {
  it("isolates reliable control from disposable frame and cursor output", async () => {
    const frameRoute: { current?: FrameEmitter } = {};
    const releaseEmitter = vi.fn();
    const handleFrame = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const surfaces = {
      bindAttachmentFrameEmitter: vi.fn(
        (
          _surfaceId: string,
          _attachmentId: string,
          _surfaceKind: "browser" | "desktop",
          emit: FrameEmitter,
        ) => {
          frameRoute.current = emit;
          return releaseEmitter;
        },
      ),
      detach,
      handleFrame,
    };
    const adapter = new RemoteSurfaceWorkerLinkAdapter(surfaces, {
      resourceKind: "browser",
      surfaceKind: "browser",
    });
    const interactiveSend = vi.fn((_payload: Uint8Array) => true);
    const realtimeSend = vi.fn((_payload: Uint8Array) => false);
    const interactive = emitter(interactiveSend);
    const realtime = emitter(realtimeSend);
    const interactiveChannel = await adapter.open({
      channel: {
        channelId: "33333333-3333-4333-8333-333333333333",
        connectionId: "44444444-4444-4444-8444-444444444444",
      },
      emit: interactive,
      grant,
      lane: "interactive",
      session,
    });
    const realtimeChannel = await adapter.open({
      channel: {
        channelId: "55555555-5555-4555-8555-555555555555",
        connectionId: "66666666-6666-4666-8666-666666666666",
      },
      emit: realtime,
      grant,
      lane: "realtime",
      session,
    });

    expect(
      frameRoute.current?.(header("control", 0), new Uint8Array([1])),
    ).toBe(true);
    expect(frameRoute.current?.(header("frame", 0), new Uint8Array([2]))).toBe(
      true,
    );
    expect(frameRoute.current?.(header("cursor", 0), new Uint8Array([3]))).toBe(
      true,
    );
    expect(interactiveSend).toHaveBeenCalledTimes(1);
    expect(
      decodeRemoteSurfaceFrame(interactiveSend.mock.calls[0]![0]).header
        .channel,
    ).toBe("control");
    expect(realtimeSend).toHaveBeenCalledTimes(2);

    const clientFrame = encodeRemoteSurfaceFrame(
      header("control", 1),
      new Uint8Array([4, 5]),
    );
    await interactiveChannel.write?.(clientFrame);
    expect(handleFrame).toHaveBeenCalledWith(
      header("control", 1),
      new Uint8Array([4, 5]),
    );
    expect(realtimeChannel.write).toBeUndefined();

    await interactiveChannel.close?.("route-replaced");
    await realtimeChannel.close?.("route-replaced");
    expect(detach).not.toHaveBeenCalled();
    await adapter.revoke?.({ grant, session });
    expect(releaseEmitter).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledWith("browser-1", "attachment-1");
  });

  it("retains bounded interactive output across lane replacement", async () => {
    const frameRoute: { current?: FrameEmitter } = {};
    const surfaces = {
      bindAttachmentFrameEmitter(
        _surfaceId: string,
        _attachmentId: string,
        _surfaceKind: "browser" | "desktop",
        emit: FrameEmitter,
      ) {
        frameRoute.current = emit;
        return () => undefined;
      },
      detach: vi.fn(async () => undefined),
      handleFrame: vi.fn(async () => undefined),
    };
    const adapter = new RemoteSurfaceWorkerLinkAdapter(surfaces, {
      resourceKind: "browser",
      surfaceKind: "browser",
    });
    const blockedSend = vi.fn((_payload: Uint8Array) => false);
    const first = await adapter.open({
      channel: {
        channelId: "33333333-3333-4333-8333-333333333333",
        connectionId: "44444444-4444-4444-8444-444444444444",
      },
      emit: emitter(blockedSend),
      grant,
      lane: "interactive",
      session,
    });
    expect(
      frameRoute.current?.(header("control", 0), new Uint8Array([7])),
    ).toBe(true);
    await first.close?.("route-replaced");

    const replacementSend = vi.fn((_payload: Uint8Array) => true);
    await adapter.open({
      channel: {
        channelId: "77777777-7777-4777-8777-777777777777",
        connectionId: "88888888-8888-4888-8888-888888888888",
      },
      emit: emitter(replacementSend),
      grant,
      lane: "interactive",
      session,
    });
    expect(replacementSend).toHaveBeenCalledOnce();
    expect(
      decodeRemoteSurfaceFrame(replacementSend.mock.calls[0]![0]).payload,
    ).toEqual(new Uint8Array([7]));
  });

  it("fails closed on duplicate lanes and cross-attachment frames", async () => {
    const surfaces = {
      bindAttachmentFrameEmitter: vi.fn(() => () => undefined),
      detach: vi.fn(async () => undefined),
      handleFrame: vi.fn(async () => undefined),
    };
    const adapter = new RemoteSurfaceWorkerLinkAdapter(surfaces, {
      resourceKind: "browser",
      surfaceKind: "browser",
    });
    const context = {
      channel: {
        channelId: "33333333-3333-4333-8333-333333333333",
        connectionId: "44444444-4444-4444-8444-444444444444",
      },
      emit: emitter(),
      grant,
      lane: "interactive" as const,
      session,
    };
    const channel = await adapter.open(context);
    await expect(
      Promise.resolve().then(() =>
        adapter.open({
          ...context,
          channel: {
            channelId: "55555555-5555-4555-8555-555555555555",
            connectionId: "66666666-6666-4666-8666-666666666666",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "resource-unavailable" });
    await expect(
      channel.write?.(
        encodeRemoteSurfaceFrame(
          { ...header("control", 0), attachmentId: "another-attachment" },
          new Uint8Array([1]),
        ),
      ),
    ).rejects.toThrow(/grant binding/u);
  });
});
