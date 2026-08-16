import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";

import {
  terminalClientMessageSchema,
  terminalServerMessageSchema,
  type TunnelDataPlaneTarget,
  type WorkerEvent,
} from "@cantrip/protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { TerminalManager } from "./terminal-manager.js";
import { workerLogError, workerLogger } from "./logger.js";

interface Endpoint {
  server: HttpServer;
  sockets: Set<WebSocket>;
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
    "utf8",
  );
}

export class TerminalDirectEndpointManager {
  readonly #endpoints = new Map<string, Endpoint>();

  constructor(private readonly terminals: TerminalManager) {}

  async prepare(
    capabilityId: string,
    terminalId: string,
  ): Promise<TunnelDataPlaneTarget> {
    this.revoke(capabilityId, "Direct terminal capability rotated");
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: 100_000,
    });
    const endpoint: Endpoint = { server, sockets: new Set() };
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/terminal" || endpoint.sockets.size > 0) {
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (client) => {
        webSockets.emit("connection", client, request);
      });
    });
    webSockets.on("connection", (socket) => {
      endpoint.sockets.add(socket);
      server.close();
      this.#attach(terminalId, socket);
      socket.once("close", () => endpoint.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Direct terminal endpoint did not bind a loopback port.");
    }
    this.#endpoints.set(capabilityId, endpoint);
    workerLogger.event("debug", "Direct terminal endpoint prepared", {
      event: "terminal.direct.prepared",
      subsystem: "terminal",
      operation: "prepare-direct-endpoint",
      status: "completed",
      capabilityId,
      terminalId,
      counts: { endpoints: this.#endpoints.size },
    });
    return { kind: "tcp", host: "127.0.0.1", port: address.port };
  }

  revoke(capabilityId: string, reason: string): void {
    const endpoint = this.#endpoints.get(capabilityId);
    if (!endpoint) return;
    this.#endpoints.delete(capabilityId);
    endpoint.server.close();
    for (const socket of endpoint.sockets) {
      socket.close(1008, reason.slice(0, 123));
    }
    workerLogger.event("debug", "Direct terminal endpoint revoked", {
      event: "terminal.direct.revoked",
      subsystem: "terminal",
      operation: "revoke-direct-endpoint",
      status: "completed",
      capabilityId,
      counts: { endpoints: this.#endpoints.size },
    });
  }

  close(): void {
    for (const capabilityId of [...this.#endpoints.keys()]) {
      this.revoke(capabilityId, "Worker stopping");
    }
  }

  #attach(terminalId: string, socket: WebSocket): void {
    const attachmentId = `direct:${randomUUID()}`;
    const startedAtMs = Date.now();
    workerLogger.event("info", "Direct terminal client connected", {
      event: "terminal.direct.connected",
      subsystem: "terminal",
      operation: "attach-direct-client",
      status: "completed",
      terminalId,
      attachmentId,
    });
    let detached = false;
    const send = (message: unknown) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(terminalServerMessageSchema.parse(message)));
      }
    };
    const detach = () => {
      if (detached) return;
      detached = true;
      this.terminals.detach(terminalId, attachmentId);
      workerLogger.event("info", "Direct terminal client disconnected", {
        event: "terminal.direct.disconnected",
        subsystem: "terminal",
        operation: "attach-direct-client",
        status: "completed",
        terminalId,
        attachmentId,
        durationMs: Date.now() - startedAtMs,
      });
    };
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        send({ type: "error", message: "Terminal messages must be text." });
        return;
      }
      try {
        const message = terminalClientMessageSchema.parse(
          JSON.parse(rawText(data)),
        );
        if (message.type === "input") {
          this.terminals.input(terminalId, message.data);
        } else {
          this.terminals.resize(terminalId, message.cols, message.rows);
        }
      } catch (error) {
        send({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Invalid terminal message.",
        });
      }
    });
    socket.once("close", detach);
    socket.once("error", detach);
    let opened: ReturnType<TerminalManager["attachExisting"]>;
    try {
      opened = this.terminals.attachExisting(
        terminalId,
        attachmentId,
        80,
        24,
        (event: WorkerEvent) => {
          if (event.type === "terminal.ready") send({ type: "ready" });
          else if (event.type === "terminal.output") {
            send({ type: "output", data: event.data });
          }
        },
      );
    } catch (error) {
      workerLogger.event("warn", "Direct terminal attachment failed", {
        event: "terminal.direct.attach-failed",
        subsystem: "terminal",
        operation: "attach-direct-client",
        reasonCode: "terminal-unavailable",
        status: "failed",
        terminalId,
        attachmentId,
        error: workerLogError(error),
      });
      send({
        type: "error",
        message:
          error instanceof Error ? error.message : "Terminal is unavailable.",
      });
      socket.close(1011, "Terminal is unavailable");
      return;
    }
    void opened
      .then((result) => {
        if (result.status === "exited") send({ type: "exit", ...result });
      })
      .catch((error: unknown) => {
        workerLogger.event("warn", "Direct terminal session disconnected", {
          event: "terminal.direct.session-failed",
          subsystem: "terminal",
          operation: "attach-direct-client",
          reasonCode: "session-disconnected",
          status: "failed",
          terminalId,
          attachmentId,
          error: workerLogError(error),
        });
        send({
          type: "error",
          message:
            error instanceof Error ? error.message : "Terminal disconnected.",
        });
      });
  }
}
