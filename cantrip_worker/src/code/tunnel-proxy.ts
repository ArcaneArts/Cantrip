import {
  request as requestHttp,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";

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
  codeAdapterRequestHeadSchema,
  codeAdapterWebSocketCloseSchema,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import WebSocket, { type RawData } from "ws";

import type { CodeSupervisor } from "./supervisor.js";

type FrameEmitter = (
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
) => boolean;
type CapacityWaiter = (attachmentId: string) => Promise<boolean>;

interface BaseStream {
  destinationToSourceCredit: number;
  flushing: boolean;
  headBytes: Buffer;
  headLength: number | null;
  header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>;
  inputSequence: number;
  outputSequence: number;
  outputWaiters: Set<() => void>;
  pendingBytes: number;
  pendingOutput: Buffer[];
  sessionId: string | null;
  sourceHalfClosed: boolean;
}

interface OpeningStream extends BaseStream {
  kind: "opening";
}

interface HttpStream extends BaseStream {
  kind: "http";
  request: ClientRequest;
  response: IncomingMessage | null;
}

interface WebSocketStream extends BaseStream {
  authenticationForwarded: boolean;
  inputBytes: Buffer;
  kind: "websocket";
  socket: WebSocket;
}

type CodeStream = OpeningStream | HttpStream | WebSocketStream;

const EMPTY_PAYLOAD = new Uint8Array();
const INITIAL_CREDIT_BYTES = 256 * 1_024;
const MAX_STREAMS = 256;
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

function key(header: TunnelDataPlaneFrameHeader): string {
  return `${header.tunnelId}\0${header.attachmentId}\0${header.connectionId}`;
}

function responseBase(stream: CodeStream) {
  return {
    protocolVersion: 1 as const,
    tunnelId: stream.header.tunnelId,
    attachmentId: stream.header.attachmentId,
    sourceEndpointId: stream.header.sourceEndpointId,
    destinationEndpointId: stream.header.destinationEndpointId,
    connectionId: stream.header.connectionId,
    sequence: stream.outputSequence++,
  };
}

export function rawCodeWebSocketBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function editorAuthenticatedPayload(
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
    JSON.stringify({ ...message, auth: connectionToken }),
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

export function codeEditorRequestHeaders(
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

export function codeEditorResponseHeaders(
  message: IncomingMessage,
): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const value = message.rawHeaders[index + 1];
    if (
      !name ||
      value === undefined ||
      BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())
    )
      continue;
    headers.push([name, value]);
  }
  return headers;
}

export function codeEditorTargetUrl(
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
    const workspace = new URL(workspaceUri);
    if (
      workspace.protocol !== "file:" ||
      workspace.host !== "" ||
      workspace.search !== "" ||
      workspace.hash !== ""
    ) {
      throw new Error("Cantrip Code supplied an invalid workspace URI.");
    }
    // The web workbench interprets an absolute path as a resource on its
    // remote authority. Passing the worker's file:// URI instead makes the
    // browser try to open a local workspace, which disconnects the folder,
    // its settings, Git, and all workspace extensions from the worker.
    target.searchParams.set(
      "workspace",
      decodeURIComponent(workspace.pathname),
    );
  }
  return target;
}

export function codeHeaderValue(
  headers: Array<[string, string]>,
  targetName: string,
): string | undefined {
  return headers.find(([name]) => name.toLowerCase() === targetName)?.[1];
}

function encodeHead(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.byteLength > CODE_ADAPTER_MAX_HEAD_BYTES) {
    throw new Error("Cantrip Code response headers exceed the tunnel limit.");
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

export class CodeTunnelProxy {
  readonly #streams = new Map<string, CodeStream>();
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

  handleFrame(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): void {
    if (header.kind === "connect") {
      this.#connect(header);
      return;
    }
    let stream = this.#streams.get(key(header));
    if (!stream) return;
    if (
      header.sourceEndpointId !== stream.header.sourceEndpointId ||
      header.destinationEndpointId !== stream.header.destinationEndpointId ||
      header.sequence !== stream.inputSequence
    ) {
      this.#closeStream(stream, "protocol-error");
      return;
    }
    stream.inputSequence += 1;
    if (
      header.kind === "data" &&
      header.direction === "source-to-destination"
    ) {
      stream = this.#consumeInput(stream, Buffer.from(payload));
      return;
    }
    if (
      header.kind === "credit" &&
      header.direction === "destination-to-source"
    ) {
      stream.destinationToSourceCredit = Math.min(
        TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES,
        stream.destinationToSourceCredit + header.bytes,
      );
      void this.#flushOutput(stream).then(() => this.#wakeOutput(stream));
      return;
    }
    if (
      header.kind === "half-close" &&
      header.direction === "source-to-destination"
    ) {
      stream.sourceHalfClosed = true;
      if (stream.kind === "http") stream.request.end();
      else if (stream.kind === "opening")
        this.#closeStream(stream, "protocol-error");
      return;
    }
    if (header.kind === "close" || header.kind === "error") {
      this.#remove(stream);
      this.#destroy(stream);
    }
  }

  closeSession(sessionId: string): void {
    for (const stream of [...this.#streams.values()]) {
      if (stream.sessionId === sessionId) this.#closeStream(stream, "revoked");
    }
  }

  disconnect(): void {
    for (const stream of [...this.#streams.values()]) {
      this.#remove(stream);
      this.#destroy(stream);
    }
  }

  close(): void {
    this.disconnect();
  }

  #connect(
    header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>,
  ): void {
    if (header.target.kind !== "adapter" || header.target.adapter !== "code") {
      return;
    }
    if (this.#streams.has(key(header))) {
      this.#reject(header, "protocol-error", "Tunnel stream already exists.");
      return;
    }
    if (this.#streams.size >= MAX_STREAMS) {
      this.#reject(
        header,
        "limit-exceeded",
        "Cantrip Code stream limit reached.",
      );
      return;
    }
    const stream: OpeningStream = {
      destinationToSourceCredit: header.initialCreditBytes,
      flushing: false,
      headBytes: Buffer.alloc(0),
      headLength: null,
      header,
      inputSequence: 1,
      kind: "opening",
      outputSequence: 0,
      outputWaiters: new Set(),
      pendingBytes: 0,
      pendingOutput: [],
      sessionId: null,
      sourceHalfClosed: false,
    };
    this.#streams.set(key(header), stream);
    if (
      !this.#emit(
        {
          ...responseBase(stream),
          kind: "accepted",
          initialCreditBytes: INITIAL_CREDIT_BYTES,
        },
        EMPTY_PAYLOAD,
      )
    ) {
      this.#remove(stream);
    }
  }

  #consumeInput(stream: CodeStream, payload: Buffer): CodeStream {
    if (stream.kind === "opening") {
      stream.headBytes = Buffer.concat([stream.headBytes, payload]);
      if (stream.headLength === null && stream.headBytes.byteLength >= 4) {
        stream.headLength = stream.headBytes.readUInt32BE(0);
        if (
          stream.headLength < 1 ||
          stream.headLength > CODE_ADAPTER_MAX_HEAD_BYTES
        ) {
          this.#closeStream(stream, "protocol-error");
          return stream;
        }
      }
      if (
        stream.headLength === null ||
        stream.headBytes.byteLength < 4 + stream.headLength
      )
        return stream;
      const consumed = 4 + stream.headLength;
      let head: CodeAdapterRequestHead;
      try {
        head = codeAdapterRequestHeadSchema.parse(
          JSON.parse(stream.headBytes.subarray(4, consumed).toString("utf8")),
        );
      } catch {
        this.#closeStream(stream, "protocol-error");
        return stream;
      }
      const body = stream.headBytes.subarray(consumed);
      stream.headBytes = Buffer.alloc(0);
      const opened = this.#openTarget(stream, head);
      if (!opened) return stream;
      this.#grantInputCredit(opened, consumed);
      if (body.byteLength > 0) return this.#consumeInput(opened, body);
      return opened;
    }
    if (stream.kind === "http") {
      if (
        stream.sourceHalfClosed ||
        stream.request.writableLength + payload.byteLength >
          MAX_LOCAL_BUFFER_BYTES
      ) {
        this.#closeStream(stream, "congested");
        return stream;
      }
      stream.request.write(payload, () =>
        this.#grantInputCredit(stream, payload.byteLength),
      );
      return stream;
    }
    stream.inputBytes = Buffer.concat([stream.inputBytes, payload]);
    this.#flushWebSocketInput(stream);
    return stream;
  }

  #openTarget(
    opening: OpeningStream,
    head: CodeAdapterRequestHead,
  ): CodeStream | null {
    try {
      const tunnelTarget = opening.header.target;
      if (tunnelTarget.kind !== "adapter" || tunnelTarget.adapter !== "code") {
        throw new Error("Cantrip Code tunnel target is invalid.");
      }
      const proxy = this.supervisor.proxyTarget(head.sessionId);
      if (proxy.codeTabId !== tunnelTarget.resourceId) {
        throw new Error("Cantrip Code session does not belong to this tunnel.");
      }
      const target = codeEditorTargetUrl(
        proxy.editorOrigin,
        head.path,
        head.basePath,
        proxy.workspaceUri,
      );
      if (head.kind === "http") {
        let stream!: HttpStream;
        const request = requestHttp(
          target,
          {
            method: head.method,
            headers: codeEditorRequestHeaders(
              head.headers,
              target,
              head.basePath,
              proxy.connectionToken,
            ),
          },
          (response) => void this.#pipeHttpResponse(stream, response),
        );
        stream = {
          ...opening,
          kind: "http",
          request,
          response: null,
          sessionId: head.sessionId,
        };
        this.#replace(opening, stream);
        this.supervisor.beginTunnelStream(head.sessionId, key(opening.header));
        request.once("error", () =>
          this.#closeStream(stream, "protocol-error"),
        );
        return stream;
      }
      target.protocol = "ws:";
      const protocols = (
        codeHeaderValue(head.headers, "sec-websocket-protocol") ?? ""
      )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const headers = codeEditorRequestHeaders(
        head.headers.filter(
          ([name]) => name.toLowerCase() !== "sec-websocket-protocol",
        ),
        target,
        head.basePath,
        proxy.connectionToken,
      );
      const socket = new WebSocket(target, protocols, {
        headers,
        maxPayload: CODE_ADAPTER_MAX_WEBSOCKET_MESSAGE_BYTES,
      });
      const stream: WebSocketStream = {
        ...opening,
        authenticationForwarded: false,
        inputBytes: Buffer.alloc(0),
        kind: "websocket",
        sessionId: head.sessionId,
        socket,
      };
      this.#replace(opening, stream);
      this.supervisor.beginTunnelStream(head.sessionId, key(opening.header));
      socket.once("open", () => {
        this.#queueOutput(
          stream,
          encodeHead({ protocolVersion: 1, kind: "websocket", headers: [] }),
        );
        void this.#drainOutput(stream);
      });
      socket.on("message", (data, binary) => {
        try {
          this.#queueOutput(
            stream,
            record(
              binary
                ? CODE_ADAPTER_WEBSOCKET_BINARY_RECORD
                : CODE_ADAPTER_WEBSOCKET_TEXT_RECORD,
              rawCodeWebSocketBytes(data),
            ),
          );
          void this.#drainOutput(stream);
        } catch {
          this.#closeStream(stream, "congested");
        }
      });
      socket.once("close", (code, reason) => {
        if (!this.#streams.has(key(stream.header))) return;
        const close = Buffer.from(
          JSON.stringify({
            code: code >= 1_000 && code <= 4_999 ? code : 1_000,
            reason: reason.toString().slice(0, 1_024),
          }),
        );
        this.#queueOutput(
          stream,
          record(CODE_ADAPTER_WEBSOCKET_CLOSE_RECORD, close),
        );
        void this.#drainOutput(stream).then(() =>
          this.#halfCloseOutput(stream),
        );
      });
      socket.once("error", () => this.#closeStream(stream, "protocol-error"));
      return stream;
    } catch {
      this.#closeStream(opening, "protocol-error");
      return null;
    }
  }

  async #pipeHttpResponse(
    stream: HttpStream,
    response: IncomingMessage,
  ): Promise<void> {
    if (!this.#streams.has(key(stream.header))) {
      response.destroy();
      return;
    }
    stream.response = response;
    try {
      this.#queueOutput(
        stream,
        encodeHead({
          protocolVersion: 1,
          kind: "http",
          statusCode: response.statusCode ?? 502,
          headers: codeEditorResponseHeaders(response),
        }),
      );
      await this.#drainOutput(stream);
      for await (const rawChunk of response) {
        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk as Uint8Array);
        this.#queueOutput(stream, chunk);
        await this.#drainOutput(stream);
        if (!this.#streams.has(key(stream.header))) return;
      }
      this.#halfCloseOutput(stream);
    } catch {
      this.#closeStream(stream, "congested");
    }
  }

  #flushWebSocketInput(stream: WebSocketStream): void {
    while (
      stream.inputBytes.byteLength >= CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES
    ) {
      const kind = stream.inputBytes[0]!;
      const length = stream.inputBytes.readUInt32BE(1);
      if (length > CODE_ADAPTER_MAX_WEBSOCKET_MESSAGE_BYTES) {
        this.#closeStream(stream, "protocol-error");
        return;
      }
      const recordLength = CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES + length;
      if (stream.inputBytes.byteLength < recordLength) return;
      let payload = stream.inputBytes.subarray(
        CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES,
        recordLength,
      );
      stream.inputBytes = stream.inputBytes.subarray(recordLength);
      if (
        kind === CODE_ADAPTER_WEBSOCKET_TEXT_RECORD ||
        kind === CODE_ADAPTER_WEBSOCKET_BINARY_RECORD
      ) {
        if (!stream.authenticationForwarded) {
          try {
            payload = Buffer.from(
              editorAuthenticatedPayload(
                payload,
                this.supervisor.proxyTarget(stream.sessionId!).connectionToken,
              ),
            );
            stream.authenticationForwarded = true;
          } catch {
            this.#closeStream(stream, "protocol-error");
            return;
          }
        }
        if (
          stream.socket.readyState !== WebSocket.OPEN ||
          stream.socket.bufferedAmount + payload.byteLength >
            MAX_LOCAL_BUFFER_BYTES
        ) {
          this.#closeStream(stream, "congested");
          return;
        }
        stream.socket.send(payload, {
          binary: kind === CODE_ADAPTER_WEBSOCKET_BINARY_RECORD,
        });
      } else if (kind === CODE_ADAPTER_WEBSOCKET_CLOSE_RECORD) {
        try {
          const close = codeAdapterWebSocketCloseSchema.parse(
            JSON.parse(payload.toString("utf8")),
          );
          stream.socket.close(close.code, close.reason);
        } catch {
          this.#closeStream(stream, "protocol-error");
          return;
        }
      } else {
        this.#closeStream(stream, "protocol-error");
        return;
      }
      this.#grantInputCredit(stream, recordLength);
    }
  }

  #queueOutput(stream: CodeStream, payload: Uint8Array): void {
    for (const part of parts(payload)) {
      stream.pendingOutput.push(part);
      stream.pendingBytes += part.byteLength;
    }
    if (stream.pendingBytes > MAX_LOCAL_BUFFER_BYTES) {
      this.#closeStream(stream, "congested");
    }
  }

  async #flushOutput(stream: CodeStream): Promise<void> {
    if (stream.flushing) return;
    const pendingBefore = stream.pendingBytes;
    stream.flushing = true;
    try {
      while (stream.pendingOutput.length > 0) {
        if (!this.#streams.has(key(stream.header))) return;
        let payload = stream.pendingOutput[0]!;
        if (stream.destinationToSourceCredit < 1) return;
        if (payload.byteLength > stream.destinationToSourceCredit) {
          const sent = payload.subarray(0, stream.destinationToSourceCredit);
          stream.pendingOutput[0] = payload.subarray(
            stream.destinationToSourceCredit,
          );
          stream.pendingBytes -= sent.byteLength;
          payload = sent;
        } else {
          stream.pendingOutput.shift();
          stream.pendingBytes -= payload.byteLength;
        }
        stream.destinationToSourceCredit -= payload.byteLength;
        if (
          !this.#emit(
            {
              ...responseBase(stream),
              kind: "data",
              direction: "destination-to-source",
            },
            payload,
          ) ||
          !(await this.#waitForCapacity(stream.header.attachmentId))
        ) {
          this.#closeStream(stream, "congested");
          return;
        }
      }
    } finally {
      stream.flushing = false;
      if (
        stream.pendingBytes !== pendingBefore ||
        stream.pendingOutput.length === 0
      )
        this.#wakeOutput(stream);
    }
  }

  async #drainOutput(stream: CodeStream): Promise<void> {
    while (
      this.#streams.has(key(stream.header)) &&
      stream.pendingOutput.length > 0
    ) {
      await this.#flushOutput(stream);
      if (stream.pendingOutput.length === 0) return;
      await new Promise<void>((resolve) => {
        stream.outputWaiters.add(resolve);
        if (stream.pendingOutput.length === 0) {
          stream.outputWaiters.delete(resolve);
          resolve();
        }
      });
    }
  }

  #wakeOutput(stream: CodeStream): void {
    for (const resolve of stream.outputWaiters) resolve();
    stream.outputWaiters.clear();
  }

  #grantInputCredit(stream: CodeStream, bytes: number): void {
    if (bytes < 1 || !this.#streams.has(key(stream.header))) return;
    this.#emit(
      {
        ...responseBase(stream),
        kind: "credit",
        direction: "source-to-destination",
        bytes,
      },
      EMPTY_PAYLOAD,
    );
  }

  #halfCloseOutput(stream: CodeStream): void {
    if (!this.#streams.has(key(stream.header))) return;
    this.#emit(
      {
        ...responseBase(stream),
        kind: "half-close",
        direction: "destination-to-source",
      },
      EMPTY_PAYLOAD,
    );
  }

  #reject(
    header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>,
    code: Extract<TunnelDataPlaneFrameHeader, { kind: "rejected" }>["code"],
    message: string,
  ): void {
    this.#emit(
      {
        protocolVersion: 1,
        tunnelId: header.tunnelId,
        attachmentId: header.attachmentId,
        sourceEndpointId: header.sourceEndpointId,
        destinationEndpointId: header.destinationEndpointId,
        connectionId: header.connectionId,
        sequence: 0,
        kind: "rejected",
        code,
        message,
      },
      EMPTY_PAYLOAD,
    );
  }

  #closeStream(
    stream: CodeStream,
    code: Extract<TunnelDataPlaneFrameHeader, { kind: "close" }>["code"],
  ): void {
    if (!this.#remove(stream)) return;
    this.#emit(
      { ...responseBase(stream), kind: "close", code, message: null },
      EMPTY_PAYLOAD,
    );
    this.#destroy(stream);
  }

  #replace(before: CodeStream, after: CodeStream): void {
    this.#streams.set(key(before.header), after);
  }

  #remove(stream: CodeStream): boolean {
    const streamKey = key(stream.header);
    if (this.#streams.get(streamKey) !== stream) return false;
    this.#streams.delete(streamKey);
    this.#wakeOutput(stream);
    if (stream.sessionId) {
      this.supervisor.endTunnelStream(stream.sessionId, streamKey);
    }
    return true;
  }

  #destroy(stream: CodeStream): void {
    if (stream.kind === "http") {
      stream.response?.destroy();
      stream.request.destroy();
    } else if (stream.kind === "websocket") {
      stream.socket.close(1000);
    }
  }
}
