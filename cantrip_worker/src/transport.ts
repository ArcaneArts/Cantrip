import { randomUUID } from "node:crypto";

import {
  agentTurnResultSchema,
  decodeWorkerConnectionEnvelope,
  decodeWorkerRequestEnvelope,
  decodeRemoteSurfaceFrame,
  decodeTunnelDataPlaneFrame,
  encodeWorkerServerEnvelope,
  encodeRemoteSurfaceFrame,
  encodeTunnelDataPlaneFrame,
  isTunnelDataPlaneFrame,
  type RemoteSurfaceFrameHeader,
  type TunnelDataPlaneFrameHeader,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerNotification,
  type WorkerRequestEnvelope,
  type WorkerServerEnvelope,
  WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL,
  WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL,
  WORKER_WEBSOCKET_SUBPROTOCOLS,
} from "@cantrip/protocol";
import type { OperationalLogContext } from "@cantrip/logging";
import WebSocket, { type RawData } from "ws";

import type { WorkerConfig } from "./config.js";
import { workerLogError, workerLogger } from "./logger.js";

type CommandHandler = (
  command: WorkerCommand,
  emit: (event: WorkerEvent) => void,
) => Promise<unknown>;

type SurfaceFrameHandler = (
  header: RemoteSurfaceFrameHeader,
  payload: Uint8Array,
) => Promise<void> | void;

type TunnelDataPlaneFrameHandler = (
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
) => Promise<void> | void;

const MAX_BUFFERED_SURFACE_BYTES = 8 * 1_024 * 1_024;
const MAX_BUFFERED_NOTIFICATION_BYTES = 1 * 1_024 * 1_024;
const MAX_BUFFERED_COMMAND_BYTES = 8 * 1_024 * 1_024;
const TUNNEL_DATA_PLANE_LOW_WATER_BYTES = 256 * 1_024;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_TRANSPORT_DISCONNECT_GRACE_MS = 15_000;
type CommandEnvelopeDelivery = "sent" | "queued" | "dropped";

export interface WorkerConnectionTimingOptions {
  reconnectDelayMs?: number;
  transportDisconnectGraceMs?: number;
}

function rawDataBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function commandLogContext(
  request: WorkerRequestEnvelope,
): OperationalLogContext {
  const command = request.command as WorkerCommand & {
    chatId?: unknown;
    projectId?: unknown;
    sessionId?: unknown;
    surfaceId?: unknown;
    terminalId?: unknown;
    worktreeId?: unknown;
    branch?: unknown;
    revision?: unknown;
    baseRevision?: unknown;
    headRevision?: unknown;
  };
  return {
    event: "worker.command.dispatched",
    subsystem: "worker-command",
    operation: command.type,
    status: "started",
    requestId: request.requestId,
    ...(typeof command.chatId === "string" ? { chatId: command.chatId } : {}),
    ...(typeof command.projectId === "string"
      ? { projectId: command.projectId }
      : {}),
    ...(typeof command.sessionId === "string"
      ? { sessionId: command.sessionId }
      : {}),
    ...(typeof command.surfaceId === "string"
      ? { surfaceId: command.surfaceId }
      : {}),
    ...(typeof command.terminalId === "string"
      ? { terminalId: command.terminalId }
      : {}),
    ...(typeof command.worktreeId === "string"
      ? { worktreeId: command.worktreeId }
      : {}),
    ...(typeof command.branch === "string" ? { branch: command.branch } : {}),
    ...(typeof command.revision === "string"
      ? { revision: command.revision }
      : {}),
    ...(typeof command.baseRevision === "string"
      ? { baseRevision: command.baseRevision }
      : {}),
    ...(typeof command.headRevision === "string"
      ? { headRevision: command.headRevision }
      : {}),
  };
}

const HIGH_VOLUME_COMMANDS = new Set<WorkerCommand["type"]>([
  "diagnostics.logs.read",
  "diagnostics.logs.stream.start",
  "diagnostics.logs.stream.renew",
  "diagnostics.logs.stream.stop",
  "surface.configure",
  "terminal.input",
  "terminal.resize",
]);

function commandLevel(command: WorkerCommand): "debug" | "info" | "trace" {
  if (HIGH_VOLUME_COMMANDS.has(command.type)) return "trace";
  return command.type === "chat.turn" ||
    command.type === "workflow.node.execute"
    ? "info"
    : "debug";
}

function commandCompletionLogContext(
  request: WorkerRequestEnvelope,
  result: unknown,
): Record<string, unknown> {
  if (Array.isArray(result)) {
    return { counts: { items: result.length } };
  }
  if (!result || typeof result !== "object") {
    return {};
  }
  const value = result as Record<string, unknown>;
  if (request.command.type !== "chat.turn") {
    const countFields = [
      "branches",
      "commits",
      "conflicts",
      "entries",
      "files",
      "issues",
      "items",
      "models",
      "pullRequests",
      "references",
      "releases",
      "remotes",
      "repositories",
      "shares",
      "stashes",
      "submodules",
      "tags",
      "targets",
      "worktrees",
    ] as const;
    const counts = Object.fromEntries(
      countFields.flatMap((field) =>
        Array.isArray(value[field]) ? [[field, value[field].length]] : [],
      ),
    );
    return Object.keys(counts).length > 0 ? { counts } : {};
  }
  return {
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
    ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
    ...(typeof value.text === "string"
      ? { responseCharacterCount: value.text.length }
      : {}),
  };
}

export class WorkerConnection {
  #closed = false;
  #authenticationRejected = false;
  readonly #connectionGeneration = randomUUID();
  #connectionReadyDeadlineMs: number | null = null;
  #connectionReadyTimer: ReturnType<typeof setTimeout> | null = null;
  #connectionPendingObserved = false;
  #connectAttempt = 0;
  #disconnectStartedAtMs: number | null = null;
  #lastConnectionError: string | null = null;
  #keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  #offerConnectionSubprotocols = true;
  #pendingCommandBytes = 0;
  readonly #pendingCommandEnvelopes: string[] = [];
  readonly #reconnectDelayMs: number;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #readySocket: WebSocket | null = null;
  #socket: WebSocket | null = null;
  #socketReadiness: "idle" | "negotiating" | "protocol-pending" | "ready" =
    "idle";
  #transportDisconnectDeadlineMs: number | null = null;
  readonly #transportDisconnectGraceMs: number;
  #transportDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #transportLossGeneration = 0;
  #transportState: "inactive" | "connected" | "grace" | "disconnected" =
    "inactive";

  constructor(
    private readonly config: WorkerConfig,
    private readonly handleCommand: CommandHandler,
    private readonly handleSurfaceFrame: SurfaceFrameHandler = () => undefined,
    private readonly handleTunnelDataPlaneFrame: TunnelDataPlaneFrameHandler = () =>
      undefined,
    private readonly handleTransportDisconnect: () => void = () => undefined,
    private readonly keepaliveIntervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS,
    private readonly handleTransportConnect: () => void = () => undefined,
    timing: WorkerConnectionTimingOptions = {},
  ) {
    this.#reconnectDelayMs = Math.max(
      0,
      timing.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    );
    this.#transportDisconnectGraceMs = Math.max(
      0,
      timing.transportDisconnectGraceMs ??
        DEFAULT_TRANSPORT_DISCONNECT_GRACE_MS,
    );
  }

  start(): void {
    this.#authenticationRejected = false;
    this.#disconnectStartedAtMs ??= Date.now();
    workerLogger.event("info", "Worker command channel starting", {
      event: "worker.connection.starting",
      subsystem: "worker-connection",
      operation: "connect",
      status: "started",
      workerId: this.config.workerId,
    });
    this.connect();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.clearKeepalive();
    this.clearSocketNegotiation();
    this.finalizeTransportDisconnect("worker-stopping");
    this.#pendingCommandEnvelopes.length = 0;
    this.#pendingCommandBytes = 0;
    this.#socket?.close(1000, "Worker stopping");
    this.#socket = null;
    workerLogger.event("info", "Worker command channel stopped", {
      event: "worker.connection.stopped",
      subsystem: "worker-connection",
      operation: "disconnect",
      status: "completed",
      workerId: this.config.workerId,
      counts: { queuedCommands: 0 },
    });
  }

  private connect(): void {
    if (this.#closed) {
      return;
    }
    const url = new URL(this.config.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/internal/workers/connect";
    url.searchParams.set("workerId", this.config.workerId);
    url.searchParams.set("connectionGeneration", this.#connectionGeneration);

    this.#connectAttempt += 1;
    workerLogger.event("debug", "Worker command connection attempted", {
      event: "worker.connection.attempted",
      subsystem: "worker-connection",
      operation: "connect",
      status: "started",
      attempt: this.#connectAttempt,
      workerId: this.config.workerId,
      serverOrigin: url.origin,
    });

    const socketOptions = {
      headers: { authorization: `Bearer ${this.config.token}` },
    };
    const socket = this.#offerConnectionSubprotocols
      ? new WebSocket(url, [...WORKER_WEBSOCKET_SUBPROTOCOLS], socketOptions)
      : new WebSocket(url, socketOptions);
    this.clearSocketNegotiation();
    this.#socket = socket;
    this.#socketReadiness = "negotiating";
    socket.once("open", () => this.handleSocketOpen(socket));
    socket.on("message", (data, isBinary) => {
      if (this.#socket === socket) void this.onMessage(socket, data, isBinary);
    });
    socket.once("error", (error) => this.handleSocketError(socket, error));
    socket.once("close", (code, reason) =>
      this.handleSocketClose(socket, code, reason.toString()),
    );
  }

  private handleSocketOpen(socket: WebSocket): void {
    if (this.#closed || this.#socket !== socket) {
      socket.close(1012, "Worker connection was superseded");
      return;
    }
    this.#lastConnectionError = null;
    if (socket.protocol === WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL) {
      this.markSocketReady(socket, "legacy-subprotocol");
    } else if (socket.protocol === WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL) {
      this.#socketReadiness = "protocol-pending";
      this.startConnectionReadyTimer(socket);
    }
  }

  private handleSocketError(socket: WebSocket, error: Error): void {
    if (
      this.#closed ||
      this.#socket !== socket ||
      error.message === this.#lastConnectionError
    )
      return;
    if (error.message === "Server sent no subprotocol") {
      // Some legacy servers accept the offered handshake but omit the selected
      // protocol. Retry without offers and require a real request or a
      // pending/ready envelope before trusting that connection.
      this.#offerConnectionSubprotocols = false;
    }
    this.#lastConnectionError = error.message;
    workerLogger.rateLimited(
      `worker-connection-error:${this.config.workerId}`,
      "warn",
      "Worker command channel unavailable",
      {
        event: "worker.connection.failed",
        subsystem: "worker-connection",
        operation: "connect",
        status: "retrying",
        attempt: this.#connectAttempt,
        workerId: this.config.workerId,
        error: workerLogError(error),
      },
    );
  }

  private handleSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ): void {
    const wasCurrent = this.#socket === socket;
    if (wasCurrent) {
      this.#disconnectStartedAtMs ??= Date.now();
      this.clearKeepalive();
      this.clearSocketNegotiation();
      this.#socket = null;
    }
    if (wasCurrent && code === 1008) {
      this.#authenticationRejected = true;
      this.finalizeTransportDisconnect("authentication-rejected");
      const message = reason || "worker authentication rejected";
      if (message !== this.#lastConnectionError) {
        this.#lastConnectionError = message;
        workerLogger.event(
          "warn",
          "Command channel authentication rejected; update or re-enroll this worker, then restart it",
          {
            event: "worker.connection.authentication-rejected",
            subsystem: "worker-connection",
            operation: "authenticate",
            reasonCode: "authentication-rejected",
            status: "rejected",
            workerId: this.config.workerId,
            closeCode: code,
          },
        );
      }
    }
    if (wasCurrent && !this.#closed && !this.#authenticationRejected) {
      this.scheduleTransportDisconnect();
      workerLogger.event("warn", "Worker command channel disconnected", {
        event: "worker.connection.disconnected",
        subsystem: "worker-connection",
        operation: "disconnect",
        reasonCode: code === 1000 ? "normal-close" : "socket-closed",
        status: "retrying",
        workerId: this.config.workerId,
        closeCode: code,
        reconnectDelayMs: this.#reconnectDelayMs,
        transportDisconnectGraceMs: this.#transportDisconnectGraceMs,
      });
      this.#reconnectTimer = setTimeout(
        () => this.connect(),
        this.#reconnectDelayMs,
      );
      this.#reconnectTimer.unref();
    }
  }

  private markTransportConnected(): void {
    this.cancelTransportDisconnectTimer();
    this.#transportDisconnectDeadlineMs = null;
    this.#transportLossGeneration += 1;
    this.#transportState = "connected";
  }

  private scheduleTransportDisconnect(): void {
    if (
      this.#transportState === "inactive" ||
      this.#transportState === "disconnected" ||
      this.#transportState === "grace"
    ) {
      return;
    }
    this.#transportState = "grace";
    const generation = ++this.#transportLossGeneration;
    this.#transportDisconnectDeadlineMs =
      Date.now() + this.#transportDisconnectGraceMs;
    if (this.#transportDisconnectGraceMs === 0) {
      this.finalizeTransportDisconnect("reconnect-grace-expired", generation);
      return;
    }
    this.#transportDisconnectTimer = setTimeout(() => {
      this.#transportDisconnectTimer = null;
      this.finalizeTransportDisconnect("reconnect-grace-expired", generation);
    }, this.#transportDisconnectGraceMs);
    this.#transportDisconnectTimer.unref();
  }

  private finalizeTransportDisconnect(
    reasonCode:
      "authentication-rejected" | "reconnect-grace-expired" | "worker-stopping",
    generation?: number,
  ): void {
    if (
      generation !== undefined &&
      generation !== this.#transportLossGeneration
    ) {
      return;
    }
    if (this.#transportState === "disconnected") return;
    this.cancelTransportDisconnectTimer();
    this.#transportDisconnectDeadlineMs = null;
    this.#transportLossGeneration += 1;
    this.#transportState = "disconnected";
    workerLogger.event(
      reasonCode === "reconnect-grace-expired" ? "warn" : "debug",
      "Worker transport resources disconnected",
      {
        event: "worker.transport.disconnected",
        subsystem: "worker-connection",
        operation: "disconnect-transport",
        reasonCode,
        status:
          reasonCode === "reconnect-grace-expired" ? "degraded" : "completed",
        workerId: this.config.workerId,
      },
    );
    this.handleTransportDisconnect();
  }

  private cancelTransportDisconnectTimer(): void {
    if (!this.#transportDisconnectTimer) return;
    clearTimeout(this.#transportDisconnectTimer);
    this.#transportDisconnectTimer = null;
  }

  private startConnectionReadyTimer(socket: WebSocket): void {
    this.clearConnectionReadyTimer();
    const deadlineMs =
      this.#transportDisconnectDeadlineMs ??
      this.#connectionReadyDeadlineMs ??
      Date.now() + this.#transportDisconnectGraceMs;
    this.#connectionReadyDeadlineMs = deadlineMs;
    const delayMs = Math.max(0, deadlineMs - Date.now());
    this.#connectionReadyTimer = setTimeout(() => {
      this.#connectionReadyTimer = null;
      if (
        this.#socket !== socket ||
        this.#socketReadiness !== "protocol-pending"
      ) {
        return;
      }
      this.finalizeTransportDisconnect("reconnect-grace-expired");
      socket.close(1013, "Worker connection did not become ready");
    }, delayMs);
    this.#connectionReadyTimer.unref();
  }

  private markSocketReady(
    socket: WebSocket,
    negotiation: "legacy-request" | "legacy-subprotocol" | "protocol",
  ): void {
    if (
      this.#closed ||
      this.#socket !== socket ||
      socket.readyState !== WebSocket.OPEN ||
      this.#socketReadiness === "ready"
    ) {
      return;
    }
    const reconnectDurationMs = this.#disconnectStartedAtMs
      ? Math.max(0, Date.now() - this.#disconnectStartedAtMs)
      : 0;
    this.clearSocketNegotiationTimers();
    this.#connectionReadyDeadlineMs = null;
    this.#readySocket = socket;
    this.#socketReadiness = "ready";
    this.markTransportConnected();
    this.startKeepalive(socket);
    this.flushCommandEnvelopes(socket);
    workerLogger.event("info", "Worker command channel connected", {
      event: "worker.connection.connected",
      subsystem: "worker-connection",
      operation: "connect",
      status: "completed",
      attempt: this.#connectAttempt,
      durationMs: reconnectDurationMs,
      workerId: this.config.workerId,
      negotiation,
      counts: {
        queuedCommands: this.#pendingCommandEnvelopes.length,
        queuedBytes: this.#pendingCommandBytes,
      },
    });
    this.#disconnectStartedAtMs = null;
    this.#connectAttempt = 0;
    this.handleTransportConnect();
  }

  private handleConnectionEnvelope(
    socket: WebSocket,
    encoded: string,
  ): boolean {
    const decoded = decodeWorkerConnectionEnvelope(encoded);
    if (!decoded.success) {
      if (
        decoded.reason === "invalid-message" &&
        typeof decoded.value === "object" &&
        decoded.value !== null &&
        "kind" in decoded.value &&
        decoded.value.kind === "connection"
      ) {
        this.clearKeepalive();
        this.#readySocket = null;
        this.#socketReadiness = "protocol-pending";
        socket.close(1002, "Invalid worker connection envelope");
        return true;
      }
      return false;
    }
    if (decoded.data.connectionGeneration !== this.#connectionGeneration) {
      this.clearKeepalive();
      this.#readySocket = null;
      this.#socketReadiness = "protocol-pending";
      socket.close(1002, "Worker connection generation mismatch");
      return true;
    }
    if (decoded.data.state === "pending") {
      this.#connectionPendingObserved = true;
      if (this.#socketReadiness !== "ready") {
        this.#socketReadiness = "protocol-pending";
        this.startConnectionReadyTimer(socket);
      }
      return true;
    }
    if (
      this.#socketReadiness !== "protocol-pending" ||
      !this.#connectionPendingObserved
    ) {
      this.clearKeepalive();
      this.#readySocket = null;
      this.#socketReadiness = "protocol-pending";
      socket.close(1002, "Worker connection became ready before pending");
      return true;
    }
    this.markSocketReady(socket, "protocol");
    return true;
  }

  private clearSocketNegotiation(): void {
    this.clearSocketNegotiationTimers();
    this.#connectionReadyDeadlineMs = null;
    this.#connectionPendingObserved = false;
    this.#readySocket = null;
    this.#socketReadiness = "idle";
  }

  private clearSocketNegotiationTimers(): void {
    this.clearConnectionReadyTimer();
  }

  private clearConnectionReadyTimer(): void {
    if (!this.#connectionReadyTimer) return;
    clearTimeout(this.#connectionReadyTimer);
    this.#connectionReadyTimer = null;
  }

  private startKeepalive(socket: WebSocket): void {
    this.clearKeepalive();
    if (this.keepaliveIntervalMs <= 0) return;
    this.#keepaliveTimer = setInterval(() => {
      if (
        this.#readySocket !== socket ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, this.keepaliveIntervalMs);
    this.#keepaliveTimer.unref();
  }

  private clearKeepalive(): void {
    if (!this.#keepaliveTimer) return;
    clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = null;
  }

  private sendCommandEnvelope(envelope: string): CommandEnvelopeDelivery {
    const socket = this.#readySocket;
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(envelope);
        return "sent";
      } catch {
        // Preserve the command result for the reconnecting channel below.
      }
    }
    if (this.#closed || this.#authenticationRejected) return "dropped";
    const bytes = Buffer.byteLength(envelope);
    while (
      this.#pendingCommandEnvelopes.length > 0 &&
      this.#pendingCommandBytes + bytes > MAX_BUFFERED_COMMAND_BYTES
    ) {
      const removed = this.#pendingCommandEnvelopes.shift()!;
      this.#pendingCommandBytes -= Buffer.byteLength(removed);
      workerLogger.rateLimited(
        `worker-command-buffer-evicted:${this.config.workerId}`,
        "warn",
        "Queued worker command response evicted by backpressure",
        {
          event: "worker.command.response-evicted",
          subsystem: "worker-command",
          operation: "buffer-response",
          reasonCode: "buffer-limit",
          status: "dropped",
          workerId: this.config.workerId,
          counts: { queuedBytes: this.#pendingCommandBytes },
        },
      );
    }
    if (bytes > MAX_BUFFERED_COMMAND_BYTES) return "dropped";
    this.#pendingCommandEnvelopes.push(envelope);
    this.#pendingCommandBytes += bytes;
    return "queued";
  }

  private sendServerEnvelope(
    envelope: WorkerServerEnvelope,
  ): CommandEnvelopeDelivery {
    return this.sendCommandEnvelope(encodeWorkerServerEnvelope(envelope));
  }

  private dispatchChatTurnOutcome(
    request: WorkerRequestEnvelope,
    command: Extract<WorkerCommand, { type: "chat.turn" }>,
    outcome: Extract<
      WorkerNotification,
      { type: "chat.turn.outcome" }
    >["outcome"],
  ): void {
    const delivery = this.sendServerEnvelope({
      kind: "notification",
      notification: {
        type: "chat.turn.outcome",
        chatId: command.chatId,
        clientMessageId: command.clientMessageId,
        executionLaneId: command.executionLaneId,
        worktreeId: command.worktreeId,
        taskDispatchFence: command.taskDispatchLease
          ? {
              cycleId: command.taskDispatchLease.cycleId,
              operationId: command.taskDispatchLease.operationId,
              leaseOwner: command.taskDispatchLease.leaseOwner,
              fencingToken: command.taskDispatchLease.fencingToken,
            }
          : undefined,
        outcome,
      },
    });
    workerLogger.event(
      "debug",
      "Codex outcome dispatched for durable recovery",
      {
        event: "codex.turn.outcome-dispatched",
        subsystem: "worker-command",
        operation: "dispatch-durable-outcome",
        status: delivery,
        requestId: request.requestId,
        chatId: command.chatId,
        delivery,
        outcome: outcome.ok ? "completed" : "failed",
      },
    );
  }

  private flushCommandEnvelopes(socket: WebSocket): void {
    while (
      this.#readySocket === socket &&
      socket.readyState === WebSocket.OPEN &&
      this.#pendingCommandEnvelopes.length > 0
    ) {
      const envelope = this.#pendingCommandEnvelopes[0]!;
      try {
        socket.send(envelope);
      } catch {
        return;
      }
      this.#pendingCommandEnvelopes.shift();
      this.#pendingCommandBytes -= Buffer.byteLength(envelope);
    }
  }

  sendSurfaceFrame(
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const socket = this.#readySocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) {
      if (header.channel !== "frame" && header.channel !== "cursor") {
        socket.close(1013, "Remote Surface worker channel is congested");
      }
      return false;
    }
    try {
      socket.send(encodeRemoteSurfaceFrame(header, payload), { binary: true });
      return true;
    } catch {
      return false;
    }
  }

  sendTunnelDataPlaneFrame(
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const socket = this.#readySocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) return false;
    try {
      socket.send(encodeTunnelDataPlaneFrame(header, payload), {
        binary: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  sendNotification(notification: WorkerNotification): boolean {
    const socket = this.#readySocket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_BUFFERED_NOTIFICATION_BYTES
    ) {
      return false;
    }
    try {
      socket.send(
        encodeWorkerServerEnvelope({ kind: "notification", notification }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async waitForTunnelDataPlaneCapacity(): Promise<boolean> {
    while (!this.#closed) {
      const socket = this.#readySocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      if (socket.bufferedAmount <= TUNNEL_DATA_PLANE_LOW_WATER_BYTES)
        return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    return false;
  }

  private async onMessage(
    socket: WebSocket,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (this.#socket !== socket) return;
    if (isBinary) {
      if (this.#readySocket !== socket) return;
      await this.handleBinaryFrame(data);
      return;
    }
    const encoded = data.toString();
    if (this.handleConnectionEnvelope(socket, encoded)) return;
    const request = decodeWorkerRequestEnvelope(encoded);
    if (!request.success) {
      workerLogger.rateLimited(
        `worker-command-invalid-envelope:${this.config.workerId}`,
        "warn",
        "Worker command envelope was rejected",
        {
          event: "worker.command.rejected",
          subsystem: "worker-command",
          operation: "decode",
          reasonCode: "invalid-envelope",
          status: "rejected",
          workerId: this.config.workerId,
        },
      );
      return;
    }

    if (this.#readySocket !== socket) {
      if (this.#socketReadiness === "protocol-pending") return;
      this.markSocketReady(socket, "legacy-request");
    }
    if (this.#readySocket !== socket) return;

    await this.handleRequest(request.data);
  }

  private async handleBinaryFrame(data: RawData): Promise<void> {
    try {
      const bytes = rawDataBytes(data);
      if (isTunnelDataPlaneFrame(bytes)) {
        const frame = decodeTunnelDataPlaneFrame(bytes);
        await this.handleTunnelDataPlaneFrame(frame.header, frame.payload);
      } else {
        const frame = decodeRemoteSurfaceFrame(bytes);
        await this.handleSurfaceFrame(frame.header, frame.payload);
      }
    } catch (error) {
      workerLogger.rateLimited(
        `worker-data-frame-rejected:${this.config.workerId}`,
        "warn",
        "Rejected worker data frame",
        {
          event: "worker.transport.frame-rejected",
          subsystem: "worker-connection",
          operation: "decode-data-frame",
          reasonCode: "invalid-frame",
          status: "rejected",
          workerId: this.config.workerId,
          error: workerLogError(error),
        },
      );
    }
  }

  private async handleRequest(request: WorkerRequestEnvelope): Promise<void> {
    const startedAt = performance.now();
    let emittedEventCount = 0;
    const level = commandLevel(request.command);
    const logContext = commandLogContext(request);
    if (level === "trace") {
      workerLogger.sampled(
        `worker-command-dispatched:${request.command.type}`,
        100,
        "trace",
        "Worker command dispatched",
        logContext,
      );
    } else {
      workerLogger.event(level, "Worker command dispatched", logContext);
    }
    try {
      const emit = (event: WorkerEvent) => {
        emittedEventCount += 1;
        this.sendServerEnvelope({
          kind: "event",
          requestId: request.requestId,
          event,
        });
      };
      const result = await this.handleCommand(request.command, emit);
      this.sendServerEnvelope({
        kind: "response",
        requestId: request.requestId,
        ok: true,
        result,
      });
      if (request.command.type === "chat.turn") {
        const parsedResult = agentTurnResultSchema.safeParse(result);
        if (parsedResult.success) {
          this.dispatchChatTurnOutcome(request, request.command, {
            ok: true,
            result: parsedResult.data,
          });
        } else {
          workerLogger.event(
            "error",
            "Codex command returned an invalid result",
            {
              ...commandLogContext(request),
              event: "worker.command.invalid-result",
              reasonCode: "schema-validation-failed",
              status: "failed",
              counts: { validationIssues: parsedResult.error.issues.length },
            },
          );
        }
      }
      const completionContext = commandCompletionLogContext(request, result);
      const completedContext = {
        ...commandLogContext(request),
        event: "worker.command.completed",
        status: "completed",
        ...completionContext,
        durationMs: Math.round(performance.now() - startedAt),
        counts: {
          ...(completionContext.counts &&
          typeof completionContext.counts === "object"
            ? completionContext.counts
            : {}),
          emittedEvents: emittedEventCount,
        },
      };
      if (level === "trace") {
        workerLogger.sampled(
          `worker-command-completed:${request.command.type}`,
          100,
          "trace",
          "Worker command completed",
          completedContext,
        );
      } else {
        workerLogger.event(level, "Worker command completed", completedContext);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureContext = {
        ...commandLogContext(request),
        event: "worker.command.failed",
        reasonCode: "handler-failed",
        status: "failed",
        durationMs: Math.round(performance.now() - startedAt),
        error: workerLogError(error),
      };
      if (
        request.command.type === "chat.turn" ||
        request.command.type === "workflow.node.execute"
      ) {
        workerLogger.event("error", "Worker command failed", failureContext);
      } else {
        workerLogger.rateLimited(
          `worker-command-failed:${request.command.type}`,
          "error",
          "Worker command failed",
          failureContext,
        );
      }
      this.sendServerEnvelope({
        kind: "response",
        requestId: request.requestId,
        ok: false,
        error: {
          message,
        },
      });
      if (request.command.type === "chat.turn") {
        this.dispatchChatTurnOutcome(request, request.command, {
          ok: false,
          error: message,
        });
      }
    }
  }
}
