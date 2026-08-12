import { randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";

import {
  PROJECT_SHARE_ADAPTER_MAX_HEAD_BYTES,
  TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES,
  TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES,
  type ProjectShareAdapterRequestHead,
  type ProjectShareAdapterResponseHead,
  projectShareAdapterResponseHeadSchema,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";

import type {
  TunnelDataPlaneEndpoint,
  TunnelEndpointFrameListener,
} from "../tunnels/broker.js";

const EMPTY_PAYLOAD = new Uint8Array();
const INITIAL_CREDIT_BYTES = 256 * 1_024;
const MAX_BUFFERED_BYTES = 8 * 1_024 * 1_024;
const RESPONSE_START_TIMEOUT_MS = 30_000;
const BLOCKED_CLIENT_HEADERS = new Set([
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
const BLOCKED_WORKER_HEADERS = new Set([
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

interface HttpStream {
  connectionId: string;
  destinationSequence: number;
  destinationToSourcePendingCredit: number;
  headerBytes: Buffer;
  headerLength: number | null;
  localSequence: number;
  request: IncomingMessage;
  requestEnded: boolean;
  requestHalfClosed: boolean;
  requestPending: Buffer[];
  requestPendingBytes: number;
  response: ServerResponse;
  responseStarted: boolean;
  sourceToDestinationCredit: number;
  timeout: ReturnType<typeof setTimeout>;
}

function encodeHead(head: ProjectShareAdapterRequestHead): Buffer {
  const body = Buffer.from(JSON.stringify(head));
  if (body.byteLength > PROJECT_SHARE_ADAPTER_MAX_HEAD_BYTES) {
    throw new Error("Project share request headers exceed the tunnel limit.");
  }
  const output = Buffer.allocUnsafe(4 + body.byteLength);
  output.writeUInt32BE(body.byteLength, 0);
  body.copy(output, 4);
  return output;
}

function payloadParts(payload: Uint8Array): Buffer[] {
  const parts: Buffer[] = [];
  for (
    let offset = 0;
    offset < payload.byteLength;
    offset += TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES
  ) {
    parts.push(
      Buffer.from(
        payload.subarray(offset, offset + TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES),
      ),
    );
  }
  return parts;
}

export class ProjectShareHttpEndpoint implements TunnelDataPlaneEndpoint {
  readonly endpointId: string;
  readonly placement: { kind: "server-adapter"; adapterId: string };
  readonly #disconnectListeners = new Set<() => void>();
  readonly #listeners = new Set<TunnelEndpointFrameListener>();
  readonly #streams = new Map<string, HttpStream>();
  #closed = false;

  constructor(
    readonly tunnelId: string,
    readonly attachmentId: string,
    private readonly destinationEndpointId: string,
    private readonly touch: (input: {
      bytesFromSource: number;
      bytesToSource: number;
      connectionDelta: number;
    }) => void,
  ) {
    this.endpointId = `server:project-share:${attachmentId}`;
    this.placement = {
      kind: "server-adapter",
      adapterId: `project-share:${attachmentId}`,
    };
  }

  proxy(request: IncomingMessage, response: ServerResponse): void {
    if (this.#closed) {
      response
        .writeHead(503, { "cache-control": "no-store" })
        .end("Share unavailable");
      return;
    }
    if (this.#streams.size >= 64) {
      response
        .writeHead(429, { "cache-control": "no-store" })
        .end("Project share is busy");
      return;
    }
    const connectionId = randomUUID();
    request.pause();
    let requestHead: Buffer;
    try {
      requestHead = encodeHead({
        protocolVersion: 1,
        method: (request.method ?? "GET").toUpperCase(),
        path: request.url ?? "/",
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
    const timeout = setTimeout(
      () => this.#fail(connectionId, 504, "Project share response timed out."),
      RESPONSE_START_TIMEOUT_MS,
    );
    timeout.unref();
    const stream: HttpStream = {
      connectionId,
      destinationSequence: 0,
      destinationToSourcePendingCredit: 0,
      headerBytes: Buffer.alloc(0),
      headerLength: null,
      localSequence: 1,
      request,
      requestEnded: false,
      requestHalfClosed: false,
      requestPending: payloadParts(requestHead),
      requestPendingBytes: requestHead.byteLength,
      response,
      responseStarted: false,
      sourceToDestinationCredit: 0,
      timeout,
    };
    this.#streams.set(connectionId, stream);
    this.touch({ bytesFromSource: 0, bytesToSource: 0, connectionDelta: 1 });
    request.on("data", (chunk: Buffer) => {
      if (this.#streams.get(connectionId) !== stream) return;
      request.pause();
      for (const part of payloadParts(chunk)) {
        stream.requestPending.push(part);
        stream.requestPendingBytes += part.byteLength;
      }
      if (stream.requestPendingBytes > MAX_BUFFERED_BYTES) {
        this.#fail(connectionId, 413, "Project share request is too large.");
        return;
      }
      this.#flushRequest(stream);
    });
    request.once("end", () => {
      stream.requestEnded = true;
      this.#flushRequest(stream);
    });
    request.once("aborted", () =>
      this.#closeStream(stream, "Client aborted request."),
    );
    response.once("close", () => {
      if (!response.writableEnded)
        this.#closeStream(stream, "Client closed response.");
    });
    this.#emit(
      {
        ...this.#identity(stream, 0),
        kind: "open",
        initialCreditBytes: INITIAL_CREDIT_BYTES,
      },
      EMPTY_PAYLOAD,
    );
  }

  send(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): boolean {
    const stream = this.#streams.get(header.connectionId);
    if (!stream || this.#closed) return false;
    if (
      header.sequence !== stream.destinationSequence ||
      header.sourceEndpointId !== this.endpointId
    ) {
      this.#closeStream(stream, "Invalid project share tunnel sequence.");
      return false;
    }
    stream.destinationSequence += 1;
    if (header.kind === "accepted") {
      stream.sourceToDestinationCredit = header.initialCreditBytes;
      this.#flushRequest(stream);
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
      this.#flushRequest(stream);
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
      this.#consumeResponse(stream, Buffer.from(payload));
      return true;
    }
    if (
      header.kind === "half-close" &&
      header.direction === "destination-to-source"
    ) {
      if (!stream.responseStarted) {
        this.#fail(
          stream.connectionId,
          502,
          "Worker returned an incomplete response.",
        );
      } else {
        stream.response.end(() => this.#closeStream(stream, null));
      }
      return true;
    }
    if (header.kind === "rejected" || header.kind === "error") {
      this.#fail(stream.connectionId, 502, header.message);
      return true;
    }
    if (header.kind === "close") {
      if (!stream.response.writableEnded) {
        this.#fail(stream.connectionId, 502, "Project share tunnel closed.");
      } else {
        this.#remove(stream);
      }
      return true;
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
      this.#fail(stream.connectionId, 503, "Project share is unavailable.");
    }
    for (const listener of this.#disconnectListeners) listener();
    this.#disconnectListeners.clear();
    this.#listeners.clear();
  }

  #consumeResponse(stream: HttpStream, payload: Buffer): void {
    let body = payload;
    if (!stream.responseStarted) {
      stream.headerBytes = Buffer.concat([stream.headerBytes, payload]);
      if (stream.headerLength === null && stream.headerBytes.byteLength >= 4) {
        stream.headerLength = stream.headerBytes.readUInt32BE(0);
        if (
          stream.headerLength < 1 ||
          stream.headerLength > PROJECT_SHARE_ADAPTER_MAX_HEAD_BYTES
        ) {
          this.#fail(
            stream.connectionId,
            502,
            "Worker response headers are invalid.",
          );
          return;
        }
      }
      if (
        stream.headerLength === null ||
        stream.headerBytes.byteLength < 4 + stream.headerLength
      ) {
        return;
      }
      const consumed = 4 + stream.headerLength;
      let head: ProjectShareAdapterResponseHead;
      try {
        head = projectShareAdapterResponseHeadSchema.parse(
          JSON.parse(stream.headerBytes.subarray(4, consumed).toString("utf8")),
        );
      } catch {
        this.#fail(
          stream.connectionId,
          502,
          "Worker response headers are invalid.",
        );
        return;
      }
      clearTimeout(stream.timeout);
      this.#writeResponseHeaders(stream.response, head);
      stream.responseStarted = true;
      body = stream.headerBytes.subarray(consumed);
      stream.headerBytes = Buffer.alloc(0);
      this.#grantResponseCredit(stream, consumed);
    }
    if (body.byteLength === 0) return;
    if (stream.response.write(body)) {
      this.#grantResponseCredit(stream, body.byteLength);
    } else {
      stream.destinationToSourcePendingCredit += body.byteLength;
      stream.response.once("drain", () => {
        const bytes = stream.destinationToSourcePendingCredit;
        stream.destinationToSourcePendingCredit = 0;
        this.#grantResponseCredit(stream, bytes);
      });
    }
  }

  #flushRequest(stream: HttpStream): void {
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
    } else if (!stream.requestEnded && stream.sourceToDestinationCredit > 0) {
      stream.request.resume();
    }
  }

  #grantResponseCredit(stream: HttpStream, bytes: number): void {
    if (bytes < 1 || this.#streams.get(stream.connectionId) !== stream) return;
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

  #closeStream(stream: HttpStream, message: string | null): void {
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

  #fail(connectionId: string, status: number, message: string): void {
    const stream = this.#streams.get(connectionId);
    if (!stream) return;
    if (!stream.response.headersSent) {
      stream.response
        .writeHead(status, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        })
        .end(message);
    } else {
      stream.response.destroy(new Error(message));
    }
    this.#closeStream(stream, message);
  }

  #remove(stream: HttpStream): boolean {
    if (this.#streams.get(stream.connectionId) !== stream) return false;
    this.#streams.delete(stream.connectionId);
    clearTimeout(stream.timeout);
    stream.request.pause();
    this.touch({ bytesFromSource: 0, bytesToSource: 0, connectionDelta: -1 });
    return true;
  }

  #emit(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): void {
    for (const listener of this.#listeners) listener(header, payload);
  }

  #identity(stream: HttpStream, sequence: number) {
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
    return headers;
  }

  #writeResponseHeaders(
    response: ServerResponse,
    head: ProjectShareAdapterResponseHead,
  ): void {
    const values = new Map<string, { name: string; values: string[] }>();
    for (const [name, value] of head.headers) {
      const lower = name.toLowerCase();
      if (BLOCKED_WORKER_HEADERS.has(lower)) continue;
      const current = values.get(lower) ?? { name, values: [] };
      current.values.push(value);
      values.set(lower, current);
    }
    for (const { name, values: entries } of values.values()) {
      response.setHeader(name, entries.length === 1 ? entries[0]! : entries);
    }
    response.writeHead(head.statusCode);
  }
}
