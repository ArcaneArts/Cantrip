import { randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";

import {
  CODE_ADAPTER_MAX_HEAD_BYTES,
  CODE_ADAPTER_MAX_WEBSOCKET_MESSAGE_BYTES,
  CODE_ADAPTER_WEBSOCKET_BINARY_RECORD,
  CODE_ADAPTER_WEBSOCKET_CLOSE_RECORD,
  CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES,
  CODE_ADAPTER_WEBSOCKET_TEXT_RECORD,
  TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES,
  TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES,
  type CodeAdapterRequestHead,
  type CodeAdapterResponseHead,
  codeAdapterResponseHeadSchema,
  codeAdapterWebSocketCloseSchema,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import WebSocket, { type RawData } from "ws";

import type {
  TunnelDataPlaneEndpoint,
  TunnelEndpointFrameListener,
} from "../tunnels/broker.js";

const EMPTY_PAYLOAD = new Uint8Array();
const INITIAL_CREDIT_BYTES = 256 * 1_024;
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

interface CodeStream {
  connectionId: string;
  destinationSequence: number;
  destinationToSourcePendingCredit: number;
  headerBytes: Buffer;
  headerLength: number | null;
  localSequence: number;
  outputBytes: Buffer;
  requestEnded: boolean;
  requestHalfClosed: boolean;
  requestPending: Buffer[];
  requestPendingBytes: number;
  responseStarted: boolean;
  sourceToDestinationCredit: number;
  timeout: ReturnType<typeof setTimeout>;
  transport:
    | { kind: "http"; request: IncomingMessage; response: ServerResponse }
    | {
        kind: "websocket";
        socket: WebSocket;
        queued: Buffer[];
        queuedBytes: number;
      };
}

function rawBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function encodeHead(head: CodeAdapterRequestHead): Buffer {
  const body = Buffer.from(JSON.stringify(head));
  if (body.byteLength > CODE_ADAPTER_MAX_HEAD_BYTES) {
    throw new Error("Cantrip Code request headers exceed the tunnel limit.");
  }
  const output = Buffer.allocUnsafe(4 + body.byteLength);
  output.writeUInt32BE(body.byteLength, 0);
  body.copy(output, 4);
  return output;
}

function record(kind: number, payload: Uint8Array): Buffer {
  if (payload.byteLength > CODE_ADAPTER_MAX_WEBSOCKET_MESSAGE_BYTES) {
    throw new Error("Cantrip Code message exceeds the tunnel limit.");
  }
  const output = Buffer.allocUnsafe(
    CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES + payload.byteLength,
  );
  output[0] = kind;
  output.writeUInt32BE(payload.byteLength, 1);
  output.set(payload, CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES);
  return output;
}

function parts(payload: Uint8Array): Buffer[] {
  const output: Buffer[] = [];
  for (
    let offset = 0;
    offset < payload.byteLength;
    offset += TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES
  ) {
    output.push(
      Buffer.from(
        payload.subarray(offset, offset + TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES),
      ),
    );
  }
  return output;
}

export class CodeHttpEndpoint implements TunnelDataPlaneEndpoint {
  readonly endpointId: string;
  readonly placement: { kind: "server-adapter"; adapterId: string };
  readonly #disconnectListeners = new Set<() => void>();
  readonly #listeners = new Set<TunnelEndpointFrameListener>();
  readonly #streams = new Map<string, CodeStream>();
  #closed = false;

  constructor(
    readonly tunnelId: string,
    readonly attachmentId: string,
    private readonly destinationEndpointId: string,
    private readonly sessionId: string,
    private readonly basePath: string,
    private readonly surfaceOrigin: URL,
    private readonly allowedFrameAncestors: string,
    private readonly touch: (input: {
      bytesFromSource: number;
      bytesToSource: number;
      connectionDelta: number;
    }) => void,
  ) {
    this.endpointId = `server:code:${attachmentId}`;
    this.placement = {
      kind: "server-adapter",
      adapterId: `code:${attachmentId}`,
    };
  }

  proxyHttp(request: IncomingMessage, response: ServerResponse): void {
    let head: Buffer;
    try {
      head = encodeHead({
        protocolVersion: 1,
        kind: "http",
        sessionId: this.sessionId,
        method: (request.method ?? "GET").toUpperCase(),
        path: request.url ?? `${this.basePath}/`,
        basePath: this.basePath,
        headers: this.#requestHeaders(request),
      });
    } catch (error) {
      response
        .writeHead(431, { "cache-control": "no-store" })
        .end(
          error instanceof Error ? error.message : "Invalid request headers",
        );
      return;
    }
    request.pause();
    const stream = this.#createStream(
      { kind: "http", request, response },
      parts(head),
    );
    request.on("data", (chunk: Buffer) => {
      if (!this.#streams.has(stream.connectionId)) return;
      request.pause();
      this.#queueInput(stream, chunk);
      this.#flushInput(stream);
    });
    request.once("end", () => {
      stream.requestEnded = true;
      this.#flushInput(stream);
    });
    request.once("aborted", () =>
      this.#closeStream(stream, "Client aborted request."),
    );
    response.once("close", () => {
      if (!response.writableEnded)
        this.#closeStream(stream, "Client closed response.");
    });
  }

  proxyWebSocket(socket: WebSocket, request: IncomingMessage): void {
    let head: Buffer;
    try {
      head = encodeHead({
        protocolVersion: 1,
        kind: "websocket",
        sessionId: this.sessionId,
        path: request.url ?? `${this.basePath}/`,
        basePath: this.basePath,
        headers: this.#requestHeaders(request),
      });
    } catch {
      socket.close(1008, "Cantrip Code request headers are invalid");
      return;
    }
    const stream = this.#createStream(
      { kind: "websocket", socket, queued: [], queuedBytes: 0 },
      parts(head),
    );
    socket.on("message", (data, binary) => {
      try {
        const payload = record(
          binary
            ? CODE_ADAPTER_WEBSOCKET_BINARY_RECORD
            : CODE_ADAPTER_WEBSOCKET_TEXT_RECORD,
          rawBytes(data),
        );
        if (!stream.responseStarted) {
          const transport = stream.transport;
          if (transport.kind !== "websocket") return;
          transport.queued.push(payload);
          transport.queuedBytes += payload.byteLength;
          if (transport.queuedBytes > MAX_BUFFERED_BYTES) {
            socket.close(1009, "Cantrip Code startup buffer exceeded");
            this.#closeStream(stream, "WebSocket startup buffer exceeded.");
          }
          return;
        }
        this.#queueInput(stream, payload);
        this.#flushInput(stream);
      } catch (error) {
        socket.close(
          1009,
          error instanceof Error
            ? error.message
            : "Cantrip Code message is invalid",
        );
        this.#closeStream(stream, "Invalid WebSocket message.");
      }
    });
    socket.once("close", (code, reason) => {
      if (!this.#streams.has(stream.connectionId)) return;
      try {
        const close = Buffer.from(
          JSON.stringify({
            code: code >= 1_000 && code <= 4_999 ? code : 1_000,
            reason: reason.toString().slice(0, 1_024),
          }),
        );
        this.#queueInput(
          stream,
          record(CODE_ADAPTER_WEBSOCKET_CLOSE_RECORD, close),
        );
        stream.requestEnded = true;
        this.#flushInput(stream);
      } catch {
        this.#closeStream(stream, "WebSocket closed.");
      }
    });
  }

  send(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): boolean {
    const stream = this.#streams.get(header.connectionId);
    if (!stream || this.#closed) return false;
    if (
      header.sequence !== stream.destinationSequence ||
      header.sourceEndpointId !== this.endpointId
    ) {
      this.#closeStream(stream, "Invalid Cantrip Code tunnel sequence.");
      return false;
    }
    stream.destinationSequence += 1;
    if (header.kind === "accepted") {
      stream.sourceToDestinationCredit = header.initialCreditBytes;
      this.#flushInput(stream);
      return true;
    }
    if (
      header.kind === "credit" &&
      header.direction === "source-to-destination"
    ) {
      stream.sourceToDestinationCredit = Math.min(
        TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES,
        stream.sourceToDestinationCredit + header.bytes,
      );
      this.#flushInput(stream);
      return true;
    }
    if (
      header.kind === "data" &&
      header.direction === "destination-to-source"
    ) {
      this.touch({
        bytesFromSource: 0,
        bytesToSource: payload.byteLength,
        connectionDelta: 0,
      });
      this.#consumeOutput(stream, Buffer.from(payload));
      return true;
    }
    if (
      header.kind === "half-close" &&
      header.direction === "destination-to-source"
    ) {
      this.#finishOutput(stream);
      return true;
    }
    if (header.kind === "rejected" || header.kind === "error") {
      this.#fail(stream, header.message);
      return true;
    }
    if (header.kind === "close") {
      if (!this.#finished(stream)) {
        this.#fail(
          stream,
          header.code === "bandwidth-limit"
            ? "Cantrip Code relay bandwidth quota reached."
            : "Cantrip Code tunnel closed.",
          header.code === "bandwidth-limit" ? 429 : 502,
        );
      } else this.#remove(stream);
    }
    return true;
  }

  subscribe(listener: TunnelEndpointFrameListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeDisconnect(listener: () => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const stream of [...this.#streams.values()]) {
      this.#fail(stream, "Cantrip Code attachment is unavailable.");
    }
    for (const listener of this.#disconnectListeners) listener();
    this.#disconnectListeners.clear();
    this.#listeners.clear();
  }

  #createStream(
    transport: CodeStream["transport"],
    requestPending: Buffer[],
  ): CodeStream {
    const connectionId = randomUUID();
    const timeout = setTimeout(() => {
      const stream = this.#streams.get(connectionId);
      if (stream) this.#fail(stream, "Cantrip Code editor response timed out.");
    }, RESPONSE_START_TIMEOUT_MS);
    timeout.unref();
    const stream: CodeStream = {
      connectionId,
      destinationSequence: 0,
      destinationToSourcePendingCredit: 0,
      headerBytes: Buffer.alloc(0),
      headerLength: null,
      localSequence: 1,
      outputBytes: Buffer.alloc(0),
      requestEnded: false,
      requestHalfClosed: false,
      requestPending,
      requestPendingBytes: requestPending.reduce(
        (total, part) => total + part.byteLength,
        0,
      ),
      responseStarted: false,
      sourceToDestinationCredit: 0,
      timeout,
      transport,
    };
    this.#streams.set(connectionId, stream);
    this.touch({ bytesFromSource: 0, bytesToSource: 0, connectionDelta: 1 });
    this.#emit(
      {
        ...this.#identity(stream, 0),
        kind: "open",
        initialCreditBytes: INITIAL_CREDIT_BYTES,
      },
      EMPTY_PAYLOAD,
    );
    return stream;
  }

  #queueInput(stream: CodeStream, payload: Uint8Array): void {
    for (const part of parts(payload)) {
      stream.requestPending.push(part);
      stream.requestPendingBytes += part.byteLength;
    }
    if (stream.requestPendingBytes > MAX_BUFFERED_BYTES) {
      this.#fail(stream, "Cantrip Code request buffer exceeded.");
    }
  }

  #flushInput(stream: CodeStream): void {
    while (stream.requestPending.length > 0) {
      const payload = stream.requestPending[0]!;
      if (payload.byteLength > stream.sourceToDestinationCredit) return;
      stream.requestPending.shift();
      stream.requestPendingBytes -= payload.byteLength;
      stream.sourceToDestinationCredit -= payload.byteLength;
      this.touch({
        bytesFromSource: payload.byteLength,
        bytesToSource: 0,
        connectionDelta: 0,
      });
      this.#emit(
        {
          ...this.#identity(stream, stream.localSequence++),
          kind: "data",
          direction: "source-to-destination",
        },
        payload,
      );
    }
    if (stream.requestEnded && !stream.requestHalfClosed) {
      stream.requestHalfClosed = true;
      this.#emit(
        {
          ...this.#identity(stream, stream.localSequence++),
          kind: "half-close",
          direction: "source-to-destination",
        },
        EMPTY_PAYLOAD,
      );
    } else if (stream.transport.kind === "http" && !stream.requestEnded) {
      stream.transport.request.resume();
    }
  }

  #consumeOutput(stream: CodeStream, payload: Buffer): void {
    let body = payload;
    if (!stream.responseStarted) {
      stream.headerBytes = Buffer.concat([stream.headerBytes, payload]);
      if (stream.headerLength === null && stream.headerBytes.byteLength >= 4) {
        stream.headerLength = stream.headerBytes.readUInt32BE(0);
        if (
          stream.headerLength < 1 ||
          stream.headerLength > CODE_ADAPTER_MAX_HEAD_BYTES
        ) {
          this.#fail(stream, "Cantrip Code response headers are invalid.");
          return;
        }
      }
      if (
        stream.headerLength === null ||
        stream.headerBytes.byteLength < 4 + stream.headerLength
      )
        return;
      const consumed = 4 + stream.headerLength;
      let head: CodeAdapterResponseHead;
      try {
        head = codeAdapterResponseHeadSchema.parse(
          JSON.parse(stream.headerBytes.subarray(4, consumed).toString("utf8")),
        );
      } catch {
        this.#fail(stream, "Cantrip Code response headers are invalid.");
        return;
      }
      if (head.kind !== stream.transport.kind) {
        this.#fail(stream, "Cantrip Code returned the wrong transport.");
        return;
      }
      clearTimeout(stream.timeout);
      if (stream.transport.kind === "http" && head.kind === "http") {
        this.#writeResponseHeaders(stream.transport.response, head);
      }
      stream.responseStarted = true;
      if (stream.transport.kind === "websocket") {
        for (const queued of stream.transport.queued)
          this.#queueInput(stream, queued);
        stream.transport.queued = [];
        stream.transport.queuedBytes = 0;
        this.#flushInput(stream);
      }
      body = stream.headerBytes.subarray(consumed);
      stream.headerBytes = Buffer.alloc(0);
      this.#grantOutputCredit(stream, consumed);
    }
    if (body.byteLength === 0) return;
    if (stream.transport.kind === "http") {
      if (stream.transport.response.write(body)) {
        this.#grantOutputCredit(stream, body.byteLength);
      } else {
        stream.destinationToSourcePendingCredit += body.byteLength;
        stream.transport.response.once("drain", () => {
          const bytes = stream.destinationToSourcePendingCredit;
          stream.destinationToSourcePendingCredit = 0;
          this.#grantOutputCredit(stream, bytes);
        });
      }
      return;
    }
    stream.outputBytes = Buffer.concat([stream.outputBytes, body]);
    this.#flushWebSocketOutput(stream);
  }

  #flushWebSocketOutput(stream: CodeStream): void {
    if (stream.transport.kind !== "websocket") return;
    while (
      stream.outputBytes.byteLength >=
      CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES
    ) {
      const kind = stream.outputBytes[0]!;
      const length = stream.outputBytes.readUInt32BE(1);
      if (length > CODE_ADAPTER_MAX_WEBSOCKET_MESSAGE_BYTES) {
        this.#fail(stream, "Cantrip Code WebSocket message is too large.");
        return;
      }
      const recordLength = CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES + length;
      if (stream.outputBytes.byteLength < recordLength) return;
      const payload = stream.outputBytes.subarray(
        CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES,
        recordLength,
      );
      stream.outputBytes = stream.outputBytes.subarray(recordLength);
      if (
        kind === CODE_ADAPTER_WEBSOCKET_TEXT_RECORD ||
        kind === CODE_ADAPTER_WEBSOCKET_BINARY_RECORD
      ) {
        if (
          stream.transport.socket.readyState !== WebSocket.OPEN ||
          stream.transport.socket.bufferedAmount + payload.byteLength >
            MAX_BUFFERED_BYTES
        ) {
          this.#fail(stream, "Cantrip Code client is too slow.");
          return;
        }
        stream.transport.socket.send(payload, {
          binary: kind === CODE_ADAPTER_WEBSOCKET_BINARY_RECORD,
        });
      } else if (kind === CODE_ADAPTER_WEBSOCKET_CLOSE_RECORD) {
        try {
          const close = codeAdapterWebSocketCloseSchema.parse(
            JSON.parse(payload.toString("utf8")),
          );
          stream.transport.socket.close(close.code, close.reason);
        } catch {
          this.#fail(stream, "Cantrip Code WebSocket close is invalid.");
          return;
        }
      } else {
        this.#fail(stream, "Cantrip Code WebSocket record is invalid.");
        return;
      }
      this.#grantOutputCredit(stream, recordLength);
    }
  }

  #grantOutputCredit(stream: CodeStream, bytes: number): void {
    if (bytes < 1 || !this.#streams.has(stream.connectionId)) return;
    this.#emit(
      {
        ...this.#identity(stream, stream.localSequence++),
        kind: "credit",
        direction: "destination-to-source",
        bytes,
      },
      EMPTY_PAYLOAD,
    );
  }

  #finishOutput(stream: CodeStream): void {
    if (stream.transport.kind === "http") {
      if (!stream.responseStarted) {
        this.#fail(stream, "Cantrip Code returned an incomplete response.");
        return;
      }
      stream.transport.response.end(() => this.#closeStream(stream, null));
    } else if (stream.transport.socket.readyState === WebSocket.OPEN) {
      stream.transport.socket.close(1000);
      this.#closeStream(stream, null);
    } else {
      this.#closeStream(stream, null);
    }
  }

  #fail(stream: CodeStream, message: string, status = 502): void {
    if (!this.#streams.has(stream.connectionId)) return;
    if (stream.transport.kind === "http") {
      const { response } = stream.transport;
      if (!response.headersSent) {
        response
          .writeHead(status, {
            "cache-control": "no-store",
            "content-type": "text/plain; charset=utf-8",
          })
          .end(message);
      } else response.destroy(new Error(message));
    } else {
      stream.transport.socket.close(1013, message.slice(0, 123));
    }
    this.#closeStream(stream, message);
  }

  #closeStream(stream: CodeStream, message: string | null): void {
    if (!this.#remove(stream)) return;
    this.#emit(
      {
        ...this.#identity(stream, stream.localSequence++),
        kind: "close",
        code: message ? "revoked" : "normal",
        message,
      },
      EMPTY_PAYLOAD,
    );
  }

  #remove(stream: CodeStream): boolean {
    if (this.#streams.get(stream.connectionId) !== stream) return false;
    this.#streams.delete(stream.connectionId);
    clearTimeout(stream.timeout);
    if (stream.transport.kind === "http") stream.transport.request.pause();
    this.touch({ bytesFromSource: 0, bytesToSource: 0, connectionDelta: -1 });
    return true;
  }

  #finished(stream: CodeStream): boolean {
    return stream.transport.kind === "http"
      ? stream.transport.response.writableEnded
      : stream.transport.socket.readyState !== WebSocket.OPEN;
  }

  #emit(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): void {
    for (const listener of this.#listeners) listener(header, payload);
  }

  #identity(stream: CodeStream, sequence: number) {
    return {
      protocolVersion: 1 as const,
      tunnelId: this.tunnelId,
      attachmentId: this.attachmentId,
      sourceEndpointId: this.endpointId,
      destinationEndpointId: this.destinationEndpointId,
      connectionId: stream.connectionId,
      sequence,
    };
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
      )
        continue;
      headers.push([name, value]);
    }
    headers.push(["x-forwarded-host", this.surfaceOrigin.host]);
    headers.push([
      "x-forwarded-proto",
      this.surfaceOrigin.protocol.slice(0, -1),
    ]);
    if (this.surfaceOrigin.port) {
      headers.push(["x-forwarded-port", this.surfaceOrigin.port]);
    }
    return headers;
  }

  #writeResponseHeaders(
    response: ServerResponse,
    head: Extract<CodeAdapterResponseHead, { kind: "http" }>,
  ): void {
    const values = new Map<string, { name: string; values: string[] }>();
    let contentSecurityPolicy: string | null = null;
    for (const [name, value] of head.headers) {
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
    for (const { name, values: entries } of values.values()) {
      response.setHeader(name, entries.length === 1 ? entries[0]! : entries);
    }
    const policy = (contentSecurityPolicy ?? "")
      .split(";")
      .map((directive) => directive.trim())
      .filter(
        (directive) =>
          directive && !directive.toLowerCase().startsWith("frame-ancestors"),
      );
    policy.push(`frame-ancestors ${this.allowedFrameAncestors}`);
    response.setHeader("Content-Security-Policy", policy.join("; "));
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.writeHead(head.statusCode);
  }
}
