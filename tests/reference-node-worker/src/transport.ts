import {
  TaskGoalOutcomeDelivery,
  type GoalOutcomeScope,
} from "./task-goal-outcome-delivery.js";
import type { TaskGoalOutcomeDelivery as GoalOutcomeRecord } from "@cantrip/protocol";
import { randomBytes, randomUUID } from "node:crypto";
import { inferenceFailure } from "./inference-failure.js";

import {
  agentTurnResultSchema,
  decodeWorkerConnectionEnvelope,
  decodeWorkerRequestEnvelope,
  decodeRemoteSurfaceFrame,
  decodeTunnelDataPlaneFrame,
  decodeWorkerLinkFrame,
  encodeWorkerServerEnvelope,
  encodeRemoteSurfaceFrame,
  encodeTunnelDataPlaneFrame,
  encodeWorkerLinkFrame,
  isTunnelDataPlaneFrame,
  isWorkerLinkFrame,
  type RemoteSurfaceFrameHeader,
  type TunnelDataPlaneFrameHeader,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerNotification,
  type WorkerLinkFrameHeader,
  type WorkerRequestEnvelope,
  type WorkerServerEnvelope,
  WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL,
  WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL,
  WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL,
  WORKER_WEBSOCKET_SUBPROTOCOLS,
} from "@cantrip/protocol";
import type { OperationalLogContext } from "@cantrip/logging";
import WebSocket, { type RawData } from "ws";

import { serverWorkerNotification } from "./worker-notification-privacy.js";
import type { WorkerConfig } from "./config.js";
import { workerLogError, workerLogger } from "./logger.js";

type CommandHandler = (
  command: WorkerCommand,
  emit: (event: WorkerEvent) => void,
  context: Pick<
    WorkerRequestEnvelope,
    "inferenceAdmissionAck" | "modelOperationUsage"
  > & {
    inferenceOperationIdentity?: string;
    inferenceOperationSignal?: AbortSignal;
  },
) => Promise<unknown>;

type SurfaceFrameHandler = (
  header: RemoteSurfaceFrameHeader,
  payload: Uint8Array,
) => Promise<void> | void;

type TunnelDataPlaneFrameHandler = (
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
) => Promise<void> | void;

type WorkerLinkFrameHandler = (
  header: WorkerLinkFrameHeader,
  payload: Uint8Array,
) => Promise<void> | void;

const MAX_BUFFERED_SURFACE_BYTES = 8 * 1_024 * 1_024;
const MAX_BUFFERED_NOTIFICATION_BYTES = 1 * 1_024 * 1_024;
const MAX_BUFFERED_COMMAND_BYTES = 8 * 1_024 * 1_024;
const TUNNEL_DATA_PLANE_LOW_WATER_BYTES = 256 * 1_024;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_TRANSPORT_DISCONNECT_GRACE_MS = 15_000;
export function workerReconnectDelayMs(
  baseMs: number,
  failedAttempts: number,
  random = Math.random,
): number {
  const ceiling = Math.min(
    15_000,
    baseMs * 2 ** Math.min(4, Math.max(0, failedAttempts - 1)),
  );
  return Math.max(
    1,
    Math.floor(ceiling * (0.75 + Math.min(1, Math.max(0, random())) * 0.25)),
  );
}

type CommandEnvelopeDelivery = "sent" | "queued" | "dropped";

function workerCommandFailureCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return;
  const code = error.code;
  return typeof code === "string" &&
    code.length <= 100 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(code)
    ? code
    : undefined;
}

export interface WorkerConnectionTimingOptions {
  connectionGeneration?: string;
  goalOutcomeDelivery?: {
    scope(): GoalOutcomeScope;
    send(record: GoalOutcomeRecord, signal: AbortSignal): Promise<void>;
  };
  handleWorkerLinkFrame?: WorkerLinkFrameHandler;
  keepaliveTimeoutMs?: number;
  /** Synchronously stop new execution admission; retire existing ownership asynchronously. */
  onAuthenticationRejected?: () => void;
  observeEvent?: (command: WorkerCommand, event: WorkerEvent) => void;
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
  return command.type === "chat.turn" ? "info" : "debug";
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
  readonly #connectionGeneration: string;
  #connectionReadyDeadlineMs: number | null = null;
  #connectionReadyTimer: ReturnType<typeof setTimeout> | null = null;
  #connectionPendingObserved = false;
  #pendingServerControlPlaneGeneration: string | null = null;
  #inferenceCommandGeneration: string | null = null;
  #lastInferenceCommandSequence = 0n;
  #inferenceCommandLifetime = new AbortController();
  #connectAttempt = 0;
  #disconnectStartedAtMs: number | null = null;
  #keepalivePingSendDeadline: ReturnType<typeof setTimeout> | null = null;
  #keepalivePongDeadline: ReturnType<typeof setTimeout> | null = null;
  #keepalivePongListener: ((payload: Buffer) => void) | null = null;
  #keepalivePongNonce: Buffer | null = null;
  #keepaliveSocket: WebSocket | null = null;
  readonly #keepaliveTimeoutMs: number;
  #lastConnectionError: string | null = null;
  #keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  #omitConnectionSubprotocolsOnce = false;
  #pendingCommandBytes = 0;
  readonly #pendingCommandEnvelopes: string[] = [];
  readonly #reconnectDelayMs: number;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingInferenceStatus: Extract<
    WorkerNotification,
    { type: "inference.status" }
  > | null = null;
  #inferenceStatusRetry: ReturnType<typeof setTimeout> | null = null;
  #inferenceStatusVersion = Symbol();
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
  #workerLinkCapacityWait: Promise<boolean> | null = null;
  readonly #goalOutcomes: TaskGoalOutcomeDelivery | null;
  readonly #taskResultCommits = new Map<
    string,
    { result: Promise<void>; resolve(): void; reject(error: unknown): void }
  >();

  constructor(
    private readonly config: WorkerConfig,
    private readonly handleCommand: CommandHandler,
    private readonly handleSurfaceFrame: SurfaceFrameHandler = () => undefined,
    private readonly handleTunnelDataPlaneFrame: TunnelDataPlaneFrameHandler = () =>
      undefined,
    private readonly handleTransportDisconnect: () => void = () => undefined,
    private readonly keepaliveIntervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS,
    private readonly handleTransportConnect: (
      serverControlPlaneGeneration: string | null,
    ) => void = () => undefined,
    private readonly timing: WorkerConnectionTimingOptions = {},
  ) {
    this.#goalOutcomes = timing.goalOutcomeDelivery
      ? new TaskGoalOutcomeDelivery({
          ...timing.goalOutcomeDelivery,
          directory: config.dataDirectory,
          onError: (error) =>
            workerLogger.rateLimited(
              "task-outcome-delivery",
              "warn",
              "Task outcome durable delivery remains pending",
              {
                event: "task.outcome-delivery-pending",
                workerId: config.workerId,
                error: workerLogError(error),
              },
            ),
        })
      : null;
    this.#connectionGeneration = timing.connectionGeneration ?? randomUUID();
    this.#keepaliveTimeoutMs = Math.max(
      1,
      timing.keepaliveTimeoutMs ?? DEFAULT_KEEPALIVE_TIMEOUT_MS,
    );
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

  connectionGeneration(): string {
    return this.#connectionGeneration;
  }

  async deliverGoalCycleOutcome(
    notification: GoalOutcomeRecord["notification"],
    source: NonNullable<GoalOutcomeRecord["goalCycleSource"]>,
    scope: GoalOutcomeScope,
  ): Promise<void> {
    if (!this.#goalOutcomes || !this.timing.goalOutcomeDelivery)
      throw new Error("The Goal cycle has no durable outcome publisher.");
    await this.#goalOutcomes.append(notification, scope, "goal-cycle", source);
  }

  taskResultCommitted(operationId: string): Promise<void> {
    let pending = this.#taskResultCommits.get(operationId);
    if (!pending) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const result = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void result.catch(() => {});
      pending = { result, resolve, reject };
      this.#taskResultCommits.set(operationId, pending);
    }
    return pending.result;
  }

  start(): void {
    if (this.#closed || this.#authenticationRejected) return;
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
    for (const pending of this.#taskResultCommits.values())
      pending.reject(new Error("Task result publication stopped."));
    this.#taskResultCommits.clear();
    if (this.#closed) return;
    this.#closed = true;
    this.#goalOutcomes?.close();
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
    if (this.#closed || this.#authenticationRejected) {
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
    const omitConnectionSubprotocols = this.#omitConnectionSubprotocolsOnce;
    this.#omitConnectionSubprotocolsOnce = false;
    const socket = omitConnectionSubprotocols
      ? new WebSocket(url, socketOptions)
      : new WebSocket(url, [...WORKER_WEBSOCKET_SUBPROTOCOLS], socketOptions);
    this.clearSocketNegotiation();
    this.#socket = socket;
    this.#socketReadiness = "negotiating";
    let unexpectedResponse = false;
    socket.once("open", () => this.handleSocketOpen(socket));
    socket.on("message", (data, isBinary) => {
      if (this.#socket === socket) void this.onMessage(socket, data, isBinary);
    });
    socket.once("error", (error) => {
      if (!unexpectedResponse) this.handleSocketError(socket, error);
    });
    socket.once("unexpected-response", (_request, response) => {
      unexpectedResponse = true;
      const status = response.statusCode;
      if (status === 401 || status === 403)
        this.rejectAuthentication(socket, { httpStatus: status });
      else
        this.handleSocketError(
          socket,
          new Error(`Unexpected server response: ${status}`),
        );
      // Handling this event suppresses ws's default handshake abort. Complete
      // the socket lifecycle for every non-upgrade response, including retries.
      response.resume();
      socket.terminate();
    });
    socket.once("close", (code) => this.handleSocketClose(socket, code));
  }

  private handleSocketOpen(socket: WebSocket): void {
    if (this.#closed || this.#socket !== socket) {
      socket.close(1012, "Worker connection was superseded");
      return;
    }
    this.#lastConnectionError = null;
    if (socket.protocol === WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL) {
      this.markSocketReady(socket, "legacy-subprotocol");
    } else if (
      socket.protocol === WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL ||
      socket.protocol === WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL
    ) {
      this.#socketReadiness = "protocol-pending";
      this.startConnectionReadyTimer(socket);
    }
  }

  private handleSocketError(socket: WebSocket, error: Error): void {
    if (
      this.#closed ||
      this.#authenticationRejected ||
      this.#socket !== socket ||
      error.message === this.#lastConnectionError
    )
      return;
    if (error.message === "Server sent no subprotocol") {
      // Some legacy servers accept the offered handshake but omit the selected
      // protocol. Retry without offers and require a real request or a
      // pending/ready envelope before trusting that connection.
      this.#omitConnectionSubprotocolsOnce = true;
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

  private handleSocketClose(socket: WebSocket, code: number): void {
    const wasCurrent = this.#socket === socket;
    if (wasCurrent && code === 1008)
      this.rejectAuthentication(socket, { closeCode: code });
    if (wasCurrent) {
      this.#disconnectStartedAtMs ??= Date.now();
      this.clearKeepalive();
      this.clearSocketNegotiation();
      this.#socket = null;
    }
    if (wasCurrent && !this.#closed && !this.#authenticationRejected) {
      this.scheduleTransportDisconnect();
      const reconnectDelayMs = workerReconnectDelayMs(
        this.#reconnectDelayMs,
        this.#connectAttempt,
      );
      workerLogger.event("warn", "Worker command channel disconnected", {
        event: "worker.connection.disconnected",
        subsystem: "worker-connection",
        operation: "disconnect",
        reasonCode: code === 1000 ? "normal-close" : "socket-closed",
        status: "retrying",
        workerId: this.config.workerId,
        closeCode: code,
        reconnectDelayMs,
        transportDisconnectGraceMs: this.#transportDisconnectGraceMs,
      });
      this.#reconnectTimer = setTimeout(() => this.connect(), reconnectDelayMs);
      this.#reconnectTimer.unref();
    }
  }

  private rejectAuthentication(
    socket: WebSocket,
    evidence: { closeCode?: number; httpStatus?: number },
  ): void {
    if (this.#closed || this.#authenticationRejected || this.#socket !== socket)
      return;
    this.#authenticationRejected = true;
    this.#goalOutcomes?.close();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    // A prior reconnect-grace expiry may already have disconnected transport
    // resources. Authority retirement still has to run exactly once here.
    try {
      this.timing.onAuthenticationRejected?.();
    } catch (error) {
      workerLogger.event(
        "warn",
        "Worker authority retirement could not start",
        {
          event: "worker.connection.authority-retirement-failed",
          subsystem: "worker-connection",
          operation: "retire-authority",
          status: "degraded",
          workerId: this.config.workerId,
          error: workerLogError(error),
        },
      );
    }
    this.finalizeTransportDisconnect("authentication-rejected");
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
        ...evidence,
      },
    );
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
    this.#inferenceCommandLifetime.abort(
      new Error("The worker command transport ended."),
    );
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
    serverControlPlaneGeneration: string | null = null,
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
    // Reconnect within the same authenticated control plane preserves the high
    // water mark. Only an actual ready handshake can establish a new issuer.
    if (this.#inferenceCommandGeneration !== serverControlPlaneGeneration) {
      this.#inferenceCommandLifetime.abort(
        new Error("The worker command issuer changed."),
      );
      this.#inferenceCommandGeneration = serverControlPlaneGeneration;
      this.#lastInferenceCommandSequence = 0n;
    }
    if (this.#inferenceCommandLifetime.signal.aborted)
      this.#inferenceCommandLifetime = new AbortController();
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
    this.handleTransportConnect(serverControlPlaneGeneration);
    this.#goalOutcomes?.wake();
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
      this.#pendingServerControlPlaneGeneration =
        decoded.data.protocolVersion === 2
          ? decoded.data.serverControlPlaneGeneration
          : null;
      if (this.#socketReadiness !== "ready") {
        this.#socketReadiness = "protocol-pending";
        this.startConnectionReadyTimer(socket);
      }
      return true;
    }
    if (
      this.#socketReadiness !== "protocol-pending" ||
      !this.#connectionPendingObserved ||
      this.#pendingServerControlPlaneGeneration !==
        (decoded.data.protocolVersion === 2
          ? decoded.data.serverControlPlaneGeneration
          : null)
    ) {
      this.clearKeepalive();
      this.#readySocket = null;
      this.#socketReadiness = "protocol-pending";
      socket.close(1002, "Worker connection became ready before pending");
      return true;
    }
    this.markSocketReady(
      socket,
      "protocol",
      decoded.data.protocolVersion === 2
        ? decoded.data.serverControlPlaneGeneration
        : null,
    );
    return true;
  }

  private clearSocketNegotiation(): void {
    if (this.#inferenceStatusRetry) clearTimeout(this.#inferenceStatusRetry);
    this.#inferenceStatusRetry = null;
    // The configuration handshake supplies a fresh snapshot on reconnect.
    this.#pendingInferenceStatus = null;
    this.#inferenceStatusVersion = Symbol();
    this.clearSocketNegotiationTimers();
    this.#connectionReadyDeadlineMs = null;
    this.#connectionPendingObserved = false;
    this.#pendingServerControlPlaneGeneration = null;
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
    this.#keepaliveSocket = socket;
    this.#keepalivePongListener = (payload) => {
      const nonce = this.#keepalivePongNonce;
      if (
        this.#keepaliveSocket !== socket ||
        this.#readySocket !== socket ||
        this.#socket !== socket ||
        !nonce?.equals(payload)
      ) {
        return;
      }
      this.clearKeepalivePingSendDeadline();
      this.clearKeepalivePongDeadline();
      this.#keepalivePongNonce = null;
    };
    socket.on("pong", this.#keepalivePongListener);
    this.#keepaliveTimer = setInterval(() => {
      if (
        this.#keepaliveSocket !== socket ||
        this.#readySocket !== socket ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      if (this.#keepalivePongNonce) return;
      const nonce = randomBytes(16);
      this.#keepalivePongNonce = nonce;
      this.#keepalivePingSendDeadline = setTimeout(
        () => this.expireKeepalive(socket, nonce),
        this.#keepaliveTimeoutMs,
      );
      this.#keepalivePingSendDeadline.unref();
      try {
        socket.ping(nonce, undefined, (error?: Error) => {
          if (
            this.#keepaliveSocket !== socket ||
            this.#readySocket !== socket ||
            this.#socket !== socket ||
            !this.#keepalivePongNonce?.equals(nonce)
          ) {
            return;
          }
          this.clearKeepalivePingSendDeadline();
          if (error) {
            this.clearKeepalive();
            socket.terminate();
            return;
          }
          this.#keepalivePongDeadline = setTimeout(
            () => this.expireKeepalive(socket, nonce),
            this.#keepaliveTimeoutMs,
          );
          this.#keepalivePongDeadline.unref();
        });
      } catch {
        this.clearKeepalive();
        socket.terminate();
      }
    }, this.keepaliveIntervalMs);
    this.#keepaliveTimer.unref();
  }

  private clearKeepalive(): void {
    if (this.#keepaliveTimer) {
      clearInterval(this.#keepaliveTimer);
      this.#keepaliveTimer = null;
    }
    this.clearKeepalivePingSendDeadline();
    this.clearKeepalivePongDeadline();
    this.#keepalivePongNonce = null;
    const socket = this.#keepaliveSocket;
    const listener = this.#keepalivePongListener;
    this.#keepaliveSocket = null;
    this.#keepalivePongListener = null;
    if (socket && listener) socket.off("pong", listener);
  }

  private clearKeepalivePingSendDeadline(): void {
    if (!this.#keepalivePingSendDeadline) return;
    clearTimeout(this.#keepalivePingSendDeadline);
    this.#keepalivePingSendDeadline = null;
  }

  private clearKeepalivePongDeadline(): void {
    if (!this.#keepalivePongDeadline) return;
    clearTimeout(this.#keepalivePongDeadline);
    this.#keepalivePongDeadline = null;
  }

  private expireKeepalive(socket: WebSocket, nonce: Buffer): void {
    if (
      this.#keepaliveSocket !== socket ||
      this.#readySocket !== socket ||
      this.#socket !== socket ||
      !this.#keepalivePongNonce?.equals(nonce) ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    this.clearKeepalive();
    socket.terminate();
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

  private async prepareChatTurnOutcome(
    command: Extract<WorkerCommand, { type: "chat.turn" }>,
    outcome: Extract<
      WorkerNotification,
      { type: "chat.turn.outcome" }
    >["outcome"],
    scope?: GoalOutcomeScope,
  ): Promise<Extract<WorkerNotification, { type: "chat.turn.outcome" }>> {
    const notification: Extract<
      WorkerNotification,
      { type: "chat.turn.outcome" }
    > = {
      type: "chat.turn.outcome",
      chatId: command.chatId,
      clientMessageId: command.clientMessageId,
      executionLaneId: command.executionLaneId,
      contextKind: command.contextKind,
      worktreeId: command.worktreeId,
      scratchRootId: command.scratchRootId,
      nativeLogicalRoot: command.nativeCommandReceipt
        ? {
            operationId: command.nativeCommandReceipt.operationId,
            operationGeneration:
              command.nativeCommandReceipt.operationGeneration,
          }
        : undefined,
      taskInferenceInputOperationId: command.taskInferenceInput?.operationId,
      taskDispatchFence: command.taskDispatchLease
        ? {
            cycleId: command.taskDispatchLease.cycleId,
            operationId: command.taskDispatchLease.operationId,
            leaseOwner: command.taskDispatchLease.leaseOwner,
            fencingToken: command.taskDispatchLease.fencingToken,
          }
        : undefined,
      outcome,
    };
    if (command.taskInferenceInput && this.#goalOutcomes) {
      try {
        await this.#goalOutcomes.append(
          notification,
          scope,
          command.taskInferenceInput.kind === "goal" ? "goal" : "round",
          undefined,
          command.taskInferenceInput.kind === "goal",
        );
        this.#taskResultCommits
          .get(command.taskInferenceInput.operationId)
          ?.resolve();
        this.#taskResultCommits.delete(command.taskInferenceInput.operationId);
      } catch (error) {
        this.#taskResultCommits
          .get(command.taskInferenceInput.operationId)
          ?.reject(error);
        this.#taskResultCommits.delete(command.taskInferenceInput.operationId);
        // Persistence/transport errors cannot contradict the actual execution
        // result. Shutdown leaves already committed files for the next owner.
        workerLogger.event("warn", "Task outcome persistence was interrupted", {
          event: "task.outcome-persistence-interrupted",
          subsystem: "worker-command",
          workerId: this.config.workerId,
          error: workerLogError(error),
        });
      }
    }
    return notification;
  }

  private dispatchChatTurnOutcome(
    request: WorkerRequestEnvelope,
    notification: Extract<WorkerNotification, { type: "chat.turn.outcome" }>,
  ): void {
    const delivery = this.sendServerEnvelope({
      kind: "notification",
      notification,
    });
    workerLogger.event("debug", "Codex outcome dispatched for recovery", {
      event: "codex.turn.outcome-dispatched",
      subsystem: "worker-command",
      operation: "dispatch-durable-outcome",
      status: delivery,
      requestId: request.requestId,
      chatId: notification.chatId,
      delivery,
      outcome: notification.outcome.ok ? "completed" : "failed",
    });
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
      socket.terminate();
      return false;
    }
  }

  sendWorkerLinkFrame(
    header: WorkerLinkFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const socket = this.#readySocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) return false;
    try {
      socket.send(encodeWorkerLinkFrame(header, payload));
      return true;
    } catch {
      socket.terminate();
      return false;
    }
  }

  waitForWorkerLinkCapacity(): Promise<boolean> {
    if (this.#workerLinkCapacityWait) return this.#workerLinkCapacityWait;
    const waiting = (async () => {
      while (!this.#closed) {
        if (
          this.#transportState === "inactive" ||
          this.#transportState === "disconnected"
        ) {
          return false;
        }
        const socket = this.#readySocket;
        if (
          socket?.readyState === WebSocket.OPEN &&
          socket.bufferedAmount <= TUNNEL_DATA_PLANE_LOW_WATER_BYTES
        ) {
          return true;
        }
        // Keep authorized WorkerLink channels alive through the bounded
        // reconnect grace. A replacement ready socket wakes this coalesced
        // low-water poll without waiting for unrelated protocol credit.
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      return false;
    })();
    this.#workerLinkCapacityWait = waiting;
    void waiting.then(() => {
      if (this.#workerLinkCapacityWait === waiting) {
        this.#workerLinkCapacityWait = null;
      }
    });
    return waiting;
  }

  private retryInferenceStatus(): void {
    if (
      this.#inferenceStatusRetry ||
      !this.#pendingInferenceStatus ||
      this.#closed ||
      this.#readySocket?.readyState !== WebSocket.OPEN
    )
      return;
    // This timer exists only while a latest snapshot is blocked by transport
    // congestion. It never polls capacity or runs while idle/disconnected.
    this.#inferenceStatusRetry = setTimeout(() => {
      this.#inferenceStatusRetry = null;
      this.flushInferenceStatus();
    }, 100);
    this.#inferenceStatusRetry.unref();
  }

  private flushInferenceStatus(): boolean {
    const socket = this.#readySocket;
    const notification = this.#pendingInferenceStatus;
    if (!socket || socket.readyState !== WebSocket.OPEN || !notification)
      return false;
    if (socket.bufferedAmount > MAX_BUFFERED_NOTIFICATION_BYTES) {
      this.retryInferenceStatus();
      return false;
    }
    const version = this.#inferenceStatusVersion;
    this.#pendingInferenceStatus = null;
    if (this.#inferenceStatusRetry) clearTimeout(this.#inferenceStatusRetry);
    this.#inferenceStatusRetry = null;
    const retry = () => {
      if (
        this.#readySocket !== socket ||
        this.#inferenceStatusVersion !== version
      )
        return;
      // A newer snapshot, including an already-successful write, wins.
      this.#pendingInferenceStatus ??= notification;
      this.retryInferenceStatus();
    };
    try {
      socket.send(
        encodeWorkerServerEnvelope({ kind: "notification", notification }),
        (error) => {
          if (error) retry();
        },
      );
      return true;
    } catch {
      retry();
      return false;
    }
  }

  sendNotification(notification: WorkerNotification): boolean {
    if (notification.type === "inference.status") {
      if (this.#closed || this.#readySocket?.readyState !== WebSocket.OPEN)
        return false;
      this.#inferenceStatusVersion = Symbol();
      this.#pendingInferenceStatus = notification;
      return this.flushInferenceStatus();
    }
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
        encodeWorkerServerEnvelope({
          kind: "notification",
          notification: serverWorkerNotification(notification),
        }),
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
      } else if (isWorkerLinkFrame(bytes)) {
        const frame = decodeWorkerLinkFrame(bytes);
        await this.timing.handleWorkerLinkFrame?.(frame.header, frame.payload);
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
    let inferenceOperationIdentity: string | undefined;
    let inferenceOperationSignal: AbortSignal | undefined;
    if (request.inferenceSequence && this.#inferenceCommandGeneration) {
      const sequence = BigInt(request.inferenceSequence);
      // WebSocket commands arrive in issuer send order. A duplicate frame must
      // not create another command owner, even after the old owner was collected.
      if (sequence <= this.#lastInferenceCommandSequence) return;
      this.#lastInferenceCommandSequence = sequence;
      inferenceOperationIdentity = `${this.#inferenceCommandGeneration}:${request.inferenceSequence}`;
      inferenceOperationSignal = this.#inferenceCommandLifetime.signal;
    }
    const startedAt = performance.now();
    let outcomeScope: GoalOutcomeScope | undefined;
    if (
      request.command.type === "chat.turn" &&
      request.command.taskInferenceInput !== undefined
    ) {
      try {
        outcomeScope = this.timing.goalOutcomeDelivery?.scope();
      } catch {
        // First bootstrap may establish this identity while resolving the command.
      }
    }
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
        try {
          this.timing.observeEvent?.(request.command, event);
        } catch {
          // Direct observations are provisional; the server event remains authoritative.
        }
        this.sendServerEnvelope({
          kind: "event",
          requestId: request.requestId,
          event,
        });
      };
      const result = await this.handleCommand(request.command, emit, {
        inferenceAdmissionAck: request.inferenceAdmissionAck,
        modelOperationUsage: request.modelOperationUsage,
        inferenceOperationIdentity,
        inferenceOperationSignal,
      });
      let turnOutcome: Extract<
        WorkerNotification,
        { type: "chat.turn.outcome" }
      > | null = null;
      if (request.command.type === "chat.turn") {
        const parsedResult = agentTurnResultSchema.safeParse(result);
        if (parsedResult.success) {
          turnOutcome = await this.prepareChatTurnOutcome(
            request.command,
            {
              ok: true,
              result: parsedResult.data,
            },
            outcomeScope,
          );
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
      this.sendServerEnvelope({
        kind: "response",
        requestId: request.requestId,
        ok: true,
        result,
      });
      if (turnOutcome) this.dispatchChatTurnOutcome(request, turnOutcome);
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
      const errorCode = workerCommandFailureCode(error);
      const failureContext = {
        ...commandLogContext(request),
        event: "worker.command.failed",
        reasonCode: errorCode ?? "handler-failed",
        status: "failed",
        durationMs: Math.round(performance.now() - startedAt),
        error: workerLogError(error),
      };
      if (request.command.type === "chat.turn") {
        workerLogger.event("error", "Worker command failed", failureContext);
      } else {
        workerLogger.rateLimited(
          `worker-command-failed:${request.command.type}`,
          "error",
          "Worker command failed",
          failureContext,
        );
      }
      const turnOutcome =
        request.command.type === "chat.turn"
          ? await this.prepareChatTurnOutcome(
              request.command,
              {
                ok: false,
                error: message,
                inference: inferenceFailure(error),
              },
              outcomeScope,
            )
          : null;
      this.sendServerEnvelope({
        kind: "response",
        requestId: request.requestId,
        ok: false,
        error: {
          ...(errorCode ? { code: errorCode } : {}),
          message,
          ...(inferenceFailure(error)
            ? { inference: inferenceFailure(error) }
            : {}),
        },
      });
      if (turnOutcome) this.dispatchChatTurnOutcome(request, turnOutcome);
    }
  }
}
