import {
  type WorkerCommand,
  workerEventEnvelopeSchema,
  type WorkerEvent,
  workerRequestEnvelopeSchema,
  workerResponseEnvelopeSchema,
} from "@cantrip/protocol";
import WebSocket, { type RawData } from "ws";

import type { WorkerConfig } from "./config.js";

type CommandHandler = (
  command: WorkerCommand,
  emit: (event: WorkerEvent) => void,
) => Promise<unknown>;

export class WorkerConnection {
  #closed = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #socket: WebSocket | null = null;

  constructor(
    private readonly config: WorkerConfig,
    private readonly handleCommand: CommandHandler,
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
      console.log("[cantrip_worker] Command channel connected.");
    });
    socket.on("message", (data) => {
      void this.onMessage(socket, data);
    });
    socket.once("error", (error) => {
      if (!this.#closed) {
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

  private async onMessage(socket: WebSocket, data: RawData): Promise<void> {
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
