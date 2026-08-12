import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  CODE_TUNNEL_MAX_PAYLOAD_BYTES,
  type CodeAttachment,
  type CodeRuntimeStatus,
  type CodeTunnelFrameHeader,
} from "@cantrip/protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { WorkerCommandBus } from "../workers/bridge.js";
import {
  type ProjectShareTunnelBroker,
  projectShareTokenFromRequest,
} from "../project-shares/tunnel.js";

export interface CodeAttachmentBinding {
  attachmentId: string;
  authSessionId: string | null;
  codeTabId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ownerId: string;
  sessionId: string;
  token: string;
  workerId: string;
}

export interface CreateCodeAttachmentInput {
  authSessionId?: string | null;
  codeTabId: string;
  ownerId: string;
  runtime: CodeRuntimeStatus;
  sessionId: string;
  workerId: string;
}

export interface CodeTunnelBrokerOptions {
  allowedFrameAncestors: string[];
  idleTtlMs?: number;
  maxAttachments?: number;
  maxLifetimeMs?: number;
  surfaceOrigin: string;
}

const EMPTY_PAYLOAD = new Uint8Array();
const MAX_BUFFERED_BYTES = 8 * 1_024 * 1_024;
const RESPONSE_START_TIMEOUT_MS = 30_000;
const BLOCKED_CLIENT_HEADERS = new Set([
  "authorization",
  "connection",
  "cookie",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-prefix",
  "x-forwarded-proto",
]);
const BLOCKED_EDITOR_HEADERS = new Set([
  "connection",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
  "x-frame-options",
]);
const surfaceWebSockets = new WeakMap<Server, WebSocketServer>();

function bytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function streamMatches(
  header: CodeTunnelFrameHeader,
  binding: CodeAttachmentBinding,
  streamId: string,
): boolean {
  return (
    header.attachmentId === binding.attachmentId &&
    header.sessionId === binding.sessionId &&
    header.streamId === streamId
  );
}

function splitPayload(payload: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < payload.byteLength;
    offset += CODE_TUNNEL_MAX_PAYLOAD_BYTES
  ) {
    parts.push(
      payload.subarray(offset, offset + CODE_TUNNEL_MAX_PAYLOAD_BYTES),
    );
  }
  return parts.length > 0 ? parts : [EMPTY_PAYLOAD];
}

export class CodeTunnelBroker {
  readonly #activeStreams = new Map<string, Set<() => void>>();
  readonly #allowedFrameAncestors: string;
  readonly #attachments = new Map<string, CodeAttachmentBinding>();
  readonly #idleTtlMs: number;
  readonly #maxAttachments: number;
  readonly #maxLifetimeMs: number;
  readonly #surfaceOrigin: URL;
  readonly #sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly bridge: WorkerCommandBus,
    options: CodeTunnelBrokerOptions,
  ) {
    this.#surfaceOrigin = new URL(options.surfaceOrigin);
    this.#allowedFrameAncestors = [
      "'self'",
      ...options.allowedFrameAncestors,
    ].join(" ");
    this.#idleTtlMs = options.idleTtlMs ?? 15 * 60_000;
    this.#maxLifetimeMs = options.maxLifetimeMs ?? 12 * 60 * 60_000;
    this.#maxAttachments = options.maxAttachments ?? 128;
    this.#sweepTimer = setInterval(
      () => this.#prune(),
      Math.max(1_000, Math.min(60_000, this.#idleTtlMs)),
    );
    this.#sweepTimer.unref();
  }

  createAttachment(input: CreateCodeAttachmentInput): CodeAttachment {
    this.#prune();
    let workspacePath: string | null = null;
    if (input.runtime.workspaceUri) {
      const workspace = new URL(input.runtime.workspaceUri);
      if (
        workspace.protocol !== "file:" ||
        workspace.host !== "" ||
        workspace.search !== "" ||
        workspace.hash !== ""
      ) {
        throw new Error("Cantrip Code supplied an invalid workspace URI.");
      }
      workspacePath = decodeURIComponent(workspace.pathname);
    }
    if (this.#attachments.size >= this.#maxAttachments) {
      throw new Error(
        "This server has reached its Cantrip Code attachment limit.",
      );
    }
    const now = Date.now();
    const token = randomBytes(32).toString("base64url");
    const binding: CodeAttachmentBinding = {
      attachmentId: randomUUID(),
      authSessionId: input.authSessionId ?? null,
      codeTabId: input.codeTabId,
      createdAt: now,
      expiresAt: now + this.#idleTtlMs,
      lastSeenAt: now,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      token,
      workerId: input.workerId,
    };
    const attachmentUrl = new URL(
      `${this.basePath(token)}/`,
      this.#surfaceOrigin,
    );
    if (workspacePath)
      attachmentUrl.searchParams.set("workspace", workspacePath);
    this.#attachments.set(token, binding);
    return {
      attachmentId: binding.attachmentId,
      sessionId: binding.sessionId,
      url: attachmentUrl.toString(),
      expiresAt: new Date(binding.expiresAt).toISOString(),
      runtime: input.runtime,
    };
  }

  basePath(token: string): string {
    return `/code/${token}`;
  }

  hasAttachment(token: string): boolean {
    return this.#resolve(token) !== null;
  }

  revokeAttachment(attachmentId: string, ownerId: string): boolean {
    for (const [token, binding] of this.#attachments) {
      if (
        binding.attachmentId === attachmentId &&
        binding.ownerId === ownerId
      ) {
        this.#removeAttachment(token, binding);
        return true;
      }
    }
    return false;
  }

  revokeSession(sessionId: string): void {
    for (const [token, binding] of this.#attachments) {
      if (binding.sessionId === sessionId) {
        this.#removeAttachment(token, binding);
      }
    }
  }

  revokeAuthSession(authSessionId: string): void {
    for (const [token, binding] of this.#attachments) {
      if (binding.authSessionId === authSessionId) {
        this.#removeAttachment(token, binding);
      }
    }
  }

  revokeOwner(ownerId: string): void {
    for (const [token, binding] of this.#attachments) {
      if (binding.ownerId === ownerId) this.#removeAttachment(token, binding);
    }
  }

  close(): void {
    clearInterval(this.#sweepTimer);
    for (const [token, binding] of this.#attachments) {
      this.#removeAttachment(token, binding);
    }
  }

  proxyHttp(
    token: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const binding = this.#resolve(token);
    if (!binding) {
      this.#writeUnavailable(response);
      return;
    }
    const sendFrame = this.bridge.sendCodeTunnelFrame;
    const subscribe = this.bridge.subscribeCodeTunnelFrames;
    if (
      !sendFrame ||
      !subscribe ||
      !this.bridge.isConnected(binding.workerId)
    ) {
      response
        .writeHead(503, { "cache-control": "no-store" })
        .end("Worker offline");
      return;
    }
    const streamId = randomUUID();
    const basePath = this.basePath(token);
    let started = false;
    let completed = false;
    let workerPaused = false;
    let unregisterActive: () => void = () => undefined;
    const sendResponseFlow = (
      kind: "http-response-pause" | "http-response-resume",
    ) =>
      sendFrame.call(
        this.bridge,
        binding.workerId,
        {
          protocolVersion: 1,
          attachmentId: binding.attachmentId,
          sessionId: binding.sessionId,
          streamId,
          kind,
        },
        EMPTY_PAYLOAD,
      );
    const resumeWorker = () => {
      if (completed || !workerPaused) return;
      workerPaused = false;
      if (!sendResponseFlow("http-response-resume")) {
        this.#sendCancel(binding, streamId, "Client response resume failed.");
        fail(503, "Cantrip Code worker is unavailable or congested.");
      }
    };
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(startTimer);
      response.off("drain", resumeWorker);
      unsubscribe();
      unsubscribeDisconnect();
      unregisterActive();
    };
    const fail = (status: number, message: string) => {
      if (completed) return;
      if (!response.headersSent) {
        response.writeHead(status, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(message);
      } else {
        response.destroy(new Error(message));
      }
      finish();
    };
    const unsubscribe = subscribe.call(
      this.bridge,
      binding.workerId,
      (header, payload) => {
        if (completed || !streamMatches(header, binding, streamId)) return;
        this.#touch(binding);
        switch (header.kind) {
          case "http-response-start":
            if (started) return;
            started = true;
            clearTimeout(startTimer);
            this.#writeResponseHeaders(
              response,
              header.statusCode,
              header.headers,
            );
            return;
          case "http-response-data":
            if (!started || response.destroyed) return;
            if (
              response.writableLength + payload.byteLength >
              MAX_BUFFERED_BYTES
            ) {
              this.#sendCancel(
                binding,
                streamId,
                "Client response buffer exceeded.",
              );
              fail(502, "Cantrip Code client is too slow.");
              return;
            }
            if (!response.write(payload) && !workerPaused) {
              workerPaused = true;
              if (!sendResponseFlow("http-response-pause")) {
                this.#sendCancel(
                  binding,
                  streamId,
                  "Client response pause failed.",
                );
                fail(503, "Cantrip Code worker is unavailable or congested.");
              }
            }
            return;
          case "http-response-end":
            if (!started) this.#writeResponseHeaders(response, 200, []);
            response.end();
            finish();
            return;
          case "error":
            fail(502, header.message);
            return;
          default:
            return;
        }
      },
    );
    const unsubscribeDisconnect = this.bridge.subscribeWorkerDisconnect(
      binding.workerId,
      () => fail(503, "Cantrip Code worker disconnected."),
    );
    const startTimer = setTimeout(() => {
      this.#sendCancel(binding, streamId, "Editor response timed out.");
      fail(504, "Cantrip Code editor response timed out.");
    }, RESPONSE_START_TIMEOUT_MS);
    unregisterActive = this.#registerActive(binding, () => {
      this.#sendCancel(binding, streamId, "Attachment was revoked.");
      fail(401, "Cantrip Code attachment expired or was revoked.");
    });
    response.on("drain", resumeWorker);

    const requestHeader: CodeTunnelFrameHeader = {
      protocolVersion: 1,
      attachmentId: binding.attachmentId,
      sessionId: binding.sessionId,
      streamId,
      kind: "http-request-start",
      method: (request.method ?? "GET").toUpperCase(),
      path: request.url ?? `${basePath}/`,
      basePath,
      headers: this.#requestHeaders(request),
    };
    if (
      !sendFrame.call(
        this.bridge,
        binding.workerId,
        requestHeader,
        EMPTY_PAYLOAD,
      )
    ) {
      fail(503, "Cantrip Code worker is unavailable or congested.");
      return;
    }
    request.on("data", (chunk: Buffer) => {
      if (completed) return;
      this.#touch(binding);
      for (const part of splitPayload(chunk)) {
        if (
          !sendFrame.call(
            this.bridge,
            binding.workerId,
            { ...requestHeader, kind: "http-request-data" },
            part,
          )
        ) {
          this.#sendCancel(
            binding,
            streamId,
            "Worker request buffer exceeded.",
          );
          fail(503, "Cantrip Code worker is unavailable or congested.");
          return;
        }
      }
    });
    request.once("end", () => {
      if (completed) return;
      if (
        !sendFrame.call(
          this.bridge,
          binding.workerId,
          { ...requestHeader, kind: "http-request-end" },
          EMPTY_PAYLOAD,
        )
      ) {
        fail(503, "Cantrip Code worker is unavailable or congested.");
      }
    });
    request.once("aborted", () => {
      this.#sendCancel(binding, streamId, "Client aborted request.");
      finish();
    });
    response.once("close", () => {
      if (completed) return;
      this.#sendCancel(binding, streamId, "Client closed response.");
      finish();
    });
  }

  proxyWebSocket(
    token: string,
    socket: WebSocket,
    request: IncomingMessage,
  ): void {
    const binding = this.#resolve(token);
    const sendFrame = this.bridge.sendCodeTunnelFrame;
    const subscribe = this.bridge.subscribeCodeTunnelFrames;
    if (
      !binding ||
      !sendFrame ||
      !subscribe ||
      !this.bridge.isConnected(binding.workerId)
    ) {
      socket.close(1013, "Cantrip Code worker is unavailable");
      return;
    }
    const streamId = randomUUID();
    const basePath = this.basePath(token);
    let opened = false;
    let completed = false;
    let unregisterActive: () => void = () => undefined;
    const queued: Array<{ binary: boolean; payload: Uint8Array }> = [];
    let queuedBytes = 0;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(openTimer);
      unsubscribe();
      unsubscribeDisconnect();
      unregisterActive();
    };
    const sendData = (payload: Uint8Array, binary: boolean) => {
      if (payload.byteLength > CODE_TUNNEL_MAX_PAYLOAD_BYTES) {
        socket.close(1009, "Cantrip Code message exceeds the tunnel limit");
        finish();
        return false;
      }
      if (
        !sendFrame.call(
          this.bridge,
          binding.workerId,
          {
            protocolVersion: 1,
            attachmentId: binding.attachmentId,
            sessionId: binding.sessionId,
            streamId,
            kind: "websocket-data",
            binary,
          },
          payload,
        )
      ) {
        socket.close(1013, "Cantrip Code tunnel is congested");
        finish();
        return false;
      }
      return true;
    };
    const unsubscribe = subscribe.call(
      this.bridge,
      binding.workerId,
      (header, payload) => {
        if (completed || !streamMatches(header, binding, streamId)) return;
        this.#touch(binding);
        switch (header.kind) {
          case "websocket-opened":
            opened = true;
            clearTimeout(openTimer);
            for (const message of queued.splice(0)) {
              if (!sendData(message.payload, message.binary)) break;
            }
            queuedBytes = 0;
            return;
          case "websocket-data":
            if (!opened || socket.readyState !== WebSocket.OPEN) return;
            if (
              socket.bufferedAmount + payload.byteLength >
              MAX_BUFFERED_BYTES
            ) {
              socket.close(1013, "Cantrip Code client is too slow");
              finish();
              return;
            }
            socket.send(payload, { binary: header.binary });
            return;
          case "websocket-close":
            socket.close(header.code, header.reason);
            finish();
            return;
          case "error":
            socket.close(1011, header.message.slice(0, 123));
            finish();
            return;
          default:
            return;
        }
      },
    );
    const unsubscribeDisconnect = this.bridge.subscribeWorkerDisconnect(
      binding.workerId,
      () => {
        socket.close(1013, "Cantrip Code worker disconnected");
        finish();
      },
    );
    const openTimer = setTimeout(() => {
      this.#sendCancel(binding, streamId, "Editor WebSocket timed out.");
      socket.close(1013, "Cantrip Code editor connection timed out");
      finish();
    }, RESPONSE_START_TIMEOUT_MS);
    unregisterActive = this.#registerActive(binding, () => {
      this.#sendCancel(binding, streamId, "Attachment was revoked.");
      socket.close(1008, "Cantrip Code attachment expired or was revoked");
      finish();
    });

    if (
      !sendFrame.call(
        this.bridge,
        binding.workerId,
        {
          protocolVersion: 1,
          attachmentId: binding.attachmentId,
          sessionId: binding.sessionId,
          streamId,
          kind: "websocket-open",
          path: request.url ?? `${basePath}/`,
          basePath,
          headers: this.#requestHeaders(request),
        },
        EMPTY_PAYLOAD,
      )
    ) {
      socket.close(1013, "Cantrip Code worker is unavailable or congested");
      finish();
      return;
    }
    socket.on("message", (data, binary) => {
      this.#touch(binding);
      const payload = bytes(data);
      if (!opened) {
        queuedBytes += payload.byteLength;
        if (queuedBytes > MAX_BUFFERED_BYTES) {
          socket.close(1009, "Cantrip Code startup buffer exceeded");
          finish();
          return;
        }
        queued.push({ payload, binary });
        return;
      }
      sendData(payload, binary);
    });
    socket.once("close", (code, reason) => {
      if (!completed && opened) {
        sendFrame.call(
          this.bridge,
          binding.workerId,
          {
            protocolVersion: 1,
            attachmentId: binding.attachmentId,
            sessionId: binding.sessionId,
            streamId,
            kind: "websocket-close",
            code: code >= 1_000 && code <= 4_999 ? code : 1_000,
            reason: reason.toString().slice(0, 1_024),
          },
          EMPTY_PAYLOAD,
        );
      } else if (!completed) {
        this.#sendCancel(binding, streamId, "Client closed WebSocket.");
      }
      finish();
    });
  }

  #resolve(token: string): CodeAttachmentBinding | null {
    const binding = this.#attachments.get(token);
    if (!binding) return null;
    const now = Date.now();
    if (
      binding.expiresAt <= now ||
      binding.createdAt + this.#maxLifetimeMs <= now
    ) {
      this.#removeAttachment(token, binding);
      return null;
    }
    this.#touch(binding, now);
    return binding;
  }

  #prune(): void {
    const now = Date.now();
    for (const [token, binding] of this.#attachments) {
      if (
        binding.expiresAt <= now ||
        binding.createdAt + this.#maxLifetimeMs <= now
      ) {
        this.#removeAttachment(token, binding);
      }
    }
  }

  #touch(binding: CodeAttachmentBinding, now = Date.now()): void {
    binding.lastSeenAt = now;
    binding.expiresAt = Math.min(
      binding.createdAt + this.#maxLifetimeMs,
      now + this.#idleTtlMs,
    );
  }

  #registerActive(
    binding: CodeAttachmentBinding,
    close: () => void,
  ): () => void {
    let streams = this.#activeStreams.get(binding.attachmentId);
    if (!streams) {
      streams = new Set();
      this.#activeStreams.set(binding.attachmentId, streams);
    }
    streams.add(close);
    return () => {
      streams?.delete(close);
      if (streams?.size === 0) {
        this.#activeStreams.delete(binding.attachmentId);
      }
    };
  }

  #removeAttachment(token: string, binding: CodeAttachmentBinding): void {
    this.#attachments.delete(token);
    const streams = this.#activeStreams.get(binding.attachmentId);
    this.#activeStreams.delete(binding.attachmentId);
    for (const close of [...(streams ?? [])]) close();
  }

  #requestHeaders(request: IncomingMessage): Array<[string, string]> {
    const headers: Array<[string, string]> = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (
        !name ||
        value === undefined ||
        BLOCKED_CLIENT_HEADERS.has(name.toLowerCase())
      ) {
        continue;
      }
      headers.push([name, value]);
    }
    headers.push(["x-forwarded-host", this.#surfaceOrigin.host]);
    headers.push([
      "x-forwarded-proto",
      this.#surfaceOrigin.protocol.slice(0, -1),
    ]);
    if (this.#surfaceOrigin.port) {
      headers.push(["x-forwarded-port", this.#surfaceOrigin.port]);
    }
    return headers;
  }

  #writeResponseHeaders(
    response: ServerResponse,
    statusCode: number,
    headers: Array<[string, string]>,
  ): void {
    const values = new Map<string, { name: string; values: string[] }>();
    let contentSecurityPolicy: string | null = null;
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (BLOCKED_EDITOR_HEADERS.has(lower)) continue;
      if (lower === "content-security-policy") {
        contentSecurityPolicy = value;
        continue;
      }
      const current = values.get(lower) ?? { name, values: [] };
      current.values.push(value);
      values.set(lower, current);
    }
    for (const { name, values: headerValues } of values.values()) {
      response.setHeader(
        name,
        headerValues.length === 1 ? headerValues[0]! : headerValues,
      );
    }
    const policy = (contentSecurityPolicy ?? "")
      .split(";")
      .map((directive) => directive.trim())
      .filter(
        (directive) =>
          directive && !directive.toLowerCase().startsWith("frame-ancestors"),
      );
    policy.push(`frame-ancestors ${this.#allowedFrameAncestors}`);
    response.setHeader("Content-Security-Policy", policy.join("; "));
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.writeHead(statusCode);
  }

  #writeUnavailable(response: ServerResponse): void {
    const message = JSON.stringify({
      type: "cantrip-code-attachment-unavailable-v1",
    });
    response.writeHead(404, {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors ${this.#allowedFrameAncestors}`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end(`<!doctype html>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:Canvas;color:GrayText;font:14px system-ui,sans-serif}</style>
<p>Reconnecting to Cantrip Code…</p>
<script>window.parent.postMessage(${message}, "*");</script>`);
  }

  #sendCancel(
    binding: CodeAttachmentBinding,
    streamId: string,
    reason: string,
  ): void {
    this.bridge.sendCodeTunnelFrame?.(
      binding.workerId,
      {
        protocolVersion: 1,
        attachmentId: binding.attachmentId,
        sessionId: binding.sessionId,
        streamId,
        kind: "cancel",
        reason: reason.slice(0, 1_024),
      },
      EMPTY_PAYLOAD,
    );
  }
}

function tokenFromRequest(request: IncomingMessage): string | null {
  const url = new URL(request.url ?? "/", "http://cantrip-surface.invalid");
  return (
    /^\/code\/([A-Za-z0-9_-]{43})(?:\/|$)/u.exec(url.pathname)?.[1] ?? null
  );
}

export function createCodeSurfaceServer(
  broker: CodeTunnelBroker,
  surfaceOrigin: string,
  projectShares?: ProjectShareTunnelBroker,
): Server {
  const expectedOrigin = new URL(surfaceOrigin).origin;
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: CODE_TUNNEL_MAX_PAYLOAD_BYTES,
  });
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      response.end('{"status":"ok"}');
      return;
    }
    const projectShareToken = projectShareTokenFromRequest(request);
    if (projectShareToken && projectShares) {
      projectShares.proxyHttp(projectShareToken, request, response);
      return;
    }
    const token = tokenFromRequest(request);
    if (!token) {
      response.writeHead(404, { "cache-control": "no-store" }).end("Not found");
      return;
    }
    broker.proxyHttp(token, request, response);
  });
  server.on("upgrade", (request, socket, head) => {
    const token = tokenFromRequest(request);
    const origin = request.headers.origin;
    if (
      !token ||
      !broker.hasAttachment(token) ||
      (origin && origin !== expectedOrigin)
    ) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      broker.proxyWebSocket(token, webSocket, request);
    });
  });
  surfaceWebSockets.set(server, webSockets);
  return server;
}

export async function closeCodeSurfaceServer(server: Server): Promise<void> {
  const webSockets = surfaceWebSockets.get(server);
  for (const client of webSockets?.clients ?? []) client.terminate();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  await new Promise<void>(
    (resolve) => webSockets?.close(() => resolve()) ?? resolve(),
  );
  surfaceWebSockets.delete(server);
}
