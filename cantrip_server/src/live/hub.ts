import { randomUUID } from "node:crypto";

import {
  appLiveClientMessageSchema,
  appLiveScopeKey,
  appLiveServerMessageSchema,
} from "@cantrip/protocol";
import type {
  AppLiveClientMessage,
  AppLiveErrorCode,
  AppLiveResyncReason,
  AppLiveScope,
  AppLiveServerMessage,
} from "@cantrip/protocol";

const OPEN_SOCKET_STATE = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BUFFERED_BYTES = 1_024 * 1_024;
const DEFAULT_MAX_INBOUND_BYTES = 64 * 1_024;
const DEFAULT_MAX_REPLAY_EVENTS = 2_048;
const MAX_PROTOCOL_VIOLATIONS = 5;
const MAX_REQUEST_HISTORY = 256;

export interface AppLiveSocket {
  bufferedAmount: number;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "message",
    listener: (data: unknown, isBinary?: boolean) => void,
  ): void;
  readyState: number;
  send(data: string): void;
}

type AppLiveEvent = Extract<AppLiveServerMessage, { type: "event" }>;
export type AppLivePublication = Omit<
  AppLiveEvent,
  "cursor" | "occurredAt" | "type"
> & {
  occurredAt?: string;
  ownerId: string;
};

export interface AppLiveConnectionContext {
  authorizeScope(scope: AppLiveScope): Promise<boolean> | boolean;
  isActive?(): Promise<boolean> | boolean;
  ownerId: string;
  sessionId?: string | null;
}

export interface AppLiveHubOptions {
  epoch?: string;
  heartbeatIntervalMs?: number;
  maxBufferedBytes?: number;
  maxInboundBytes?: number;
  maxReplayEvents?: number;
  now?: () => number;
}

export interface AppLiveHubStats {
  acceptedConnectionCount: number;
  connectionCount: number;
  currentCursor: number;
  deliveredEventCount: number;
  disconnectedConnectionCount: number;
  heartbeatPongCount: number;
  heartbeatTimeoutCount: number;
  protocolViolationCount: number;
  publicationCount: number;
  queuePressureCount: number;
  replayEventCount: number;
  replaySessionCount: number;
  replayedEventCount: number;
  resyncRequiredCount: number;
  resumeAttemptCount: number;
  serverEpoch: string;
  slowConsumerClosureCount: number;
}

interface ResumeState {
  cursor: number;
  reason: AppLiveResyncReason | null;
}

interface Connection {
  closed: boolean;
  context: AppLiveConnectionContext;
  id: string;
  initialized: boolean;
  lastSeenAt: number;
  protocolViolations: number;
  requestHistory: Map<string, AppLiveServerMessage>;
  resume: ResumeState | null;
  scopes: Map<string, AppLiveScope>;
  serial: Promise<void>;
  socket: AppLiveSocket;
}

interface RetainedEvent {
  event: AppLiveEvent;
  ownerId: string;
}

function frameByteLength(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + frameByteLength(chunk), 0);
  }
  return Buffer.byteLength(String(data));
}

function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).toString();
  }
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((chunk) => Buffer.from(frameText(chunk))),
    ).toString();
  }
  return String(data);
}

function requestIdFromUnknown(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    value.requestId.length <= 200
  ) {
    return value.requestId;
  }
  return null;
}

export class AppLiveHub {
  readonly #connections = new Set<Connection>();
  readonly #epoch: string;
  readonly #heartbeatIntervalMs: number;
  readonly #maxBufferedBytes: number;
  readonly #maxInboundBytes: number;
  readonly #maxReplayEvents: number;
  readonly #now: () => number;
  readonly #ownerCursors = new Map<string, number>();
  readonly #replayEvents: RetainedEvent[] = [];
  readonly #heartbeatTimer: ReturnType<typeof setInterval>;
  #maintainingConnections = false;
  #acceptedConnectionCount = 0;
  #closed = false;
  #currentCursor = 0;
  #deliveredEventCount = 0;
  #disconnectedConnectionCount = 0;
  #heartbeatPongCount = 0;
  #heartbeatTimeoutCount = 0;
  #protocolViolationCount = 0;
  #publicationCount = 0;
  #queuePressureCount = 0;
  #replaySessionCount = 0;
  #replayedEventCount = 0;
  #resyncRequiredCount = 0;
  #resumeAttemptCount = 0;
  #slowConsumerClosureCount = 0;

  constructor(options: AppLiveHubOptions = {}) {
    this.#epoch = options.epoch ?? randomUUID();
    this.#heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#maxBufferedBytes =
      options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.#maxInboundBytes =
      options.maxInboundBytes ?? DEFAULT_MAX_INBOUND_BYTES;
    this.#maxReplayEvents =
      options.maxReplayEvents ?? DEFAULT_MAX_REPLAY_EVENTS;
    this.#now = options.now ?? Date.now;

    if (
      this.#heartbeatIntervalMs < 5_000 ||
      this.#heartbeatIntervalMs > 120_000
    ) {
      throw new Error("Live heartbeat interval must be between 5s and 120s.");
    }
    if (this.#maxReplayEvents < 1 || this.#maxReplayEvents > 10_000) {
      throw new Error("Live replay capacity must be between 1 and 10,000.");
    }
    if (this.#maxBufferedBytes < 1 || this.#maxInboundBytes < 1) {
      throw new Error("Live frame limits must be positive.");
    }

    this.#heartbeatTimer = setInterval(
      () => void this.#maintainConnections(),
      this.#heartbeatIntervalMs,
    );
    this.#heartbeatTimer.unref();
  }

  attach(socket: AppLiveSocket, context: AppLiveConnectionContext): void {
    if (this.#closed) {
      socket.close(1012, "Live service is shutting down");
      return;
    }

    const connection: Connection = {
      closed: false,
      context,
      id: randomUUID(),
      initialized: false,
      lastSeenAt: this.#now(),
      protocolViolations: 0,
      requestHistory: new Map(),
      resume: null,
      scopes: new Map(),
      serial: Promise.resolve(),
      socket,
    };
    this.#connections.add(connection);
    this.#acceptedConnectionCount += 1;

    socket.on("message", (data, isBinary) => {
      connection.serial = connection.serial
        .then(() => this.#handleFrame(connection, data, Boolean(isBinary)))
        .catch(() => {
          this.#sendError(
            connection,
            null,
            "internal-error",
            "The live server could not process that message.",
            true,
          );
        });
    });
    const disconnect = () => this.#disconnect(connection);
    socket.on("close", disconnect);
    socket.on("error", disconnect);
  }

  publish(publication: AppLivePublication): AppLiveEvent {
    if (this.#closed) {
      throw new Error("Cannot publish after the live hub has closed.");
    }
    const { ownerId, ...event } = publication;
    const cursor = this.#ownerCursor(ownerId) + 1;
    const parsed = appLiveServerMessageSchema.parse({
      ...event,
      type: "event",
      cursor,
      occurredAt: publication.occurredAt ?? new Date(this.#now()).toISOString(),
    });
    if (parsed.type !== "event") {
      throw new Error("Live publication did not produce an event.");
    }
    this.#ownerCursors.set(ownerId, cursor);
    this.#currentCursor += 1;
    this.#publicationCount += 1;
    this.#replayEvents.push({ event: parsed, ownerId });
    if (this.#replayEvents.length > this.#maxReplayEvents) {
      this.#replayEvents.splice(
        0,
        this.#replayEvents.length - this.#maxReplayEvents,
      );
    }

    const scopeKey = appLiveScopeKey(parsed.scope);
    for (const connection of this.#connections) {
      if (
        connection.context.ownerId === ownerId &&
        connection.initialized &&
        connection.scopes.has(scopeKey) &&
        !connection.resume
      ) {
        if (this.#send(connection, parsed)) this.#deliveredEventCount += 1;
      }
    }
    return parsed;
  }

  stats(): AppLiveHubStats {
    return {
      acceptedConnectionCount: this.#acceptedConnectionCount,
      connectionCount: this.#connections.size,
      currentCursor: this.#currentCursor,
      deliveredEventCount: this.#deliveredEventCount,
      disconnectedConnectionCount: this.#disconnectedConnectionCount,
      heartbeatPongCount: this.#heartbeatPongCount,
      heartbeatTimeoutCount: this.#heartbeatTimeoutCount,
      protocolViolationCount: this.#protocolViolationCount,
      publicationCount: this.#publicationCount,
      queuePressureCount: this.#queuePressureCount,
      replayEventCount: this.#replayEvents.length,
      replaySessionCount: this.#replaySessionCount,
      replayedEventCount: this.#replayedEventCount,
      resyncRequiredCount: this.#resyncRequiredCount,
      resumeAttemptCount: this.#resumeAttemptCount,
      serverEpoch: this.#epoch,
      slowConsumerClosureCount: this.#slowConsumerClosureCount,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeatTimer);
    for (const connection of [...this.#connections]) {
      connection.closed = true;
      connection.socket.close(1001, "Live service is shutting down");
      this.#connections.delete(connection);
      this.#disconnectedConnectionCount += 1;
    }
  }

  revokeOwner(ownerId: string): number {
    return this.#revokeConnections(
      (connection) => connection.context.ownerId === ownerId,
      "Account sessions were revoked",
    );
  }

  revokeSession(sessionId: string): number {
    return this.#revokeConnections(
      (connection) => connection.context.sessionId === sessionId,
      "Session was revoked",
    );
  }

  async #handleFrame(
    connection: Connection,
    data: unknown,
    isBinary: boolean,
  ): Promise<void> {
    if (connection.closed) return;
    if (!(await this.#isConnectionActive(connection))) {
      this.#closeConnection(connection, 1008, "Session is no longer active");
      return;
    }
    connection.lastSeenAt = this.#now();

    if (isBinary) {
      this.#protocolViolation(
        connection,
        null,
        "invalid-message",
        "The application live channel accepts JSON text frames only.",
      );
      return;
    }
    if (frameByteLength(data) > this.#maxInboundBytes) {
      this.#sendError(
        connection,
        null,
        "payload-too-large",
        "The application live frame exceeds the configured size limit.",
        false,
      );
      this.#closeConnection(connection, 1009, "Live frame is too large");
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(frameText(data));
    } catch {
      this.#protocolViolation(
        connection,
        null,
        "invalid-message",
        "The application live frame must contain valid JSON.",
      );
      return;
    }

    if (
      typeof raw === "object" &&
      raw !== null &&
      "type" in raw &&
      raw.type === "initialize" &&
      "protocolVersion" in raw &&
      raw.protocolVersion !== 1
    ) {
      this.#protocolViolation(
        connection,
        null,
        "unsupported-version",
        "The application live protocol version is not supported.",
      );
      return;
    }

    const parsed = appLiveClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.#protocolViolation(
        connection,
        requestIdFromUnknown(raw),
        "invalid-message",
        "The application live message does not match the protocol.",
      );
      return;
    }

    await this.#handleMessage(connection, parsed.data);
  }

  async #handleMessage(
    connection: Connection,
    message: AppLiveClientMessage,
  ): Promise<void> {
    if (message.type === "initialize") {
      this.#initialize(connection, message);
      return;
    }
    if (!connection.initialized) {
      this.#protocolViolation(
        connection,
        "requestId" in message ? message.requestId : null,
        "not-initialized",
        "Initialize the application live connection before using it.",
      );
      return;
    }
    if (message.type === "ping") {
      this.#heartbeatPongCount += 1;
      this.#send(connection, {
        type: "pong",
        nonce: message.nonce,
        cursor: this.#ownerCursor(connection.context.ownerId),
      });
      return;
    }

    const previous = connection.requestHistory.get(message.requestId);
    if (previous) {
      this.#send(connection, previous);
      return;
    }

    switch (message.type) {
      case "subscribe":
        await this.#subscribe(connection, message);
        break;
      case "unsubscribe":
        this.#unsubscribe(connection, message);
        break;
      case "resync-ack":
        await this.#acknowledgeResync(connection, message);
        break;
    }
  }

  #initialize(
    connection: Connection,
    message: Extract<AppLiveClientMessage, { type: "initialize" }>,
  ): void {
    if (connection.initialized) {
      this.#protocolViolation(
        connection,
        null,
        "already-initialized",
        "The application live connection is already initialized.",
      );
      return;
    }

    connection.initialized = true;
    let resumeMode: Extract<AppLiveServerMessage, { type: "ready" }>["resume"] =
      "not-requested";
    if (message.resume) {
      this.#resumeAttemptCount += 1;
      const reason = this.#resumeFailureReason(
        connection.context.ownerId,
        message.resume.serverEpoch,
        message.resume.cursor,
      );
      connection.resume = { cursor: message.resume.cursor, reason };
      resumeMode = reason ? "resync-required" : "replaying";
    }

    this.#send(connection, {
      type: "ready",
      protocolVersion: 1,
      serverEpoch: this.#epoch,
      connectionId: connection.id,
      currentCursor: this.#ownerCursor(connection.context.ownerId),
      heartbeatIntervalMs: this.#heartbeatIntervalMs,
      resume: resumeMode,
    });
  }

  async #subscribe(
    connection: Connection,
    message: Extract<AppLiveClientMessage, { type: "subscribe" }>,
  ): Promise<void> {
    const combinedKeys = new Set(connection.scopes.keys());
    for (const scope of message.scopes)
      combinedKeys.add(appLiveScopeKey(scope));
    if (combinedKeys.size > 128) {
      this.#rememberAndSendError(
        connection,
        message.requestId,
        "subscription-limit",
        "An application live connection may subscribe to at most 128 scopes.",
        false,
      );
      return;
    }
    if (!(await this.#authorizeScopes(connection, message.scopes))) {
      this.#rememberAndSendError(
        connection,
        message.requestId,
        "unauthorized-scope",
        "One or more requested live scopes do not exist or are not owned by the current user.",
        false,
      );
      return;
    }

    for (const scope of message.scopes) {
      connection.scopes.set(appLiveScopeKey(scope), scope);
    }
    const response: AppLiveServerMessage = {
      type: "subscribed",
      requestId: message.requestId,
      scopes: message.scopes,
      cursor: this.#ownerCursor(connection.context.ownerId),
    };
    this.#rememberAndSend(connection, response);
    this.#finishResume(connection);
  }

  #unsubscribe(
    connection: Connection,
    message: Extract<AppLiveClientMessage, { type: "unsubscribe" }>,
  ): void {
    for (const scope of message.scopes) {
      connection.scopes.delete(appLiveScopeKey(scope));
    }
    this.#rememberAndSend(connection, {
      type: "unsubscribed",
      requestId: message.requestId,
      scopes: message.scopes,
      cursor: this.#ownerCursor(connection.context.ownerId),
    });
  }

  async #acknowledgeResync(
    connection: Connection,
    message: Extract<AppLiveClientMessage, { type: "resync-ack" }>,
  ): Promise<void> {
    if (!(await this.#authorizeScopes(connection, message.scopes))) {
      this.#rememberAndSendError(
        connection,
        message.requestId,
        "unauthorized-scope",
        "One or more requested live scopes do not exist or are not owned by the current user.",
        false,
      );
      return;
    }

    const reason = this.#resumeFailureReason(
      connection.context.ownerId,
      this.#epoch,
      message.cursor,
    );
    connection.scopes = new Map(
      message.scopes.map((scope) => [appLiveScopeKey(scope), scope]),
    );
    if (reason) {
      connection.resume = { cursor: message.cursor, reason };
      const response = {
        type: "resync-required",
        cursor: this.#ownerCursor(connection.context.ownerId),
        reason,
        scopes: [...connection.scopes.values()],
      } satisfies Extract<AppLiveServerMessage, { type: "resync-required" }>;
      this.#rememberRequest(connection, message.requestId, response);
      this.#sendResyncRequired(connection, response);
      return;
    }

    const response: AppLiveServerMessage = {
      type: "subscribed",
      requestId: message.requestId,
      scopes: message.scopes,
      cursor: this.#ownerCursor(connection.context.ownerId),
    };
    this.#rememberAndSend(connection, response);
    this.#replay(connection, message.cursor);
  }

  async #authorizeScopes(
    connection: Connection,
    scopes: AppLiveScope[],
  ): Promise<boolean> {
    try {
      const decisions = await Promise.all(
        scopes.map((scope) => connection.context.authorizeScope(scope)),
      );
      return decisions.every(Boolean);
    } catch {
      return false;
    }
  }

  #finishResume(connection: Connection): void {
    const resume = connection.resume;
    if (!resume) return;
    if (resume.reason) {
      this.#sendResyncRequired(connection, {
        type: "resync-required",
        cursor: this.#ownerCursor(connection.context.ownerId),
        reason: resume.reason,
        scopes: [...connection.scopes.values()],
      });
      return;
    }
    this.#replay(connection, resume.cursor);
  }

  #replay(connection: Connection, cursor: number): void {
    connection.resume = null;
    this.#replaySessionCount += 1;
    let replayedCount = 0;
    for (const retained of this.#replayEvents) {
      const { event } = retained;
      if (
        retained.ownerId === connection.context.ownerId &&
        event.cursor > cursor &&
        connection.scopes.has(appLiveScopeKey(event.scope))
      ) {
        if (!this.#send(connection, event)) return;
        replayedCount += 1;
        this.#replayedEventCount += 1;
        this.#deliveredEventCount += 1;
      }
    }
    this.#send(connection, {
      type: "caught-up",
      cursor: this.#ownerCursor(connection.context.ownerId),
      replayedCount,
    });
  }

  #resumeFailureReason(
    ownerId: string,
    serverEpoch: string,
    cursor: number,
  ): AppLiveResyncReason | null {
    if (serverEpoch !== this.#epoch) return "server-epoch-changed";
    const currentCursor = this.#ownerCursor(ownerId);
    if (cursor > currentCursor) return "cursor-expired";
    const oldestCursor = this.#replayEvents.find(
      (retained) => retained.ownerId === ownerId,
    )?.event.cursor;
    if (oldestCursor !== undefined && cursor < oldestCursor - 1) {
      return "cursor-expired";
    }
    if (oldestCursor === undefined && cursor !== currentCursor) {
      return "cursor-expired";
    }
    return null;
  }

  #ownerCursor(ownerId: string): number {
    return this.#ownerCursors.get(ownerId) ?? 0;
  }

  async #isConnectionActive(connection: Connection): Promise<boolean> {
    try {
      return (await connection.context.isActive?.()) ?? true;
    } catch {
      return false;
    }
  }

  #revokeConnections(
    matches: (connection: Connection) => boolean,
    reason: string,
  ): number {
    let revoked = 0;
    for (const connection of [...this.#connections]) {
      if (!matches(connection)) continue;
      this.#closeConnection(connection, 1008, reason);
      revoked += 1;
    }
    return revoked;
  }

  #protocolViolation(
    connection: Connection,
    requestId: string | null,
    code: AppLiveErrorCode,
    message: string,
  ): void {
    connection.protocolViolations += 1;
    this.#protocolViolationCount += 1;
    this.#sendError(connection, requestId, code, message, false);
    if (connection.protocolViolations >= MAX_PROTOCOL_VIOLATIONS) {
      this.#closeConnection(connection, 1008, "Too many live protocol errors");
    }
  }

  #rememberAndSendError(
    connection: Connection,
    requestId: string,
    code: AppLiveErrorCode,
    message: string,
    retryable: boolean,
  ): void {
    const response: AppLiveServerMessage = {
      type: "error",
      requestId,
      code,
      message,
      retryable,
    };
    this.#rememberAndSend(connection, response);
  }

  #sendResyncRequired(
    connection: Connection,
    message: Extract<AppLiveServerMessage, { type: "resync-required" }>,
  ): boolean {
    this.#resyncRequiredCount += 1;
    return this.#send(connection, message);
  }

  #sendError(
    connection: Connection,
    requestId: string | null,
    code: AppLiveErrorCode,
    message: string,
    retryable: boolean,
  ): void {
    this.#send(connection, {
      type: "error",
      requestId,
      code,
      message,
      retryable,
    });
  }

  #rememberAndSend(
    connection: Connection,
    response: AppLiveServerMessage,
  ): void {
    if (!("requestId" in response) || response.requestId === null) {
      this.#send(connection, response);
      return;
    }
    this.#rememberRequest(connection, response.requestId, response);
    this.#send(connection, response);
  }

  #rememberRequest(
    connection: Connection,
    requestId: string,
    response: AppLiveServerMessage,
  ): void {
    connection.requestHistory.set(requestId, response);
    if (connection.requestHistory.size > MAX_REQUEST_HISTORY) {
      const oldest = connection.requestHistory.keys().next().value;
      if (oldest !== undefined) connection.requestHistory.delete(oldest);
    }
  }

  #send(connection: Connection, message: AppLiveServerMessage): boolean {
    if (
      connection.closed ||
      connection.socket.readyState !== OPEN_SOCKET_STATE
    ) {
      this.#disconnect(connection);
      return false;
    }
    const encoded = JSON.stringify(appLiveServerMessageSchema.parse(message));
    if (
      connection.socket.bufferedAmount + Buffer.byteLength(encoded) >
      this.#maxBufferedBytes
    ) {
      this.#queuePressureCount += 1;
      this.#slowConsumerClosureCount += 1;
      this.#closeConnection(
        connection,
        1013,
        "Live queue overflow; reconnect and resync",
      );
      return false;
    }
    try {
      connection.socket.send(encoded);
      return true;
    } catch {
      this.#closeConnection(connection, 1011, "Live send failed");
      return false;
    }
  }

  async #maintainConnections(): Promise<void> {
    if (this.#maintainingConnections) return;
    this.#maintainingConnections = true;
    const staleBefore = this.#now() - this.#heartbeatIntervalMs * 3;
    try {
      await Promise.all(
        [...this.#connections].map(async (connection) => {
          if (connection.lastSeenAt < staleBefore) {
            this.#heartbeatTimeoutCount += 1;
            this.#closeConnection(connection, 1001, "Live heartbeat timed out");
            return;
          }
          if (!(await this.#isConnectionActive(connection))) {
            this.#closeConnection(
              connection,
              1008,
              "Session is no longer active",
            );
          }
        }),
      );
    } finally {
      this.#maintainingConnections = false;
    }
  }

  #closeConnection(connection: Connection, code: number, reason: string): void {
    if (connection.closed) return;
    connection.closed = true;
    this.#connections.delete(connection);
    this.#disconnectedConnectionCount += 1;
    connection.socket.close(code, reason);
  }

  #disconnect(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.#connections.delete(connection);
    this.#disconnectedConnectionCount += 1;
  }
}
