import {
  request as requestHttp,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";

import {
  PROJECT_SHARE_ADAPTER_MAX_HEAD_BYTES,
  TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES,
  TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES,
  type ProjectShareAdapterRequestHead,
  projectShareAdapterRequestHeadSchema,
  type TunnelDataPlaneFrameHeader,
  type WorkerProjectShareOpenResult,
} from "@cantrip/protocol";

import type { ProjectShareManager } from "./project-share-manager.js";

type FrameEmitter = (
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
) => boolean;
type CapacityWaiter = () => Promise<boolean>;

interface ProjectShareStream {
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
  request: ClientRequest | null;
  response: IncomingMessage | null;
  share: WorkerProjectShareOpenResult;
  sourceHalfClosed: boolean;
}

const EMPTY_PAYLOAD = new Uint8Array();
const INITIAL_CREDIT_BYTES = 256 * 1_024;
const MAX_STREAMS = 64;
const MAX_LOCAL_BUFFER_BYTES = 8 * 1_024 * 1_024;
const BLOCKED_REQUEST_HEADERS = new Set([
  "connection",
  "cookie",
  "expect",
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

function responseBase(stream: ProjectShareStream) {
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

function targetUrl(share: WorkerProjectShareOpenResult, rawPath: string): URL {
  const publicUrl = new URL(rawPath, "http://cantrip-share.invalid");
  if (
    publicUrl.pathname !== share.publicBasePath &&
    !publicUrl.pathname.startsWith(`${share.publicBasePath}/`)
  ) {
    throw new Error("Project share request escaped its public path.");
  }
  const target = new URL(`http://${share.loopbackHost}:${share.loopbackPort}`);
  target.pathname = publicUrl.pathname;
  target.search = publicUrl.search;
  return target;
}

function requestHeaders(
  headers: Array<[string, string]>,
  target: URL,
  share: WorkerProjectShareOpenResult,
): Record<string, string | string[]> {
  const output = new Map<string, string[]>();
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(name)) continue;
    const values = output.get(name) ?? [];
    values.push(value);
    output.set(name, values);
  }
  output.set("host", [new URL(share.publicOrigin).host || target.host]);
  return Object.fromEntries(
    [...output].map(([name, values]) => [
      name,
      values.length === 1 ? values[0]! : values,
    ]),
  );
}

function responseHeaders(
  message: IncomingMessage,
  share: WorkerProjectShareOpenResult,
  rewritingOrigin: boolean,
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
    if (rewritingOrigin && name.toLowerCase() === "content-length") continue;
    if (
      name.toLowerCase() === "location" ||
      name.toLowerCase() === "content-location"
    ) {
      if (value.startsWith("/")) {
        headers.push([name, value]);
        continue;
      }
      try {
        const location = new URL(value);
        const publicOrigin = new URL(share.publicOrigin);
        if (
          (location.hostname === share.loopbackHost &&
            location.port === String(share.loopbackPort)) ||
          (location.host === publicOrigin.host && location.protocol === "http:")
        ) {
          headers.push([
            name,
            `${share.publicOrigin}${location.pathname}${location.search}${location.hash}`,
          ]);
        }
      } catch {
        // Invalid or private absolute locations do not leave the worker.
      }
      continue;
    }
    headers.push([name, value]);
  }
  return headers;
}

function responseNeedsOriginRewrite(
  message: IncomingMessage,
  share: WorkerProjectShareOpenResult,
): boolean {
  const contentType = message.headers["content-type"]?.toLowerCase() ?? "";
  return (
    share.publicOrigin.startsWith("https://") &&
    (contentType.includes("/xml") || contentType.includes("+xml"))
  );
}

function encodeResponseHead(input: {
  statusCode: number;
  headers: Array<[string, string]>;
}): Buffer {
  const body = Buffer.from(JSON.stringify({ protocolVersion: 1, ...input }));
  if (body.byteLength > PROJECT_SHARE_ADAPTER_MAX_HEAD_BYTES) {
    throw new Error("Project share response headers exceed the tunnel limit.");
  }
  const output = Buffer.allocUnsafe(4 + body.byteLength);
  output.writeUInt32BE(body.byteLength, 0);
  body.copy(output, 4);
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

export class StreamingByteRewriter {
  readonly #replacement: Buffer;
  readonly #source: Buffer;
  #carry: Buffer = Buffer.alloc(0);

  constructor(source: string, replacement: string) {
    this.#source = Buffer.from(source);
    this.#replacement = Buffer.from(replacement);
  }

  write(chunk: Uint8Array): Buffer {
    return this.#rewrite(
      Buffer.concat([this.#carry, Buffer.from(chunk)]),
      false,
    );
  }

  end(): Buffer {
    return this.#rewrite(this.#carry, true);
  }

  #rewrite(input: Buffer, final: boolean): Buffer {
    const safeLimit = final
      ? input.byteLength
      : Math.max(0, input.byteLength - this.#source.byteLength + 1);
    const output: Buffer[] = [];
    let cursor = 0;
    while (cursor < input.byteLength) {
      const match = input.indexOf(this.#source, cursor);
      if (match < 0 || (!final && match >= safeLimit)) break;
      output.push(input.subarray(cursor, match), this.#replacement);
      cursor = match + this.#source.byteLength;
    }
    const consumed = final ? input.byteLength : Math.max(safeLimit, cursor);
    output.push(input.subarray(cursor, consumed));
    this.#carry = final ? Buffer.alloc(0) : input.subarray(consumed);
    return Buffer.concat(output);
  }
}

export class ProjectShareTunnelDestinationAdapter {
  readonly #streams = new Map<string, ProjectShareStream>();
  #emit: FrameEmitter = () => false;
  #waitForCapacity: CapacityWaiter = async () => true;

  constructor(private readonly shares: ProjectShareManager) {}

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
    const stream = this.#streams.get(key(header));
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
      this.#consumeRequest(stream, Buffer.from(payload));
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
      if (stream.request) stream.request.end();
      else this.#closeStream(stream, "protocol-error");
      return;
    }
    if (header.kind === "close" || header.kind === "error") {
      this.#remove(stream);
      stream.response?.destroy();
      stream.request?.destroy();
    }
  }

  closeShare(shareId: string): void {
    for (const stream of [...this.#streams.values()]) {
      if (stream.share.shareId === shareId)
        this.#closeStream(stream, "revoked");
    }
  }

  disconnect(): void {
    for (const stream of [...this.#streams.values()]) {
      this.#remove(stream);
      stream.response?.destroy();
      stream.request?.destroy();
    }
  }

  close(): void {
    this.disconnect();
  }

  #connect(
    header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>,
  ): void {
    if (
      header.target.kind !== "adapter" ||
      header.target.adapter !== "project-share"
    ) {
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
        "Project share stream limit reached.",
      );
      return;
    }
    const share = this.shares.get(header.target.resourceId);
    if (!share) {
      this.#reject(header, "target-unavailable", "Project share is not open.");
      return;
    }
    const stream: ProjectShareStream = {
      destinationToSourceCredit: header.initialCreditBytes,
      flushing: false,
      headBytes: Buffer.alloc(0),
      headLength: null,
      header,
      inputSequence: 1,
      outputSequence: 0,
      outputWaiters: new Set(),
      pendingBytes: 0,
      pendingOutput: [],
      request: null,
      response: null,
      share,
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

  #consumeRequest(stream: ProjectShareStream, payload: Buffer): void {
    if (!stream.request) {
      stream.headBytes = Buffer.concat([stream.headBytes, payload]);
      if (stream.headLength === null && stream.headBytes.byteLength >= 4) {
        stream.headLength = stream.headBytes.readUInt32BE(0);
        if (
          stream.headLength < 1 ||
          stream.headLength > PROJECT_SHARE_ADAPTER_MAX_HEAD_BYTES
        ) {
          this.#closeStream(stream, "protocol-error");
          return;
        }
      }
      if (
        stream.headLength === null ||
        stream.headBytes.byteLength < 4 + stream.headLength
      )
        return;
      const consumed = 4 + stream.headLength;
      let head: ProjectShareAdapterRequestHead;
      try {
        head = projectShareAdapterRequestHeadSchema.parse(
          JSON.parse(stream.headBytes.subarray(4, consumed).toString("utf8")),
        );
        this.#openRequest(stream, head);
      } catch {
        this.#closeStream(stream, "protocol-error");
        return;
      }
      const body = stream.headBytes.subarray(consumed);
      stream.headBytes = Buffer.alloc(0);
      this.#grantRequestCredit(stream, consumed);
      if (body.byteLength > 0) this.#writeRequest(stream, body);
      return;
    }
    this.#writeRequest(stream, payload);
  }

  #openRequest(
    stream: ProjectShareStream,
    head: ProjectShareAdapterRequestHead,
  ): void {
    const target = targetUrl(stream.share, head.path);
    const request = requestHttp(
      target,
      {
        method: head.method,
        headers: requestHeaders(head.headers, target, stream.share),
      },
      (response) => void this.#pipeResponse(stream, response),
    );
    stream.request = request;
    request.once("error", () => {
      if (this.#streams.has(key(stream.header))) {
        this.#closeStream(stream, "protocol-error");
      }
    });
  }

  #writeRequest(stream: ProjectShareStream, payload: Buffer): void {
    const request = stream.request;
    if (
      !request ||
      stream.sourceHalfClosed ||
      request.writableLength + payload.byteLength > MAX_LOCAL_BUFFER_BYTES
    ) {
      this.#closeStream(stream, "congested");
      return;
    }
    request.write(payload, () =>
      this.#grantRequestCredit(stream, payload.byteLength),
    );
  }

  async #pipeResponse(
    stream: ProjectShareStream,
    response: IncomingMessage,
  ): Promise<void> {
    if (!this.#streams.has(key(stream.header))) {
      response.destroy();
      return;
    }
    stream.response = response;
    const rewritingOrigin = responseNeedsOriginRewrite(response, stream.share);
    try {
      this.#queueOutput(
        stream,
        encodeResponseHead({
          statusCode: response.statusCode ?? 502,
          headers: responseHeaders(response, stream.share, rewritingOrigin),
        }),
      );
      await this.#drainOutput(stream);
      const publicHost = new URL(stream.share.publicOrigin).host;
      const rewriter = rewritingOrigin
        ? new StreamingByteRewriter(
            `http://${publicHost}`,
            stream.share.publicOrigin,
          )
        : null;
      for await (const rawChunk of response) {
        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk as Uint8Array);
        this.#queueOutput(stream, rewriter?.write(chunk) ?? chunk);
        await this.#drainOutput(stream);
        if (!this.#streams.has(key(stream.header))) return;
      }
      this.#queueOutput(stream, rewriter?.end() ?? EMPTY_PAYLOAD);
      await this.#drainOutput(stream);
      if (!this.#streams.has(key(stream.header))) return;
      this.#emit(
        {
          ...responseBase(stream),
          kind: "half-close",
          direction: "destination-to-source",
        },
        EMPTY_PAYLOAD,
      );
    } catch {
      this.#closeStream(stream, "congested");
    }
  }

  #queueOutput(stream: ProjectShareStream, payload: Uint8Array): void {
    for (const part of parts(payload)) {
      stream.pendingOutput.push(part);
      stream.pendingBytes += part.byteLength;
    }
    if (stream.pendingBytes > MAX_LOCAL_BUFFER_BYTES) {
      this.#closeStream(stream, "congested");
    }
  }

  async #flushOutput(stream: ProjectShareStream): Promise<void> {
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
          !(await this.#waitForCapacity())
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
      ) {
        this.#wakeOutput(stream);
      }
    }
  }

  async #drainOutput(stream: ProjectShareStream): Promise<void> {
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

  #wakeOutput(stream: ProjectShareStream): void {
    for (const resolve of stream.outputWaiters) resolve();
    stream.outputWaiters.clear();
  }

  #grantRequestCredit(stream: ProjectShareStream, bytes: number): void {
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
    stream: ProjectShareStream,
    code: Extract<TunnelDataPlaneFrameHeader, { kind: "close" }>["code"],
  ): void {
    if (!this.#remove(stream)) return;
    this.#emit(
      { ...responseBase(stream), kind: "close", code, message: null },
      EMPTY_PAYLOAD,
    );
    stream.response?.destroy();
    stream.request?.destroy();
  }

  #remove(stream: ProjectShareStream): boolean {
    const streamKey = key(stream.header);
    if (this.#streams.get(streamKey) !== stream) return false;
    this.#streams.delete(streamKey);
    this.#wakeOutput(stream);
    return true;
  }
}
