import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  tunnelAttachmentReadySchema,
  TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES,
  type CodeAttachment,
  type CodeProtectedAttachmentWire,
  type TunnelAttachmentCreateResult,
  type TunnelAttachmentReady,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import type { TunnelDataProtectionConfiguration } from "@cantrip/protocol/tunnel-content";

import {
  createTunnelAttachment,
  deleteTunnelAttachment,
  getTunnelDataProtection,
} from "@/lib/api";
import { getClientSession } from "@/lib/client-session";
import {
  getActiveServerConnection,
  getActiveServerUrl,
} from "@/lib/server-connections";

const INITIAL_CREDIT_BYTES = 256 * 1_024;
const MAX_HTTP_RESPONSE_BYTES = 64 * 1_024 * 1_024;
const MAX_HTTP_REQUEST_BYTES = 16 * 1_024 * 1_024;
const MAX_HTTP_HEADER_BYTES = 64 * 1_024;
const MAX_HTTP_HEADER_COUNT = 256;
const MAX_BROWSER_HTTP_REQUESTS = 128;
const MAX_BROWSER_CODE_SOCKETS = 128;
const MAX_TUNNEL_CONNECTIONS = 256;
const MAX_CONNECTION_QUEUED_BYTES = 8 * 1_024 * 1_024;
const MAX_TUNNEL_QUEUED_SEND_BYTES = 32 * 1_024 * 1_024;
const MAX_SOCKET_BUFFER_BYTES = 8 * 1_024 * 1_024;
const MAX_SOCKET_RECEIVE_BYTES = 32 * 1_024 * 1_024;
const OUTER_SEND_HIGH_WATER_BYTES = 8 * 1_024 * 1_024;
const OUTER_SEND_LOW_WATER_BYTES = 4 * 1_024 * 1_024;
const OUTER_SEND_TIMEOUT_MS = 5_000;
const OUTER_SEND_POLL_MS = 10;
const OUTER_CONNECT_TIMEOUT_MS = 10_000;
const OUTER_READY_TIMEOUT_MS = 10_000;
const CONNECTION_OPEN_TIMEOUT_MS = 10_000;
const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;
const API_OPERATION_TIMEOUT_MS = 10_000;
const RECONNECT_GRACE_MS = 15_000;
const RECONNECT_RETRY_MS = 250;
const RELAY_ERROR_CLOSE_CLASSIFICATION_MS = 75;
const HTTP_CHANNEL = "cantrip-code-http-v1";
const SERVICE_WORKER_PATH = "/cantrip-code-service-worker.js";
const SOCKET_EVENT = "cantrip-code-websocket-event-v1";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

export function compactBrowserCodeBufferTail(
  value: Uint8Array<ArrayBufferLike>,
  consumedBytes: number,
): Uint8Array<ArrayBuffer> {
  const tail = value.subarray(consumedBytes);
  if (tail.byteLength === 0) return new Uint8Array();
  const compacted = new Uint8Array(tail.byteLength);
  compacted.set(tail);
  return compacted;
}

type ReadyMessage = Readonly<TunnelAttachmentReady>;

interface HttpProxyRequest {
  adapterId: string;
  body: ArrayBuffer | null;
  headers: Array<[string, string]>;
  method: string;
  requestId: string;
  type: "cantrip-code-http-request-v1";
  url: string;
}

interface HttpProxyCancel {
  adapterId: string;
  requestId: string;
  type: "cantrip-code-http-cancel-v1";
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

function validSocketProtocols(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (
    value.some(
      (protocol) =>
        typeof protocol !== "string" ||
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(protocol),
    )
  ) {
    return false;
  }
  return (
    new Set(value.map((protocol) => protocol.toLowerCase())).size ===
    value.length
  );
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function boundedSignal(
  timeoutMs: number,
  message: string,
  parent?: AbortSignal,
): { dispose(): void; signal: AbortSignal } {
  const controller = new AbortController();
  const onParentAbort = () =>
    controller.abort(parent?.reason ?? abortError(message));
  parent?.addEventListener("abort", onParentAbort, { once: true });
  if (parent?.aborted) onParentAbort();
  const timer = setTimeout(
    () => controller.abort(new Error(message)),
    timeoutMs,
  );
  return {
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
    signal: controller.signal,
  };
}

async function awaitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason ?? abortError("Aborted."));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function boundedOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  parent?: AbortSignal,
): Promise<T> {
  const bounded = boundedSignal(timeoutMs, message, parent);
  try {
    return await awaitWithSignal(operation(bounded.signal), bounded.signal);
  } finally {
    bounded.dispose();
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (operation: () => void) => {
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const timer = setTimeout(() => settle(resolve), ms);
    const onAbort = () => {
      clearTimeout(timer);
      settle(() => reject(signal.reason ?? abortError("Aborted.")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function apiStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = Reflect.get(error, "status");
  return typeof status === "number" ? status : null;
}

function terminalApiError(error: unknown): boolean {
  const status = apiStatus(error);
  return status === 401 || status === 403 || status === 404 || status === 409;
}

interface BrowserSecurityIdentity {
  accountId: string | null;
  ownerId: string | null;
  serverId: string | null;
  sessionServerId: string | null;
  serverUrl: string;
}

function browserSecurityIdentity(): BrowserSecurityIdentity {
  const connection = getActiveServerConnection();
  const session = getClientSession();
  return {
    accountId: connection?.accountId ?? null,
    ownerId: session?.user.id ?? null,
    serverId: connection?.id ?? null,
    sessionServerId: session?.serverId ?? null,
    serverUrl: getActiveServerUrl() || window.location.origin,
  };
}

function sameSecurityIdentity(
  left: BrowserSecurityIdentity,
  right: BrowserSecurityIdentity,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.ownerId === right.ownerId &&
    left.serverId === right.serverId &&
    left.sessionServerId === right.sessionServerId &&
    left.serverUrl === right.serverUrl
  );
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
  #didAccept = false;
  #failure: Error | null = null;
  #listener: ((chunk: Uint8Array) => void) | null = null;
  #queued = Promise.resolve();
  #queuedBytes = 0;
  #retired = false;
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
    void this.#accepted.catch(() => undefined);
    void this.#closed.catch(() => undefined);
  }

  async ready(): Promise<void> {
    return this.#accepted;
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.#listener = listener;
    for (const chunk of this.#chunks.splice(0)) listener(chunk);
  }

  async send(payload: Uint8Array): Promise<void> {
    if (payload.byteLength > MAX_CONNECTION_QUEUED_BYTES - this.#queuedBytes) {
      throw new Error("Protected Code stream send queue is congested.");
    }
    if (this.#retired) {
      throw new Error("Protected Code stream is closed.");
    }
    const releaseAggregate = this.tunnel.reserveQueuedSend(payload.byteLength);
    this.#queuedBytes += payload.byteLength;
    const operation = this.#queued.then(async () => {
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
    this.#queued = operation.catch(() => undefined);
    try {
      await operation;
    } finally {
      this.#queuedBytes -= payload.byteLength;
      releaseAggregate();
    }
  }

  halfClose(): void {
    if (this.#retired) return;
    const operation = this.#queued.then(() => {
      if (this.#retired) return;
      this.tunnel.sendControl({
        ...this.tunnel.identities(this.id, this.#sourceSequence++),
        kind: "half-close",
        direction: "source-to-destination",
      });
    });
    this.#queued = operation.catch(() => undefined);
  }

  close(code: "normal" | "protocol-error" = "normal"): void {
    if (this.#retired) return;
    const operation = this.#queued.then(() => {
      this.tunnel.sendControl({
        ...this.tunnel.identities(this.id, this.#sourceSequence++),
        kind: "close",
        code,
      });
    });
    this.#queued = operation.catch(() => undefined);
    this.#retire();
    this.#close();
    this.#wakeCredit();
  }

  async waitClosed(): Promise<void> {
    return this.#closed;
  }

  receive(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): void {
    if (this.#retired) return;
    if (header.sequence !== this.#destinationSequence) {
      this.fail(
        new Error("Protected Code tunnel frame sequence is invalid."),
        "protocol-error",
      );
      return;
    }
    this.#destinationSequence += 1;
    if (header.kind === "accepted") {
      if (this.#didAccept) {
        this.fail(
          new Error("Protected Code stream was accepted more than once."),
          "protocol-error",
        );
        return;
      }
      this.#didAccept = true;
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
      const operation = this.#queued.then(() => {
        if (this.#retired) return;
        this.tunnel.sendControl({
          ...this.tunnel.identities(this.id, this.#sourceSequence++),
          kind: "credit",
          direction: "destination-to-source",
          bytes: payload.byteLength,
        });
      });
      this.#queued = operation.catch(() => undefined);
      return;
    }
    if (
      header.kind === "half-close" &&
      header.direction === "destination-to-source"
    ) {
      this.close();
      return;
    }
    if (header.kind === "close") {
      this.#retire();
      this.#close();
      this.#wakeCredit();
      return;
    }
    if (header.kind === "error") {
      this.fail(new Error("The protected Code stream failed."));
      return;
    }
    this.fail(
      new Error("Protected Code stream frame was invalid for this route."),
      "protocol-error",
    );
  }

  fail(error: Error, code: "protocol-error" | null = null): void {
    if (this.#failure) return;
    this.#failure = error;
    if (code) {
      const operation = this.#queued.then(() => {
        this.tunnel.sendControl({
          ...this.tunnel.identities(this.id, this.#sourceSequence++),
          kind: "close",
          code,
        });
      });
      this.#queued = operation.catch(() => undefined);
    }
    this.#retire();
    this.#acceptReject(error);
    this.#closeReject(error);
    this.#wakeCredit();
  }

  transportFailed(error: Error): void {
    this.fail(error);
  }

  async #takeCredit(bytes: number): Promise<void> {
    while (this.#sourceCredit < bytes) {
      if (this.#failure) throw this.#failure;
      if (this.#retired) throw abortError("Protected Code stream is closed.");
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    if (this.#failure) throw this.#failure;
    if (this.#retired) throw abortError("Protected Code stream is closed.");
    this.#sourceCredit -= bytes;
  }

  #wakeCredit(): void {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  #retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.tunnel.forgetConnection(this);
  }
}

interface BrowserRelayCredential extends TunnelAttachmentCreateResult {
  expiresAtEpochMs: number;
  secretExpiresAtEpochMs: number;
}

interface BrowserRelayTransport {
  errorTimer: ReturnType<typeof setTimeout> | null;
  identities: ReadyMessage | null;
  published: boolean;
  ready: Promise<ReadyMessage>;
  readyReject(error: Error): void;
  readyResolve(ready: ReadyMessage): void;
  retired: boolean;
  sendAbort: AbortController;
  sendQueue: Promise<void>;
  socket: WebSocket;
}

class RelayCredentialRejectedError extends Error {}
class RelaySecurityIdentityChangedError extends Error {}

function relayCredential(
  result: TunnelAttachmentCreateResult,
  tunnelId: string,
): BrowserRelayCredential {
  const secretExpiresAtEpochMs = Date.parse(result.secretExpiresAt);
  const expiresAtEpochMs = Date.parse(result.expiresAt);
  if (
    result.tunnelId !== tunnelId ||
    !Number.isFinite(secretExpiresAtEpochMs) ||
    !Number.isFinite(expiresAtEpochMs)
  ) {
    result.secret = "";
    throw new Error("Protected Code relay credentials were invalid.");
  }
  return { ...result, secretExpiresAtEpochMs, expiresAtEpochMs };
}

class BrowserTunnelClient {
  readonly #connections = new Map<string, BrowserTunnelConnection>();
  readonly #sourceEndpointIds = new Map<string, string>();
  readonly #key: Promise<CryptoKey>;
  readonly #lifetime = new AbortController();
  readonly #ownedAttachmentIds = new Set<string>();
  readonly #deletePromises = new Map<string, Promise<void>>();
  readonly #terminalListeners = new Set<(error: Error) => void>();
  #closing = false;
  #credential: BrowserRelayCredential;
  #credentialRotationRequired = false;
  #queuedSendBytes = 0;
  #destinationEndpointId: string | null = null;
  #queuedReceiveBytes = 0;
  #reconnectPromise: Promise<void> | null = null;
  #receiveQueue = Promise.resolve();
  #terminalError: Error | null = null;
  #transport: BrowserRelayTransport | null = null;

  private constructor(
    readonly tunnelId: string,
    private readonly clientId: string,
    private readonly securityIdentity: BrowserSecurityIdentity,
    credential: BrowserRelayCredential,
    private readonly protection: TunnelDataProtectionConfiguration,
  ) {
    this.#credential = credential;
    this.#ownedAttachmentIds.add(credential.attachmentId);
    this.#key = crypto.subtle.importKey(
      "raw",
      toArrayBuffer(decodeBase64Url(protection.key)),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  }

  static async open(
    tunnelId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTunnelClient> {
    const clientId = `web-code:${crypto.randomUUID()}`;
    const securityIdentity = browserSecurityIdentity();
    const protection = await boundedOperation(
      (operationSignal) =>
        getTunnelDataProtection(tunnelId, { signal: operationSignal }),
      API_OPERATION_TIMEOUT_MS,
      "Protected Code data-plane keys timed out.",
      signal,
    );
    const attachment = relayCredential(
      await boundedOperation(
        (operationSignal) =>
          createTunnelAttachment(
            tunnelId,
            { clientId },
            { signal: operationSignal },
          ),
        API_OPERATION_TIMEOUT_MS,
        "Protected Code relay allocation timed out.",
        signal,
      ),
      tunnelId,
    );
    const client = new BrowserTunnelClient(
      tunnelId,
      clientId,
      securityIdentity,
      attachment,
      protection,
    );
    try {
      await client.#connect(signal);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  identities(
    connectionId: string,
    sequence: number,
    transport = this.#transport,
  ) {
    const identities = transport?.identities;
    if (!identities) throw new Error("Protected Code tunnel is not ready.");
    return {
      protocolVersion: 1 as const,
      tunnelId: this.tunnelId,
      attachmentId: identities.attachmentId,
      sourceEndpointId: identities.sourceEndpointId,
      destinationEndpointId: identities.destinationEndpointId,
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
    return this.openConnectionWithSignal();
  }

  async openConnectionWithSignal(
    parent?: AbortSignal,
  ): Promise<BrowserTunnelConnection> {
    return boundedOperation(
      async (signal) => {
        await this.#waitConnected(signal);
        if (!this.healthy || !this.#transport?.published) {
          throw (
            this.#terminalError ??
            new Error("The protected Code relay is no longer available.")
          );
        }
        if (this.#connections.size >= MAX_TUNNEL_CONNECTIONS) {
          throw new Error("Protected Code relay stream limit was reached.");
        }
        const connection = new BrowserTunnelConnection(
          crypto.randomUUID(),
          this,
        );
        this.#connections.set(connection.id, connection);
        this.sendControl({
          ...this.identities(connection.id, 0),
          kind: "open",
          initialCreditBytes: INITIAL_CREDIT_BYTES,
        });
        try {
          await awaitWithSignal(connection.ready(), signal);
          return connection;
        } catch (error) {
          connection.close(
            error instanceof Error && error.name === "AbortError"
              ? "normal"
              : "protocol-error",
          );
          throw error;
        }
      },
      CONNECTION_OPEN_TIMEOUT_MS,
      "Protected Code logical stream open timed out.",
      parent,
    );
  }

  reserveQueuedSend(byteLength: number): () => void {
    if (byteLength > MAX_TUNNEL_QUEUED_SEND_BYTES - this.#queuedSendBytes) {
      throw new Error(
        "Protected Code aggregate stream send queue is congested.",
      );
    }
    this.#queuedSendBytes += byteLength;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#queuedSendBytes = Math.max(0, this.#queuedSendBytes - byteLength);
    };
  }

  sendControl(header: TunnelDataPlaneFrameHeader): void {
    const transport = this.#transport;
    if (!transport?.published || transport.retired) {
      throw new Error("Protected Code relay is reconnecting.");
    }
    void this.#queuePhysicalSend(
      transport,
      toArrayBuffer(encodeTunnelDataPlaneFrame(header, new Uint8Array())),
    );
  }

  async sendData(
    connectionId: string,
    sequence: number,
    payload: Uint8Array,
  ): Promise<void> {
    const transport = this.#transport;
    if (!transport?.published || transport.retired) {
      throw new Error("Protected Code relay is reconnecting.");
    }
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const protection = {
      formatVersion: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: this.protection.keyRevision,
      nonce: encodeBase64Url(nonce),
    };
    const header = {
      ...this.identities(connectionId, sequence, transport),
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
    await this.#queuePhysicalSend(
      transport,
      toArrayBuffer(
        encodeTunnelDataPlaneFrame(header, new Uint8Array(ciphertext)),
      ),
    );
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#lifetime.abort(abortError("Protected Code attachment closed."));
    this.#terminalListeners.clear();
    for (const connection of this.#connections.values()) connection.close();
    this.#connections.clear();
    const transport = this.#transport;
    this.#transport = null;
    if (transport) {
      transport.retired = true;
      transport.sendAbort.abort(
        abortError("Protected Code attachment closed."),
      );
      if (transport.errorTimer) clearTimeout(transport.errorTimer);
      transport.socket.close(1000, "Code attachment closed");
    }
    this.#credential.secret = "";
    await Promise.all(
      [...this.#ownedAttachmentIds].map((attachmentId) =>
        this.#deleteAttachmentOnce(attachmentId),
      ),
    );
  }

  forgetConnection(connection: BrowserTunnelConnection): void {
    if (this.#connections.get(connection.id) === connection) {
      this.#connections.delete(connection.id);
    }
  }

  #queuePhysicalSend(
    transport: BrowserRelayTransport,
    payload: string | ArrayBuffer,
  ): Promise<void> {
    const operation = transport.sendQueue.then(() =>
      this.#writePhysical(transport, payload),
    );
    transport.sendQueue = operation.catch(() => undefined);
    void operation.catch((error) => {
      this.#transportLost(
        transport,
        error instanceof Error
          ? error
          : new Error("Protected Code relay send failed."),
        false,
      );
    });
    return operation;
  }

  async #writePhysical(
    transport: BrowserRelayTransport,
    payload: string | ArrayBuffer,
  ): Promise<void> {
    if (transport.retired || transport.sendAbort.signal.aborted) {
      throw (
        transport.sendAbort.signal.reason ??
        abortError("Protected Code relay is reconnecting.")
      );
    }
    const byteLength =
      typeof payload === "string"
        ? textEncoder.encode(payload).byteLength
        : payload.byteLength;
    if (byteLength > OUTER_SEND_HIGH_WATER_BYTES) {
      throw new Error("Protected Code relay frame exceeded its send limit.");
    }
    const bounded = boundedSignal(
      OUTER_SEND_TIMEOUT_MS,
      "Protected Code relay send queue remained congested.",
      transport.sendAbort.signal,
    );
    try {
      if (
        transport.socket.bufferedAmount + byteLength >
        OUTER_SEND_HIGH_WATER_BYTES
      ) {
        while (transport.socket.bufferedAmount > OUTER_SEND_LOW_WATER_BYTES) {
          if (transport.socket.readyState !== WebSocket.OPEN) {
            throw new Error("Protected Code relay disconnected while sending.");
          }
          await delay(OUTER_SEND_POLL_MS, bounded.signal);
        }
      }
      bounded.signal.throwIfAborted();
      if (
        transport.retired ||
        transport.socket.readyState !== WebSocket.OPEN ||
        transport.socket.bufferedAmount + byteLength >
          OUTER_SEND_HIGH_WATER_BYTES
      ) {
        throw new Error("Protected Code relay send queue is congested.");
      }
      transport.socket.send(payload);
    } finally {
      bounded.dispose();
    }
  }

  async #connect(parent?: AbortSignal): Promise<void> {
    this.#assertSecurityIdentity();
    const credential = this.#credential;
    const base = new URL(this.securityIdentity.serverUrl);
    const url = new URL(credential.connectPath, base);
    const expectedPath = `/api/tunnel-attachments/${encodeURIComponent(credential.attachmentId)}/connect`;
    if (
      url.origin !== base.origin ||
      url.pathname !== expectedPath ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error("Protected Code relay route was invalid.");
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let readyResolve!: (ready: ReadyMessage) => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<ReadyMessage>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    void ready.catch(() => undefined);
    const socket = new WebSocket(url, `cantrip-tunnel-v1.${credential.secret}`);
    const transport: BrowserRelayTransport = {
      errorTimer: null,
      identities: null,
      published: false,
      ready,
      readyReject,
      readyResolve,
      retired: false,
      sendAbort: new AbortController(),
      sendQueue: Promise.resolve(),
      socket,
    };
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) =>
      this.#message(transport, event),
    );
    socket.addEventListener("close", (event) => {
      if (transport.errorTimer) clearTimeout(transport.errorTimer);
      transport.errorTimer = null;
      const close = event as CloseEvent;
      if (close.code === 1008) this.#credentialRotationRequired = true;
      this.#transportLost(
        transport,
        close.code === 1008
          ? new RelayCredentialRejectedError(
              "Protected Code relay credentials were rejected.",
            )
          : new Error("The protected Code relay disconnected."),
        close.code === 1008,
      );
    });
    socket.addEventListener("error", () => {
      if (transport.errorTimer || transport.retired) return;
      transport.errorTimer = setTimeout(() => {
        transport.errorTimer = null;
        this.#transportLost(
          transport,
          new Error("The protected Code relay failed."),
          false,
        );
      }, RELAY_ERROR_CLOSE_CLASSIFICATION_MS);
    });
    try {
      await boundedOperation(
        () =>
          new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener(
              "error",
              () =>
                reject(
                  new Error("Could not connect to the protected Code relay."),
                ),
              { once: true },
            );
            socket.addEventListener(
              "close",
              (event) =>
                reject(
                  (event as CloseEvent).code === 1008
                    ? new RelayCredentialRejectedError(
                        "Protected Code relay credentials were rejected.",
                      )
                    : new Error(
                        "Could not connect to the protected Code relay.",
                      ),
                ),
              { once: true },
            );
          }),
        OUTER_CONNECT_TIMEOUT_MS,
        "Protected Code relay connection timed out.",
        parent,
      );
      if (transport.retired) {
        throw new Error("Protected Code relay disconnected while opening.");
      }
      await this.#queuePhysicalSend(
        transport,
        JSON.stringify({ type: "initialize", clientId: this.clientId }),
      );
      await boundedOperation(
        () => ready,
        OUTER_READY_TIMEOUT_MS,
        "Protected Code relay initialization timed out.",
        parent,
      );
      if (transport.retired || !transport.identities) {
        throw new Error("Protected Code relay disconnected while opening.");
      }
      transport.published = true;
      this.#transport = transport;
    } catch (error) {
      transport.retired = true;
      transport.sendAbort.abort(
        abortError("Protected Code relay open was cancelled."),
      );
      if (transport.errorTimer) clearTimeout(transport.errorTimer);
      socket.close(1000, "Code relay open cancelled");
      throw error;
    }
  }

  #message(transport: BrowserRelayTransport, event: MessageEvent): void {
    if (transport.retired) return;
    if (typeof event.data === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        parsed = null;
      }
      const result = tunnelAttachmentReadySchema.safeParse(parsed);
      if (
        !result.success ||
        result.data.attachmentId !== this.#credential.attachmentId ||
        result.data.tunnelId !== this.tunnelId ||
        result.data.expiresAt !== this.#credential.expiresAt
      ) {
        const error = new RelaySecurityIdentityChangedError(
          "Protected Code relay identity did not match.",
        );
        transport.readyReject(error);
        if (transport.published) this.#failTerminal(error);
        return;
      }
      const knownSourceEndpointId = this.#sourceEndpointIds.get(
        result.data.attachmentId,
      );
      if (
        (knownSourceEndpointId !== undefined &&
          knownSourceEndpointId !== result.data.sourceEndpointId) ||
        (this.#destinationEndpointId !== null &&
          this.#destinationEndpointId !== result.data.destinationEndpointId)
      ) {
        const error = new RelaySecurityIdentityChangedError(
          "Protected Code relay endpoint identity changed during recovery.",
        );
        transport.readyReject(error);
        if (transport.published) this.#failTerminal(error);
        return;
      }
      this.#sourceEndpointIds.set(
        result.data.attachmentId,
        result.data.sourceEndpointId,
      );
      this.#destinationEndpointId = result.data.destinationEndpointId;
      const next = Object.freeze({ ...result.data });
      if (transport.identities) {
        const error = new RelaySecurityIdentityChangedError(
          "Protected Code relay published readiness more than once.",
        );
        transport.readyReject(error);
        this.#failTerminal(error);
        return;
      }
      transport.identities = next;
      transport.readyResolve(next);
      return;
    }
    if (!transport.published || this.#transport !== transport) {
      transport.readyReject(
        new Error("Protected Code relay sent data before initialization."),
      );
      return;
    }
    const frameBytes =
      event.data instanceof Blob
        ? event.data.size
        : event.data instanceof ArrayBuffer
          ? event.data.byteLength
          : MAX_SOCKET_BUFFER_BYTES + 1;
    if (frameBytes > MAX_SOCKET_BUFFER_BYTES - this.#queuedReceiveBytes) {
      this.#transportLost(
        transport,
        new Error("Protected Code relay receive queue is congested."),
        false,
      );
      return;
    }
    this.#queuedReceiveBytes += frameBytes;
    const operation = this.#receiveQueue
      .then(() => this.#receiveFrame(transport, event.data))
      .catch((error) => {
        const failure =
          error instanceof Error
            ? error
            : new Error("Protected Code frame failed.");
        if (failure instanceof RelaySecurityIdentityChangedError) {
          this.#failTerminal(failure);
        } else {
          this.#transportLost(transport, failure, false);
        }
      })
      .finally(() => {
        this.#queuedReceiveBytes -= frameBytes;
      });
    this.#receiveQueue = operation;
  }

  async #receiveFrame(
    transport: BrowserRelayTransport,
    data: unknown,
  ): Promise<void> {
    if (transport.retired || this.#transport !== transport) return;
    const bytes =
      data instanceof Blob
        ? data.size > MAX_SOCKET_BUFFER_BYTES
          ? (() => {
              throw new Error("Protected Code relay frame is too large.");
            })()
          : new Uint8Array(await data.arrayBuffer())
        : new Uint8Array(data as ArrayBuffer);
    if (bytes.byteLength > MAX_SOCKET_BUFFER_BYTES) {
      throw new Error("Protected Code relay frame is too large.");
    }
    if (transport.retired || this.#transport !== transport) return;
    const frame = decodeTunnelDataPlaneFrame(bytes);
    const identities = transport.identities;
    if (
      !identities ||
      frame.header.tunnelId !== identities.tunnelId ||
      frame.header.attachmentId !== identities.attachmentId ||
      frame.header.sourceEndpointId !== identities.sourceEndpointId ||
      frame.header.destinationEndpointId !== identities.destinationEndpointId
    ) {
      throw new RelaySecurityIdentityChangedError(
        "Protected Code relay frame escaped its authenticated route.",
      );
    }
    const connection = this.#connections.get(frame.header.connectionId);
    if (!connection) return;
    let payload = frame.payload;
    if (frame.header.kind === "data") {
      if (
        frame.header.direction !== "destination-to-source" ||
        !frame.header.protection ||
        frame.header.protection.keyRevision !== this.protection.keyRevision
      ) {
        connection.fail(
          new Error("Protected Code relay returned invalid protected data."),
          "protocol-error",
        );
        return;
      }
      try {
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
      } catch {
        connection.fail(
          new Error("Protected Code relay data authentication failed."),
          "protocol-error",
        );
        return;
      }
    }
    connection.receive(frame.header, payload);
  }

  #transportLost(
    transport: BrowserRelayTransport,
    error: Error,
    credentialRejected: boolean,
  ): void {
    if (credentialRejected) this.#credentialRotationRequired = true;
    if (transport.retired) {
      if (credentialRejected && transport.published) {
        const current = this.#transport;
        if (current && current !== transport) {
          this.#transportLost(current, error, true);
        } else if (!current) {
          this.#beginReconnect(true);
        }
      }
      return;
    }
    transport.retired = true;
    transport.sendAbort.abort(error);
    if (transport.errorTimer) clearTimeout(transport.errorTimer);
    transport.errorTimer = null;
    if (transport.socket.readyState !== WebSocket.CLOSED) {
      transport.socket.close(1013, "Protected Code relay was congested");
    }
    transport.readyReject(error);
    if (!transport.published) return;
    if (this.#transport === transport) this.#transport = null;
    for (const connection of [...this.#connections.values()]) {
      connection.transportFailed(error);
    }
    this.#connections.clear();
    if (!this.#closing && !this.#terminalError) {
      this.#beginReconnect(credentialRejected);
    }
  }

  #beginReconnect(credentialRejected: boolean): void {
    if (this.#reconnectPromise || this.#closing || this.#terminalError) return;
    const reconnect = this.#reconnect(credentialRejected)
      .catch((error) => {
        this.#failTerminal(
          error instanceof Error
            ? error
            : new Error("Protected Code relay recovery failed."),
        );
      })
      .finally(() => {
        if (this.#reconnectPromise === reconnect) {
          this.#reconnectPromise = null;
        }
      });
    this.#reconnectPromise = reconnect;
  }

  async #reconnect(credentialRejected: boolean): Promise<void> {
    const grace = boundedSignal(
      RECONNECT_GRACE_MS,
      "Protected Code relay recovery timed out.",
      this.#lifetime.signal,
    );
    let rotate = credentialRejected || this.#credentialRotationRequired;
    try {
      while (true) {
        grace.signal.throwIfAborted();
        this.#assertSecurityIdentity();
        if (Date.now() >= this.#credential.expiresAtEpochMs) {
          throw new RelayCredentialRejectedError(
            "Protected Code relay attachment expired.",
          );
        }
        if (Date.now() >= this.#credential.secretExpiresAtEpochMs)
          rotate = true;
        if (rotate) {
          try {
            await this.#rotateCredential(grace.signal);
            this.#credentialRotationRequired = false;
            rotate = false;
          } catch (error) {
            if (
              error instanceof RelaySecurityIdentityChangedError ||
              terminalApiError(error)
            ) {
              throw error;
            }
            grace.signal.throwIfAborted();
            await delay(RECONNECT_RETRY_MS, grace.signal);
            continue;
          }
        }
        try {
          await this.#connect(grace.signal);
          if (this.#credentialRotationRequired) {
            const transport = this.#transport;
            this.#transport = null;
            if (transport) {
              transport.retired = true;
              transport.sendAbort.abort(
                abortError("Protected Code relay credentials rotated."),
              );
              transport.socket.close(1000, "Rotating relay credentials");
            }
            rotate = true;
            continue;
          }
          return;
        } catch (error) {
          if (
            error instanceof RelaySecurityIdentityChangedError ||
            terminalApiError(error)
          ) {
            throw error;
          }
          if (error instanceof RelayCredentialRejectedError) rotate = true;
          grace.signal.throwIfAborted();
          await delay(RECONNECT_RETRY_MS, grace.signal);
        }
      }
    } finally {
      grace.dispose();
    }
  }

  async #rotateCredential(signal: AbortSignal): Promise<void> {
    this.#assertSecurityIdentity();
    const refreshedProtection = await boundedOperation(
      (operationSignal) =>
        getTunnelDataProtection(this.tunnelId, { signal: operationSignal }),
      API_OPERATION_TIMEOUT_MS,
      "Protected Code data-plane key refresh timed out.",
      signal,
    );
    if (
      refreshedProtection.formatVersion !== this.protection.formatVersion ||
      refreshedProtection.algorithm !== this.protection.algorithm ||
      refreshedProtection.keyRevision !== this.protection.keyRevision ||
      refreshedProtection.key !== this.protection.key
    ) {
      throw new RelaySecurityIdentityChangedError(
        "Protected Code data-plane identity changed during recovery.",
      );
    }
    const previous = this.#credential;
    const next = relayCredential(
      await boundedOperation(
        (operationSignal) =>
          createTunnelAttachment(
            this.tunnelId,
            { clientId: this.clientId },
            { signal: operationSignal },
          ),
        API_OPERATION_TIMEOUT_MS,
        "Protected Code relay credential rotation timed out.",
        signal,
      ),
      this.tunnelId,
    );
    previous.secret = "";
    this.#credential = next;
    this.#ownedAttachmentIds.add(next.attachmentId);
    if (previous.attachmentId !== next.attachmentId) {
      void this.#deleteAttachmentOnce(previous.attachmentId);
    }
  }

  async #waitConnected(signal: AbortSignal): Promise<void> {
    while (!this.#transport?.published) {
      if (this.#terminalError) throw this.#terminalError;
      if (this.#closing) throw abortError("Protected Code attachment closed.");
      const reconnect = this.#reconnectPromise;
      if (!reconnect) {
        throw new Error("Protected Code relay is not connected.");
      }
      await awaitWithSignal(reconnect, signal);
    }
  }

  #assertSecurityIdentity(): void {
    if (
      !sameSecurityIdentity(this.securityIdentity, browserSecurityIdentity())
    ) {
      throw new RelaySecurityIdentityChangedError(
        "Protected Code server or account identity changed.",
      );
    }
  }

  async #deleteAttachmentOnce(attachmentId: string): Promise<void> {
    const existing = this.#deletePromises.get(attachmentId);
    if (existing) return existing;
    const operation = boundedOperation(
      (signal) => deleteTunnelAttachment(attachmentId, { signal }),
      API_OPERATION_TIMEOUT_MS,
      "Protected Code relay cleanup timed out.",
    ).catch(() => undefined);
    this.#deletePromises.set(attachmentId, operation);
    await operation;
  }

  #failTerminal(error: Error): void {
    if (this.#closing || this.#terminalError) return;
    this.#terminalError = error;
    const transport = this.#transport;
    this.#transport = null;
    if (transport) {
      transport.retired = true;
      transport.sendAbort.abort(error);
      if (transport.errorTimer) clearTimeout(transport.errorTimer);
      transport.socket.close(1008, "Protected Code security identity changed");
    }
    for (const connection of [...this.#connections.values()]) {
      connection.transportFailed(error);
    }
    this.#connections.clear();
    for (const listener of this.#terminalListeners) {
      try {
        listener(error);
      } catch {
        // Recovery listeners are isolated so every retained surface is notified.
      }
    }
    this.#terminalListeners.clear();
  }
}

function virtualCodePath(url: URL, adapterId: string): string {
  const prefix = `/__cantrip_code/${adapterId}`;
  const codePath = `${prefix}/code`;
  if (
    url.origin !== window.location.origin ||
    (url.pathname !== codePath && !url.pathname.startsWith(`${codePath}/`))
  ) {
    throw new Error("Protected Code request escaped its browser adapter.");
  }
  return url.pathname.slice(prefix.length) + url.search;
}

function serializeHttpRequest(request: HttpProxyRequest): Uint8Array {
  const url = new URL(request.url);
  const path = virtualCodePath(url, request.adapterId);
  if (
    typeof request.method !== "string" ||
    request.method.length > 32 ||
    !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(request.method)
  ) {
    throw new Error("Protected Code request method was invalid.");
  }
  if (
    !Array.isArray(request.headers) ||
    request.headers.length > MAX_HTTP_HEADER_COUNT
  ) {
    throw new Error("Protected Code request headers were invalid.");
  }
  const blocked = new Set([
    "authorization",
    "connection",
    "content-length",
    "cookie",
    "host",
    "proxy-authorization",
    "transfer-encoding",
  ]);
  const headers = request.headers.filter((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error("Protected Code request header was invalid.");
    }
    const [name, value] = entry;
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      name.length > 256 ||
      value.length > 8_192 ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) ||
      /[\r\n]/u.test(value)
    ) {
      throw new Error("Protected Code request header was invalid.");
    }
    return !blocked.has(name.toLowerCase());
  });
  headers.push(
    ["Host", "cantrip-code.local"],
    ["Connection", "close"],
    ["Accept-Encoding", "identity"],
    ["X-Cantrip-Code-Base-Path", `/__cantrip_code/${request.adapterId}/code`],
  );
  if (request.body !== null && !(request.body instanceof ArrayBuffer)) {
    throw new Error("Protected Code request body was invalid.");
  }
  const body = request.body ? new Uint8Array(request.body) : new Uint8Array();
  if (body.byteLength > MAX_HTTP_REQUEST_BYTES) {
    throw new Error("Protected Code request body is too large.");
  }
  if (body.byteLength > 0)
    headers.push(["Content-Length", String(body.byteLength)]);
  const head = textEncoder.encode(
    `${request.method} ${path} HTTP/1.1\r\n${headers
      .map(([name, value]) => `${name}: ${value}`)
      .join("\r\n")}\r\n\r\n`,
  );
  if (head.byteLength > MAX_HTTP_HEADER_BYTES) {
    throw new Error("Protected Code request headers are too large.");
  }
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
  options: { signal?: AbortSignal } = {},
) {
  const connection = await boundedOperation(
    (signal) =>
      "openConnectionWithSignal" in tunnel &&
      typeof tunnel.openConnectionWithSignal === "function"
        ? tunnel.openConnectionWithSignal(signal)
        : awaitWithSignal(tunnel.openConnection(), signal),
    CONNECTION_OPEN_TIMEOUT_MS,
    "Protected Code logical stream open timed out.",
    options.signal,
  );
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
  try {
    await boundedOperation(
      (signal) =>
        awaitWithSignal(connection.send(serializeHttpRequest(request)), signal),
      HTTP_REQUEST_TIMEOUT_MS,
      "Protected Code request send timed out.",
      options.signal,
    );
    // The HTTP message is self-delimiting and requests connection closure after
    // the response. Half-closing here makes Node treat the relay as a departed
    // client and abort the worker's OpenVSCode upstream request before it can
    // answer.
    await boundedOperation(
      (signal) => awaitWithSignal(connection.waitClosed(), signal),
      HTTP_REQUEST_TIMEOUT_MS,
      "Protected Code request timed out.",
      options.signal,
    );
  } catch (error) {
    connection.close();
    throw error;
  }
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

interface BrowserSocketReceiveBudget {
  release(byteLength: number): void;
  reserve(byteLength: number): boolean;
}

class BrowserSocketReceiveOverflowError extends Error {}

class BrowserCodeSocket {
  readonly #connection: BrowserTunnelConnection;
  #buffer = new Uint8Array();
  #fragmentOpcode = 0;
  #fragmentBytes = 0;
  #fragments: Uint8Array[] = [];
  #handshake = false;
  #closed = false;
  #closePosted = false;

  private constructor(
    private readonly adapterId: string,
    private readonly socketId: string,
    private readonly target: WindowProxy,
    connection: BrowserTunnelConnection,
    private readonly protocols: readonly string[],
    private readonly receiveBudget: BrowserSocketReceiveBudget,
    private readonly onRetired: () => void,
  ) {
    this.#connection = connection;
    connection.onData(
      (chunk) => void this.#data(chunk).catch((error) => this.#failed(error)),
    );
    void connection.waitClosed().then(
      () => this.#closedFromTunnel(),
      (error) => this.#closedFromTunnel(error),
    );
  }

  static async open(
    tunnel: BrowserTunnelClient,
    request: SocketRequest,
    target: WindowProxy,
    receiveBudget: BrowserSocketReceiveBudget,
    signal?: AbortSignal,
    onRetired: () => void = () => undefined,
  ): Promise<BrowserCodeSocket> {
    const connection = await tunnel.openConnectionWithSignal(signal);
    const socket = new BrowserCodeSocket(
      request.adapterId,
      request.socketId,
      target,
      connection,
      request.protocols ?? [],
      receiveBudget,
      onRetired,
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
    try {
      await awaitWithSignal(
        connection.send(handshake),
        signal ?? new AbortController().signal,
      );
      await socket.#waitHandshake(key, signal);
      return socket;
    } catch (error) {
      socket.#abortOpen();
      connection.close();
      throw error;
    }
  }

  async send(data: string | ArrayBuffer, binary: boolean): Promise<number> {
    const payload =
      typeof data === "string"
        ? textEncoder.encode(data)
        : new Uint8Array(data);
    await this.#connection.send(websocketFrame(binary ? 2 : 1, payload));
    return payload.byteLength;
  }

  ownedBy(target: MessageEventSource): boolean {
    return this.target === target;
  }

  get terminal(): boolean {
    return this.#closed;
  }

  acknowledgeSend(byteLength: number): void {
    this.#post({ event: "send-ack", byteLength });
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseReceiveState();
    const reasonBytes = textEncoder.encode(reason).subarray(0, 123);
    const payload = new Uint8Array(2 + reasonBytes.byteLength);
    new DataView(payload.buffer).setUint16(0, code, false);
    payload.set(reasonBytes, 2);
    try {
      await boundedOperation(
        (signal) =>
          awaitWithSignal(
            this.#connection.send(websocketFrame(8, payload)),
            signal,
          ),
        5_000,
        "Protected Code WebSocket close timed out.",
      );
      this.#connection.halfClose();
    } catch {
      this.#connection.close();
    } finally {
      this.#postClose(code, reason, true);
      this.#retire();
    }
  }

  async #waitHandshake(key: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!this.#handshake) {
      if (this.#closed) {
        throw new Error("Protected Code WebSocket closed during handshake.");
      }
      signal?.throwIfAborted();
      if (Date.now() >= deadline)
        throw new Error("Protected Code WebSocket handshake timed out.");
      await boundedOperation(
        () => new Promise((resolve) => setTimeout(resolve, 10)),
        Math.max(1, deadline - Date.now()),
        "Protected Code WebSocket handshake timed out.",
        signal,
      );
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
    if (protocol && !this.protocols.includes(protocol)) {
      throw new Error("Protected Code WebSocket selected an invalid protocol.");
    }
    this.#consumeBuffer(headEnd + 4, 0);
    this.#post({ event: "open", protocol });
    this.#frames();
  }

  async #data(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength > MAX_SOCKET_BUFFER_BYTES - this.#buffer.byteLength) {
      throw new BrowserSocketReceiveOverflowError(
        "Protected Code WebSocket receive buffer is congested.",
      );
    }
    if (!this.receiveBudget.reserve(chunk.byteLength)) {
      throw new BrowserSocketReceiveOverflowError(
        "Protected Code WebSocket session receive buffer exceeded 32 MiB.",
      );
    }
    let committed = false;
    try {
      const next = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
      next.set(this.#buffer);
      next.set(chunk, this.#buffer.byteLength);
      this.#buffer = next;
      committed = true;
    } finally {
      if (!committed) this.receiveBudget.release(chunk.byteLength);
    }
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
      const opcode = first & 0x0f;
      if (
        ((opcode === 1 || opcode === 2) && length > MAX_SOCKET_BUFFER_BYTES) ||
        (opcode === 0 &&
          this.#fragmentOpcode &&
          length > MAX_SOCKET_BUFFER_BYTES - this.#fragmentBytes)
      ) {
        throw new BrowserSocketReceiveOverflowError(
          "Protected Code WebSocket message is too large.",
        );
      }
      const payload = Uint8Array.from(
        this.#buffer.subarray(offset, offset + length),
      );
      const retainsPayload =
        opcode === 1 || opcode === 2 || (opcode === 0 && this.#fragmentOpcode);
      this.#consumeBuffer(offset + length, retainsPayload ? length : 0);
      const final = (first & 0x80) !== 0;
      if (opcode === 9) {
        void this.#connection
          .send(websocketFrame(10, payload))
          .catch((error) => this.#failed(error));
      } else if (opcode === 8) {
        const code =
          payload.byteLength >= 2
            ? new DataView(payload.buffer).getUint16(0, false)
            : 1000;
        const reason =
          payload.byteLength > 2 ? textDecoder.decode(payload.subarray(2)) : "";
        this.#closed = true;
        this.#releaseReceiveState();
        this.#postClose(code, reason, true);
        this.#connection.close();
        this.#retire();
        return;
      } else if (opcode === 1 || opcode === 2) {
        this.#releaseFragments();
        this.#fragmentOpcode = opcode;
        this.#fragments = [payload];
        this.#fragmentBytes = payload.byteLength;
        if (final) this.#message();
      } else if (opcode === 0 && this.#fragmentOpcode) {
        this.#fragments.push(payload);
        this.#fragmentBytes += payload.byteLength;
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
    try {
      this.#post({
        event: "message",
        binary,
        data: binary ? payload.buffer : textDecoder.decode(payload),
      });
    } finally {
      this.#releaseFragments();
    }
  }

  #closedFromTunnel(error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseReceiveState();
    if (error) {
      this.#post({
        event: "error",
        message:
          error instanceof Error
            ? error.message
            : "Protected Code WebSocket failed.",
      });
    }
    this.#postClose(1006, "", false);
    this.#retire();
  }

  #failed(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseReceiveState();
    const overflow = error instanceof BrowserSocketReceiveOverflowError;
    this.#post({
      event: "error",
      message:
        error instanceof Error
          ? error.message
          : "Protected Code WebSocket failed.",
    });
    this.#postClose(
      overflow ? 1009 : 1006,
      overflow ? error.message : "",
      false,
    );
    this.#connection.close("protocol-error");
    this.#retire();
  }

  #abortOpen(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseReceiveState();
    this.#retire();
  }

  #consumeBuffer(consumedBytes: number, retainedBytes: number): void {
    this.#buffer = compactBrowserCodeBufferTail(this.#buffer, consumedBytes);
    this.receiveBudget.release(consumedBytes - retainedBytes);
  }

  #releaseFragments(): void {
    this.receiveBudget.release(this.#fragmentBytes);
    this.#fragmentOpcode = 0;
    this.#fragmentBytes = 0;
    this.#fragments = [];
  }

  #releaseReceiveState(): void {
    this.receiveBudget.release(this.#buffer.byteLength + this.#fragmentBytes);
    this.#buffer = new Uint8Array();
    this.#fragmentOpcode = 0;
    this.#fragmentBytes = 0;
    this.#fragments = [];
  }

  #retire(): void {
    this.onRetired();
  }

  #postClose(code: number, reason: string, wasClean: boolean): void {
    if (this.#closePosted) return;
    this.#closePosted = true;
    this.#post({ event: "close", code, reason, wasClean });
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
  readonly #httpRequests = new Map<string, AbortController>();
  readonly #pendingSockets = new Map<
    string,
    { controller: AbortController; target: MessageEventSource }
  >();
  readonly #sockets = new Map<string, BrowserCodeSocket>();
  readonly #socketReceiveBudget: BrowserSocketReceiveBudget = {
    release: (byteLength) => {
      this.#socketReceiveBytes = Math.max(
        0,
        this.#socketReceiveBytes - byteLength,
      );
    },
    reserve: (byteLength) => {
      if (byteLength > MAX_SOCKET_RECEIVE_BYTES - this.#socketReceiveBytes) {
        return false;
      }
      this.#socketReceiveBytes += byteLength;
      return true;
    },
  };
  #closePromise: Promise<void> | null = null;
  #failure: Error | null = null;
  #healthy = true;
  #removeTerminalListener: (() => void) | null = null;
  #socketReceiveBytes = 0;

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
    signal?: AbortSignal,
  ): Promise<BrowserCodeSession> {
    if (!("serviceWorker" in navigator)) {
      throw new Error("This browser cannot host protected Code attachments.");
    }
    const registration = await boundedOperation(
      () =>
        navigator.serviceWorker.register(SERVICE_WORKER_PATH, { scope: "/" }),
      SERVICE_WORKER_READY_TIMEOUT_MS,
      "Protected Code service worker registration timed out.",
      signal,
    );
    const readyRegistration = await boundedOperation(
      () => navigator.serviceWorker.ready,
      SERVICE_WORKER_READY_TIMEOUT_MS,
      "Protected Code service worker readiness timed out.",
      signal,
    );
    if (!readyRegistration.active && !registration.active)
      throw new Error("Protected Code service worker is unavailable.");
    const adapterId = crypto.randomUUID();
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
    const tunnel = await BrowserTunnelClient.open(wire.tunnelId, signal);
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
    for (const controller of this.#httpRequests.values()) {
      controller.abort(abortError("Protected Code attachment closed."));
    }
    this.#httpRequests.clear();
    for (const pending of this.#pendingSockets.values()) {
      pending.controller.abort(abortError("Protected Code attachment closed."));
    }
    this.#pendingSockets.clear();
    const sockets = [...this.#sockets.values()];
    this.#sockets.clear();
    await Promise.all(
      sockets.map((socket) =>
        socket.close(1001, "Code attachment closed").catch(() => undefined),
      ),
    );
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

  readonly #http = (
    event: MessageEvent<HttpProxyRequest | HttpProxyCancel>,
  ) => {
    const request = event.data;
    if (
      request?.type === "cantrip-code-http-cancel-v1" &&
      request.adapterId === this.adapterId
    ) {
      const controller = this.#httpRequests.get(request.requestId);
      if (!controller) return;
      this.#httpRequests.delete(request.requestId);
      controller.abort(abortError("Protected Code request was cancelled."));
      return;
    }
    if (
      request?.type !== "cantrip-code-http-request-v1" ||
      request.adapterId !== this.adapterId ||
      typeof request.requestId !== "string" ||
      this.#httpRequests.has(request.requestId)
    )
      return;
    if (this.#httpRequests.size >= MAX_BROWSER_HTTP_REQUESTS) {
      this.#channel.postMessage({
        adapterId: this.adapterId,
        type: "cantrip-code-http-response-v1",
        requestId: request.requestId,
        error: "Protected Code request limit was reached.",
      });
      return;
    }
    const controller = new AbortController();
    this.#httpRequests.set(request.requestId, controller);
    void proxyBrowserCodeHttp(this.tunnel, request, {
      signal: controller.signal,
    })
      .then((response) =>
        this.#channel.postMessage({
          adapterId: this.adapterId,
          type: "cantrip-code-http-response-v1",
          requestId: request.requestId,
          ...response,
        }),
      )
      .catch((error) =>
        this.#channel.postMessage({
          adapterId: this.adapterId,
          type: "cantrip-code-http-response-v1",
          requestId: request.requestId,
          error:
            error instanceof Error
              ? error.message
              : "Protected Code request failed.",
        }),
      )
      .finally(() => {
        if (this.#httpRequests.get(request.requestId) === controller) {
          this.#httpRequests.delete(request.requestId);
        }
      });
  };

  readonly #socket = (event: MessageEvent<SocketRequest>) => {
    if (event.origin !== window.location.origin) return;
    const request = event.data;
    if (
      !request ||
      typeof request.type !== "string" ||
      request.adapterId !== this.adapterId ||
      !request.type.startsWith("cantrip-code-websocket-")
    )
      return;
    const target = event.source;
    if (!target || !("postMessage" in target)) return;
    if (request.type === "cantrip-code-websocket-open-v1") {
      if (
        typeof request.socketId !== "string" ||
        request.socketId.length < 1 ||
        request.socketId.length > 200 ||
        typeof request.url !== "string" ||
        !validSocketProtocols(request.protocols) ||
        this.#pendingSockets.has(request.socketId) ||
        this.#sockets.has(request.socketId) ||
        this.#pendingSockets.size + this.#sockets.size >=
          MAX_BROWSER_CODE_SOCKETS
      ) {
        this.#postSocketFailure(
          target as WindowProxy,
          request.socketId,
          "Protected Code WebSocket request was invalid or duplicated.",
        );
        return;
      }
      const pending = {
        controller: new AbortController(),
        target,
      };
      this.#pendingSockets.set(request.socketId, pending);
      let opened: BrowserCodeSocket | null = null;
      void BrowserCodeSocket.open(
        this.tunnel,
        request,
        target as WindowProxy,
        this.#socketReceiveBudget,
        pending.controller.signal,
        () => {
          if (opened && this.#sockets.get(request.socketId) === opened) {
            this.#sockets.delete(request.socketId);
          }
        },
      )
        .then((socket) => {
          opened = socket;
          const stillPending =
            this.#pendingSockets.get(request.socketId) === pending;
          if (
            !stillPending ||
            pending.controller.signal.aborted ||
            socket.terminal
          ) {
            if (stillPending) this.#pendingSockets.delete(request.socketId);
            void socket.close(1000, "Socket open cancelled");
            return;
          }
          this.#pendingSockets.delete(request.socketId);
          this.#sockets.set(request.socketId, socket);
        })
        .catch((error) => {
          if (this.#pendingSockets.get(request.socketId) !== pending) return;
          this.#pendingSockets.delete(request.socketId);
          this.#postSocketFailure(
            target as WindowProxy,
            request.socketId,
            error instanceof Error
              ? error.message
              : "Protected Code WebSocket failed.",
          );
        });
      return;
    }
    if (
      typeof request.socketId !== "string" ||
      request.socketId.length < 1 ||
      request.socketId.length > 200
    ) {
      return;
    }
    const pending = this.#pendingSockets.get(request.socketId);
    if (pending) {
      if (
        request.type === "cantrip-code-websocket-close-v1" &&
        pending.target === target
      ) {
        this.#pendingSockets.delete(request.socketId);
        pending.controller.abort(abortError("Socket open was cancelled."));
        (target as WindowProxy).postMessage(
          {
            adapterId: this.adapterId,
            socketId: request.socketId,
            type: SOCKET_EVENT,
            event: "close",
            code: request.code ?? 1000,
            reason: request.reason ?? "",
            wasClean: true,
          },
          { targetOrigin: window.location.origin },
        );
      }
      return;
    }
    const socket = this.#sockets.get(request.socketId);
    if (!socket || !socket.ownedBy(target)) return;
    if (request.type === "cantrip-code-websocket-send-v1") {
      if (
        request.data === undefined ||
        (typeof request.data !== "string" &&
          !(request.data instanceof ArrayBuffer)) ||
        (request.binary !== undefined && typeof request.binary !== "boolean")
      ) {
        this.#sockets.delete(request.socketId);
        this.#postSocketFailure(
          target as WindowProxy,
          request.socketId,
          "Protected Code WebSocket send payload was invalid.",
        );
        void socket.close(1002, "Invalid socket payload");
        return;
      }
      void socket
        .send(request.data, request.binary ?? false)
        .then((byteLength) => {
          if (
            this.#sockets.get(request.socketId) === socket &&
            socket.ownedBy(target)
          ) {
            socket.acknowledgeSend(byteLength);
          }
        })
        .catch((error) => {
          if (this.#sockets.get(request.socketId) !== socket) return;
          this.#sockets.delete(request.socketId);
          this.#postSocketFailure(
            target as WindowProxy,
            request.socketId,
            error instanceof Error
              ? error.message
              : "Protected Code WebSocket send failed.",
          );
          void socket.close(1011, "Socket send failed");
        });
      return;
    }
    if (request.type === "cantrip-code-websocket-close-v1") {
      this.#sockets.delete(request.socketId);
      void socket.close(request.code, request.reason);
    }
  };

  #postSocketFailure(
    destination: WindowProxy,
    socketId: string,
    message: string,
  ): void {
    const base = {
      adapterId: this.adapterId,
      socketId,
      type: SOCKET_EVENT,
    };
    destination.postMessage(
      { ...base, event: "error", message },
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
  }
}

const sessions = new Map<string, BrowserCodeSession>();
interface PendingBrowserCodeStart {
  controller: AbortController;
  removeCallerAbort(): void;
  token: symbol;
}

const pendingStarts = new Map<string, PendingBrowserCodeStart>();

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
  options: { signal?: AbortSignal } = {},
): Promise<CodeAttachment> {
  options.signal?.throwIfAborted();
  const startToken = Symbol(wire.tunnelId);
  const previousPending = pendingStarts.get(wire.tunnelId);
  previousPending?.controller.abort(
    abortError("Protected Code attachment startup was superseded."),
  );
  const controller = new AbortController();
  const onCallerAbort = () =>
    controller.abort(
      options.signal?.reason ??
        abortError("Protected Code attachment startup was aborted."),
    );
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (options.signal?.aborted) onCallerAbort();
  const pending = {
    controller,
    removeCallerAbort: () =>
      options.signal?.removeEventListener("abort", onCallerAbort),
    token: startToken,
  };
  pendingStarts.set(wire.tunnelId, pending);
  try {
    const existing = sessions.get(wire.tunnelId);
    if (existing) {
      sessions.delete(wire.tunnelId);
      await existing.close();
    }
    const session = await BrowserCodeSession.open(
      wire,
      (failed, error) => {
        if (sessions.get(wire.tunnelId) !== failed) return;
        sessions.delete(wire.tunnelId);
        notifyBrowserCodeAttachmentUnavailable(wire.tunnelId, error);
      },
      controller.signal,
    );
    if (!session.healthy) {
      await session.close();
      throw (
        session.failure ??
        new Error("The protected Code relay disconnected during startup.")
      );
    }
    if (controller.signal.aborted) {
      await session.close();
      throw (
        controller.signal.reason ??
        abortError("Protected Code attachment startup was aborted.")
      );
    }
    if (pendingStarts.get(wire.tunnelId)?.token !== startToken) {
      await session.close();
      throw new DOMException(
        "Protected Code attachment startup was superseded.",
        "AbortError",
      );
    }
    sessions.set(wire.tunnelId, session);
    return session.attachment;
  } finally {
    pending.removeCallerAbort();
    if (pendingStarts.get(wire.tunnelId)?.token === startToken) {
      pendingStarts.delete(wire.tunnelId);
    }
  }
}

export async function stopBrowserCodeAttachment(
  tunnelId: string,
): Promise<void> {
  const pending = pendingStarts.get(tunnelId);
  if (pending) {
    pendingStarts.delete(tunnelId);
    pending.controller.abort(
      abortError("Protected Code attachment startup was superseded."),
    );
  }
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
