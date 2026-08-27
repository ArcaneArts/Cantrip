import {
  directBrokerReadySchema,
  type DirectAttachmentTicket,
  type WorkerLinkRoute,
  type WorkerLinkSession,
  type ValidatedWorkerLinkFrame,
} from "@cantrip/protocol";

const CONNECT_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_BYTES = 8 * 1_024 * 1_024;
const DIRECT_RENEW_INTERVAL_MS = 20_000;

export type WorkerLinkCarrierCloseListener = (reason: string) => void;
export type WorkerLinkCarrierFrameListener = (frame: Uint8Array) => void;

export interface WorkerLinkCarrier {
  readonly latencyMs: number | null;
  readonly route: WorkerLinkRoute;
  close(reason?: string): void;
  onClose(listener: WorkerLinkCarrierCloseListener): () => void;
  onFrame(listener: WorkerLinkCarrierFrameListener): () => void;
  send(frame: ValidatedWorkerLinkFrame): boolean;
}

export function workerLinkFrameBufferSource(
  frame: ValidatedWorkerLinkFrame,
): Uint8Array<ArrayBuffer> {
  return frame.bytes.buffer instanceof ArrayBuffer
    ? (frame.bytes as Uint8Array<ArrayBuffer>)
    : Uint8Array.from(frame.bytes);
}

export interface WorkerLinkWebSocketLike {
  binaryType: string;
  bufferedAmount: number;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  addEventListener(
    event: "open" | "close" | "error",
    listener: (event: Event) => void,
    options?: { once?: boolean },
  ): void;
  addEventListener(
    event: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    event: "open" | "close" | "error",
    listener: (event: Event) => void,
  ): void;
  removeEventListener(
    event: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  send(data: string | Blob | BufferSource): void;
}

export interface WorkerLinkLocalCarrierOptions {
  activateCapability(sessionId: string, capabilityId: string): Promise<void>;
  createTicket(sessionId: string): Promise<DirectAttachmentTicket>;
  createWebSocket(url: string): WorkerLinkWebSocketLike;
  recordActivity(capabilityId: string): Promise<void>;
  releaseCapability(capabilityId: string): Promise<void>;
  session: WorkerLinkSession;
}

export interface WorkerLinkRelayCarrierOptions {
  browserOrigin: string;
  clientInstanceId: string;
  createWebSocket(url: string): WorkerLinkWebSocketLike;
  serverUrl: string;
  session: WorkerLinkSession;
}

class WebSocketWorkerLinkCarrier implements WorkerLinkCarrier {
  readonly #closeListeners = new Set<WorkerLinkCarrierCloseListener>();
  #closed = false;
  readonly #frameListeners = new Set<WorkerLinkCarrierFrameListener>();

  constructor(
    readonly route: "local" | "relay",
    readonly latencyMs: number | null,
    private readonly socket: WorkerLinkWebSocketLike,
    private readonly cleanup: () => void,
  ) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      void messageBytes(event.data).then((bytes) => {
        if (this.#closed || !bytes) return;
        for (const listener of this.#frameListeners) listener(bytes);
      });
    });
    const closed = () => this.#retire("carrier-disconnected");
    socket.addEventListener("close", closed, { once: true });
    socket.addEventListener("error", closed, { once: true });
  }

  send(frame: ValidatedWorkerLinkFrame): boolean {
    if (
      this.#closed ||
      this.socket.readyState !== 1 ||
      this.socket.bufferedAmount > MAX_BUFFERED_BYTES
    ) {
      return false;
    }
    try {
      this.socket.send(workerLinkFrameBufferSource(frame));
      return true;
    } catch {
      this.#retire("carrier-send-failed");
      return false;
    }
  }

  onClose(listener: WorkerLinkCarrierCloseListener): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onFrame(listener: WorkerLinkCarrierFrameListener): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  close(reason = "carrier-closed"): void {
    if (this.#closed) return;
    this.socket.close(1000, reason.slice(0, 123));
    this.#retire(reason);
  }

  #retire(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.cleanup();
    for (const listener of this.#closeListeners) listener(reason);
    this.#closeListeners.clear();
    this.#frameListeners.clear();
  }
}

export async function openWorkerLinkRelayCarrier(
  options: WorkerLinkRelayCarrierOptions,
): Promise<WorkerLinkCarrier> {
  const url = new URL(
    `/api/worker-links/${encodeURIComponent(options.session.sessionId)}/connect`,
    options.serverUrl || options.browserOrigin,
  );
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else throw new Error("WorkerLink relay requires HTTP or HTTPS.");
  url.searchParams.set("clientInstanceId", options.clientInstanceId);
  const startedAt = performance.now();
  const socket = options.createWebSocket(url.toString());
  await waitForOpen(socket, CONNECT_TIMEOUT_MS);
  return new WebSocketWorkerLinkCarrier(
    "relay",
    Math.max(0, performance.now() - startedAt),
    socket,
    () => undefined,
  );
}

export async function openWorkerLinkLocalCarrier(
  options: WorkerLinkLocalCarrierOptions,
): Promise<WorkerLinkCarrier> {
  const ticket = await options.createTicket(options.session.sessionId);
  let capabilityId: string | null = ticket.binding.capabilityId;
  let socket: WorkerLinkWebSocketLike | null = null;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const startedAt = performance.now();
    socket = options.createWebSocket(
      `ws://127.0.0.1:${ticket.broker.loopbackPort}/direct/v1`,
    );
    await waitForOpen(socket, CONNECT_TIMEOUT_MS);
    const challenge = encodeBase64Url(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const readyPromise = waitForMessage(socket, CONNECT_TIMEOUT_MS);
    socket.send(
      JSON.stringify({
        type: "initialize",
        binding: ticket.binding,
        secret: ticket.secret,
        challenge,
      }),
    );
    ticket.secret = "";
    const ready = directBrokerReadySchema.parse(
      JSON.parse(String(await readyPromise)),
    );
    await verifyDirectBroker(ticket, ready, challenge);
    await options.activateCapability(
      options.session.sessionId,
      ticket.binding.capabilityId,
    );
    const connectedSocket = socket;
    const connectedCapabilityId = capabilityId;
    let carrier!: WebSocketWorkerLinkCarrier;
    const scheduleRenewal = () => {
      renewTimer = setTimeout(() => {
        renewTimer = null;
        if (!capabilityId) return;
        void options
          .recordActivity(capabilityId)
          .then(scheduleRenewal)
          .catch(() => carrier.close("local-capability-renewal-failed"));
      }, DIRECT_RENEW_INTERVAL_MS);
    };
    carrier = new WebSocketWorkerLinkCarrier(
      "local",
      Math.max(0, performance.now() - startedAt),
      connectedSocket,
      () => {
        if (renewTimer) clearTimeout(renewTimer);
        renewTimer = null;
        capabilityId = null;
        void options
          .releaseCapability(connectedCapabilityId)
          .catch(() => undefined);
      },
    );
    scheduleRenewal();
    return carrier;
  } catch (error) {
    if (renewTimer) clearTimeout(renewTimer);
    socket?.close(1000, "WorkerLink local setup failed");
    if (capabilityId) {
      await options.releaseCapability(capabilityId).catch(() => undefined);
    }
    ticket.secret = "";
    throw error;
  }
}

async function verifyDirectBroker(
  ticket: DirectAttachmentTicket,
  ready: ReturnType<typeof directBrokerReadySchema.parse>,
  challenge: string,
): Promise<void> {
  if (
    ready.brokerInstanceId !== ticket.broker.instanceId ||
    ready.fingerprint !== ticket.broker.fingerprint ||
    ready.challenge !== challenge ||
    Date.parse(ready.leaseExpiresAt) <= Date.now()
  ) {
    throw new Error(
      "Local WorkerLink broker identity did not match authority.",
    );
  }
  const publicKeyBytes = decodeBase64Url(ticket.broker.publicKey);
  const fingerprint = new Uint8Array(
    await crypto.subtle.digest("SHA-256", copiedArrayBuffer(publicKeyBytes)),
  );
  if (hex(fingerprint) !== ticket.broker.fingerprint) {
    throw new Error("Local WorkerLink broker fingerprint was rejected.");
  }
  const publicKey = await crypto.subtle.importKey(
    "raw",
    copiedArrayBuffer(publicKeyBytes),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(
    `cantrip-direct-v1\0${ticket.binding.capabilityId}\0${challenge}`,
  );
  if (
    !(await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      copiedArrayBuffer(decodeBase64Url(ready.signature)),
      copiedArrayBuffer(signed),
    ))
  ) {
    throw new Error("Local WorkerLink broker signature was rejected.");
  }
}

function waitForOpen(
  socket: WorkerLinkWebSocketLike,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("close", failed);
      socket.removeEventListener("error", failed);
    };
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("WorkerLink carrier connection failed."));
    };
    const timeout = setTimeout(() => {
      cleanup();
      socket.close(1000, "WorkerLink connection timed out");
      reject(new Error("WorkerLink carrier connection timed out."));
    }, timeoutMs);
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("close", failed, { once: true });
    socket.addEventListener("error", failed, { once: true });
  });
}

function waitForMessage(
  socket: WorkerLinkWebSocketLike,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", received);
      socket.removeEventListener("close", failed);
      socket.removeEventListener("error", failed);
    };
    const received = (event: MessageEvent) => {
      cleanup();
      resolve(event.data);
    };
    const failed = () => {
      cleanup();
      reject(new Error("WorkerLink broker proof connection failed."));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("WorkerLink broker proof timed out."));
    }, timeoutMs);
    socket.addEventListener("message", received);
    socket.addEventListener("close", failed, { once: true });
    socket.addEventListener("error", failed, { once: true });
  });
}

async function messageBytes(value: unknown): Promise<Uint8Array | null> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return null;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function copiedArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}
