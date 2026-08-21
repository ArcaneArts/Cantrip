import { describe, expect, it, vi } from "vitest";
import {
  decryptRemoteSurfaceStreamPayload,
  encryptRemoteSurfaceStreamPayload,
  randomBytes,
} from "@cantrip/crypto";

import {
  RemoteSurfaceManager,
  type RemoteSurfaceAdapter,
  type RemoteSurfaceSession,
  type WorkerWebRtcAttachmentFactory,
} from "../src/remote-surface-manager.js";
import type { WorkerWebRtcAttachment } from "../src/remote-surfaces/webrtc.js";
import { readWorkerLogs } from "../src/logger.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const attachCommand = {
  type: "surface.attach" as const,
  surfaceId: "surface-1",
  attachmentId: "attachment-1",
  projectId: "project-1",
  serverId: "server-1",
  configuration: {
    kind: "browser" as const,
    profileId: null,
  },
  stateResource: "browser-row" as const,
  stateRevision: 1,
  stateProtection: {
    classification: { recordKind: "browser-state" as const },
    protectedState: {
      formatVersion: 1 as const,
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
  preferredTransport: "websocket" as const,
  viewport: { width: 1_280, height: 720, devicePixelRatio: 2 },
  desktopStream: null,
};

function streamEncryption(): {
  componentKey: Uint8Array;
  ownerId: string;
  service: WorkerEncryptionService;
} {
  const key = randomBytes(32);
  const ownerId = "remote-surface-owner";
  const service = {
    componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
    ownerId: () => ownerId,
  } as unknown as WorkerEncryptionService;
  return { componentKey: key, ownerId, service };
}

describe("RemoteSurfaceManager", () => {
  it("isolates rejected WebRTC control input from the worker process", async () => {
    const cursor = readWorkerLogs({}).nextCursor;
    const handleFrame = vi.fn(async () => {
      throw new Error("Pointer target is outside display bounds.");
    });
    const session = {
      configuration: attachCommand.configuration,
      transport: "webrtc" as const,
      attach: vi.fn(),
      close: vi.fn(),
      detach: vi.fn(),
      handleFrame,
      resume: vi.fn(),
      suspend: vi.fn(),
    } satisfies RemoteSurfaceSession;
    let receiveFrame:
      Parameters<WorkerWebRtcAttachmentFactory>[0]["onFrame"] | undefined;
    const createWebRtcAttachment: WorkerWebRtcAttachmentFactory = (options) => {
      receiveFrame = options.onFrame;
      return {
        close: vi.fn(async () => undefined),
        handleSignal: vi.fn(async () => undefined),
        send: vi.fn(() => "unavailable" as const),
      } as unknown as WorkerWebRtcAttachment;
    };
    const manager = new RemoteSurfaceManager(
      { browser: { open: async () => session } },
      4,
      createWebRtcAttachment,
    );
    await manager.attach({
      ...attachCommand,
      preferredTransport: "webrtc",
      webrtc: {
        iceServers: [],
        iceTransportPolicy: "all",
        negotiationTimeoutMs: 1_000,
      },
    });

    receiveFrame?.(
      {
        protocolVersion: 1,
        surfaceId: "surface-1",
        attachmentId: "attachment-1",
        sequence: 1,
        channel: "control",
      },
      new Uint8Array([1]),
    );

    await vi.waitFor(() => {
      expect(
        readWorkerLogs({ afterCursor: cursor }).records.some(
          (record) =>
            record.context?.event === "surface.transport.frame-rejected",
        ),
      ).toBe(true);
    });
    const record = readWorkerLogs({ afterCursor: cursor }).records.find(
      (candidate) =>
        candidate.context?.event === "surface.transport.frame-rejected",
    );
    expect(record).toMatchObject({
      level: "warn",
      message: "Rejected Remote Surface WebRTC frame",
      context: {
        reasonCode: "invalid-frame",
        surfaceId: "surface-1",
      },
    });
  });

  it("routes only protected ordered frames through a reusable worker-owned session", async () => {
    const handleFrame = vi.fn();
    const attach = vi.fn();
    const detach = vi.fn();
    const updateConfiguration = vi.fn();
    let emit:
      | ((
          attachmentId: string,
          channel: "frame",
          payload: Uint8Array,
        ) => boolean)
      | undefined;
    const session: RemoteSurfaceSession = {
      configuration: attachCommand.configuration,
      transport: "websocket",
      attach,
      close: vi.fn(),
      detach,
      handleFrame,
      resume: vi.fn(),
      suspend: vi.fn(),
      updateConfiguration,
    };
    const adapter: RemoteSurfaceAdapter = {
      async open(_command, send) {
        emit = send as typeof emit;
        return session;
      },
    };
    const manager = new RemoteSurfaceManager({ browser: adapter });
    const encryption = streamEncryption();
    manager.setEncryptionService(encryption.service);
    const outbound = vi.fn(() => true);
    manager.setFrameEmitter(outbound);

    await expect(manager.attach(attachCommand)).resolves.toEqual({
      accepted: true,
      transport: "websocket",
    });
    expect(attach).toHaveBeenCalledWith({
      id: "attachment-1",
      viewport: attachCommand.viewport,
    });

    const firstHeader = {
      protocolVersion: 1,
      surfaceId: "surface-1",
      attachmentId: "attachment-1",
      sequence: 4,
      channel: "control" as const,
    };
    await manager.handleFrame(
      firstHeader,
      await encryptRemoteSurfaceStreamPayload({
        ownerId: encryption.ownerId,
        context: {
          serverId: attachCommand.serverId,
          surfaceKind: "browser",
          surfaceId: firstHeader.surfaceId,
          attachmentId: firstHeader.attachmentId,
          direction: "client-to-worker",
          channel: firstHeader.channel,
          sequence: firstHeader.sequence,
        },
        keyRevision: 1,
        componentKey: encryption.componentKey,
        plaintext: new Uint8Array([1]),
      }),
    );
    const staleHeader = { ...firstHeader, sequence: 3 };
    await manager.handleFrame(
      staleHeader,
      await encryptRemoteSurfaceStreamPayload({
        ownerId: encryption.ownerId,
        context: {
          serverId: attachCommand.serverId,
          surfaceKind: "browser",
          surfaceId: staleHeader.surfaceId,
          attachmentId: staleHeader.attachmentId,
          direction: "client-to-worker",
          channel: staleHeader.channel,
          sequence: staleHeader.sequence,
        },
        keyRevision: 1,
        componentKey: encryption.componentKey,
        plaintext: new Uint8Array([2]),
      }),
    );
    expect(handleFrame).toHaveBeenCalledTimes(1);
    expect(handleFrame.mock.calls[0]![0]).toBe("attachment-1");
    expect(handleFrame.mock.calls[0]![1]).toBe("control");
    expect(Uint8Array.from(handleFrame.mock.calls[0]![2])).toEqual(
      new Uint8Array([1]),
    );

    await manager.configure({
      type: "surface.configure",
      surfaceId: "surface-1",
      serverId: attachCommand.serverId,
      configuration: attachCommand.configuration,
      stateResource: attachCommand.stateResource,
      stateRevision: 2,
      stateProtection: attachCommand.stateProtection,
    });
    expect(updateConfiguration).toHaveBeenCalledWith(
      attachCommand.configuration,
      expect.objectContaining({ stateRevision: 2 }),
    );

    emit?.("attachment-1", "frame", new Uint8Array([9, 8]));
    expect(outbound).toHaveBeenCalledOnce();
    const [outboundHeader, outboundPayload] = outbound.mock.calls[0]!;
    expect(outboundHeader).toMatchObject({
      surfaceId: "surface-1",
      attachmentId: "attachment-1",
      sequence: 0,
      channel: "frame",
    });
    expect(outboundPayload).not.toEqual(new Uint8Array([9, 8]));
    await expect(
      decryptRemoteSurfaceStreamPayload({
        ownerId: encryption.ownerId,
        context: {
          serverId: attachCommand.serverId,
          surfaceKind: "browser",
          surfaceId: "surface-1",
          attachmentId: "attachment-1",
          direction: "worker-to-client",
          channel: "frame",
          sequence: 0,
        },
        keyRevision: 1,
        componentKey: encryption.componentKey,
        protectedPayload: outboundPayload,
      }),
    ).resolves.toEqual(new Uint8Array([9, 8]));

    await manager.detach("surface-1", "attachment-1");
    expect(detach).toHaveBeenCalledWith("attachment-1");
  });

  it("does not expose private adapter failures to logs or bridge callers", async () => {
    const sentinel = "SURFACE-PRIVATE-ERROR-SENTINEL";
    const cursor = readWorkerLogs({}).nextCursor;
    const manager = new RemoteSurfaceManager({
      browser: {
        open: async () => {
          throw new Error(`${sentinel}: https://private.example/path`);
        },
      },
    });

    await expect(manager.attach(attachCommand)).rejects.toThrow(
      "Remote Surface could not be opened.",
    );
    expect(
      JSON.stringify(readWorkerLogs({ afterCursor: cursor }).records),
    ).not.toContain(sentinel);
  });

  it("serializes concurrent attachments while a surface is opening", async () => {
    const attach = vi.fn();
    const session = {
      configuration: attachCommand.configuration,
      transport: "websocket" as const,
      attach,
      close: vi.fn(),
      detach: vi.fn(),
      handleFrame: vi.fn(),
      resume: vi.fn(),
      suspend: vi.fn(),
    } satisfies RemoteSurfaceSession;
    let releaseOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const open = vi.fn(async () => {
      await openGate;
      return session;
    });
    const manager = new RemoteSurfaceManager({ browser: { open } });

    const first = manager.attach(attachCommand);
    const second = manager.attach({
      ...attachCommand,
      attachmentId: "attachment-2",
    });
    releaseOpen?.();
    await Promise.all([first, second]);

    expect(open).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach).toHaveBeenCalledWith({
      id: "attachment-1",
      viewport: attachCommand.viewport,
    });
    expect(attach).toHaveBeenCalledWith({
      id: "attachment-2",
      viewport: attachCommand.viewport,
    });
  });

  it("rejects kinds for which the worker has no adapter", async () => {
    const manager = new RemoteSurfaceManager();
    await expect(manager.attach(attachCommand)).rejects.toThrow(
      /does not support browser/i,
    );
  });

  it("enforces the worker session limit", async () => {
    const session = {
      configuration: attachCommand.configuration,
      transport: "websocket" as const,
      attach() {},
      close() {},
      detach() {},
      handleFrame() {},
      resume() {},
      suspend() {},
    } satisfies RemoteSurfaceSession;
    const manager = new RemoteSurfaceManager(
      { browser: { open: async () => session } },
      1,
    );
    await manager.attach(attachCommand);
    await expect(
      manager.attach({
        ...attachCommand,
        surfaceId: "surface-2",
        attachmentId: "attachment-2",
      }),
    ).rejects.toThrow(/limit of 1/i);
  });

  it("bounds independent client attachments to one surface", async () => {
    const session = {
      configuration: attachCommand.configuration,
      transport: "websocket" as const,
      attach() {},
      close() {},
      detach() {},
      handleFrame() {},
      resume() {},
      suspend() {},
    } satisfies RemoteSurfaceSession;
    const manager = new RemoteSurfaceManager({
      browser: { open: async () => session },
    });
    for (let index = 1; index <= 4; index += 1) {
      await manager.attach({
        ...attachCommand,
        attachmentId: `attachment-${index}`,
      });
    }
    await expect(
      manager.attach({
        ...attachCommand,
        attachmentId: "attachment-5",
      }),
    ).rejects.toThrow(/4 active attachments/i);
  });
});
