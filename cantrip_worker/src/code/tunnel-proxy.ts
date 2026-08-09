import {
  request as requestHttp,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";

import {
  CODE_TUNNEL_MAX_PAYLOAD_BYTES,
  type CodeTunnelFrameHeader,
} from "@cantrip/protocol";
import WebSocket, { type RawData } from "ws";

import type { CodeSupervisor } from "./supervisor.js";

type FrameEmitter = (
  header: CodeTunnelFrameHeader,
  payload: Uint8Array,
) => boolean;
type CapacityWaiter = () => Promise<boolean>;

interface HttpStream {
  kind: "http";
  request: ClientRequest;
  response: IncomingMessage | null;
  responsePaused: boolean;
  resumeWaiters: Set<() => void>;
  sessionId: string;
}

interface WebSocketStream {
  authenticationForwarded: boolean;
  kind: "websocket";
  sessionId: string;
  socket: WebSocket;
}

type TunnelStream = HttpStream | WebSocketStream;

const EMPTY_PAYLOAD = new Uint8Array();
const MAX_LOCAL_BUFFER_BYTES = 8 * 1_024 * 1_024;
const BLOCKED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-prefix",
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function key(header: CodeTunnelFrameHeader): string {
  return `${header.attachmentId}\0${header.streamId}`;
}

function rawDataBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function editorAuthenticatedPayload(
  payload: Uint8Array,
  connectionToken: string,
): Uint8Array {
  const headerLength = 13;
  const controlMessageType = 2;
  if (payload.byteLength < headerLength || payload[0] !== controlMessageType) {
    throw new Error(
      "Cantrip Code client sent an invalid authentication frame.",
    );
  }
  const source = Buffer.from(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const bodyLength = source.readUInt32BE(9);
  if (bodyLength > source.byteLength - headerLength) {
    throw new Error(
      "Cantrip Code client sent a truncated authentication frame.",
    );
  }
  let message: unknown;
  try {
    message = JSON.parse(
      source.subarray(headerLength, headerLength + bodyLength).toString("utf8"),
    );
  } catch {
    throw new Error("Cantrip Code client sent malformed authentication data.");
  }
  if (
    !message ||
    typeof message !== "object" ||
    !("type" in message) ||
    message.type !== "auth"
  ) {
    throw new Error("Cantrip Code client omitted its authentication message.");
  }
  const body = Buffer.from(
    JSON.stringify({
      ...message,
      auth: connectionToken,
    }),
  );
  const trailing = source.subarray(headerLength + bodyLength);
  const translated = Buffer.allocUnsafe(
    headerLength + body.length + trailing.length,
  );
  source.copy(translated, 0, 0, 9);
  translated.writeUInt32BE(body.length, 9);
  body.copy(translated, headerLength);
  trailing.copy(translated, headerLength + body.length);
  return translated;
}

function payloadParts(payload: Uint8Array): Uint8Array[] {
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
  return parts;
}

function requestHeaders(
  headers: Array<[string, string]>,
  target: URL,
  basePath: string,
  connectionToken: string,
): Record<string, string | string[]> {
  const output = new Map<string, string[]>();
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(name)) continue;
    const values = output.get(name) ?? [];
    values.push(value);
    output.set(name, values);
  }
  output.set("cookie", [`vscode-tkn=${encodeURIComponent(connectionToken)}`]);
  output.set("host", [target.host]);
  output.set("x-forwarded-prefix", [basePath]);
  return Object.fromEntries(
    [...output].map(([name, values]) => [
      name,
      values.length === 1 ? values[0]! : values,
    ]),
  );
}

function responseHeaders(message: IncomingMessage): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const value = message.rawHeaders[index + 1];
    if (
      !name ||
      value === undefined ||
      BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())
    ) {
      continue;
    }
    headers.push([name, value]);
  }
  return headers;
}

function targetUrl(
  editorOrigin: string,
  rawPath: string,
  basePath: string,
  workspaceUri: string,
): URL {
  const publicUrl = new URL(rawPath, "http://cantrip-surface.invalid");
  if (
    publicUrl.pathname !== basePath &&
    !publicUrl.pathname.startsWith(`${basePath}/`)
  ) {
    throw new Error("Cantrip Code request escaped its attachment path.");
  }
  const target = new URL(editorOrigin);
  target.pathname = publicUrl.pathname.slice(basePath.length) || "/";
  target.search = publicUrl.search;
  if (
    (publicUrl.pathname === basePath ||
      publicUrl.pathname === `${basePath}/`) &&
    !target.searchParams.has("workspace") &&
    !target.searchParams.has("folder")
  ) {
    target.searchParams.set("workspace", workspaceUri);
  }
  return target;
}

function headerValue(
  headers: Array<[string, string]>,
  targetName: string,
): string | undefined {
  return headers.find(([name]) => name.toLowerCase() === targetName)?.[1];
}

export class CodeTunnelProxy {
  readonly #streams = new Map<string, TunnelStream>();
  #emit: FrameEmitter = () => false;
  #waitForCapacity: CapacityWaiter = async () => true;

  constructor(private readonly supervisor: CodeSupervisor) {}

  setFrameEmitter(
    emit: FrameEmitter,
    waitForCapacity: CapacityWaiter = async () => true,
  ): void {
    this.#emit = emit;
    this.#waitForCapacity = waitForCapacity;
  }

  async handleFrame(
    header: CodeTunnelFrameHeader,
    payload: Uint8Array,
  ): Promise<void> {
    switch (header.kind) {
      case "http-request-start":
        this.#openHttp(header);
        return;
      case "http-request-data": {
        const stream = this.#streams.get(key(header));
        if (stream?.kind !== "http") return;
        if (
          stream.request.writableLength + payload.byteLength >
          MAX_LOCAL_BUFFER_BYTES
        ) {
          stream.request.destroy(
            new Error("Cantrip Code request exceeded its buffer limit."),
          );
          return;
        }
        stream.request.write(payload);
        return;
      }
      case "http-request-end": {
        const stream = this.#streams.get(key(header));
        if (stream?.kind === "http") stream.request.end();
        return;
      }
      case "http-response-pause": {
        const stream = this.#streams.get(key(header));
        if (stream?.kind === "http") {
          stream.responsePaused = true;
          stream.response?.pause();
        }
        return;
      }
      case "http-response-resume": {
        const stream = this.#streams.get(key(header));
        if (stream?.kind === "http") {
          stream.responsePaused = false;
          stream.response?.resume();
          for (const resume of stream.resumeWaiters) resume();
          stream.resumeWaiters.clear();
        }
        return;
      }
      case "websocket-open":
        this.#openWebSocket(header);
        return;
      case "websocket-data": {
        const stream = this.#streams.get(key(header));
        if (
          stream?.kind !== "websocket" ||
          stream.socket.readyState !== WebSocket.OPEN
        ) {
          return;
        }
        let forwardedPayload = payload;
        if (!stream.authenticationForwarded) {
          try {
            forwardedPayload = editorAuthenticatedPayload(
              payload,
              this.supervisor.proxyTarget(header.sessionId).connectionToken,
            );
            stream.authenticationForwarded = true;
          } catch (error) {
            stream.socket.close(
              1008,
              error instanceof Error ? error.message : "Authentication failed",
            );
            return;
          }
        }
        if (
          stream.socket.bufferedAmount + forwardedPayload.byteLength >
          MAX_LOCAL_BUFFER_BYTES
        ) {
          stream.socket.close(1013, "Cantrip Code tunnel is congested");
          return;
        }
        stream.socket.send(forwardedPayload, { binary: header.binary });
        return;
      }
      case "websocket-close": {
        const stream = this.#streams.get(key(header));
        if (stream?.kind === "websocket") {
          stream.socket.close(header.code, header.reason);
        }
        return;
      }
      case "cancel":
        this.#cancel(key(header), header.reason);
        return;
      default:
        return;
    }
  }

  close(): void {
    for (const streamKey of [...this.#streams.keys()]) {
      this.#cancel(streamKey, "Worker is stopping.");
    }
  }

  #openHttp(
    header: Extract<CodeTunnelFrameHeader, { kind: "http-request-start" }>,
  ): void {
    const streamKey = key(header);
    if (this.#streams.has(streamKey)) {
      this.#error(header, "Cantrip Code tunnel stream already exists.");
      return;
    }
    let target;
    try {
      const proxy = this.supervisor.proxyTarget(header.sessionId);
      target = targetUrl(
        proxy.editorOrigin,
        header.path,
        header.basePath,
        proxy.workspaceUri,
      );
      const request = requestHttp(
        target,
        {
          method: header.method,
          headers: requestHeaders(
            header.headers,
            target,
            header.basePath,
            proxy.connectionToken,
          ),
        },
        (response) => void this.#pipeHttpResponse(header, response),
      );
      this.#trackStream(streamKey, header.sessionId, {
        kind: "http",
        request,
        response: null,
        responsePaused: false,
        resumeWaiters: new Set(),
        sessionId: header.sessionId,
      });
      request.once("error", (error) => {
        if (this.#removeStream(streamKey)) this.#error(header, error.message);
      });
    } catch (error) {
      this.#error(
        header,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async #pipeHttpResponse(
    requestHeader: Extract<
      CodeTunnelFrameHeader,
      { kind: "http-request-start" }
    >,
    response: IncomingMessage,
  ): Promise<void> {
    const streamKey = key(requestHeader);
    const stream = this.#streams.get(streamKey);
    if (stream?.kind !== "http") {
      response.destroy();
      return;
    }
    stream.response = response;
    if (
      !this.#emit(
        {
          protocolVersion: 1,
          attachmentId: requestHeader.attachmentId,
          sessionId: requestHeader.sessionId,
          streamId: requestHeader.streamId,
          kind: "http-response-start",
          statusCode: response.statusCode ?? 502,
          headers: responseHeaders(response),
        },
        EMPTY_PAYLOAD,
      )
    ) {
      response.destroy();
      this.#removeStream(streamKey);
      return;
    }
    try {
      for await (const rawChunk of response) {
        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk as Uint8Array);
        for (const part of payloadParts(chunk)) {
          if (!(await this.#awaitHttpFlow(streamKey, stream))) {
            response.destroy(
              new Error("Cantrip Code command tunnel disconnected."),
            );
            if (this.#removeStream(streamKey)) {
              this.#error(
                requestHeader,
                "Cantrip Code command tunnel disconnected.",
              );
            }
            return;
          }
          if (
            !this.#emit(
              {
                protocolVersion: 1,
                attachmentId: requestHeader.attachmentId,
                sessionId: requestHeader.sessionId,
                streamId: requestHeader.streamId,
                kind: "http-response-data",
              },
              part,
            )
          ) {
            response.destroy(new Error("Cantrip Code tunnel is congested."));
            return;
          }
        }
      }
      if (!this.#removeStream(streamKey)) return;
      this.#emit(
        {
          protocolVersion: 1,
          attachmentId: requestHeader.attachmentId,
          sessionId: requestHeader.sessionId,
          streamId: requestHeader.streamId,
          kind: "http-response-end",
        },
        EMPTY_PAYLOAD,
      );
    } catch (error) {
      if (this.#removeStream(streamKey)) {
        this.#error(
          requestHeader,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async #awaitHttpFlow(
    streamKey: string,
    stream: HttpStream,
  ): Promise<boolean> {
    while (stream.responsePaused) {
      await new Promise<void>((resolve) => stream.resumeWaiters.add(resolve));
      if (this.#streams.get(streamKey) !== stream) return false;
    }
    if (!(await this.#waitForCapacity())) return false;
    return this.#streams.get(streamKey) === stream && !stream.responsePaused;
  }

  #openWebSocket(
    header: Extract<CodeTunnelFrameHeader, { kind: "websocket-open" }>,
  ): void {
    const streamKey = key(header);
    if (this.#streams.has(streamKey)) {
      this.#error(header, "Cantrip Code tunnel stream already exists.");
      return;
    }
    try {
      const proxy = this.supervisor.proxyTarget(header.sessionId);
      const target = targetUrl(
        proxy.editorOrigin,
        header.path,
        header.basePath,
        proxy.workspaceUri,
      );
      target.protocol = "ws:";
      const protocols = (
        headerValue(header.headers, "sec-websocket-protocol") ?? ""
      )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const headers = requestHeaders(
        header.headers.filter(
          ([name]) => name.toLowerCase() !== "sec-websocket-protocol",
        ),
        target,
        header.basePath,
        proxy.connectionToken,
      );
      const socket = new WebSocket(target, protocols, {
        headers,
        maxPayload: CODE_TUNNEL_MAX_PAYLOAD_BYTES,
      });
      this.#trackStream(streamKey, header.sessionId, {
        authenticationForwarded: false,
        kind: "websocket",
        sessionId: header.sessionId,
        socket,
      });
      socket.once("open", () => {
        this.#emit(
          {
            protocolVersion: 1,
            attachmentId: header.attachmentId,
            sessionId: header.sessionId,
            streamId: header.streamId,
            kind: "websocket-opened",
            headers: [],
          },
          EMPTY_PAYLOAD,
        );
      });
      socket.on("message", (data, isBinary) => {
        const payload = rawDataBytes(data);
        if (payload.byteLength > CODE_TUNNEL_MAX_PAYLOAD_BYTES) {
          socket.close(1009, "Cantrip Code message exceeds the tunnel limit");
          return;
        }
        if (
          !this.#emit(
            {
              protocolVersion: 1,
              attachmentId: header.attachmentId,
              sessionId: header.sessionId,
              streamId: header.streamId,
              kind: "websocket-data",
              binary: isBinary,
            },
            payload,
          )
        ) {
          socket.close(1013, "Cantrip Code tunnel is congested");
        }
      });
      socket.once("close", (code, reason) => {
        if (!this.#removeStream(streamKey)) return;
        this.#emit(
          {
            protocolVersion: 1,
            attachmentId: header.attachmentId,
            sessionId: header.sessionId,
            streamId: header.streamId,
            kind: "websocket-close",
            code: code >= 1_000 && code <= 4_999 ? code : 1_000,
            reason: reason.toString().slice(0, 1_024),
          },
          EMPTY_PAYLOAD,
        );
      });
      socket.once("error", (error) => {
        if (this.#removeStream(streamKey)) this.#error(header, error.message);
      });
    } catch (error) {
      this.#error(
        header,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #cancel(streamKey: string, reason: string): void {
    const stream = this.#removeStream(streamKey);
    if (!stream) return;
    if (stream.kind === "http") {
      const error = new Error(reason);
      stream.response?.destroy(error);
      stream.request.destroy(error);
    } else stream.socket.close(1_000, reason.slice(0, 1_024));
  }

  #trackStream(
    streamKey: string,
    sessionId: string,
    stream: TunnelStream,
  ): void {
    this.#streams.set(streamKey, stream);
    this.supervisor.beginTunnelStream(sessionId, streamKey);
  }

  #removeStream(streamKey: string): TunnelStream | null {
    const stream = this.#streams.get(streamKey);
    if (!stream) return null;
    this.#streams.delete(streamKey);
    if (stream.kind === "http") {
      for (const resume of stream.resumeWaiters) resume();
      stream.resumeWaiters.clear();
    }
    this.supervisor.endTunnelStream(stream.sessionId, streamKey);
    return stream;
  }

  #error(header: CodeTunnelFrameHeader, message: string): void {
    this.#emit(
      {
        protocolVersion: 1,
        attachmentId: header.attachmentId,
        sessionId: header.sessionId,
        streamId: header.streamId,
        kind: "error",
        message: message.slice(0, 4_000) || "Cantrip Code tunnel failed.",
      },
      EMPTY_PAYLOAD,
    );
  }
}
