import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES,
  type CodeAttachment,
  type CodeProtectedAttachmentWire,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import type { TunnelDataProtectionConfiguration } from "@cantrip/protocol/tunnel-content";

import {
  createTunnelAttachment,
  deleteTunnelAttachment,
  getTunnelDataProtection,
} from "@/lib/api";
import { getActiveServerUrl } from "@/lib/server-connections";

const INITIAL_CREDIT_BYTES = 256 * 1_024;
const MAX_HTTP_RESPONSE_BYTES = 64 * 1_024 * 1_024;
const HTTP_CHANNEL = "cantrip-code-http-v1";
const SERVICE_WORKER_PATH = "/cantrip-code-service-worker.js";
const SOCKET_EVENT = "cantrip-code-websocket-event-v1";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

interface ReadyMessage {
  type: "ready";
  attachmentId: string;
  tunnelId: string;
  sourceEndpointId: string;
  destinationEndpointId: string;
  expiresAt: string;
}

interface HttpProxyRequest {
  adapterId: string;
  body: ArrayBuffer | null;
  headers: Array<[string, string]>;
  method: string;
  requestId: string;
  type: "cantrip-code-http-request-v1";
  url: string;
}

interface SocketRequest {
  adapterId: string;
  socketId: string;
  type:
    | "cantrip-code-websocket-close-v1"
    | "cantrip-code-websocket-open-v1"
    | "cantrip-code-websocket-send-v1";
  url?: string;
  protocols?: string[];
  data?: string | ArrayBuffer;
  binary?: boolean;
  code?: number;
  reason?: string;
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function frameAad(
  header: Extract<TunnelDataPlaneFrameHeader, { kind: "data" }>,
  protection: NonNullable<
    Extract<TunnelDataPlaneFrameHeader, { kind: "data" }>["protection"]
  >,
): Uint8Array {
  return textEncoder.encode(
    JSON.stringify([
      header.protocolVersion,
      header.tunnelId,
      header.attachmentId,
      header.sourceEndpointId,
      header.destinationEndpointId,
      header.connectionId,
      header.sequence,
      "data",
      header.direction,
      protection.formatVersion,
      protection.algorithm,
      protection.keyRevision,
      protection.nonce,
    ]),
  );
}

class BrowserTunnelConnection {
  readonly #chunks: Uint8Array[] = [];
  readonly #closed: Promise<void>;
  readonly #accepted: Promise<void>;
  #accept!: () => void;
  #acceptReject!: (error: Error) => void;
  #close!: () => void;
  #closeReject!: (error: Error) => void;
  #destinationSequence = 0;
  #failure: Error | null = null;
  #listener: ((chunk: Uint8Array) => void) | null = null;
  #queued = Promise.resolve();
  #sourceCredit = 0;
  #sourceSequence = 1;
  #waiters: Array<() => void> = [];

  constructor(
    readonly id: string,
    private readonly tunnel: BrowserTunnelClient,
  ) {
    this.#accepted = new Promise<void>((resolve, reject) => {
      this.#accept = resolve;
      this.#acceptReject = reject;
    });
    this.#closed = new Promise<void>((resolve, reject) => {
      this.#close = resolve;
      this.#closeReject = reject;
    });
  }

  async ready(): Promise<void> {
    return this.#accepted;
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.#listener = listener;
    for (const chunk of this.#chunks.splice(0)) listener(chunk);
  }

  async send(payload: Uint8Array): Promise<void> {
    this.#queued = this.#queued.then(async () => {
      for (
        let offset = 0;
        offset < payload.byteLength;
        offset += TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES
      ) {
        const chunk = payload.subarray(
          offset,
          offset + TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES,
        );
        await this.#takeCredit(chunk.byteLength);
        await this.tunnel.sendData(this.id, this.#sourceSequence++, chunk);
      }
    });
    return this.#queued;
  }

  halfClose(): void {
    this.#queued = this.#queued.then(() => {
      this.tunnel.sendControl({
        ...this.tunnel.identities(this.id, this.#sourceSequence++),
        kind: "half-close",
        direction: "source-to-destination",
      });
    });
  }

  close(): void {
    this.#queued = this.#queued.then(() => {
      this.tunnel.sendControl({
        ...this.tunnel.identities(this.id, this.#sourceSequence++),
        kind: "close",
        code: "normal",
      });
    });
  }

  async waitClosed(): Promise<void> {
    return this.#closed;
  }

  receive(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): void {
    if (header.sequence !== this.#destinationSequence++) {
      this.fail(new Error("Protected Code tunnel frame sequence is invalid."));
      return;
    }
    if (header.kind === "accepted") {
      this.#sourceCredit = header.initialCreditBytes;
      this.#accept();
      this.#wakeCredit();
      return;
    }
    if (header.kind === "rejected") {
      this.fail(new Error("The worker rejected the protected Code route."));
      return;
    }
    if (
      header.kind === "credit" &&
      header.direction === "source-to-destination"
    ) {
      this.#sourceCredit += header.bytes;
      this.#wakeCredit();
      return;
    }
    if (
      header.kind === "data" &&
      header.direction === "destination-to-source"
    ) {
      const copy = Uint8Array.from(payload);
      if (this.#listener) this.#listener(copy);
      else this.#chunks.push(copy);
      this.#queued = this.#queued.then(() => {
        this.tunnel.sendControl({
          ...this.tunnel.identities(this.id, this.#sourceSequence++),
          kind: "credit",
          direction: "destination-to-source",
          bytes: payload.byteLength,
        });
      });
      return;
    }
    if (
      (header.kind === "half-close" &&
        header.direction === "destination-to-source") ||
      header.kind === "close"
    ) {
      this.#close();
      return;
    }
    if (header.kind === "error") {
      this.fail(new Error("The protected Code stream failed."));
    }
  }

  fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#acceptReject(error);
    this.#closeReject(error);
    this.#wakeCredit();
  }

  async #takeCredit(bytes: number): Promise<void> {
    while (this.#sourceCredit < bytes) {
      if (this.#failure) throw this.#failure;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    if (this.#failure) throw this.#failure;
    this.#sourceCredit -= bytes;
  }

  #wakeCredit(): void {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}

class BrowserTunnelClient {
  readonly #connections = new Map<string, BrowserTunnelConnection>();
  readonly #key: Promise<CryptoKey>;
  readonly #socket: WebSocket;
  readonly #ready: Promise<ReadyMessage>;
  readonly #terminalListeners = new Set<(error: Error) => void>();
  #readyResolve!: (ready: ReadyMessage) => void;
  #readyReject!: (error: Error) => void;
  #closing = false;
  #identities: ReadyMessage | null = null;
  #receiveQueue = Promise.resolve();
  #terminalError: Error | null = null;

  private constructor(
    readonly attachmentId: string,
    readonly tunnelId: string,
    socket: WebSocket,
    private readonly protection: TunnelDataProtectionConfiguration,
  ) {
    this.#socket = socket;
    this.#key = crypto.subtle.importKey(
      "raw",
      toArrayBuffer(decodeBase64Url(protection.key)),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    this.#ready = new Promise<ReadyMessage>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    socket.addEventListener("message", (event) => this.#message(event));
    socket.addEventListener("close", () =>
      this.#fail(new Error("The protected Code relay disconnected.")),
    );
    socket.addEventListener("error", () =>
      this.#fail(new Error("The protected Code relay failed.")),
    );
  }

  static async open(tunnelId: string): Promise<BrowserTunnelClient> {
    const clientId = `web-code:${crypto.randomUUID()}`;
    const protection = await getTunnelDataProtection(tunnelId);
    const attachment = await createTunnelAttachment(tunnelId, { clientId });
    let socket: WebSocket | null = null;
    try {
      const base = getActiveServerUrl() || window.location.origin;
      const url = new URL(attachment.connectPath, base);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url, `cantrip-tunnel-v1.${attachment.secret}`);
      attachment.secret = "";
      const client = new BrowserTunnelClient(
        attachment.attachmentId,
        tunnelId,
        socket,
        protection,
      );
      await new Promise<void>((resolve, reject) => {
        socket!.addEventListener("open", () => resolve(), { once: true });
        socket!.addEventListener(
          "error",
          () =>
            reject(new Error("Could not connect to the protected Code relay.")),
          { once: true },
        );
      });
      socket.send(JSON.stringify({ type: "initialize", clientId }));
      await client.#ready;
      return client;
    } catch (error) {
      socket?.close();
      await deleteTunnelAttachment(attachment.attachmentId).catch(
        () => undefined,
      );
      throw error;
    }
  }

  identities(connectionId: string, sequence: number) {
    if (!this.#identities)
      throw new Error("Protected Code tunnel is not ready.");
    return {
      protocolVersion: 1 as const,
      tunnelId: this.tunnelId,
      attachmentId: this.attachmentId,
      sourceEndpointId: this.#identities.sourceEndpointId,
      destinationEndpointId: this.#identities.destinationEndpointId,
      connectionId,
      sequence,
    };
  }

  get healthy(): boolean {
    return !this.#closing && this.#terminalError === null;
  }

  onTerminal(listener: (error: Error) => void): () => void {
    if (this.#terminalError) {
      listener(this.#terminalError);
      return () => undefined;
    }
    if (this.#closing) return () => undefined;
    this.#terminalListeners.add(listener);
    return () => this.#terminalListeners.delete(listener);
  }

  async openConnection(): Promise<BrowserTunnelConnection> {
    await this.#ready;
    if (!this.healthy) {
      throw (
        this.#terminalError ??
        new Error("The protected Code relay is no longer available.")
      );
    }
    const connection = new BrowserTunnelConnection(crypto.randomUUID(), this);
    this.#connections.set(connection.id, connection);
    this.sendControl({
      ...this.identities(connection.id, 0),
      kind: "open",
      initialCreditBytes: INITIAL_CREDIT_BYTES,
    });
    try {
      await connection.ready();
      return connection;
    } catch (error) {
      this.#connections.delete(connection.id);
      throw error;
    }
  }

  sendControl(header: TunnelDataPlaneFrameHeader): void {
    this.#socket.send(
      toArrayBuffer(encodeTunnelDataPlaneFrame(header, new Uint8Array())),
    );
  }

  async sendData(
    connectionId: string,
    sequence: number,
    payload: Uint8Array,
  ): Promise<void> {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const protection = {
      formatVersion: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: this.protection.keyRevision,
      nonce: encodeBase64Url(nonce),
    };
    const header = {
      ...this.identities(connectionId, sequence),
      kind: "data" as const,
      direction: "source-to-destination" as const,
      protection,
    };
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(frameAad(header, protection)),
      },
      await this.#key,
      toArrayBuffer(payload),
    );
    this.#socket.send(
      toArrayBuffer(
        encodeTunnelDataPlaneFrame(header, new Uint8Array(ciphertext)),
      ),
    );
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#terminalListeners.clear();
    for (const connection of this.#connections.values()) connection.close();
    this.#connections.clear();
    this.#socket.close(1000, "Code attachment closed");
    await deleteTunnelAttachment(this.attachmentId).catch(() => undefined);
  }

  #message(event: MessageEvent): void {
    if (typeof event.data === "string") {
      try {
        const ready = JSON.parse(event.data) as ReadyMessage;
        if (
          ready.type !== "ready" ||
          ready.attachmentId !== this.attachmentId ||
          ready.tunnelId !== this.tunnelId
        ) {
          throw new Error("Protected Code relay identity did not match.");
        }
        this.#identities = ready;
        this.#readyResolve(ready);
      } catch (error) {
        this.#readyReject(
          error instanceof Error
            ? error
            : new Error("Protected Code relay initialization failed."),
        );
      }
      return;
    }
    this.#receiveQueue = this.#receiveQueue
      .then(async () => {
        const bytes =
          event.data instanceof Blob
            ? new Uint8Array(await event.data.arrayBuffer())
            : new Uint8Array(event.data as ArrayBuffer);
        const frame = decodeTunnelDataPlaneFrame(bytes);
        let payload = frame.payload;
        if (frame.header.kind === "data") {
          if (!frame.header.protection) {
            throw new Error("Protected Code relay returned plaintext data.");
          }
          const nonce = decodeBase64Url(frame.header.protection.nonce);
          payload = new Uint8Array(
            await crypto.subtle.decrypt(
              {
                name: "AES-GCM",
                iv: toArrayBuffer(nonce),
                additionalData: toArrayBuffer(
                  frameAad(frame.header, frame.header.protection),
                ),
              },
              await this.#key,
              toArrayBuffer(payload),
            ),
          );
        }
        const connection = this.#connections.get(frame.header.connectionId);
        if (!connection) return;
        connection.receive(frame.header, payload);
        if (frame.header.kind === "close" || frame.header.kind === "error") {
          this.#connections.delete(frame.header.connectionId);
        }
      })
      .catch((error) =>
        this.#fail(
          error instanceof Error
            ? error
            : new Error("Protected Code frame failed."),
        ),
      );
  }

  #fail(error: Error): void {
    if (this.#closing || this.#terminalError) return;
    this.#terminalError = error;
    this.#readyReject(error);
    for (const connection of this.#connections.values()) connection.fail(error);
    this.#connections.clear();
    for (const listener of this.#terminalListeners) {
      try {
        listener(error);
      } catch {
        // A recovery observer must not prevent the terminal state from settling.
      }
    }
    this.#terminalListeners.clear();
  }
}

function virtualCodePath(url: URL, adapterId: string): string {
  const prefix = `/__cantrip_code/${adapterId}`;
  if (
    url.origin !== window.location.origin ||
    !url.pathname.startsWith(`${prefix}/code`)
  ) {
    throw new Error("Protected Code request escaped its browser adapter.");
  }
  return url.pathname.slice(prefix.length) + url.search;
}

function serializeHttpRequest(request: HttpProxyRequest): Uint8Array {
  const url = new URL(request.url);
  const path = virtualCodePath(url, request.adapterId);
  const blocked = new Set([
    "authorization",
    "connection",
    "content-length",
    "cookie",
    "host",
    "proxy-authorization",
    "transfer-encoding",
  ]);
  const headers = request.headers.filter(
    ([name]) => !blocked.has(name.toLowerCase()),
  );
  headers.push(
    ["Host", "cantrip-code.local"],
    ["Connection", "close"],
    ["Accept-Encoding", "identity"],
    ["X-Cantrip-Code-Base-Path", `/__cantrip_code/${request.adapterId}/code`],
  );
  const body = request.body ? new Uint8Array(request.body) : new Uint8Array();
  if (body.byteLength > 0)
    headers.push(["Content-Length", String(body.byteLength)]);
  const head = textEncoder.encode(
    `${request.method} ${path} HTTP/1.1\r\n${headers
      .map(([name, value]) => `${name}: ${value.replace(/[\r\n]/gu, " ")}`)
      .join("\r\n")}\r\n\r\n`,
  );
  const output = new Uint8Array(head.byteLength + body.byteLength);
  output.set(head);
  output.set(body, head.byteLength);
  return output;
}

function dechunk(body: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  while (offset < body.byteLength) {
    const lineEnd = findBytes(body, textEncoder.encode("\r\n"), offset);
    if (lineEnd < 0)
      throw new Error("Protected Code returned invalid chunked HTTP.");
    const sizeText = textDecoder
      .decode(body.subarray(offset, lineEnd))
      .split(";", 1)[0]!;
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0)
      throw new Error("Protected Code returned an invalid chunk size.");
    offset = lineEnd + 2;
    if (size === 0) break;
    if (offset + size + 2 > body.byteLength)
      throw new Error("Protected Code returned a truncated chunk.");
    const chunk = body.subarray(offset, offset + size);
    chunks.push(chunk);
    total += chunk.byteLength;
    offset += size + 2;
  }
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return output;
}

function findBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  start = 0,
): number {
  outer: for (
    let offset = start;
    offset <= haystack.byteLength - needle.byteLength;
    offset += 1
  ) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function parseHttpResponse(bytes: Uint8Array) {
  const separator = textEncoder.encode("\r\n\r\n");
  const headEnd = findBytes(bytes, separator);
  if (headEnd < 0)
    throw new Error("Protected Code returned an invalid HTTP response.");
  const lines = textDecoder.decode(bytes.subarray(0, headEnd)).split("\r\n");
  const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/u.exec(
    lines.shift() ?? "",
  );
  if (!statusMatch)
    throw new Error("Protected Code returned an invalid HTTP status.");
  const headers: Array<[string, string]> = [];
  for (const line of lines) {
    const split = line.indexOf(":");
    if (split <= 0) continue;
    headers.push([line.slice(0, split).trim(), line.slice(split + 1).trim()]);
  }
  const chunked = headers.some(
    ([name, value]) =>
      name.toLowerCase() === "transfer-encoding" && /chunked/iu.test(value),
  );
  const rawBody = bytes.subarray(headEnd + separator.byteLength);
  return {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] ?? "",
    headers: headers.filter(
      ([name]) =>
        !["connection", "transfer-encoding"].includes(name.toLowerCase()),
    ),
    body: Uint8Array.from(chunked ? dechunk(rawBody) : rawBody).buffer,
  };
}

export async function proxyBrowserCodeHttp(
  tunnel: BrowserTunnelClient,
  request: HttpProxyRequest,
) {
  const connection = await tunnel.openConnection();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  connection.onData((chunk) => {
    bytes += chunk.byteLength;
    if (bytes > MAX_HTTP_RESPONSE_BYTES) {
      connection.close();
      return;
    }
    chunks.push(chunk);
  });
  await connection.send(serializeHttpRequest(request));
  // The HTTP message is self-delimiting and requests connection closure after
  // the response. Half-closing here makes Node treat the relay as a departed
  // client and abort the worker's OpenVSCode upstream request before it can
  // answer.
  await connection.waitClosed();
  if (bytes > MAX_HTTP_RESPONSE_BYTES)
    throw new Error("Protected Code response is too large.");
  const response = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    response.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseHttpResponse(response);
}

function websocketFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const lengthBytes =
    payload.byteLength < 126 ? 0 : payload.byteLength <= 0xffff ? 2 : 8;
  const frame = new Uint8Array(2 + lengthBytes + 4 + payload.byteLength);
  frame[0] = 0x80 | opcode;
  frame[1] =
    0x80 |
    (lengthBytes === 0 ? payload.byteLength : lengthBytes === 2 ? 126 : 127);
  let offset = 2;
  if (lengthBytes === 2) {
    new DataView(frame.buffer).setUint16(offset, payload.byteLength, false);
    offset += 2;
  } else if (lengthBytes === 8) {
    new DataView(frame.buffer).setBigUint64(
      offset,
      BigInt(payload.byteLength),
      false,
    );
    offset += 8;
  }
  frame.set(mask, offset);
  offset += 4;
  for (let index = 0; index < payload.byteLength; index += 1)
    frame[offset + index] = payload[index]! ^ mask[index % 4]!;
  return frame;
}

class BrowserCodeSocket {
  readonly #connection: BrowserTunnelConnection;
  #buffer = new Uint8Array();
  #fragmentOpcode = 0;
  #fragments: Uint8Array[] = [];
  #handshake = false;
  #closed = false;

  private constructor(
    private readonly adapterId: string,
    private readonly socketId: string,
    private readonly target: WindowProxy,
    connection: BrowserTunnelConnection,
  ) {
    this.#connection = connection;
    connection.onData((chunk) => void this.#data(chunk));
    void connection.waitClosed().then(
      () => this.#closedFromTunnel(),
      (error) => this.#closedFromTunnel(error),
    );
  }

  static async open(
    tunnel: BrowserTunnelClient,
    request: SocketRequest,
    target: WindowProxy,
  ): Promise<BrowserCodeSocket> {
    const connection = await tunnel.openConnection();
    const socket = new BrowserCodeSocket(
      request.adapterId,
      request.socketId,
      target,
      connection,
    );
    const url = new URL(request.url!);
    const path = virtualCodePath(url, request.adapterId);
    const keyBytes = crypto.getRandomValues(new Uint8Array(16));
    let keyBinary = "";
    for (const byte of keyBytes) keyBinary += String.fromCharCode(byte);
    const key = btoa(keyBinary);
    const protocols = request.protocols ?? [];
    const handshake = textEncoder.encode(
      `GET ${path} HTTP/1.1\r\nHost: cantrip-code.local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${window.location.origin}\r\nX-Cantrip-Code-Base-Path: /__cantrip_code/${request.adapterId}/code\r\n${protocols.length ? `Sec-WebSocket-Protocol: ${protocols.join(", ")}\r\n` : ""}\r\n`,
    );
    await connection.send(handshake);
    await socket.#waitHandshake(key);
    return socket;
  }

  async send(data: string | ArrayBuffer, binary: boolean): Promise<void> {
    const payload =
      typeof data === "string"
        ? textEncoder.encode(data)
        : new Uint8Array(data);
    await this.#connection.send(websocketFrame(binary ? 2 : 1, payload));
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const reasonBytes = textEncoder.encode(reason).subarray(0, 123);
    const payload = new Uint8Array(2 + reasonBytes.byteLength);
    new DataView(payload.buffer).setUint16(0, code, false);
    payload.set(reasonBytes, 2);
    await this.#connection.send(websocketFrame(8, payload));
    this.#connection.halfClose();
  }

  async #waitHandshake(key: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!this.#handshake) {
      if (Date.now() >= deadline)
        throw new Error("Protected Code WebSocket handshake timed out.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const expected = encodeBase64(
      await crypto.subtle.digest(
        "SHA-1",
        textEncoder.encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`),
      ),
    );
    const headEnd = findBytes(this.#buffer, textEncoder.encode("\r\n\r\n"));
    const head = textDecoder.decode(this.#buffer.subarray(0, headEnd));
    if (
      !/^HTTP\/1\.[01] 101\b/mu.test(head) ||
      !new RegExp(
        `^Sec-WebSocket-Accept:\\s*${expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`,
        "imu",
      ).test(head)
    ) {
      throw new Error("Protected Code WebSocket handshake was rejected.");
    }
    const protocol =
      /^Sec-WebSocket-Protocol:\s*(.+)\s*$/imu.exec(head)?.[1]?.trim() ?? "";
    this.#buffer = this.#buffer.subarray(headEnd + 4);
    this.#post({ event: "open", protocol });
    this.#frames();
  }

  async #data(chunk: Uint8Array): Promise<void> {
    const next = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    next.set(this.#buffer);
    next.set(chunk, this.#buffer.byteLength);
    this.#buffer = next;
    if (
      !this.#handshake &&
      findBytes(this.#buffer, textEncoder.encode("\r\n\r\n")) >= 0
    )
      this.#handshake = true;
    if (this.#handshake) this.#frames();
  }

  #frames(): void {
    if (
      !this.#handshake ||
      /^HTTP\//u.test(
        textDecoder.decode(
          this.#buffer.subarray(0, Math.min(5, this.#buffer.byteLength)),
        ),
      )
    )
      return;
    while (this.#buffer.byteLength >= 2) {
      const first = this.#buffer[0]!;
      const second = this.#buffer[1]!;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.byteLength < 4) return;
        length = new DataView(
          this.#buffer.buffer,
          this.#buffer.byteOffset,
        ).getUint16(2, false);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.byteLength < 10) return;
        const large = new DataView(
          this.#buffer.buffer,
          this.#buffer.byteOffset,
        ).getBigUint64(2, false);
        if (large > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error("Protected Code WebSocket frame is too large.");
        length = Number(large);
        offset = 10;
      }
      if ((second & 0x80) !== 0)
        throw new Error("Protected Code server sent a masked WebSocket frame.");
      if (this.#buffer.byteLength < offset + length) return;
      const payload = Uint8Array.from(
        this.#buffer.subarray(offset, offset + length),
      );
      this.#buffer = this.#buffer.subarray(offset + length);
      const opcode = first & 0x0f;
      const final = (first & 0x80) !== 0;
      if (opcode === 9) {
        void this.#connection.send(websocketFrame(10, payload));
      } else if (opcode === 8) {
        const code =
          payload.byteLength >= 2
            ? new DataView(payload.buffer).getUint16(0, false)
            : 1000;
        const reason =
          payload.byteLength > 2 ? textDecoder.decode(payload.subarray(2)) : "";
        this.#closed = true;
        this.#post({ event: "close", code, reason, wasClean: true });
        this.#connection.close();
      } else if (opcode === 1 || opcode === 2) {
        this.#fragmentOpcode = opcode;
        this.#fragments = [payload];
        if (final) this.#message();
      } else if (opcode === 0 && this.#fragmentOpcode) {
        this.#fragments.push(payload);
        if (final) this.#message();
      }
    }
  }

  #message(): void {
    const length = this.#fragments.reduce(
      (sum, chunk) => sum + chunk.byteLength,
      0,
    );
    const payload = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.#fragments) {
      payload.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const binary = this.#fragmentOpcode === 2;
    this.#post({
      event: "message",
      binary,
      data: binary ? payload.buffer : textDecoder.decode(payload),
    });
    this.#fragmentOpcode = 0;
    this.#fragments = [];
  }

  #closedFromTunnel(error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    if (error) {
      this.#post({
        event: "error",
        message:
          error instanceof Error
            ? error.message
            : "Protected Code WebSocket failed.",
      });
    }
    this.#post({ event: "close", code: 1006, reason: "", wasClean: false });
  }

  #post(message: Record<string, unknown>): void {
    this.target.postMessage(
      {
        adapterId: this.adapterId,
        socketId: this.socketId,
        type: SOCKET_EVENT,
        ...message,
      },
      { targetOrigin: window.location.origin },
    );
  }
}

function encodeBase64(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class BrowserCodeSession {
  readonly #channel = new BroadcastChannel(HTTP_CHANNEL);
  readonly #sockets = new Map<string, BrowserCodeSocket>();
  #closePromise: Promise<void> | null = null;
  #failure: Error | null = null;
  #healthy = true;
  #removeTerminalListener: (() => void) | null = null;

  private constructor(
    readonly adapterId: string,
    readonly attachment: CodeAttachment,
    private readonly tunnel: BrowserTunnelClient,
  ) {
    this.#channel.addEventListener("message", this.#http);
    window.addEventListener("message", this.#socket);
  }

  static async open(
    wire: CodeProtectedAttachmentWire,
    onTerminal: (session: BrowserCodeSession, error: Error) => void,
  ): Promise<BrowserCodeSession> {
    if (!("serviceWorker" in navigator)) {
      throw new Error("This browser cannot host protected Code attachments.");
    }
    const registration = await navigator.serviceWorker.register(
      SERVICE_WORKER_PATH,
      { scope: "/" },
    );
    await navigator.serviceWorker.ready;
    if (!registration.active)
      throw new Error("Protected Code service worker is unavailable.");
    const adapterId = wire.tunnelId;
    const url = new URL(
      `/__cantrip_code/${adapterId}/code/`,
      window.location.origin,
    );
    if (wire.runtime.workspaceUri) {
      const workspace = new URL(wire.runtime.workspaceUri);
      if (workspace.protocol !== "file:")
        throw new Error("Cantrip Code supplied an invalid workspace URI.");
      url.searchParams.set("workspace", decodeURIComponent(workspace.pathname));
    }
    const tunnel = await BrowserTunnelClient.open(wire.tunnelId);
    try {
      const session = new BrowserCodeSession(
        adapterId,
        {
          attachmentId: wire.attachmentId,
          sessionId: wire.sessionId,
          url: url.toString(),
          expiresAt: wire.expiresAt,
          runtime: wire.runtime,
        },
        tunnel,
      );
      session.#removeTerminalListener = tunnel.onTerminal((error) => {
        session.#terminal(error, onTerminal);
      });
      return session;
    } catch (error) {
      await tunnel.close().catch(() => undefined);
      throw error;
    }
  }

  get healthy(): boolean {
    return this.#healthy && this.tunnel.healthy;
  }

  get failure(): Error | null {
    return this.#failure;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#healthy = false;
    this.#removeTerminalListener?.();
    this.#removeTerminalListener = null;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#channel.removeEventListener("message", this.#http);
    this.#channel.close();
    window.removeEventListener("message", this.#socket);
    for (const socket of this.#sockets.values())
      await socket.close(1001, "Code attachment closed");
    this.#sockets.clear();
    await this.tunnel.close();
  }

  #terminal(
    error: Error,
    onTerminal: (session: BrowserCodeSession, error: Error) => void,
  ): void {
    if (!this.#healthy) return;
    this.#healthy = false;
    this.#failure = error;
    onTerminal(this, error);
    void this.close();
  }

  readonly #http = (event: MessageEvent<HttpProxyRequest>) => {
    const request = event.data;
    if (
      request?.type !== "cantrip-code-http-request-v1" ||
      request.adapterId !== this.adapterId
    )
      return;
    void proxyBrowserCodeHttp(this.tunnel, request)
      .then((response) =>
        this.#channel.postMessage({
          type: "cantrip-code-http-response-v1",
          requestId: request.requestId,
          ...response,
        }),
      )
      .catch((error) =>
        this.#channel.postMessage({
          type: "cantrip-code-http-response-v1",
          requestId: request.requestId,
          error:
            error instanceof Error
              ? error.message
              : "Protected Code request failed.",
        }),
      );
  };

  readonly #socket = (event: MessageEvent<SocketRequest>) => {
    if (event.origin !== window.location.origin) return;
    const request = event.data;
    if (
      !request ||
      request.adapterId !== this.adapterId ||
      !request.type.startsWith("cantrip-code-websocket-")
    )
      return;
    const target = event.source;
    if (!target || !("postMessage" in target)) return;
    if (request.type === "cantrip-code-websocket-open-v1") {
      void BrowserCodeSocket.open(this.tunnel, request, target as WindowProxy)
        .then((socket) => this.#sockets.set(request.socketId, socket))
        .catch((error) => {
          const destination = target as WindowProxy;
          const base = {
            adapterId: this.adapterId,
            socketId: request.socketId,
            type: SOCKET_EVENT,
          };
          destination.postMessage(
            {
              ...base,
              event: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "Protected Code WebSocket failed.",
            },
            { targetOrigin: window.location.origin },
          );
          destination.postMessage(
            {
              ...base,
              event: "close",
              code: 1006,
              reason: "",
              wasClean: false,
            },
            { targetOrigin: window.location.origin },
          );
        });
      return;
    }
    const socket = this.#sockets.get(request.socketId);
    if (!socket) return;
    if (
      request.type === "cantrip-code-websocket-send-v1" &&
      request.data !== undefined
    ) {
      void socket.send(request.data, request.binary ?? false);
    } else if (request.type === "cantrip-code-websocket-close-v1") {
      this.#sockets.delete(request.socketId);
      void socket.close(request.code, request.reason);
    }
  };
}

const sessions = new Map<string, BrowserCodeSession>();
const pendingStartTokens = new Map<string, symbol>();

export interface BrowserCodeAttachmentUnavailableEvent {
  reason: string;
  tunnelId: string;
}

const unavailableListeners = new Set<
  (event: BrowserCodeAttachmentUnavailableEvent) => void
>();

export function subscribeBrowserCodeAttachmentUnavailable(
  listener: (event: BrowserCodeAttachmentUnavailableEvent) => void,
): () => void {
  unavailableListeners.add(listener);
  return () => unavailableListeners.delete(listener);
}

function notifyBrowserCodeAttachmentUnavailable(
  tunnelId: string,
  error: Error,
): void {
  const event = { tunnelId, reason: error.message };
  for (const listener of unavailableListeners) {
    try {
      listener(event);
    } catch {
      // Recovery listeners are isolated so every mounted surface is notified.
    }
  }
}

export async function startBrowserCodeAttachment(
  wire: CodeProtectedAttachmentWire,
): Promise<CodeAttachment> {
  const startToken = Symbol(wire.tunnelId);
  pendingStartTokens.set(wire.tunnelId, startToken);
  try {
    const existing = sessions.get(wire.tunnelId);
    if (existing) {
      sessions.delete(wire.tunnelId);
      await existing.close();
    }
    const session = await BrowserCodeSession.open(wire, (failed, error) => {
      if (sessions.get(wire.tunnelId) !== failed) return;
      sessions.delete(wire.tunnelId);
      notifyBrowserCodeAttachmentUnavailable(wire.tunnelId, error);
    });
    if (!session.healthy) {
      await session.close();
      throw (
        session.failure ??
        new Error("The protected Code relay disconnected during startup.")
      );
    }
    if (pendingStartTokens.get(wire.tunnelId) !== startToken) {
      await session.close();
      throw new DOMException(
        "Protected Code attachment startup was superseded.",
        "AbortError",
      );
    }
    sessions.set(wire.tunnelId, session);
    return session.attachment;
  } finally {
    if (pendingStartTokens.get(wire.tunnelId) === startToken) {
      pendingStartTokens.delete(wire.tunnelId);
    }
  }
}

export async function stopBrowserCodeAttachment(
  tunnelId: string,
): Promise<void> {
  pendingStartTokens.delete(tunnelId);
  const session = sessions.get(tunnelId);
  if (!session) return;
  sessions.delete(tunnelId);
  await session.close();
}

export function browserCodeAttachmentHealthy(tunnelId: string): boolean {
  const session = sessions.get(tunnelId);
  if (!session?.healthy) {
    if (session && sessions.get(tunnelId) === session)
      sessions.delete(tunnelId);
    return false;
  }
  return true;
}
