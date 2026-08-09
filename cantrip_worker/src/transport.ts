import {
  decodeCodeTunnelFrame,
  decodeRemoteSurfaceFrame,
  encodeCodeTunnelFrame,
  encodeRemoteSurfaceFrame,
  isCodeTunnelFrame,
  type CodeTunnelFrameHeader,
  type RemoteSurfaceFrameHeader,
  type WorkerCommand,
  workerEventEnvelopeSchema,
  type WorkerEvent,
  workerNotificationEnvelopeSchema,
  type WorkerNotification,
  workerRequestEnvelopeSchema,
  workerResponseEnvelopeSchema,
} from "@cantrip/protocol";
import WebSocket, { type RawData } from "ws";

import type { WorkerConfig } from "./config.js";

type CommandHandler = (
  command: WorkerCommand,
  emit: (event: WorkerEvent) => void,
) => Promise<unknown>;

type SurfaceFrameHandler = (
  header: RemoteSurfaceFrameHeader,
  payload: Uint8Array,
) => Promise<void> | void;

type CodeTunnelFrameHandler = (
  header: CodeTunnelFrameHeader,
  payload: Uint8Array,
) => Promise<void> | void;

const MAX_BUFFERED_SURFACE_BYTES = 8 * 1_024 * 1_024;
const MAX_BUFFERED_NOTIFICATION_BYTES = 1 * 1_024 * 1_024;
const CODE_TUNNEL_LOW_WATER_BYTES = 256 * 1_024;

function rawDataBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export class WorkerConnection {
  #closed = false;
  #lastConnectionError: string | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #socket: WebSocket | null = null;

  constructor(
    private readonly config: WorkerConfig,
    private readonly handleCommand: CommandHandler,
    private readonly handleSurfaceFrame: SurfaceFrameHandler = () => undefined,
    private readonly handleCodeTunnelFrame: CodeTunnelFrameHandler = () =>
      undefined,
  ) {}

  start(): void {
    this.connect();
  }

  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.close(1000, "Worker stopping");
    this.#socket = null;
  }

  private connect(): void {
    if (this.#closed) {
      return;
    }
    const url = new URL(this.config.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/internal/workers/connect";
    url.searchParams.set("workerId", this.config.workerId);

    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.config.token}` },
    });
    this.#socket = socket;
    socket.once("open", () => {
      this.#lastConnectionError = null;
      console.log("[cantrip_worker] Command channel connected.");
    });
    socket.on("message", (data, isBinary) => {
      void this.onMessage(socket, data, isBinary);
    });
    socket.once("error", (error) => {
      if (!this.#closed && error.message !== this.#lastConnectionError) {
        this.#lastConnectionError = error.message;
        console.warn(
          `[cantrip_worker] Command channel unavailable: ${error.message}`,
        );
      }
    });
    socket.once("close", () => {
      if (this.#socket === socket) {
        this.#socket = null;
      }
      if (!this.#closed) {
        this.#reconnectTimer = setTimeout(() => this.connect(), 1_000);
      }
    });
  }

  sendSurfaceFrame(
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) {
      if (header.channel !== "frame" && header.channel !== "cursor") {
        socket.close(1013, "Remote Surface worker channel is congested");
      }
      return false;
    }
    try {
      socket.send(encodeRemoteSurfaceFrame(header, payload), { binary: true });
      return true;
    } catch {
      return false;
    }
  }

  sendCodeTunnelFrame(
    header: CodeTunnelFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) return false;
    try {
      socket.send(encodeCodeTunnelFrame(header, payload), { binary: true });
      return true;
    } catch {
      return false;
    }
  }

  sendNotification(notification: WorkerNotification): boolean {
    const socket = this.#socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_BUFFERED_NOTIFICATION_BYTES
    ) {
      return false;
    }
    try {
      socket.send(
        JSON.stringify(
          workerNotificationEnvelopeSchema.parse({
            kind: "notification",
            notification,
          }),
        ),
      );
      return true;
    } catch {
      return false;
    }
  }

  async waitForCodeTunnelCapacity(): Promise<boolean> {
    while (!this.#closed) {
      const socket = this.#socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      if (socket.bufferedAmount <= CODE_TUNNEL_LOW_WATER_BYTES) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    return false;
  }

  private async onMessage(
    socket: WebSocket,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      try {
        const bytes = rawDataBytes(data);
        if (isCodeTunnelFrame(bytes)) {
          const frame = decodeCodeTunnelFrame(bytes);
          await this.handleCodeTunnelFrame(frame.header, frame.payload);
        } else {
          const frame = decodeRemoteSurfaceFrame(bytes);
          await this.handleSurfaceFrame(frame.header, frame.payload);
        }
      } catch (error) {
        console.warn(
          `[cantrip_worker] Rejected worker data frame: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return;
    }
    const request = workerRequestEnvelopeSchema.safeParse(raw);
    if (!request.success) {
      return;
    }

    try {
      const emit = (event: WorkerEvent) => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(
          JSON.stringify(
            workerEventEnvelopeSchema.parse({
              kind: "event",
              requestId: request.data.requestId,
              event,
            }),
          ),
        );
      };
      const result = await this.handleCommand(request.data.command, emit);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify(
            workerResponseEnvelopeSchema.parse({
              kind: "response",
              requestId: request.data.requestId,
              ok: true,
              result,
            }),
          ),
        );
      }
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify(
            workerResponseEnvelopeSchema.parse({
              kind: "response",
              requestId: request.data.requestId,
              ok: false,
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          ),
        );
      }
    }
  }
}
