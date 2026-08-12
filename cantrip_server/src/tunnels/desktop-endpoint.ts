import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";

import type {
  TunnelDataPlaneEndpoint,
  TunnelEndpointFrameListener,
} from "./broker.js";

const MAX_BUFFERED_BYTES = 8 * 1_024 * 1_024;

export interface DesktopTunnelSocket {
  bufferedAmount: number;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: () => void): void;
  on(
    event: "message",
    listener: (data: unknown, isBinary?: boolean) => void,
  ): void;
  readyState: number;
  send(data: Uint8Array, options?: { binary?: boolean }): void;
}

function frameBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const chunks = data.map(frameBytes);
    const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  throw new Error("Desktop client sent an unsupported binary frame type.");
}

export class DesktopTunnelEndpoint implements TunnelDataPlaneEndpoint {
  readonly endpointId: string;
  readonly placement: { kind: "desktop-client"; clientId: string };
  readonly #disconnectListeners = new Set<() => void>();
  readonly #frameListeners = new Set<TunnelEndpointFrameListener>();
  #disconnected = false;

  constructor(
    readonly socket: DesktopTunnelSocket,
    readonly clientId: string,
    attachmentId: string,
  ) {
    this.endpointId = `desktop:${clientId}:${attachmentId}`;
    this.placement = { kind: "desktop-client", clientId };
    socket.on("message", (data, isBinary) => {
      if (!isBinary || this.#disconnected) return;
      try {
        const frame = decodeTunnelDataPlaneFrame(frameBytes(data));
        for (const listener of this.#frameListeners) {
          listener(frame.header, frame.payload);
        }
      } catch {
        socket.close(1003, "Invalid tunnel frame");
      }
    });
    const disconnect = () => this.#disconnect();
    socket.on("close", disconnect);
    socket.on("error", disconnect);
  }

  send(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): boolean {
    if (
      this.#disconnected ||
      this.socket.readyState !== 1 ||
      this.socket.bufferedAmount > MAX_BUFFERED_BYTES
    ) {
      return false;
    }
    try {
      this.socket.send(encodeTunnelDataPlaneFrame(header, payload), {
        binary: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  subscribe(listener: TunnelEndpointFrameListener): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  subscribeDisconnect(listener: () => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  close(code = 1000, reason = "Tunnel attachment closed"): void {
    if (this.socket.readyState === 0 || this.socket.readyState === 1) {
      this.socket.close(code, reason);
    }
    this.#disconnect();
  }

  #disconnect(): void {
    if (this.#disconnected) return;
    this.#disconnected = true;
    for (const listener of this.#disconnectListeners) listener();
    this.#disconnectListeners.clear();
    this.#frameListeners.clear();
  }
}
