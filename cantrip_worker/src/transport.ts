import {
  decodeWorkerRequestEnvelope,
  decodeRemoteSurfaceFrame,
  decodeTunnelDataPlaneFrame,
  encodeWorkerServerEnvelope,
  encodeRemoteSurfaceFrame,
  encodeTunnelDataPlaneFrame,
  isTunnelDataPlaneFrame,
  type RemoteSurfaceFrameHeader,
  type TunnelDataPlaneFrameHeader,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerNotification,
  type WorkerRequestEnvelope,
  type WorkerServerEnvelope,
} from "@cantrip/protocol";
import WebSocket, { type RawData } from "ws";

import type { WorkerConfig } from "./config.js";
import { workerLogger } from "./logger.js";

type CommandHandler = (
  command: WorkerCommand,
  emit: (event: WorkerEvent) => void,
) => Promise<unknown>;

type SurfaceFrameHandler = (
  header: RemoteSurfaceFrameHeader,
  payload: Uint8Array,
) => Promise<void> | void;

type TunnelDataPlaneFrameHandler = (
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
) => Promise<void> | void;

const MAX_BUFFERED_SURFACE_BYTES = 8 * 1_024 * 1_024;
const MAX_BUFFERED_NOTIFICATION_BYTES = 1 * 1_024 * 1_024;
const MAX_BUFFERED_COMMAND_BYTES = 8 * 1_024 * 1_024;
const TUNNEL_DATA_PLANE_LOW_WATER_BYTES = 256 * 1_024;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;

function rawDataBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function commandLogContext(
  request: WorkerRequestEnvelope,
): Record<string, unknown> {
  const command = request.command as WorkerCommand & {
    chatId?: unknown;
    terminalId?: unknown;
  };
  return {
    requestId: request.requestId,
    command: command.type,
    ...(typeof command.chatId === "string" ? { chatId: command.chatId } : {}),
    ...(typeof command.terminalId === "string"
      ? { terminalId: command.terminalId }
      : {}),
  };
}

export class WorkerConnection {
  #closed = false;
  #authenticationRejected = false;
  #lastConnectionError: string | null = null;
  #keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  #pendingCommandBytes = 0;
  readonly #pendingCommandEnvelopes: string[] = [];
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #socket: WebSocket | null = null;

  constructor(
    private readonly config: WorkerConfig,
    private readonly handleCommand: CommandHandler,
    private readonly handleSurfaceFrame: SurfaceFrameHandler = () => undefined,
    private readonly handleTunnelDataPlaneFrame: TunnelDataPlaneFrameHandler = () =>
      undefined,
    private readonly handleTransportDisconnect: () => void = () => undefined,
    private readonly keepaliveIntervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS,
  ) {}

  start(): void {
    this.#authenticationRejected = false;
    this.connect();
  }

  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.clearKeepalive();
    this.#pendingCommandEnvelopes.length = 0;
    this.#pendingCommandBytes = 0;
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
    socket.once("open", () => this.handleSocketOpen(socket));
    socket.on("message", (data, isBinary) => {
      void this.onMessage(data, isBinary);
    });
    socket.once("error", (error) => this.handleSocketError(error));
    socket.once("close", (code, reason) =>
      this.handleSocketClose(socket, code, reason.toString()),
    );
  }

  private handleSocketOpen(socket: WebSocket): void {
    this.#lastConnectionError = null;
    this.startKeepalive(socket);
    this.flushCommandEnvelopes(socket);
    workerLogger.info("Command channel connected");
  }

  private handleSocketError(error: Error): void {
    if (this.#closed || error.message === this.#lastConnectionError) return;
    this.#lastConnectionError = error.message;
    workerLogger.warn("Command channel unavailable", {
      error: error.message,
    });
  }

  private handleSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ): void {
    const wasCurrent = this.#socket === socket;
    if (wasCurrent) {
      this.clearKeepalive();
      this.#socket = null;
      this.handleTransportDisconnect();
    }
    if (code === 1008) {
      this.#authenticationRejected = true;
      const message = reason || "worker authentication rejected";
      if (message !== this.#lastConnectionError) {
        this.#lastConnectionError = message;
        workerLogger.warn(
          "Command channel authentication rejected; update or re-enroll this worker, then restart it",
          { error: message },
        );
      }
    }
    if (wasCurrent && !this.#closed && !this.#authenticationRejected) {
      this.#reconnectTimer = setTimeout(() => this.connect(), 1_000);
    }
  }

  private startKeepalive(socket: WebSocket): void {
    this.clearKeepalive();
    if (this.keepaliveIntervalMs <= 0) return;
    this.#keepaliveTimer = setInterval(() => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, this.keepaliveIntervalMs);
    this.#keepaliveTimer.unref();
  }

  private clearKeepalive(): void {
    if (!this.#keepaliveTimer) return;
    clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = null;
  }

  private sendCommandEnvelope(envelope: string): void {
    const socket = this.#socket;
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(envelope);
        return;
      } catch {
        // Preserve the command result for the reconnecting channel below.
      }
    }
    if (this.#closed || this.#authenticationRejected) return;
    const bytes = Buffer.byteLength(envelope);
    while (
      this.#pendingCommandEnvelopes.length > 0 &&
      this.#pendingCommandBytes + bytes > MAX_BUFFERED_COMMAND_BYTES
    ) {
      const removed = this.#pendingCommandEnvelopes.shift()!;
      this.#pendingCommandBytes -= Buffer.byteLength(removed);
    }
    if (bytes > MAX_BUFFERED_COMMAND_BYTES) return;
    this.#pendingCommandEnvelopes.push(envelope);
    this.#pendingCommandBytes += bytes;
  }

  private sendServerEnvelope(envelope: WorkerServerEnvelope): void {
    this.sendCommandEnvelope(encodeWorkerServerEnvelope(envelope));
  }

  private flushCommandEnvelopes(socket: WebSocket): void {
    while (
      this.#socket === socket &&
      socket.readyState === WebSocket.OPEN &&
      this.#pendingCommandEnvelopes.length > 0
    ) {
      const envelope = this.#pendingCommandEnvelopes[0]!;
      try {
        socket.send(envelope);
      } catch {
        return;
      }
      this.#pendingCommandEnvelopes.shift();
      this.#pendingCommandBytes -= Buffer.byteLength(envelope);
    }
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

  sendTunnelDataPlaneFrame(
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) return false;
    try {
      socket.send(encodeTunnelDataPlaneFrame(header, payload), {
        binary: true,
      });
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
        encodeWorkerServerEnvelope({ kind: "notification", notification }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async waitForTunnelDataPlaneCapacity(): Promise<boolean> {
    while (!this.#closed) {
      const socket = this.#socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      if (socket.bufferedAmount <= TUNNEL_DATA_PLANE_LOW_WATER_BYTES)
        return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    return false;
  }

  private async onMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      await this.handleBinaryFrame(data);
      return;
    }
    const request = decodeWorkerRequestEnvelope(data.toString());
    if (!request.success) return;

    await this.handleRequest(request.data);
  }

  private async handleBinaryFrame(data: RawData): Promise<void> {
    try {
      const bytes = rawDataBytes(data);
      if (isTunnelDataPlaneFrame(bytes)) {
        const frame = decodeTunnelDataPlaneFrame(bytes);
        await this.handleTunnelDataPlaneFrame(frame.header, frame.payload);
      } else {
        const frame = decodeRemoteSurfaceFrame(bytes);
        await this.handleSurfaceFrame(frame.header, frame.payload);
      }
    } catch (error) {
      workerLogger.warn("Rejected worker data frame", error);
    }
  }

  private async handleRequest(request: WorkerRequestEnvelope): Promise<void> {
    const startedAt = performance.now();
    try {
      const emit = (event: WorkerEvent) => {
        this.sendServerEnvelope({
          kind: "event",
          requestId: request.requestId,
          event,
        });
      };
      const result = await this.handleCommand(request.command, emit);
      this.sendServerEnvelope({
        kind: "response",
        requestId: request.requestId,
        ok: true,
        result,
      });
      if (
        request.command.type === "chat.turn" ||
        request.command.type === "chat.thread.ensure"
      ) {
        workerLogger.info("Codex command completed", {
          ...commandLogContext(request),
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
    } catch (error) {
      workerLogger.error("Worker command failed", {
        ...commandLogContext(request),
        durationMs: Math.round(performance.now() - startedAt),
        error,
      });
      this.sendServerEnvelope({
        kind: "response",
        requestId: request.requestId,
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
