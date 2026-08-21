import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  type RemoteSurfaceFrameHeader,
} from "@cantrip/protocol";

import type { WorkerCommandBus } from "../workers/bridge.js";
import { serverLogger } from "../logger.js";

const MAX_BUFFERED_SURFACE_BYTES = 8 * 1_024 * 1_024;

export interface RemoteSurfaceClientSocket {
  bufferedAmount: number;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
  on(
    event: "message",
    listener: (data: unknown, isBinary?: boolean) => void,
  ): void;
  readyState: number;
  send(data: string | Uint8Array, options?: { binary?: boolean }): void;
}

export interface RemoteSurfaceRelayBinding {
  attachmentId: string;
  ownerId: string;
  surfaceId: string;
  workerId: string;
}

function frameBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const chunks = data.map(frameBytes);
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }
  throw new Error("Unsupported Remote Surface binary frame type.");
}

export class RemoteSurfaceRelay {
  constructor(
    private readonly bridge: WorkerCommandBus,
    private readonly consumeRelayBytes: (
      ownerId: string,
      workerId: string,
      bytes: number,
    ) => boolean = () => true,
  ) {}

  bind(
    socket: RemoteSurfaceClientSocket,
    binding: RemoteSurfaceRelayBinding,
  ): () => void {
    const startedAtMs = Date.now();
    let closed = false;
    let closeReasonCode = "client_closed";
    let bytesFromClient = 0;
    let bytesFromWorker = 0;
    let framesFromClient = 0;
    let framesFromWorker = 0;
    let droppedFrames = 0;
    const lastClientSequences = new Map<
      RemoteSurfaceFrameHeader["channel"],
      number
    >();
    const lastWorkerSequences = new Map<
      RemoteSurfaceFrameHeader["channel"],
      number
    >();
    let unsubscribeDisconnect: () => void = () => undefined;

    const unsubscribe = this.bridge.subscribeSurfaceFrames(
      binding.workerId,
      (header, payload) => {
        if (
          closed ||
          header.surfaceId !== binding.surfaceId ||
          header.attachmentId !== binding.attachmentId ||
          header.sequence <= (lastWorkerSequences.get(header.channel) ?? -1) ||
          socket.readyState !== 1
        ) {
          return;
        }
        if (
          !this.consumeRelayBytes(
            binding.ownerId,
            binding.workerId,
            payload.byteLength,
          )
        ) {
          closeReasonCode = "relay_quota_reached";
          socket.close(1013, "Remote Surface relay bandwidth quota reached");
          cleanup();
          return;
        }
        if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) {
          if (header.channel === "frame" || header.channel === "cursor") {
            droppedFrames += 1;
            return;
          }
          closeReasonCode = "client_backpressure";
          socket.close(1013, "Remote Surface client is too slow");
          return;
        }
        socket.send(encodeRemoteSurfaceFrame(header, payload), {
          binary: true,
        });
        framesFromWorker += 1;
        bytesFromWorker += payload.byteLength;
        lastWorkerSequences.set(header.channel, header.sequence);
      },
    );

    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      unsubscribeDisconnect();
      serverLogger.info("Remote Surface relay closed", {
        event: "remote_surface.relay.closed",
        subsystem: "remote-surface",
        operation: "relay",
        status: "completed",
        reasonCode: closeReasonCode,
        attachmentId: binding.attachmentId,
        surfaceId: binding.surfaceId,
        workerId: binding.workerId,
        durationMs: Date.now() - startedAtMs,
        bytesFromClient,
        bytesFromWorker,
        counts: {
          framesFromClient,
          framesFromWorker,
          droppedFrames,
        },
      });
    };

    unsubscribeDisconnect = this.bridge.subscribeWorkerDisconnect(
      binding.workerId,
      () => {
        if (closed) return;
        closeReasonCode = "worker_disconnected";
        socket.close(1013, "Remote Surface worker disconnected");
        cleanup();
      },
    );

    socket.on("message", (data, isBinary) => {
      if (closed) return;
      if (!isBinary) {
        closeReasonCode = "non_binary_frame";
        socket.close(1003, "Remote Surface data must be binary");
        cleanup();
        return;
      }
      let frame: { header: RemoteSurfaceFrameHeader; payload: Uint8Array };
      try {
        frame = decodeRemoteSurfaceFrame(frameBytes(data));
      } catch {
        closeReasonCode = "invalid_frame";
        socket.close(1008, "Invalid Remote Surface frame");
        cleanup();
        return;
      }
      if (
        frame.header.surfaceId !== binding.surfaceId ||
        frame.header.attachmentId !== binding.attachmentId
      ) {
        closeReasonCode = "binding_mismatch";
        socket.close(1008, "Remote Surface binding mismatch");
        cleanup();
        return;
      }
      if (
        frame.header.sequence <=
        (lastClientSequences.get(frame.header.channel) ?? -1)
      ) {
        return;
      }
      if (
        !this.consumeRelayBytes(
          binding.ownerId,
          binding.workerId,
          frame.payload.byteLength,
        )
      ) {
        closeReasonCode = "relay_quota_reached";
        socket.close(1013, "Remote Surface relay bandwidth quota reached");
        cleanup();
        return;
      }
      if (
        !this.bridge.sendSurfaceFrame(
          binding.workerId,
          frame.header,
          frame.payload,
        )
      ) {
        if (
          frame.header.channel === "frame" ||
          frame.header.channel === "cursor"
        ) {
          droppedFrames += 1;
          return;
        }
        closeReasonCode = "worker_unavailable_or_congested";
        socket.close(1013, "Remote Surface worker is unavailable or congested");
        cleanup();
        return;
      }
      framesFromClient += 1;
      bytesFromClient += frame.payload.byteLength;
      lastClientSequences.set(frame.header.channel, frame.header.sequence);
    });
    socket.on("close", cleanup);
    serverLogger.info("Remote Surface relay active", {
      event: "remote_surface.relay.active",
      subsystem: "remote-surface",
      operation: "relay",
      status: "started",
      attachmentId: binding.attachmentId,
      surfaceId: binding.surfaceId,
      workerId: binding.workerId,
    });
    return cleanup;
  }
}
