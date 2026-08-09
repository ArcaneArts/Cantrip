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
};

export interface AppLiveConnectionContext {
  authorizeScope(scope: AppLiveScope): Promise<boolean> | boolean;
  ownerId: string;
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
  connectionCount: number;
  currentCursor: number;
  replayEventCount: number;
  serverEpoch: string;
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
  readonly #replayEvents: AppLiveEvent[] = [];
  readonly #heartbeatTimer: ReturnType<typeof setInterval>;
  #closed = false;
  #currentCursor = 0;

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
      () => this.#closeStaleConnections(),
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
    const cursor = this.#currentCursor + 1;
    const parsed = appLiveServerMessageSchema.parse({
      ...publication,
      type: "event",
      cursor,
      occurredAt: publication.occurredAt ?? new Date(this.#now()).toISOString(),
    });
    if (parsed.type !== "event") {
      throw new Error("Live publication did not produce an event.");
    }
    this.#currentCursor = cursor;
    this.#replayEvents.push(parsed);
    if (this.#replayEvents.length > this.#maxReplayEvents) {
      this.#replayEvents.splice(
        0,
        this.#replayEvents.length - this.#maxReplayEvents,
      );
    }

    const scopeKey = appLiveScopeKey(parsed.scope);
    for (const connection of this.#connections) {
      if (
        connection.initialized &&
        connection.scopes.has(scopeKey) &&
        !connection.resume
      ) {
        this.#send(connection, parsed);
      }
    }
    return parsed;
  }

  stats(): AppLiveHubStats {
    return {
      connectionCount: this.#connections.size,
      currentCursor: this.#currentCursor,
      replayEventCount: this.#replayEvents.length,
      serverEpoch: this.#epoch,
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
    }
  }

  async #handleFrame(
    connection: Connection,
    data: unknown,
    isBinary: boolean,
  ): Promise<void> {
    if (connection.closed) return;
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
      this.#send(connection, {
        type: "pong",
        nonce: message.nonce,
        cursor: this.#currentCursor,
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
      const reason = this.#resumeFailureReason(
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
      currentCursor: this.#currentCursor,
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
      cursor: this.#currentCursor,
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
      cursor: this.#currentCursor,
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

    const reason = this.#resumeFailureReason(this.#epoch, message.cursor);
    connection.scopes = new Map(
      message.scopes.map((scope) => [appLiveScopeKey(scope), scope]),
    );
    if (reason) {
      connection.resume = { cursor: message.cursor, reason };
      const response: AppLiveServerMessage = {
        type: "resync-required",
        cursor: this.#currentCursor,
        reason,
        scopes: [...connection.scopes.values()],
      };
      this.#rememberRequest(connection, message.requestId, response);
      this.#send(connection, response);
      return;
    }

    const response: AppLiveServerMessage = {
      type: "subscribed",
      requestId: message.requestId,
      scopes: message.scopes,
      cursor: this.#currentCursor,
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
      this.#send(connection, {
        type: "resync-required",
        cursor: this.#currentCursor,
        reason: resume.reason,
        scopes: [...connection.scopes.values()],
      });
      return;
    }
    this.#replay(connection, resume.cursor);
  }

  #replay(connection: Connection, cursor: number): void {
    connection.resume = null;
    let replayedCount = 0;
    for (const event of this.#replayEvents) {
      if (
        event.cursor > cursor &&
        connection.scopes.has(appLiveScopeKey(event.scope))
      ) {
        if (!this.#send(connection, event)) return;
        replayedCount += 1;
      }
    }
    this.#send(connection, {
      type: "caught-up",
      cursor: this.#currentCursor,
      replayedCount,
    });
  }

  #resumeFailureReason(
    serverEpoch: string,
    cursor: number,
  ): AppLiveResyncReason | null {
    if (serverEpoch !== this.#epoch) return "server-epoch-changed";
    if (cursor > this.#currentCursor) return "cursor-expired";
    const oldestCursor = this.#replayEvents[0]?.cursor;
    if (oldestCursor !== undefined && cursor < oldestCursor - 1) {
      return "cursor-expired";
    }
    if (oldestCursor === undefined && cursor !== this.#currentCursor) {
      return "cursor-expired";
    }
    return null;
  }

  #protocolViolation(
    connection: Connection,
    requestId: string | null,
    code: AppLiveErrorCode,
    message: string,
  ): void {
    connection.protocolViolations += 1;
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

  #closeStaleConnections(): void {
    const staleBefore = this.#now() - this.#heartbeatIntervalMs * 3;
    for (const connection of this.#connections) {
      if (connection.lastSeenAt < staleBefore) {
        this.#closeConnection(connection, 1001, "Live heartbeat timed out");
      }
    }
  }

  #closeConnection(connection: Connection, code: number, reason: string): void {
    if (connection.closed) return;
    connection.closed = true;
    this.#connections.delete(connection);
    connection.socket.close(code, reason);
  }

  #disconnect(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.#connections.delete(connection);
  }
}
