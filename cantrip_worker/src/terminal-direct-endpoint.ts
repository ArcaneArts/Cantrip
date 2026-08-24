import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";

import {
  terminalClientMessageSchema,
  terminalServerMessageSchema,
  type TunnelDataPlaneTarget,
} from "@cantrip/protocol";
import {
  terminalInputContentSchema,
  terminalOutputContentSchema,
} from "@cantrip/protocol/surface-stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import type {
  TerminalManager,
  TerminalRuntimeEvent,
} from "./terminal-manager.js";
import { workerLogError, workerLogger } from "./logger.js";
import {
  openWorkerSurfaceStreamContent,
  protectWorkerSurfaceStreamContent,
  type SurfaceStreamReplayGuard,
} from "./surface-stream-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

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
  #encryption: WorkerEncryptionService | null = null;
  #inputAllowed: (terminalId: string) => boolean = () => true;
  #replay: SurfaceStreamReplayGuard | null = null;

  constructor(private readonly terminals: TerminalManager) {}

  setEncryptionService(
    service: WorkerEncryptionService,
    replay: SurfaceStreamReplayGuard,
  ): void {
    this.#encryption = service;
    this.#replay = replay;
  }

  setInputPolicy(inputAllowed: (terminalId: string) => boolean): void {
    this.#inputAllowed = inputAllowed;
  }

  async prepare(
    capabilityId: string,
    terminalId: string,
    serverId: string,
  ): Promise<TunnelDataPlaneTarget> {
    if (!this.#inputAllowed(terminalId)) {
      throw new Error("Run configuration terminals are read-only.");
    }
    this.revoke(capabilityId, "Direct terminal capability rotated");
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: 200_000,
    });
    const operations = new WeakMap<WebSocket, string>();
    const endpoint: Endpoint = { server, sockets: new Set() };
    server.on("upgrade", (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "", "http://localhost");
      const operationId = requestUrl.searchParams.get("operationId");
      if (
        requestUrl.pathname !== "/terminal" ||
        !operationId ||
        operationId.length > 200 ||
        endpoint.sockets.size > 0 ||
        !this.#encryption ||
        !this.#replay
      ) {
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (client) => {
        operations.set(client, operationId);
        webSockets.emit("connection", client, request);
      });
    });
    webSockets.on("connection", (socket) => {
      const operationId = operations.get(socket);
      if (!operationId) {
        socket.close(1008, "Terminal stream operation unavailable");
        return;
      }
      endpoint.sockets.add(socket);
      server.close();
      this.#attach(terminalId, operationId, serverId, socket);
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

  #attach(
    terminalId: string,
    operationId: string,
    serverId: string,
    socket: WebSocket,
  ): void {
    const encryption = this.#encryption;
    const replay = this.#replay;
    if (!this.#inputAllowed(terminalId)) {
      socket.close(1008, "Run configuration terminal is read-only");
      return;
    }
    if (!encryption || !replay) {
      socket.close(1011, "Terminal encryption unavailable");
      return;
    }
    const attachmentId = `direct:${randomUUID()}`;
    const inputContext = {
      serverId,
      surfaceKind: "terminal" as const,
      surfaceId: terminalId,
      operationId,
      direction: "input" as const,
    };
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
      replay.release(inputContext);
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
    let inputQueue = Promise.resolve();
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        send({ type: "error", message: "Terminal messages must be text." });
        return;
      }
      inputQueue = inputQueue
        .then(async () => {
          const message = terminalClientMessageSchema.parse(
            JSON.parse(rawText(data)),
          );
          if (message.type === "input") {
            if (!this.#inputAllowed(terminalId)) {
              throw new Error("Run configuration terminal is read-only.");
            }
            if (message.operationId !== operationId) {
              throw new Error("Terminal stream operation does not match.");
            }
            const context = {
              ...inputContext,
              sequence: message.sequence,
            };
            replay.reserve(context);
            const content = await openWorkerSurfaceStreamContent({
              context,
              opaque: message.protectedData,
              schema: terminalInputContentSchema,
              service: encryption,
            });
            this.terminals.input(terminalId, content.data);
            replay.accept(context, false);
          } else {
            this.terminals.resize(terminalId, message.cols, message.rows);
          }
        })
        .catch(() => {
          send({
            type: "error",
            message: "Invalid protected terminal message.",
          });
        });
    });
    socket.once("close", detach);
    socket.once("error", detach);
    let opened: ReturnType<TerminalManager["attachExisting"]>;
    let outputSequence = 0;
    let outputQueue = Promise.resolve();
    try {
      const emit = (event: TerminalRuntimeEvent) => {
        if (event.type === "terminal.ready") {
          // Preserve replay-before-ready ordering across async encryption.
          outputQueue = outputQueue.then(() => send({ type: "ready" }));
        } else if (event.type === "terminal.output") {
          const sequence = outputSequence;
          outputSequence += 1;
          outputQueue = outputQueue.then(async () => {
            send({
              type: "output",
              operationId,
              sequence,
              protectedData: await protectWorkerSurfaceStreamContent({
                context: {
                  ...inputContext,
                  direction: "output",
                  sequence,
                },
                content: event,
                schema: terminalOutputContentSchema,
                service: encryption,
              }),
            });
          });
        }
      };
      opened = this.terminals.attachExisting(
        terminalId,
        attachmentId,
        80,
        24,
        emit,
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
      .then(async (result) => {
        await outputQueue;
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
