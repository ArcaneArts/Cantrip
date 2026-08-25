import {
  appLiveScopeKey,
  decodeAppLiveServerMessage,
  encodeAppLiveClientMessage,
} from "@cantrip/protocol";
import type {
  AppLiveClientMessage,
  AppLiveErrorCode,
  AppLiveResyncReason,
  AppLiveScope,
  AppLiveServerMessage,
  ClientControlAcknowledgement,
  ClientControlCapability,
  ClientControlCommand,
} from "@cantrip/protocol";

import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";

const OPEN_SOCKET_STATE = 1;
const RESUME_STORAGE_VERSION = 1;
const MIN_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_CONTROL_ACKNOWLEDGEMENTS = 256;
const CURSOR_PERSIST_INTERVAL_MS = 200;

type AppLiveEvent = Extract<AppLiveServerMessage, { type: "event" }>;
type AppLiveReadyMessage = Extract<AppLiveServerMessage, { type: "ready" }>;

export type AppLiveClientStatus =
  | "stopped"
  | "connecting"
  | "initializing"
  | "replaying"
  | "resyncing"
  | "live"
  | "waiting-to-reconnect";

export interface AppLiveClientSnapshot {
  activeScopeCount: number;
  desiredScopeCount: number;
  lastCursor: number | null;
  lastError: string | null;
  reconnectAttempt: number;
  serverEpoch: string | null;
  status: AppLiveClientStatus;
}

export interface AppLiveClientSocket {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  onClose(listener: (event: { code: number; reason: string }) => void): void;
  onError(listener: () => void): void;
  onMessage(listener: (data: unknown) => void): void;
  onOpen(listener: () => void): void;
  send(data: string): void;
}

export interface AppLiveClientStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface AppLiveClientOptions {
  client: {
    id: string;
    name: string;
    version: string;
    controlCapabilities?: ClientControlCapability[];
  };
  onAuthenticationRequired?(reason: string): void;
  onEvent(event: AppLiveEvent): void;
  onProtocolError?(error: {
    code: AppLiveErrorCode;
    message: string;
    retryable: boolean;
  }): void;
  onResync(
    scopes: AppLiveScope[],
    reason: AppLiveResyncReason,
  ): Promise<void> | void;
  random?: () => number;
  storage?: AppLiveClientStorage;
  storageKey: string;
  url: string;
  webSocketFactory?: (url: string) => AppLiveClientSocket;
}

export interface ClientControlHandlerResult {
  status: "applied" | "declined" | "unsupported";
  detail?: string | null;
}

export type ClientControlHandler = (
  command: ClientControlCommand,
) => Promise<ClientControlHandlerResult> | ClientControlHandlerResult;

interface StoredResumePoint {
  cursor: number;
  serverEpoch: string;
  version: typeof RESUME_STORAGE_VERSION;
}

interface ScopeReference {
  count: number;
  scope: AppLiveScope;
}

interface PendingRequest {
  kind: "resync" | "subscribe" | "unsubscribe";
  scopes: AppLiveScope[];
}

function browserWebSocket(url: string): AppLiveClientSocket {
  const socket = new WebSocket(url);
  return {
    get readyState() {
      return socket.readyState;
    },
    close: (code, reason) => socket.close(code, reason),
    onClose: (listener) =>
      socket.addEventListener("close", (event) =>
        listener({ code: event.code, reason: event.reason }),
      ),
    onError: (listener) => socket.addEventListener("error", () => listener()),
    onMessage: (listener) =>
      socket.addEventListener("message", (event) => listener(event.data)),
    onOpen: (listener) => socket.addEventListener("open", () => listener()),
    send: (data) => socket.send(data),
  };
}

function parseResumePoint(value: string | null): StoredResumePoint | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredResumePoint>;
    return parsed.version === RESUME_STORAGE_VERSION &&
      typeof parsed.serverEpoch === "string" &&
      parsed.serverEpoch.length > 0 &&
      typeof parsed.cursor === "number" &&
      Number.isSafeInteger(parsed.cursor) &&
      parsed.cursor >= 0
      ? {
          version: RESUME_STORAGE_VERSION,
          serverEpoch: parsed.serverEpoch,
          cursor: parsed.cursor,
        }
      : null;
  } catch {
    return null;
  }
}

export function appLiveWebSocketUrl(
  serverUrl: string,
  browserOrigin: string,
): string {
  const url = new URL("/api/live", serverUrl || browserOrigin);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else throw new Error("The application live server must use HTTP or HTTPS.");
  return url.toString();
}

export class AppLiveClient {
  readonly #activeScopes = new Map<string, AppLiveScope>();
  readonly #blockedScopes = new Set<string>();
  readonly #controlAcknowledgements = new Map<
    string,
    ClientControlAcknowledgement
  >();
  readonly #controlAcknowledgementPromises = new Map<
    string,
    Promise<ClientControlAcknowledgement>
  >();
  readonly #listeners = new Set<(snapshot: AppLiveClientSnapshot) => void>();
  readonly #options: AppLiveClientOptions;
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #scopeReferences = new Map<string, ScopeReference>();
  readonly #statusListeners = new Set<(status: AppLiveClientStatus) => void>();
  readonly #webSocketFactory: (url: string) => AppLiveClientSocket;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  #connectStartedAt = 0;
  #controlHandler: ClientControlHandler | null = null;
  #cursorPersistenceTimer: ReturnType<typeof setTimeout> | null = null;
  #lastCursor: number | null = null;
  #lastError: string | null = null;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #requestSequence = 0;
  #persistedCursor: number | null = null;
  #persistedServerEpoch: string | null = null;
  #resyncGeneration = 0;
  #resyncRunning = false;
  #resumeMode: AppLiveReadyMessage["resume"] | null = null;
  #running = false;
  #safeCursor: number | null = null;
  #scopeGeneration = 0;
  #serverEpoch: string | null = null;
  #socket: AppLiveClientSocket | null = null;
  #snapshotBarrierCount = 0;
  #status: AppLiveClientStatus = "stopped";

  constructor(options: AppLiveClientOptions) {
    this.#options = options;
    this.#webSocketFactory = options.webSocketFactory ?? browserWebSocket;
    const stored = parseResumePoint(
      options.storage?.getItem(options.storageKey) ?? null,
    );
    if (stored) {
      this.#serverEpoch = stored.serverEpoch;
      this.#lastCursor = stored.cursor;
      this.#safeCursor = stored.cursor;
      this.#persistedCursor = stored.cursor;
      this.#persistedServerEpoch = stored.serverEpoch;
    } else if (options.storage?.getItem(options.storageKey)) {
      options.storage.removeItem(options.storageKey);
    }
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    clientLogger.info("Application live channel started", {
      counts: { desiredScopes: this.#scopeReferences.size },
      event: "live.channel.started",
      operation: "connect",
      subsystem: "live-channel",
    });
    this.#connect();
  }

  stop(): void {
    this.flushCursorPersistence();
    if (!this.#running && this.#status === "stopped") return;
    this.#running = false;
    this.#resyncGeneration += 1;
    this.#clearReconnectTimer();
    this.#clearConnectTimer();
    this.#clearHeartbeat();
    const socket = this.#socket;
    this.#socket = null;
    if (socket) socket.close(1000, "Application live client stopped");
    this.#activeScopes.clear();
    this.#controlAcknowledgements.clear();
    this.#controlAcknowledgementPromises.clear();
    this.#pendingRequests.clear();
    this.#snapshotBarrierCount = 0;
    this.#lastCursor = this.#safeCursor;
    this.#setStatus("stopped");
    clientLogger.info("Application live channel stopped", {
      event: "live.channel.stopped",
      operation: "disconnect",
      status: "stopped",
      subsystem: "live-channel",
    });
  }

  reconnectNow(): void {
    if (!this.#running) return;
    this.#clearReconnectTimer();
    this.#clearConnectTimer();
    const socket = this.#socket;
    this.#socket = null;
    if (socket) socket.close(1012, "Application live reconnect requested");
    this.#connect();
  }

  registerClientControlHandler(handler: ClientControlHandler): () => void {
    this.#controlHandler = handler;
    return () => {
      if (this.#controlHandler === handler) this.#controlHandler = null;
    };
  }

  retainScope(scope: AppLiveScope): () => void {
    const key = appLiveScopeKey(scope);
    const existing = this.#scopeReferences.get(key);
    this.#scopeReferences.set(key, {
      count: (existing?.count ?? 0) + 1,
      scope,
    });
    if (!existing) {
      this.#scopeGeneration += 1;
      this.#syncScopes();
      this.#emit();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#scopeReferences.get(key);
      if (!current) return;
      if (current.count > 1) {
        this.#scopeReferences.set(key, {
          ...current,
          count: current.count - 1,
        });
        return;
      }
      this.#scopeReferences.delete(key);
      this.#blockedScopes.delete(key);
      this.#scopeGeneration += 1;
      this.#syncScopes();
      this.#emit();
    };
  }

  snapshot(): AppLiveClientSnapshot {
    return {
      activeScopeCount: this.#activeScopes.size,
      desiredScopeCount: this.#scopeReferences.size,
      lastCursor: this.#lastCursor,
      lastError: this.#lastError,
      reconnectAttempt: this.#reconnectAttempt,
      serverEpoch: this.#serverEpoch,
      status: this.#status,
    };
  }

  status(): AppLiveClientStatus {
    return this.#status;
  }

  subscribe(listener: (snapshot: AppLiveClientSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  subscribeStatus(listener: (status: AppLiveClientStatus) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  flushCursorPersistence(): void {
    this.#clearCursorPersistenceTimer();
    this.#persistCursor();
  }

  #connect(): void {
    if (!this.#running || this.#socket) return;
    this.#setStatus("connecting");
    this.#lastError = null;
    this.#connectStartedAt = performance.now();
    clientLogger.debug("Connecting application live channel", {
      attempt: this.#reconnectAttempt + 1,
      counts: { desiredScopes: this.#scopeReferences.size },
      event: "live.channel.connecting",
      operation: "connect",
      subsystem: "live-channel",
    });
    let socket: AppLiveClientSocket;
    try {
      socket = this.#webSocketFactory(this.#options.url);
    } catch (error) {
      this.#lastError =
        error instanceof Error ? error.message : "Could not open live socket.";
      this.#scheduleReconnect();
      clientLogger.rateLimited(
        "live-channel-open-failed",
        "warn",
        "Application live channel could not be opened",
        {
          attempt: this.#reconnectAttempt + 1,
          durationMs: Math.round(performance.now() - this.#connectStartedAt),
          error:
            error instanceof Error
              ? error
              : new Error("Socket creation failed"),
          event: "live.channel.connect.failed",
          operation: "connect",
          reasonCode: "socket-create-failed",
          status: "failed",
          subsystem: "live-channel",
        },
      );
      return;
    }
    this.#socket = socket;
    this.#connectTimer = setTimeout(() => {
      if (this.#socket === socket) {
        clientLogger.rateLimited(
          "live-channel-timeout",
          "warn",
          "Application live channel connection timed out",
          {
            attempt: this.#reconnectAttempt + 1,
            durationMs: CONNECT_TIMEOUT_MS,
            event: "live.channel.connect.failed",
            operation: "connect",
            reasonCode: "timeout",
            status: "failed",
            subsystem: "live-channel",
          },
        );
        socket.close(1013, "Application live connection timed out");
      }
    }, CONNECT_TIMEOUT_MS);
    socket.onOpen(() => this.#handleSocketOpen(socket));
    socket.onMessage((data) => this.#handleSocketMessage(socket, data));
    socket.onError(() => this.#handleSocketError(socket));
    socket.onClose((event) => this.#handleSocketClose(socket, event));
  }

  #handleSocketOpen(socket: AppLiveClientSocket): void {
    if (this.#socket !== socket || !this.#running) return;
    this.#setStatus("initializing");
    clientLogger.debug("Application live socket opened", {
      attempt: this.#reconnectAttempt + 1,
      durationMs: Math.round(performance.now() - this.#connectStartedAt),
      event: "live.channel.socket-opened",
      operation: "initialize",
      subsystem: "live-channel",
    });
    this.#send({
      type: "initialize",
      protocolVersion: 1,
      client: {
        ...this.#options.client,
        controlCapabilities: this.#options.client.controlCapabilities ?? [],
      },
      resume:
        this.#serverEpoch !== null && this.#safeCursor !== null
          ? {
              serverEpoch: this.#serverEpoch,
              cursor: this.#safeCursor,
            }
          : null,
    });
  }

  #handleSocketMessage(socket: AppLiveClientSocket, data: unknown): void {
    if (this.#socket !== socket || !this.#running) return;
    this.#handleServerFrame(data);
  }

  #handleSocketError(socket: AppLiveClientSocket): void {
    if (this.#socket !== socket || !this.#running) return;
    this.#lastError = "The application live connection encountered an error.";
    this.#emit();
    clientLogger.rateLimited(
      "live-channel-socket-error",
      "warn",
      "Application live socket encountered an error",
      {
        attempt: this.#reconnectAttempt + 1,
        event: "live.channel.socket-error",
        operation: "connect",
        reasonCode: "socket-error",
        subsystem: "live-channel",
      },
    );
  }

  #handleSocketClose(
    socket: AppLiveClientSocket,
    event: { code: number; reason: string },
  ): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#clearConnectTimer();
    this.#clearHeartbeat();
    this.#activeScopes.clear();
    this.#controlAcknowledgements.clear();
    this.#controlAcknowledgementPromises.clear();
    this.#pendingRequests.clear();
    this.#resumeMode = null;
    this.#snapshotBarrierCount = 0;
    this.#lastCursor = this.#safeCursor;
    this.#resyncGeneration += 1;
    this.#resyncRunning = false;
    clientLogger.debug("Application live socket disconnected", {
      closeCode: event.code,
      event: "live.channel.disconnected",
      operation: "disconnect",
      reasonCode:
        event.code === 1000
          ? "normal"
          : event.code === 1008
            ? "policy"
            : "transport",
      subsystem: "live-channel",
    });
    if (!this.#running) return;
    if (event.code === 1008 && /auth|session|sign[ -]?in/i.test(event.reason)) {
      this.#options.onAuthenticationRequired?.(
        event.reason || "Your Cantrip session has expired.",
      );
      clientLogger.warn("Application live authentication expired", {
        closeCode: event.code,
        event: "live.channel.authentication-required",
        operation: "authenticate",
        reasonCode: "session-expired",
        status: "stopped",
        subsystem: "live-channel",
      });
      this.stop();
      return;
    }
    if (event.code !== 1000) {
      this.#lastError =
        event.reason || `Application live connection closed (${event.code}).`;
    }
    this.#scheduleReconnect();
  }

  #handleServerFrame(data: unknown): void {
    if (typeof data !== "string") {
      this.#protocolFailure("The live server sent a non-text frame.");
      return;
    }
    const decoded = decodeAppLiveServerMessage(data);
    if (!decoded.success && decoded.reason === "invalid-json") {
      this.#protocolFailure("The live server sent invalid JSON.");
      return;
    }
    if (!decoded.success) {
      this.#protocolFailure(
        "The live server sent an invalid protocol message.",
      );
      return;
    }
    this.#handleServerMessage(decoded.data);
  }

  #handleServerMessage(message: AppLiveServerMessage): void {
    switch (message.type) {
      case "ready":
        this.#handleReady(message);
        return;
      case "subscribed":
        this.#handleSubscribed(message);
        return;
      case "unsubscribed":
        this.#handleUnsubscribed(message);
        return;
      case "event":
        this.#handleEvent(message);
        return;
      case "caught-up":
        this.#advanceCursor(message.cursor);
        this.#resumeMode = null;
        this.#reconnectAttempt = 0;
        this.#setStatus("live");
        this.#syncScopes();
        clientLogger.info("Application live channel caught up", {
          attempt: this.#reconnectAttempt + 1,
          counts: { activeScopes: this.#activeScopes.size },
          durationMs: Math.round(performance.now() - this.#connectStartedAt),
          event: "live.channel.ready",
          operation: "replay",
          status: "live",
          subsystem: "live-channel",
        });
        return;
      case "pong":
        if (this.#resumeMode === null) this.#advanceCursor(message.cursor);
        return;
      case "resync-required":
        this.#beginResync(message);
        return;
      case "client-control-request":
        void this.#handleClientControlRequest(message);
        return;
      case "error":
        const failedRequest = message.requestId
          ? this.#pendingRequests.get(message.requestId)
          : null;
        if (message.requestId) this.#pendingRequests.delete(message.requestId);
        if (!message.retryable && failedRequest) {
          for (const scope of failedRequest.scopes) {
            this.#blockedScopes.add(appLiveScopeKey(scope));
          }
        }
        this.#lastError = message.message;
        this.#options.onProtocolError?.({
          code: message.code,
          message: message.message,
          retryable: message.retryable,
        });
        this.#emit();
        clientLogger.rateLimited(
          `live-protocol:${message.code}`,
          message.retryable ? "warn" : "error",
          "Application live protocol reported an error",
          {
            event: "live.channel.protocol-error",
            operation: failedRequest?.kind ?? "protocol",
            reasonCode: message.code,
            retryable: message.retryable,
            status: "failed",
            subsystem: "live-channel",
          },
        );
        if (message.retryable) {
          this.#socket?.close(1012, "Retrying after live protocol error");
        } else {
          this.#syncScopes();
        }
    }
  }

  async #handleClientControlRequest(
    message: Extract<AppLiveServerMessage, { type: "client-control-request" }>,
  ): Promise<void> {
    const existing = this.#controlAcknowledgements.get(message.correlationId);
    if (existing) {
      this.#send({ type: "client-control-ack", ...existing });
      return;
    }
    const socket = this.#socket;
    const active = this.#controlAcknowledgementPromises.get(
      message.correlationId,
    );
    if (active) {
      const acknowledgement = await active;
      if (this.#socket === socket && this.#running) {
        this.#send({ type: "client-control-ack", ...acknowledgement });
      }
      return;
    }
    const acknowledgementPromise = (async () => {
      if (Date.now() >= Date.parse(message.expiresAt)) {
        return {
          correlationId: message.correlationId,
          status: "expired" as const,
          detail: null,
        };
      }
      if (
        !this.#options.client.controlCapabilities?.includes(
          message.command.kind,
        ) ||
        !this.#controlHandler
      ) {
        return {
          correlationId: message.correlationId,
          status: "unsupported" as const,
          detail: null,
        };
      }
      try {
        const result = await this.#controlHandler(message.command);
        return {
          correlationId: message.correlationId,
          status:
            Date.now() >= Date.parse(message.expiresAt)
              ? ("expired" as const)
              : result.status,
          detail: result.detail?.slice(0, 500) || null,
        };
      } catch {
        return {
          correlationId: message.correlationId,
          status: "declined" as const,
          detail: null,
        };
      }
    })();
    this.#controlAcknowledgementPromises.set(
      message.correlationId,
      acknowledgementPromise,
    );
    const acknowledgement = await acknowledgementPromise;
    if (
      this.#controlAcknowledgementPromises.get(message.correlationId) ===
      acknowledgementPromise
    ) {
      this.#controlAcknowledgementPromises.delete(message.correlationId);
    }
    if (this.#socket !== socket || !this.#running) return;
    this.#controlAcknowledgements.set(
      acknowledgement.correlationId,
      acknowledgement,
    );
    if (this.#controlAcknowledgements.size > MAX_CONTROL_ACKNOWLEDGEMENTS) {
      const oldest = this.#controlAcknowledgements.keys().next().value;
      if (oldest !== undefined) this.#controlAcknowledgements.delete(oldest);
    }
    this.#send({ type: "client-control-ack", ...acknowledgement });
  }

  #handleReady(message: AppLiveReadyMessage): void {
    this.#clearConnectTimer();
    if (this.#serverEpoch && this.#serverEpoch !== message.serverEpoch) {
      this.#lastCursor = null;
      this.#safeCursor = null;
    }
    this.#serverEpoch = message.serverEpoch;
    this.#resumeMode = message.resume;
    this.#activeScopes.clear();
    this.#blockedScopes.clear();
    this.#pendingRequests.clear();
    this.#startHeartbeat(message.heartbeatIntervalMs);
    clientLogger.info("Application live channel initialized", {
      attempt: this.#reconnectAttempt + 1,
      counts: { desiredScopes: this.#scopeReferences.size },
      durationMs: Math.round(performance.now() - this.#connectStartedAt),
      event: "live.channel.initialized",
      operation: "initialize",
      resumeMode: message.resume,
      subsystem: "live-channel",
    });
    if (message.resume === "replaying") this.#setStatus("replaying");
    else if (message.resume === "resync-required") this.#setStatus("resyncing");
    this.#syncScopes();
    if (this.#scopeReferences.size === 0) {
      this.#advanceCursor(message.currentCursor);
      this.#reconnectAttempt = 0;
      this.#setStatus("live");
    }
  }

  #handleSubscribed(
    message: Extract<AppLiveServerMessage, { type: "subscribed" }>,
  ): void {
    const pending = this.#pendingRequests.get(message.requestId);
    if (!pending) return;
    this.#pendingRequests.delete(message.requestId);
    if (pending.kind === "resync") {
      this.#activeScopes.clear();
    }
    for (const scope of pending.scopes) {
      this.#activeScopes.set(appLiveScopeKey(scope), scope);
    }

    if (pending.kind === "subscribe" && this.#resumeMode === "not-requested") {
      this.#recoverNewScopes(pending.scopes, message.cursor);
    } else if (pending.kind === "subscribe" && this.#resumeMode === null) {
      this.#recoverNewScopes(pending.scopes, message.cursor);
    } else if (pending.kind === "resync") {
      this.#resumeMode = "replaying";
      this.#setStatus("replaying");
    }
    this.#syncScopes();
  }

  #handleUnsubscribed(
    message: Extract<AppLiveServerMessage, { type: "unsubscribed" }>,
  ): void {
    const pending = this.#pendingRequests.get(message.requestId);
    if (!pending || pending.kind !== "unsubscribe") return;
    this.#pendingRequests.delete(message.requestId);
    for (const scope of pending.scopes) {
      this.#activeScopes.delete(appLiveScopeKey(scope));
    }
    this.#advanceCursor(message.cursor);
    this.#syncScopes();
  }

  #handleEvent(event: AppLiveEvent): void {
    if (this.#lastCursor !== null && event.cursor <= this.#lastCursor) return;
    this.#advanceCursor(event.cursor);
    this.#options.onEvent(event);
  }

  #recoverNewScopes(scopes: AppLiveScope[], cursor: number): void {
    const socket = this.#socket;
    const generation = this.#resyncGeneration;
    this.#snapshotBarrierCount += 1;
    this.#advanceCursor(cursor);
    this.#setStatus("resyncing");
    const startedAt = performance.now();
    clientLogger.debug("Refreshing application live scopes", {
      counts: { scopes: scopes.length },
      event: "live.channel.resync.started",
      operation: "scope-refresh",
      reasonCode: "scope-changed",
      subsystem: "live-channel",
    });
    void Promise.resolve(this.#options.onResync(scopes, "scope-changed")).then(
      () => {
        if (
          this.#socket !== socket ||
          generation !== this.#resyncGeneration ||
          !this.#running
        ) {
          return;
        }
        this.#snapshotBarrierCount = Math.max(
          0,
          this.#snapshotBarrierCount - 1,
        );
        if (this.#snapshotBarrierCount === 0) this.#commitCursor();
        this.#resumeMode = null;
        this.#reconnectAttempt = 0;
        this.#setStatus("live");
        this.#syncScopes();
        clientLogger.info("Application live scopes refreshed", {
          counts: { scopes: scopes.length },
          durationMs: Math.round(performance.now() - startedAt),
          event: "live.channel.resync.completed",
          operation: "scope-refresh",
          status: "completed",
          subsystem: "live-channel",
        });
      },
      (error: unknown) => {
        if (this.#socket !== socket || !this.#running) return;
        this.#snapshotBarrierCount = 0;
        this.#lastCursor = this.#safeCursor;
        this.#lastError =
          error instanceof Error
            ? error.message
            : "Could not refresh live query state.";
        socket?.close(1012, "Live snapshot refresh failed");
        clientLogger.warn("Application live scope refresh failed", {
          counts: { scopes: scopes.length },
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "live.channel.resync.failed",
          operation: "scope-refresh",
          reasonCode: "snapshot-refresh-failed",
          status: "failed",
          subsystem: "live-channel",
        });
      },
    );
  }

  #beginResync(
    message: Extract<AppLiveServerMessage, { type: "resync-required" }>,
  ): void {
    if (this.#resyncRunning) return;
    this.#resyncRunning = true;
    this.#resumeMode = "resync-required";
    this.#setStatus("resyncing");
    const startedAt = performance.now();
    clientLogger.info("Application live resynchronization started", {
      counts: { desiredScopes: this.#scopeReferences.size },
      event: "live.channel.resync.started",
      operation: "resync",
      reasonCode: message.reason,
      subsystem: "live-channel",
    });
    for (const [requestId, pending] of this.#pendingRequests) {
      if (pending.kind === "resync") this.#pendingRequests.delete(requestId);
    }
    const socket = this.#socket;
    const generation = ++this.#resyncGeneration;
    void this.#refreshDesiredScopes(message.reason, generation).then(
      () => {
        if (
          this.#socket !== socket ||
          generation !== this.#resyncGeneration ||
          !this.#running
        ) {
          return;
        }
        this.#resyncRunning = false;
        const scopes = this.#desiredScopes();
        if (scopes.length === 0) {
          this.#advanceCursor(message.cursor);
          this.#resumeMode = null;
          this.#setStatus("live");
          clientLogger.info("Application live resynchronization completed", {
            counts: { scopes: 0 },
            durationMs: Math.round(performance.now() - startedAt),
            event: "live.channel.resync.completed",
            operation: "resync",
            status: "completed",
            subsystem: "live-channel",
          });
          return;
        }
        const requestId = this.#nextRequestId();
        this.#pendingRequests.set(requestId, { kind: "resync", scopes });
        this.#send({
          type: "resync-ack",
          requestId,
          cursor: message.cursor,
          scopes,
        });
        clientLogger.debug(
          "Application live resynchronization snapshot completed",
          {
            counts: { scopes: scopes.length },
            durationMs: Math.round(performance.now() - startedAt),
            event: "live.channel.resync.snapshot-ready",
            operation: "resync",
            subsystem: "live-channel",
          },
        );
      },
      (error: unknown) => {
        if (this.#socket !== socket || !this.#running) return;
        this.#resyncRunning = false;
        this.#lastError =
          error instanceof Error
            ? error.message
            : "Could not recover application live state.";
        socket?.close(1012, "Live resynchronization failed");
        clientLogger.warn("Application live resynchronization failed", {
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "live.channel.resync.failed",
          operation: "resync",
          reasonCode: "snapshot-refresh-failed",
          status: "failed",
          subsystem: "live-channel",
        });
      },
    );
  }

  async #refreshDesiredScopes(
    reason: AppLiveResyncReason,
    generation: number,
  ): Promise<void> {
    let scopeGeneration: number;
    do {
      scopeGeneration = this.#scopeGeneration;
      await this.#options.onResync(this.#desiredScopes(), reason);
      if (generation !== this.#resyncGeneration) return;
    } while (scopeGeneration !== this.#scopeGeneration);
  }

  #syncScopes(): void {
    const socket = this.#socket;
    if (
      !socket ||
      socket.readyState !== OPEN_SOCKET_STATE ||
      this.#resyncRunning
    ) {
      return;
    }
    const pendingAdds = new Set<string>();
    const pendingRemovals = new Set<string>();
    for (const pending of this.#pendingRequests.values()) {
      for (const scope of pending.scopes) {
        const key = appLiveScopeKey(scope);
        if (pending.kind === "subscribe") pendingAdds.add(key);
        else if (pending.kind === "unsubscribe") pendingRemovals.add(key);
      }
    }

    const additions = this.#desiredScopes().filter((scope) => {
      const key = appLiveScopeKey(scope);
      return (
        !this.#activeScopes.has(key) &&
        !pendingAdds.has(key) &&
        !this.#blockedScopes.has(key)
      );
    });
    if (additions.length > 0) {
      const requestId = this.#nextRequestId();
      this.#pendingRequests.set(requestId, {
        kind: "subscribe",
        scopes: additions,
      });
      this.#send({
        type: "subscribe",
        requestId,
        scopes: additions,
      });
    }

    const removals = [...this.#activeScopes.values()].filter((scope) => {
      const key = appLiveScopeKey(scope);
      return !this.#scopeReferences.has(key) && !pendingRemovals.has(key);
    });
    if (removals.length > 0) {
      const requestId = this.#nextRequestId();
      this.#pendingRequests.set(requestId, {
        kind: "unsubscribe",
        scopes: removals,
      });
      this.#send({
        type: "unsubscribe",
        requestId,
        scopes: removals,
      });
    }
  }

  #desiredScopes(): AppLiveScope[] {
    return [...this.#scopeReferences.values()].map(({ scope }) => scope);
  }

  #send(message: AppLiveClientMessage): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN_SOCKET_STATE) return;
    try {
      socket.send(encodeAppLiveClientMessage(message));
    } catch {
      socket.close(1011, "Application live send failed");
    }
  }

  #startHeartbeat(intervalMs: number): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      this.#send({
        type: "ping",
        nonce: `heartbeat-${Date.now()}-${this.#requestSequence}`,
      });
    }, intervalMs);
  }

  #clearHeartbeat(): void {
    if (!this.#heartbeatTimer) return;
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#reconnectTimer) return;
    this.#reconnectAttempt += 1;
    this.#setStatus("waiting-to-reconnect");
    const baseDelay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      MIN_RECONNECT_DELAY_MS * 2 ** (this.#reconnectAttempt - 1),
    );
    const random = this.#options.random?.() ?? Math.random();
    const delay = Math.round(baseDelay * (0.8 + random * 0.4));
    clientLogger.rateLimited(
      "live-channel-reconnect",
      "info",
      "Application live reconnect scheduled",
      {
        attempt: this.#reconnectAttempt,
        delayMs: delay,
        event: "live.channel.reconnect-scheduled",
        operation: "reconnect",
        subsystem: "live-channel",
      },
      { summaryEvery: 10, windowMs: 30_000 },
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #clearReconnectTimer(): void {
    if (!this.#reconnectTimer) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #clearConnectTimer(): void {
    if (!this.#connectTimer) return;
    clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  #protocolFailure(message: string): void {
    this.#lastError = message;
    this.#emit();
    clientLogger.error("Application live frame failed validation", {
      event: "live.channel.protocol-error",
      operation: "decode",
      reasonCode: "invalid-frame",
      status: "failed",
      subsystem: "live-channel",
    });
    this.#socket?.close(1002, "Invalid application live protocol");
  }

  #advanceCursor(cursor: number): void {
    if (this.#lastCursor !== null && cursor < this.#lastCursor) return;
    this.#lastCursor = cursor;
    if (this.#snapshotBarrierCount === 0) this.#commitCursor();
    this.#emit();
  }

  #commitCursor(): void {
    if (this.#lastCursor === null) return;
    this.#safeCursor = this.#lastCursor;
    if (
      !this.#serverEpoch ||
      !this.#options.storage ||
      (this.#persistedCursor === this.#safeCursor &&
        this.#persistedServerEpoch === this.#serverEpoch) ||
      this.#cursorPersistenceTimer
    ) {
      return;
    }
    this.#cursorPersistenceTimer = setTimeout(() => {
      this.#cursorPersistenceTimer = null;
      this.#persistCursor();
    }, CURSOR_PERSIST_INTERVAL_MS);
  }

  #clearCursorPersistenceTimer(): void {
    if (!this.#cursorPersistenceTimer) return;
    clearTimeout(this.#cursorPersistenceTimer);
    this.#cursorPersistenceTimer = null;
  }

  #persistCursor(): void {
    const cursor = this.#safeCursor;
    const serverEpoch = this.#serverEpoch;
    const storage = this.#options.storage;
    if (
      cursor === null ||
      !serverEpoch ||
      !storage ||
      (this.#persistedCursor === cursor &&
        this.#persistedServerEpoch === serverEpoch)
    ) {
      return;
    }
    storage.setItem(
      this.#options.storageKey,
      JSON.stringify({
        version: RESUME_STORAGE_VERSION,
        serverEpoch,
        cursor,
      } satisfies StoredResumePoint),
    );
    this.#persistedCursor = cursor;
    this.#persistedServerEpoch = serverEpoch;
  }

  #nextRequestId(): string {
    this.#requestSequence += 1;
    return `live-${this.#requestSequence}`;
  }

  #setStatus(status: AppLiveClientStatus): void {
    if (this.#status === status) {
      this.#emit();
      return;
    }
    this.#status = status;
    this.#emit();
    for (const listener of this.#statusListeners) listener(status);
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}
