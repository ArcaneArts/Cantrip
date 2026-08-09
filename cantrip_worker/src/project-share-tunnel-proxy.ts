import {
  request as requestHttp,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";

import {
  PROJECT_SHARE_TUNNEL_MAX_PAYLOAD_BYTES,
  type ProjectShareTunnelFrameHeader,
  type WorkerProjectShareOpenResult,
} from "@cantrip/protocol";

import type { ProjectShareManager } from "./project-share-manager.js";

type FrameEmitter = (
  header: ProjectShareTunnelFrameHeader,
  payload: Uint8Array,
) => boolean;
type CapacityWaiter = () => Promise<boolean>;

interface ProjectShareHttpStream {
  request: ClientRequest;
  response: IncomingMessage | null;
  responsePaused: boolean;
  resumeWaiters: Set<() => void>;
  share: WorkerProjectShareOpenResult;
}

const EMPTY_PAYLOAD = new Uint8Array();
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

function streamKey(header: ProjectShareTunnelFrameHeader): string {
  return `${header.shareId}\0${header.streamId}`;
}

function payloadParts(payload: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < payload.byteLength;
    offset += PROJECT_SHARE_TUNNEL_MAX_PAYLOAD_BYTES
  ) {
    parts.push(
      payload.subarray(offset, offset + PROJECT_SHARE_TUNNEL_MAX_PAYLOAD_BYTES),
    );
  }
  return parts;
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
    ) {
      continue;
    }
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
          location.hostname === share.loopbackHost &&
          location.port === String(share.loopbackPort)
        ) {
          headers.push([
            name,
            `${share.publicOrigin}${location.pathname}${location.search}${location.hash}`,
          ]);
        } else if (
          location.host === publicOrigin.host &&
          location.protocol === "http:"
        ) {
          headers.push([
            name,
            `${share.publicOrigin}${location.pathname}${location.search}${location.hash}`,
          ]);
        }
      } catch {
        // Invalid or non-public absolute locations never leave the worker.
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

export class ProjectShareTunnelProxy {
  readonly #streams = new Map<string, ProjectShareHttpStream>();
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

  async handleFrame(
    header: ProjectShareTunnelFrameHeader,
    payload: Uint8Array,
  ): Promise<void> {
    switch (header.kind) {
      case "http-request-start":
        this.#open(header);
        return;
      case "http-request-data": {
        const stream = this.#streams.get(streamKey(header));
        if (!stream) return;
        if (
          stream.request.writableLength + payload.byteLength >
          MAX_LOCAL_BUFFER_BYTES
        ) {
          stream.request.destroy(
            new Error("Project share request exceeded its buffer limit."),
          );
          return;
        }
        stream.request.write(payload);
        return;
      }
      case "http-request-end": {
        this.#streams.get(streamKey(header))?.request.end();
        return;
      }
      case "http-response-pause": {
        const stream = this.#streams.get(streamKey(header));
        if (stream) {
          stream.responsePaused = true;
          stream.response?.pause();
        }
        return;
      }
      case "http-response-resume": {
        const stream = this.#streams.get(streamKey(header));
        if (stream) {
          stream.responsePaused = false;
          stream.response?.resume();
          for (const resume of stream.resumeWaiters) resume();
          stream.resumeWaiters.clear();
        }
        return;
      }
      case "cancel":
        this.#cancel(streamKey(header), header.reason);
        return;
      default:
        return;
    }
  }

  closeShare(shareId: string): void {
    for (const [key, stream] of this.#streams) {
      if (stream.share.shareId === shareId) {
        this.#cancel(key, "Project share was closed.");
      }
    }
  }

  close(): void {
    for (const key of [...this.#streams.keys()]) {
      this.#cancel(key, "Worker is stopping.");
    }
  }

  #open(
    header: Extract<
      ProjectShareTunnelFrameHeader,
      { kind: "http-request-start" }
    >,
  ): void {
    const key = streamKey(header);
    if (this.#streams.has(key)) {
      this.#error(header, "Project share tunnel stream already exists.");
      return;
    }
    try {
      const share = this.shares.get(header.shareId);
      if (!share) throw new Error("Project share is not open on this worker.");
      const target = targetUrl(share, header.path);
      const request = requestHttp(
        target,
        {
          method: header.method,
          headers: requestHeaders(header.headers, target, share),
        },
        (response) => void this.#pipeResponse(header, response),
      );
      this.#streams.set(key, {
        request,
        response: null,
        responsePaused: false,
        resumeWaiters: new Set(),
        share,
      });
      request.once("error", (error) => {
        if (this.#remove(key)) this.#error(header, error.message);
      });
    } catch (error) {
      this.#error(
        header,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async #pipeResponse(
    requestHeader: Extract<
      ProjectShareTunnelFrameHeader,
      { kind: "http-request-start" }
    >,
    response: IncomingMessage,
  ): Promise<void> {
    const key = streamKey(requestHeader);
    const stream = this.#streams.get(key);
    if (!stream) {
      response.destroy();
      return;
    }
    stream.response = response;
    const rewritingOrigin = responseNeedsOriginRewrite(response, stream.share);
    if (
      !this.#emit(
        {
          protocolVersion: 1,
          shareId: requestHeader.shareId,
          streamId: requestHeader.streamId,
          kind: "http-response-start",
          statusCode: response.statusCode ?? 502,
          headers: responseHeaders(response, stream.share, rewritingOrigin),
        },
        EMPTY_PAYLOAD,
      )
    ) {
      response.destroy();
      this.#remove(key);
      return;
    }
    try {
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
        const rewritten = rewriter?.write(chunk) ?? chunk;
        for (const part of payloadParts(rewritten)) {
          if (!(await this.#awaitFlow(key, stream))) {
            response.destroy(
              new Error("Project share command tunnel disconnected."),
            );
            if (this.#remove(key)) {
              this.#error(
                requestHeader,
                "Project share command tunnel disconnected.",
              );
            }
            return;
          }
          if (
            !this.#emit(
              {
                protocolVersion: 1,
                shareId: requestHeader.shareId,
                streamId: requestHeader.streamId,
                kind: "http-response-data",
              },
              part,
            )
          ) {
            response.destroy(new Error("Project share tunnel is congested."));
            if (this.#remove(key)) {
              this.#error(requestHeader, "Project share tunnel is congested.");
            }
            return;
          }
        }
      }
      for (const part of payloadParts(rewriter?.end() ?? EMPTY_PAYLOAD)) {
        if (part.byteLength === 0) continue;
        if (!(await this.#awaitFlow(key, stream))) {
          if (this.#remove(key)) {
            this.#error(
              requestHeader,
              "Project share command tunnel disconnected.",
            );
          }
          return;
        }
        if (
          !this.#emit(
            {
              protocolVersion: 1,
              shareId: requestHeader.shareId,
              streamId: requestHeader.streamId,
              kind: "http-response-data",
            },
            part,
          )
        ) {
          response.destroy(new Error("Project share tunnel is congested."));
          if (this.#remove(key)) {
            this.#error(requestHeader, "Project share tunnel is congested.");
          }
          return;
        }
      }
      if (!this.#remove(key)) return;
      this.#emit(
        {
          protocolVersion: 1,
          shareId: requestHeader.shareId,
          streamId: requestHeader.streamId,
          kind: "http-response-end",
        },
        EMPTY_PAYLOAD,
      );
    } catch (error) {
      if (this.#remove(key)) {
        this.#error(
          requestHeader,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async #awaitFlow(
    key: string,
    stream: ProjectShareHttpStream,
  ): Promise<boolean> {
    while (stream.responsePaused) {
      await new Promise<void>((resolve) => stream.resumeWaiters.add(resolve));
      if (this.#streams.get(key) !== stream) return false;
    }
    if (!(await this.#waitForCapacity())) return false;
    return this.#streams.get(key) === stream && !stream.responsePaused;
  }

  #cancel(key: string, reason: string): void {
    const stream = this.#remove(key);
    if (!stream) return;
    const error = new Error(reason);
    stream.response?.destroy(error);
    stream.request.destroy(error);
  }

  #remove(key: string): ProjectShareHttpStream | null {
    const stream = this.#streams.get(key);
    if (!stream) return null;
    this.#streams.delete(key);
    for (const resume of stream.resumeWaiters) resume();
    stream.resumeWaiters.clear();
    return stream;
  }

  #error(header: ProjectShareTunnelFrameHeader, message: string): void {
    this.#emit(
      {
        protocolVersion: 1,
        shareId: header.shareId,
        streamId: header.streamId,
        kind: "error",
        message: message.slice(0, 4_000) || "Project share tunnel failed.",
      },
      EMPTY_PAYLOAD,
    );
  }
}
