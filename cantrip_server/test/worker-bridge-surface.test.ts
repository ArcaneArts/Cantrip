import {
  decodeCodeTunnelFrame,
  decodeProjectShareTunnelFrame,
  decodeRemoteSurfaceFrame,
  decodeTunnelDataPlaneFrame,
  encodeCodeTunnelFrame,
  encodeProjectShareTunnelFrame,
  encodeRemoteSurfaceFrame,
  encodeTunnelDataPlaneFrame,
  workerNotificationEnvelopeSchema,
  type CodeTunnelFrameHeader,
  type ProjectShareTunnelFrameHeader,
  type RemoteSurfaceFrameHeader,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { WorkerBridge } from "../src/workers/bridge.js";

class TestWorkerSocket {
  bufferedAmount = 0;
  readyState = 1;
  readonly sent: Array<string | Uint8Array> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.emit("close");
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...(args as never[]));
    }
  }
}

const header: RemoteSurfaceFrameHeader = {
  protocolVersion: 1,
  surfaceId: "surface-1",
  attachmentId: "attachment-1",
  sequence: 0,
  channel: "control",
};

describe("WorkerBridge Remote Surface transport", () => {
  it("multiplexes binary frames over the authenticated worker channel", () => {
    const bridge = new WorkerBridge();
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);
    const listener = vi.fn();
    const disconnected = vi.fn();
    const unsubscribe = bridge.subscribeSurfaceFrames("worker-1", listener);
    bridge.subscribeWorkerDisconnect("worker-1", disconnected);

    socket.emit(
      "message",
      encodeRemoteSurfaceFrame(header, new Uint8Array([1, 2])),
      true,
    );
    expect(listener).toHaveBeenCalledWith(header, new Uint8Array([1, 2]));

    expect(
      bridge.sendSurfaceFrame(
        "worker-1",
        { ...header, sequence: 1 },
        new Uint8Array([3]),
      ),
    ).toBe(true);
    const outbound = socket.sent.at(-1);
    expect(outbound).toBeInstanceOf(Uint8Array);
    expect(decodeRemoteSurfaceFrame(outbound as Uint8Array)).toMatchObject({
      header: { sequence: 1, surfaceId: "surface-1" },
    });

    unsubscribe();
    socket.close();
    expect(disconnected).toHaveBeenCalledOnce();
    bridge.close();
  });

  it("keeps Code and project-share tunnels distinct on the shared worker socket", () => {
    const bridge = new WorkerBridge();
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);
    const listener = vi.fn();
    bridge.subscribeCodeTunnelFrames("worker-1", listener);
    const codeHeader: CodeTunnelFrameHeader = {
      protocolVersion: 1,
      attachmentId: "code-attachment-1",
      sessionId: "code-session-1",
      streamId: "stream-1",
      kind: "http-response-data",
    };

    socket.emit(
      "message",
      encodeCodeTunnelFrame(codeHeader, new Uint8Array([7, 8])),
      true,
    );
    expect(listener).toHaveBeenCalledWith(codeHeader, new Uint8Array([7, 8]));
    expect(
      bridge.sendCodeTunnelFrame(
        "worker-1",
        { ...codeHeader, kind: "http-request-end" },
        new Uint8Array(),
      ),
    ).toBe(true);
    expect(
      decodeCodeTunnelFrame(socket.sent.at(-1) as Uint8Array).header.kind,
    ).toBe("http-request-end");

    const shareListener = vi.fn();
    bridge.subscribeProjectShareTunnelFrames("worker-1", shareListener);
    const shareHeader: ProjectShareTunnelFrameHeader = {
      protocolVersion: 1,
      shareId: "share-1",
      streamId: "stream-1",
      kind: "http-response-data",
    };
    socket.emit(
      "message",
      encodeProjectShareTunnelFrame(shareHeader, new Uint8Array([9, 10])),
      true,
    );
    expect(shareListener).toHaveBeenCalledWith(
      shareHeader,
      new Uint8Array([9, 10]),
    );
    expect(listener).toHaveBeenCalledOnce();
    expect(
      bridge.sendProjectShareTunnelFrame(
        "worker-1",
        { ...shareHeader, kind: "http-request-end" },
        new Uint8Array(),
      ),
    ).toBe(true);
    expect(
      decodeProjectShareTunnelFrame(socket.sent.at(-1) as Uint8Array).header
        .kind,
    ).toBe("http-request-end");
    bridge.close();
  });

  it("multiplexes generic tunnel frames without leaking them to legacy listeners", () => {
    const bridge = new WorkerBridge();
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);
    const tunnelListener = vi.fn();
    const codeListener = vi.fn();
    const shareListener = vi.fn();
    bridge.subscribeTunnelDataPlaneFrames("worker-1", tunnelListener);
    bridge.subscribeCodeTunnelFrames("worker-1", codeListener);
    bridge.subscribeProjectShareTunnelFrames("worker-1", shareListener);
    const tunnelHeader: TunnelDataPlaneFrameHeader = {
      protocolVersion: 1,
      tunnelId: "tunnel-1",
      attachmentId: "attachment-1",
      sourceEndpointId: "desktop-1",
      destinationEndpointId: "worker-1",
      connectionId: "connection-1",
      sequence: 0,
      kind: "data",
      direction: "destination-to-source",
    };

    socket.emit(
      "message",
      encodeTunnelDataPlaneFrame(tunnelHeader, new Uint8Array([11, 12])),
      true,
    );
    expect(tunnelListener).toHaveBeenCalledWith(
      tunnelHeader,
      new Uint8Array([11, 12]),
    );
    expect(codeListener).not.toHaveBeenCalled();
    expect(shareListener).not.toHaveBeenCalled();

    expect(
      bridge.sendTunnelDataPlaneFrame(
        "worker-1",
        { ...tunnelHeader, sequence: 1 },
        new Uint8Array([13]),
      ),
    ).toBe(true);
    expect(
      decodeTunnelDataPlaneFrame(socket.sent.at(-1) as Uint8Array),
    ).toMatchObject({
      header: { tunnelId: "tunnel-1", sequence: 1 },
      payload: new Uint8Array([13]),
    });
    bridge.close();
  });

  it("drops disposable frames but resets a congested reliable worker channel", () => {
    const bridge = new WorkerBridge();
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);
    socket.bufferedAmount = 9 * 1_024 * 1_024;

    expect(
      bridge.sendSurfaceFrame(
        "worker-1",
        { ...header, channel: "frame" },
        new Uint8Array([1]),
      ),
    ).toBe(false);
    expect(socket.closes).toEqual([]);

    expect(
      bridge.sendSurfaceFrame(
        "worker-1",
        { ...header, channel: "control" },
        new Uint8Array([2]),
      ),
    ).toBe(false);
    expect(socket.closes).toContainEqual({
      code: 1013,
      reason: "Remote Surface worker channel is congested",
    });
    bridge.close();
  });

  it("delivers validated unsolicited worker notifications separately", () => {
    const bridge = new WorkerBridge();
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);
    const listener = vi.fn();
    bridge.subscribeNotifications("worker-1", listener);
    const notification = workerNotificationEnvelopeSchema.parse({
      kind: "notification",
      notification: {
        type: "worktree.inventory.observed",
        sourcePath: "/repo",
        inventory: {
          sourcePath: "/repo",
          primaryPath: "/repo",
          gitCommonDir: "/repo/.git",
          managedRoot: "/worker/worktrees/fingerprint",
          repositoryFingerprint: "a".repeat(64),
          worktrees: [],
        },
      },
    });

    socket.emit("message", JSON.stringify(notification), false);
    socket.emit("message", JSON.stringify({ kind: "notification" }), false);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(notification.notification);
    bridge.close();
  });
});
