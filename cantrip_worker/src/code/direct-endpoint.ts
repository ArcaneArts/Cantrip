import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";

import {
  CODE_ADAPTER_MAX_WEBSOCKET_MESSAGE_BYTES,
  isForwardableCodeAdapterWebSocketCloseCode,
} from "@cantrip/protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { workerLogError, workerLogger } from "../logger.js";
import type { CodeSupervisor } from "./supervisor.js";
import {
  codeEditorRequestHeaders,
  codeEditorResponseHeaders,
  codeEditorTargetUrl,
  editorAuthenticatedPayload,
  rawCodeWebSocketBytes,
} from "./tunnel-proxy.js";

interface Endpoint {
  server: HttpServer;
  sockets: Set<WebSocket>;
}

const BASE_PATH = "/code";
const MAX_BUFFERED_BYTES = 8 * 1_024 * 1_024;
const FRAME_ANCESTORS =
  "frame-ancestors 'self' http://127.0.0.1:1420 http://tauri.localhost https://tauri.localhost tauri://localhost";
const ABNORMAL_CLOSE_CODE = 1011;
const ABNORMAL_CLOSE_REASON = "Cantrip Code peer disconnected abnormally";

export function forwardableCodeWebSocketClose(
  code: number,
  reason: Buffer,
): { code: number; reason: Buffer | string } {
  return isForwardableCodeAdapterWebSocketCloseCode(code)
    ? { code, reason }
    : { code: ABNORMAL_CLOSE_CODE, reason: ABNORMAL_CLOSE_REASON };
}

function rawHeaders(request: IncomingMessage): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name && value !== undefined) result.push([name, value]);
  }
  return result;
}

function protocols(headers: IncomingHttpHeaders): string[] {
  const value = headers["sec-websocket-protocol"];
  return (Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function writeResponseHeaders(
  response: ServerResponse,
  upstream: IncomingMessage,
): void {
  let contentSecurityPolicy = "";
  for (const [name, value] of codeEditorResponseHeaders(upstream)) {
    const lower = name.toLowerCase();
    if (lower === "x-frame-options") continue;
    if (lower === "content-security-policy") {
      contentSecurityPolicy = value;
      continue;
    }
    response.appendHeader(name, value);
  }
  const policy = contentSecurityPolicy
    .split(";")
    .map((directive) => directive.trim())
    .filter(
      (directive) =>
        directive && !directive.toLowerCase().startsWith("frame-ancestors"),
    );
  policy.push(FRAME_ANCESTORS);
  response.setHeader("Content-Security-Policy", policy.join("; "));
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.writeHead(upstream.statusCode ?? 502);
}

export class CodeDirectEndpointManager {
  readonly #endpoints = new Map<string, Endpoint>();

  constructor(private readonly supervisor: CodeSupervisor) {}

  async prepare(
    capabilityId: string,
    sessionId: string,
  ): Promise<{ kind: "tcp"; host: "127.0.0.1"; port: number }> {
    this.revoke(capabilityId, "Direct Code capability rotated");
    const endpoint: Endpoint = {
      server: createServer(),
      sockets: new Set(),
    };
    const webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: CODE_ADAPTER_MAX_WEBSOCKET_MESSAGE_BYTES,
    });
    endpoint.server.on("request", (request, response) =>
      this.#proxyHttp(sessionId, request, response),
    );
    endpoint.server.on("upgrade", (request, socket, head) => {
      if (!this.#validPath(request.url)) {
        workerLogger.rateLimited(
          `code-direct-path-rejected:${sessionId}`,
          "warn",
          "Cantrip Code direct WebSocket path rejected",
          {
            event: "code.direct.websocket-rejected",
            subsystem: "code",
            operation: "open-websocket",
            reasonCode: "invalid-path",
            status: "rejected",
            sessionId,
          },
        );
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (client) => {
        webSockets.emit("connection", client, request);
      });
    });
    webSockets.on("connection", (socket, request) => {
      endpoint.sockets.add(socket);
      socket.once("close", () => endpoint.sockets.delete(socket));
      this.#proxyWebSocket(sessionId, socket, request);
    });
    await new Promise<void>((resolve, reject) => {
      endpoint.server.once("error", reject);
      endpoint.server.listen(0, "127.0.0.1", () => {
        endpoint.server.off("error", reject);
        resolve();
      });
    });
    const address = endpoint.server.address();
    if (!address || typeof address === "string") {
      endpoint.server.close();
      throw new Error("Direct Code endpoint did not bind a loopback port.");
    }
    this.#endpoints.set(capabilityId, endpoint);
    workerLogger.event("info", "Cantrip Code direct endpoint prepared", {
      event: "code.direct.prepared",
      subsystem: "code",
      operation: "prepare-direct-endpoint",
      status: "completed",
      capabilityId,
      sessionId,
    });
    return { kind: "tcp", host: "127.0.0.1", port: address.port };
  }

  revoke(capabilityId: string, reason: string): void {
    const endpoint = this.#endpoints.get(capabilityId);
    if (!endpoint) return;
    this.#endpoints.delete(capabilityId);
    for (const socket of endpoint.sockets) {
      socket.close(1008, reason.slice(0, 123));
    }
    endpoint.server.close();
    endpoint.server.closeAllConnections();
  }

  close(): void {
    for (const capabilityId of [...this.#endpoints.keys()]) {
      this.revoke(capabilityId, "Worker stopping");
    }
  }

  #validPath(rawPath: string | undefined): boolean {
    try {
      const url = new URL(rawPath ?? "/", "http://cantrip-code.invalid");
      return (
        url.pathname === BASE_PATH || url.pathname.startsWith(`${BASE_PATH}/`)
      );
    } catch {
      return false;
    }
  }

  #proxyHttp(
    sessionId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (request.url === `${BASE_PATH}/_cantrip/health`) {
      response
        .writeHead(200, {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json",
        })
        .end('{"status":"ok"}');
      return;
    }
    if (!this.#validPath(request.url)) {
      response.writeHead(404, { "cache-control": "no-store" }).end("Not found");
      return;
    }
    let releaseStream: (() => void) | null = null;
    try {
      const proxy = this.supervisor.proxyTarget(sessionId);
      const streamId = `direct-http:${randomUUID()}`;
      this.supervisor.beginTunnelStream(sessionId, streamId);
      let ended = false;
      const endStream = () => {
        if (ended) return;
        ended = true;
        this.supervisor.endTunnelStream(sessionId, streamId);
      };
      releaseStream = endStream;
      const target = codeEditorTargetUrl(
        proxy.editorOrigin,
        request.url ?? `${BASE_PATH}/`,
        BASE_PATH,
        proxy.workspaceUri,
      );
      const upstream = requestHttp(
        target,
        {
          method: request.method ?? "GET",
          headers: codeEditorRequestHeaders(
            rawHeaders(request),
            target,
            BASE_PATH,
            proxy.connectionToken,
          ),
        },
        (incoming) => {
          writeResponseHeaders(response, incoming);
          incoming.pipe(response);
          incoming.once("end", endStream);
          incoming.once("error", endStream);
        },
      );
      upstream.once("error", () => {
        endStream();
        if (!response.headersSent) response.writeHead(502);
        response.end("Cantrip Code is unavailable.");
      });
      request.once("aborted", endStream);
      response.once("close", endStream);
      request.pipe(upstream);
    } catch (error) {
      releaseStream?.();
      response
        .writeHead(503, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        })
        .end(
          error instanceof Error
            ? error.message
            : "Cantrip Code is unavailable.",
        );
    }
  }

  #proxyWebSocket(
    sessionId: string,
    client: WebSocket,
    request: IncomingMessage,
  ): void {
    let releaseStream: (() => void) | null = null;
    try {
      const proxy = this.supervisor.proxyTarget(sessionId);
      const streamId = `direct-websocket:${randomUUID()}`;
      this.supervisor.beginTunnelStream(sessionId, streamId);
      let ended = false;
      const endStream = () => {
        if (ended) return;
        ended = true;
        this.supervisor.endTunnelStream(sessionId, streamId);
      };
      releaseStream = endStream;
      const target = codeEditorTargetUrl(
        proxy.editorOrigin,
        request.url ?? `${BASE_PATH}/`,
        BASE_PATH,
        proxy.workspaceUri,
      );
      target.protocol = "ws:";
      const upstream = new WebSocket(target, protocols(request.headers), {
        headers: codeEditorRequestHeaders(
          rawHeaders(request).filter(
            ([name]) => name.toLowerCase() !== "sec-websocket-protocol",
          ),
          target,
          BASE_PATH,
          proxy.connectionToken,
        ),
        maxPayload: CODE_ADAPTER_MAX_WEBSOCKET_MESSAGE_BYTES,
      });
      const queued: Array<{ data: Buffer; binary: boolean }> = [];
      let queuedBytes = 0;
      let authenticationForwarded = false;
      const details = { sessionId };
      workerLogger.event("debug", "Cantrip Code direct WebSocket accepted", {
        event: "code.direct.websocket-accepted",
        subsystem: "code",
        operation: "open-websocket",
        status: "completed",
        ...details,
      });
      const closeBoth = (code = 1011, reason = "Cantrip Code disconnected") => {
        if (client.readyState === WebSocket.OPEN) client.close(code, reason);
        if (upstream.readyState === WebSocket.OPEN)
          upstream.close(code, reason);
        else upstream.terminate();
      };
      const forward = (data: RawData, binary: boolean) => {
        try {
          let payload = rawCodeWebSocketBytes(data);
          if (!authenticationForwarded) {
            payload = Buffer.from(
              editorAuthenticatedPayload(payload, proxy.connectionToken),
            );
            authenticationForwarded = true;
            workerLogger.event(
              "debug",
              "Cantrip Code direct WebSocket authentication forwarded",
              {
                event: "code.direct.authentication-forwarded",
                subsystem: "code",
                operation: "authenticate-websocket",
                status: "completed",
                ...details,
              },
            );
          }
          if (upstream.readyState !== WebSocket.OPEN) {
            queued.push({ data: payload, binary });
            queuedBytes += payload.byteLength;
            if (queuedBytes > MAX_BUFFERED_BYTES)
              closeBoth(1009, "Startup buffer exceeded");
            return;
          }
          if (
            upstream.bufferedAmount + payload.byteLength >
            MAX_BUFFERED_BYTES
          ) {
            closeBoth(1009, "Client buffer exceeded");
            return;
          }
          upstream.send(payload, { binary });
        } catch (error) {
          workerLogger.event(
            "warn",
            "Cantrip Code direct WebSocket input rejected",
            {
              event: "code.direct.websocket-rejected",
              subsystem: "code",
              operation: "forward-websocket",
              reasonCode: "invalid-authentication-frame",
              status: "rejected",
              ...details,
              error: workerLogError(error),
            },
          );
          closeBoth(1008, "Invalid Code authentication frame");
        }
      };
      client.on("message", forward);
      upstream.once("open", () => {
        workerLogger.event(
          "debug",
          "Cantrip Code direct editor WebSocket opened",
          {
            event: "code.direct.websocket-opened",
            subsystem: "code",
            operation: "open-websocket",
            status: "completed",
            ...details,
          },
        );
        for (const item of queued.splice(0)) {
          upstream.send(item.data, { binary: item.binary });
        }
        queuedBytes = 0;
      });
      upstream.on("message", (data, binary) => {
        const payload = rawCodeWebSocketBytes(data);
        if (
          client.readyState !== WebSocket.OPEN ||
          client.bufferedAmount + payload.byteLength > MAX_BUFFERED_BYTES
        ) {
          closeBoth(1009, "Editor buffer exceeded");
          return;
        }
        client.send(payload, { binary });
      });
      client.once("close", (code, reason) => {
        workerLogger.event(
          "debug",
          "Cantrip Code direct client WebSocket closed",
          {
            event: "code.direct.client-closed",
            subsystem: "code",
            operation: "forward-websocket",
            status: "completed",
            ...details,
            code,
          },
        );
        endStream();
        if (upstream.readyState === WebSocket.OPEN) {
          const forwarded = forwardableCodeWebSocketClose(code, reason);
          upstream.close(forwarded.code, forwarded.reason);
        } else upstream.terminate();
      });
      client.once("error", (error) => {
        workerLogger.event(
          "warn",
          "Cantrip Code direct client WebSocket failed",
          {
            event: "code.direct.client-failed",
            subsystem: "code",
            operation: "forward-websocket",
            reasonCode: "client-error",
            status: "degraded",
            ...details,
            error: workerLogError(error),
          },
        );
        endStream();
        closeBoth();
      });
      upstream.once("close", (code, reason) => {
        workerLogger.event(
          "debug",
          "Cantrip Code direct editor WebSocket closed",
          {
            event: "code.direct.editor-closed",
            subsystem: "code",
            operation: "forward-websocket",
            status: "completed",
            ...details,
            code,
          },
        );
        endStream();
        if (client.readyState === WebSocket.OPEN) {
          const forwarded = forwardableCodeWebSocketClose(code, reason);
          client.close(forwarded.code, forwarded.reason);
        }
      });
      upstream.once("error", (error) => {
        workerLogger.event(
          "warn",
          "Cantrip Code direct editor WebSocket failed",
          {
            event: "code.direct.editor-failed",
            subsystem: "code",
            operation: "forward-websocket",
            reasonCode: "editor-error",
            status: "degraded",
            ...details,
            error: workerLogError(error),
          },
        );
        endStream();
        closeBoth();
      });
    } catch (error) {
      releaseStream?.();
      client.close(
        1013,
        (error instanceof Error
          ? error.message
          : "Cantrip Code is unavailable"
        ).slice(0, 123),
      );
    }
  }
}
