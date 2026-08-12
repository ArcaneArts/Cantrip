import { appLiveScopeKey, appLiveServerMessageSchema } from "@cantrip/protocol";
import type {
  AppLiveErrorCode,
  AppLiveResyncReason,
  AppLiveScope,
  AppLiveServerMessage,
} from "@cantrip/protocol";

const OPEN_SOCKET_STATE = 1;
const RESUME_STORAGE_VERSION = 1;
const MIN_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;

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
  client: { id: string; name: string; version: string };
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
  readonly #listeners = new Set<(snapshot: AppLiveClientSnapshot) => void>();
  readonly #options: AppLiveClientOptions;
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #scopeReferences = new Map<string, ScopeReference>();
  readonly #webSocketFactory: (url: string) => AppLiveClientSocket;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  #lastCursor: number | null = null;
  #lastError: string | null = null;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #requestSequence = 0;
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
    } else if (options.storage?.getItem(options.storageKey)) {
      options.storage.removeItem(options.storageKey);
    }
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#connect();
  }

  stop(): void {
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
    this.#pendingRequests.clear();
    this.#snapshotBarrierCount = 0;
    this.#lastCursor = this.#safeCursor;
    this.#setStatus("stopped");
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

  subscribe(listener: (snapshot: AppLiveClientSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  #connect(): void {
    if (!this.#running || this.#socket) return;
    this.#setStatus("connecting");
    this.#lastError = null;
    let socket: AppLiveClientSocket;
    try {
      socket = this.#webSocketFactory(this.#options.url);
    } catch (error) {
      this.#lastError =
        error instanceof Error ? error.message : "Could not open live socket.";
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    this.#connectTimer = setTimeout(() => {
      if (this.#socket === socket) {
        socket.close(1013, "Application live connection timed out");
      }
    }, CONNECT_TIMEOUT_MS);
    socket.onOpen(() => {
      if (this.#socket !== socket || !this.#running) return;
      this.#setStatus("initializing");
      this.#send({
        type: "initialize",
        protocolVersion: 1,
        client: this.#options.client,
        resume:
          this.#serverEpoch !== null && this.#safeCursor !== null
            ? {
                serverEpoch: this.#serverEpoch,
                cursor: this.#safeCursor,
              }
            : null,
      });
    });
    socket.onMessage((data) => {
      if (this.#socket !== socket || !this.#running) return;
      this.#handleServerFrame(data);
    });
    socket.onError(() => {
      if (this.#socket !== socket || !this.#running) return;
      this.#lastError = "The application live connection encountered an error.";
      this.#emit();
    });
    socket.onClose((event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#clearConnectTimer();
      this.#clearHeartbeat();
      this.#activeScopes.clear();
      this.#pendingRequests.clear();
      this.#resumeMode = null;
      this.#snapshotBarrierCount = 0;
      this.#lastCursor = this.#safeCursor;
      this.#resyncGeneration += 1;
      this.#resyncRunning = false;
      if (!this.#running) return;
      if (
        event.code === 1008 &&
        /auth|session|sign[ -]?in/i.test(event.reason)
      ) {
        this.#options.onAuthenticationRequired?.(
          event.reason || "Your Cantrip session has expired.",
        );
        this.stop();
        return;
      }
      if (event.code !== 1000) {
        this.#lastError =
          event.reason || `Application live connection closed (${event.code}).`;
      }
      this.#scheduleReconnect();
    });
  }

  #handleServerFrame(data: unknown): void {
    if (typeof data !== "string") {
      this.#protocolFailure("The live server sent a non-text frame.");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      this.#protocolFailure("The live server sent invalid JSON.");
      return;
    }
    const parsed = appLiveServerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.#protocolFailure(
        "The live server sent an invalid protocol message.",
      );
      return;
    }
    this.#handleServerMessage(parsed.data);
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
        return;
      case "pong":
        if (this.#resumeMode === null) this.#advanceCursor(message.cursor);
        return;
      case "resync-required":
        this.#beginResync(message);
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
        if (message.retryable) {
          this.#socket?.close(1012, "Retrying after live protocol error");
        } else {
          this.#syncScopes();
        }
    }
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
      },
      (error: unknown) => {
        if (this.#socket !== socket || !this.#running) return;
        this.#resyncRunning = false;
        this.#lastError =
          error instanceof Error
            ? error.message
            : "Could not recover application live state.";
        socket?.close(1012, "Live resynchronization failed");
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

  #send(message: object): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN_SOCKET_STATE) return;
    try {
      socket.send(JSON.stringify(message));
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
    if (this.#serverEpoch && this.#options.storage) {
      this.#options.storage.setItem(
        this.#options.storageKey,
        JSON.stringify({
          version: RESUME_STORAGE_VERSION,
          serverEpoch: this.#serverEpoch,
          cursor: this.#lastCursor,
        } satisfies StoredResumePoint),
      );
    }
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
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}
