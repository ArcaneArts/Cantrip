import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  type RemoteSurfaceFrameHeader,
} from "@cantrip/protocol";

import type { WorkerCommandBus } from "../workers/bridge.js";

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
  constructor(private readonly bridge: WorkerCommandBus) {}

  bind(
    socket: RemoteSurfaceClientSocket,
    binding: RemoteSurfaceRelayBinding,
  ): () => void {
    let closed = false;
    let lastClientSequence = -1;
    let lastWorkerSequence = -1;

    const unsubscribe = this.bridge.subscribeSurfaceFrames(
      binding.workerId,
      (header, payload) => {
        if (
          closed ||
          header.surfaceId !== binding.surfaceId ||
          header.attachmentId !== binding.attachmentId ||
          header.sequence <= lastWorkerSequence ||
          socket.readyState !== 1
        ) {
          return;
        }
        if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) {
          if (header.channel === "frame" || header.channel === "cursor") return;
          socket.close(1013, "Remote Surface client is too slow");
          return;
        }
        socket.send(encodeRemoteSurfaceFrame(header, payload), {
          binary: true,
        });
        lastWorkerSequence = header.sequence;
      },
    );

    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    };

    socket.on("message", (data, isBinary) => {
      if (closed) return;
      if (!isBinary) {
        socket.close(1003, "Remote Surface data must be binary");
        cleanup();
        return;
      }
      let frame: { header: RemoteSurfaceFrameHeader; payload: Uint8Array };
      try {
        frame = decodeRemoteSurfaceFrame(frameBytes(data));
      } catch {
        socket.close(1008, "Invalid Remote Surface frame");
        cleanup();
        return;
      }
      if (
        frame.header.surfaceId !== binding.surfaceId ||
        frame.header.attachmentId !== binding.attachmentId
      ) {
        socket.close(1008, "Remote Surface binding mismatch");
        cleanup();
        return;
      }
      if (frame.header.sequence <= lastClientSequence) return;
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
        )
          return;
        socket.close(1013, "Remote Surface worker is unavailable or congested");
        cleanup();
        return;
      }
      lastClientSequence = frame.header.sequence;
    });
    socket.on("close", cleanup);
    return cleanup;
  }
}
