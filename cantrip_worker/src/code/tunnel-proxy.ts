import {
  request as requestHttp,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";

import type { CodeTunnelFrameHeader } from "@cantrip/protocol";
import WebSocket, { type RawData } from "ws";

import type { CodeSupervisor } from "./supervisor.js";

type FrameEmitter = (
  header: CodeTunnelFrameHeader,
  payload: Uint8Array,
) => boolean;

interface HttpStream {
  kind: "http";
  request: ClientRequest;
}

interface WebSocketStream {
  kind: "websocket";
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

  constructor(private readonly supervisor: CodeSupervisor) {}

  setFrameEmitter(emit: FrameEmitter): void {
    this.#emit = emit;
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
        if (
          stream.socket.bufferedAmount + payload.byteLength >
          MAX_LOCAL_BUFFER_BYTES
        ) {
          stream.socket.close(1013, "Cantrip Code tunnel is congested");
          return;
        }
        stream.socket.send(payload, { binary: header.binary });
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
        (response) => this.#pipeHttpResponse(header, response),
      );
      this.#streams.set(streamKey, { kind: "http", request });
      request.once("error", (error) => {
        if (this.#streams.delete(streamKey)) this.#error(header, error.message);
      });
    } catch (error) {
      this.#error(
        header,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #pipeHttpResponse(
    requestHeader: Extract<
      CodeTunnelFrameHeader,
      { kind: "http-request-start" }
    >,
    response: IncomingMessage,
  ): void {
    const streamKey = key(requestHeader);
    if (!this.#streams.has(streamKey)) {
      response.destroy();
      return;
    }
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
      this.#streams.delete(streamKey);
      return;
    }
    response.on("data", (chunk: Buffer) => {
      if (
        !this.#emit(
          {
            protocolVersion: 1,
            attachmentId: requestHeader.attachmentId,
            sessionId: requestHeader.sessionId,
            streamId: requestHeader.streamId,
            kind: "http-response-data",
          },
          chunk,
        )
      ) {
        response.destroy(new Error("Cantrip Code tunnel is congested."));
      }
    });
    response.once("end", () => {
      if (!this.#streams.delete(streamKey)) return;
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
    });
    response.once("error", (error) => {
      if (this.#streams.delete(streamKey))
        this.#error(requestHeader, error.message);
    });
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
      });
      this.#streams.set(streamKey, { kind: "websocket", socket });
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
            rawDataBytes(data),
          )
        ) {
          socket.close(1013, "Cantrip Code tunnel is congested");
        }
      });
      socket.once("close", (code, reason) => {
        if (!this.#streams.delete(streamKey)) return;
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
        if (this.#streams.delete(streamKey)) this.#error(header, error.message);
      });
    } catch (error) {
      this.#error(
        header,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #cancel(streamKey: string, reason: string): void {
    const stream = this.#streams.get(streamKey);
    if (!stream) return;
    this.#streams.delete(streamKey);
    if (stream.kind === "http") stream.request.destroy(new Error(reason));
    else stream.socket.close(1_000, reason.slice(0, 1_024));
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
