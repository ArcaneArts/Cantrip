import { randomUUID } from "node:crypto";

import {
  decodeWorkerServerEnvelope,
  decodeRemoteSurfaceFrame,
  decodeTunnelDataPlaneFrame,
  decodeWorkerLinkFrame,
  encodeWorkerRequestEnvelope,
  encodeRemoteSurfaceFrame,
  encodeTunnelDataPlaneFrame,
  isTunnelDataPlaneFrame,
  isWorkerLinkFrame,
  type RemoteSurfaceFrameHeader,
  type TunnelDataPlaneFrameHeader,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerNotification,
  type ValidatedWorkerLinkFrame,
  type WorkerServerEnvelope,
} from "@cantrip/protocol";
import type { ServiceLogger } from "@cantrip/logging";

import { serverLogger } from "../logger.js";

export interface WorkerSocket {
  activate?(): boolean;
  bufferedAmount: number;
  canActivate?(): boolean;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "message",
    listener: (data: unknown, isBinary?: boolean) => void,
  ): void;
  publishReady?(): boolean;
  readonly protocol?: string;
  readyState: number;
  send(data: string | Uint8Array, options?: { binary?: boolean }): void;
}

export type WorkerSurfaceFrameListener = (
  header: RemoteSurfaceFrameHeader,
  payload: Uint8Array,
) => void;

export type WorkerTunnelDataPlaneFrameListener = (
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
) => void;

export type WorkerLinkFrameListener = (frame: ValidatedWorkerLinkFrame) => void;

export type WorkerNotificationListener = (
  notification: WorkerNotification,
) => Promise<void> | void;

export interface WorkerConnectionContinuityIdentity {
  credentialId: string;
  ownerId: string;
  workerProcessGeneration: string;
}

export interface WorkerCommandBus {
  attach(
    workerId: string,
    socket: WorkerSocket,
    ownerId?: string,
    continuityIdentity?: WorkerConnectionContinuityIdentity,
  ): Promise<boolean | void> | boolean | void;
  close(): Promise<void> | void;
  disconnect?(workerId: string, reason?: string, code?: number): void;
  isConnected(workerId: string): boolean;
  sendSurfaceFrame(
    workerId: string,
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): boolean;
  sendTunnelDataPlaneFrame?(
    workerId: string,
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): boolean;
  sendWorkerLinkFrame?(
    workerId: string,
    frame: ValidatedWorkerLinkFrame,
  ): boolean;
  subscribeWorkerDisconnect(workerId: string, listener: () => void): () => void;
  subscribeWorkerOffline?(workerId: string, listener: () => void): () => void;
  subscribeSurfaceFrames(
    workerId: string,
    listener: WorkerSurfaceFrameListener,
  ): () => void;
  subscribeTunnelDataPlaneFrames?(
    workerId: string,
    listener: WorkerTunnelDataPlaneFrameListener,
  ): () => void;
  subscribeWorkerLinkFrames?(
    workerId: string,
    listener: WorkerLinkFrameListener,
  ): () => void;
  subscribeNotifications?(
    workerId: string,
    listener: WorkerNotificationListener,
  ): () => void;
  request(
    workerId: string,
    command: WorkerCommand,
    options?: WorkerRequestOptions,
  ): Promise<unknown>;
  stats?(): WorkerCommandBusStats;
}

export interface WorkerCommandBusStats {
  activeRequests: number;
  connectedWorkers: number;
  failedRequests: number;
  routedRequests: number;
  succeededRequests: number;
}

export interface WorkerRequestOptions {
  onEvent?(event: WorkerEvent): Promise<void> | void;
  ownerId?: string;
  timeoutMs?: number | null;
}

interface PendingRequest {
  commandType: WorkerCommand["type"];
  eventQueue: Promise<void>;
  onEvent?: WorkerRequestOptions["onEvent"];
  reject(error: Error): void;
  resolve(value: unknown): void;
  startedAtMs: number;
  timeout: ReturnType<typeof setTimeout> | null;
  workerId: string;
}

export class WorkerUnavailableError extends Error {}

export class WorkerCommandError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "WorkerCommandError";
  }
}

const MAX_BUFFERED_SURFACE_BYTES = 8 * 1_024 * 1_024;

function workerFrameBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const chunks = data.map(workerFrameBytes);
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }
  throw new Error("Worker sent an unsupported binary frame type.");
}

function subscribeKeyedListener<T>(
  registry: Map<string, Set<T>>,
  workerId: string,
  listener: T,
): () => void {
  let listeners = registry.get(workerId);
  if (!listeners) {
    listeners = new Set();
    registry.set(workerId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) registry.delete(workerId);
  };
}

export function sameWorkerConnectionContinuityIdentity(
  left: WorkerConnectionContinuityIdentity | undefined,
  right: WorkerConnectionContinuityIdentity | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.ownerId === right.ownerId &&
    left.credentialId === right.credentialId &&
    left.workerProcessGeneration === right.workerProcessGeneration
  );
}

export function workerSocketIsAttachable(socket: WorkerSocket): boolean {
  try {
    return socket.readyState === 1 && (socket.canActivate?.() ?? true);
  } catch {
    return false;
  }
}

export class WorkerBridge implements WorkerCommandBus {
  readonly #continuityIdentities = new Map<
    string,
    WorkerConnectionContinuityIdentity
  >();
  readonly #disconnectedAt = new Map<string, number>();
  readonly #disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #interruptionGenerations = new Map<string, symbol>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #sockets = new Map<string, WorkerSocket>();
  readonly #surfaceListeners = new Map<
    string,
    Set<WorkerSurfaceFrameListener>
  >();
  readonly #tunnelDataPlaneListeners = new Map<
    string,
    Set<WorkerTunnelDataPlaneFrameListener>
  >();
  readonly #workerLinkListeners = new Map<
    string,
    Set<WorkerLinkFrameListener>
  >();
  readonly #notificationListeners = new Map<
    string,
    Set<WorkerNotificationListener>
  >();
  readonly #workerDisconnectListeners = new Map<string, Set<() => void>>();
  readonly #workerOfflineListeners = new Map<string, Set<() => void>>();
  #failedRequests = 0;
  #routedRequests = 0;
  #succeededRequests = 0;

  constructor(
    private readonly reconnectGraceMs = 15_000,
    private readonly logger: ServiceLogger = serverLogger,
  ) {}

  attach(
    workerId: string,
    socket: WorkerSocket,
    ownerId?: string,
    continuityIdentity?: WorkerConnectionContinuityIdentity,
  ): boolean {
    if (!workerSocketIsAttachable(socket)) return false;
    if (
      continuityIdentity &&
      ownerId &&
      continuityIdentity.ownerId !== ownerId
    ) {
      socket.close(1008, "Worker continuity identity does not match owner");
      return false;
    }
    const existing = this.#sockets.get(workerId);
    const hadLifecycle =
      existing !== undefined || this.#disconnectedAt.has(workerId);
    const previousIdentity = this.#continuityIdentities.get(workerId);
    let closeReplacedSocket = false;
    if (
      hadLifecycle &&
      !sameWorkerConnectionContinuityIdentity(
        previousIdentity,
        continuityIdentity,
      )
    ) {
      this.logger.event("warn", "Worker continuity identity changed", {
        event: "worker.connection.identity-changed",
        subsystem: "worker-connection",
        status: "replaced",
        reasonCode: "continuity-identity-changed",
        workerId,
      });
      this.terminateWorkerLifecycle(
        workerId,
        new WorkerUnavailableError(
          `Worker ${workerId} continuity identity changed.`,
        ),
        1008,
        "Worker continuity identity changed",
      );
    } else if (existing && existing !== socket) {
      closeReplacedSocket = true;
    }
    if (!workerSocketIsAttachable(socket)) return false;
    const restorableSocket = this.#sockets.get(workerId);
    const disconnectedAt = this.#disconnectedAt.get(workerId);

    socket.on("message", (data, isBinary) =>
      this.handleSocketMessage(workerId, socket, data, Boolean(isBinary)),
    );

    const disconnect = () => this.handleSocketDisconnect(workerId, socket);
    socket.on("close", disconnect);
    socket.on("error", disconnect);

    // Publish readiness before the socket becomes command-visible. WebSocket
    // ordering then guarantees every command sent through this socket follows
    // the ready envelope on the wire.
    let readyPublished = true;
    try {
      readyPublished = socket.publishReady?.() ?? true;
    } catch {
      readyPublished = false;
    }
    if (!readyPublished || !workerSocketIsAttachable(socket)) return false;

    // Make buffered reconnect outcomes visible only after readiness is queued,
    // but retain the previous lifecycle until activation also succeeds.
    this.#sockets.set(workerId, socket);
    let activated = true;
    try {
      activated = socket.activate?.() ?? true;
    } catch {
      activated = false;
    }
    if (!activated) {
      if (this.#sockets.get(workerId) === socket) {
        if (restorableSocket) this.#sockets.set(workerId, restorableSocket);
        else this.#sockets.delete(workerId);
      }
      return false;
    }
    this.clearDisconnectTimer(workerId);
    this.#interruptionGenerations.delete(workerId);
    this.#disconnectedAt.delete(workerId);
    if (continuityIdentity) {
      this.#continuityIdentities.set(workerId, continuityIdentity);
    } else {
      this.#continuityIdentities.delete(workerId);
    }
    if (closeReplacedSocket) {
      this.logger.event("warn", "Worker connection replaced", {
        event: "worker.connection.replaced",
        subsystem: "worker-connection",
        status: "replaced",
        workerId,
      });
      existing?.close(1012, "Worker reconnected");
    }
    this.logger.event(
      "info",
      disconnectedAt ? "Worker reconnected" : "Worker connected",
      {
        event: disconnectedAt
          ? "worker.connection.recovered"
          : "worker.connection.connected",
        subsystem: "worker-connection",
        status: "online",
        workerId,
        ...(disconnectedAt
          ? { durationMs: Math.max(0, Date.now() - disconnectedAt) }
          : {}),
      },
    );

    return true;
  }

  private handleSocketMessage(
    workerId: string,
    socket: WorkerSocket,
    data: unknown,
    isBinary: boolean,
  ): void {
    if (this.#sockets.get(workerId) !== socket) return;
    if (isBinary) {
      this.handleBinaryFrame(workerId, data);
      return;
    }
    const decoded = decodeWorkerServerEnvelope(String(data));
    if (decoded.success) {
      this.handleServerEnvelope(workerId, decoded.data);
      return;
    }
    this.logger.rateLimited(
      `worker-envelope-invalid:${workerId}`,
      "warn",
      "Worker sent an invalid control envelope",
      {
        event: "worker.transport.invalid-envelope",
        subsystem: "worker-transport",
        reasonCode: "invalid-envelope",
        status: "rejected",
        workerId,
      },
    );
  }

  private handleBinaryFrame(workerId: string, data: unknown): void {
    try {
      const bytes = workerFrameBytes(data);
      if (isTunnelDataPlaneFrame(bytes)) {
        const frame = decodeTunnelDataPlaneFrame(bytes);
        for (const listener of this.#tunnelDataPlaneListeners.get(workerId) ??
          []) {
          listener(frame.header, frame.payload);
        }
        return;
      }
      if (isWorkerLinkFrame(bytes)) {
        const frame = decodeWorkerLinkFrame(bytes);
        for (const listener of this.#workerLinkListeners.get(workerId) ?? []) {
          listener(frame);
        }
        return;
      }
      const frame = decodeRemoteSurfaceFrame(bytes);
      for (const listener of this.#surfaceListeners.get(workerId) ?? []) {
        listener(frame.header, frame.payload);
      }
    } catch {
      // Malformed binary data is isolated to the worker connection.
      this.logger.rateLimited(
        `worker-binary-invalid:${workerId}`,
        "warn",
        "Worker sent an invalid binary frame",
        {
          event: "worker.transport.invalid-binary-frame",
          subsystem: "worker-transport",
          reasonCode: "invalid-binary-frame",
          status: "rejected",
          workerId,
        },
      );
    }
  }

  private handleServerEnvelope(
    workerId: string,
    envelope: WorkerServerEnvelope,
  ): void {
    switch (envelope.kind) {
      case "notification":
        this.deliverNotification(workerId, envelope.notification);
        return;
      case "event":
        this.queueRequestEvent(workerId, envelope.requestId, envelope.event);
        return;
      case "response":
        this.completeRequest(workerId, envelope);
    }
  }

  private deliverNotification(
    workerId: string,
    notification: WorkerNotification,
  ): void {
    for (const listener of this.#notificationListeners.get(workerId) ?? []) {
      void Promise.resolve(listener(notification)).catch(() => undefined);
    }
  }

  private queueRequestEvent(
    workerId: string,
    requestId: string,
    event: WorkerEvent,
  ): void {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.workerId !== workerId || !pending.onEvent) return;
    const eventQueue = pending.eventQueue.then(() => pending.onEvent?.(event));
    pending.eventQueue = eventQueue;
    void eventQueue
      .catch((error: unknown) => {
        if (this.#pending.get(requestId) !== pending) return;
        this.#pending.delete(requestId);
        if (pending.timeout) clearTimeout(pending.timeout);
        this.#failedRequests += 1;
        this.logger.event("warn", "Worker command event handling failed", {
          event: "worker.command.event-handler-failed",
          subsystem: "worker-command",
          operation: pending.commandType,
          requestId,
          reasonCode: "event-handler-failed",
          status: "failed",
          durationMs: Math.max(0, Date.now() - pending.startedAtMs),
          workerId,
        });
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      })
      .catch(() => undefined);
  }

  private completeRequest(
    workerId: string,
    response: Extract<WorkerServerEnvelope, { kind: "response" }>,
  ): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending || pending.workerId !== workerId) return;
    this.#pending.delete(response.requestId);
    if (pending.timeout) clearTimeout(pending.timeout);
    const durationMs = Math.max(0, Date.now() - pending.startedAtMs);
    void pending.eventQueue.then(
      () => {
        if (response.ok) {
          this.#succeededRequests += 1;
          this.logger.event("debug", "Worker command completed", {
            event: "worker.command.completed",
            subsystem: "worker-command",
            operation: pending.commandType,
            requestId: response.requestId,
            status: "completed",
            durationMs,
            workerId,
          });
          pending.resolve(response.result);
        } else {
          this.#failedRequests += 1;
          this.logger.event("warn", "Worker command failed", {
            event: "worker.command.failed",
            subsystem: "worker-command",
            operation: pending.commandType,
            requestId: response.requestId,
            reasonCode: "worker-reported-failure",
            status: "failed",
            durationMs,
            workerId,
          });
          pending.reject(
            new WorkerCommandError(
              response.error.message,
              response.error.code ?? null,
            ),
          );
        }
      },
      (error: unknown) => {
        this.#failedRequests += 1;
        this.logger.event("warn", "Worker command event handling failed", {
          event: "worker.command.event-handler-failed",
          subsystem: "worker-command",
          operation: pending.commandType,
          requestId: response.requestId,
          reasonCode: "event-handler-failed",
          status: "failed",
          durationMs,
          workerId,
        });
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
    );
  }

  private handleSocketDisconnect(workerId: string, socket: WorkerSocket): void {
    if (this.#sockets.get(workerId) !== socket) return;
    this.#sockets.delete(workerId);
    this.#disconnectedAt.set(workerId, Date.now());
    const interruptionGeneration = Symbol(workerId);
    this.#interruptionGenerations.set(workerId, interruptionGeneration);
    this.logger.event("warn", "Worker connection interrupted", {
      event: "worker.connection.interrupted",
      subsystem: "worker-connection",
      status: "reconnecting",
      reasonCode: "socket-disconnected",
      workerId,
    });
    this.scheduleDisconnectedRequestRejection(workerId, interruptionGeneration);
    for (const listener of this.#workerDisconnectListeners.get(workerId) ??
      []) {
      listener();
    }
  }

  disconnect(
    workerId: string,
    reason = "Worker credential was revoked",
    code = 1008,
  ): void {
    this.logger.event("warn", "Worker disconnected by server", {
      event: "worker.connection.revoked",
      subsystem: "worker-connection",
      status: "offline",
      reasonCode: code === 1008 ? "credential-revoked" : "server-disconnect",
      workerId,
    });
    this.terminateWorkerLifecycle(
      workerId,
      new WorkerUnavailableError(`Worker ${workerId} disconnected.`),
      code,
      reason,
    );
  }

  isConnected(workerId: string): boolean {
    return this.#sockets.get(workerId)?.readyState === 1;
  }

  stats(): WorkerCommandBusStats {
    return {
      activeRequests: this.#pending.size,
      connectedWorkers: this.#sockets.size,
      failedRequests: this.#failedRequests,
      routedRequests: this.#routedRequests,
      succeededRequests: this.#succeededRequests,
    };
  }

  subscribeNotifications(
    workerId: string,
    listener: WorkerNotificationListener,
  ): () => void {
    return subscribeKeyedListener(
      this.#notificationListeners,
      workerId,
      listener,
    );
  }

  sendSurfaceFrame(
    workerId: string,
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const socket = this.#sockets.get(workerId);
    if (!socket || socket.readyState !== 1) {
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
    workerId: string,
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const socket = this.#sockets.get(workerId);
    if (!socket || socket.readyState !== 1) return false;
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

  sendWorkerLinkFrame(
    workerId: string,
    frame: ValidatedWorkerLinkFrame,
  ): boolean {
    const socket = this.#sockets.get(workerId);
    if (!socket || socket.readyState !== 1) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) return false;
    try {
      socket.send(frame.bytes, { binary: true });
      return true;
    } catch {
      return false;
    }
  }

  subscribeSurfaceFrames(
    workerId: string,
    listener: WorkerSurfaceFrameListener,
  ): () => void {
    return subscribeKeyedListener(this.#surfaceListeners, workerId, listener);
  }

  subscribeTunnelDataPlaneFrames(
    workerId: string,
    listener: WorkerTunnelDataPlaneFrameListener,
  ): () => void {
    return subscribeKeyedListener(
      this.#tunnelDataPlaneListeners,
      workerId,
      listener,
    );
  }

  subscribeWorkerLinkFrames(
    workerId: string,
    listener: WorkerLinkFrameListener,
  ): () => void {
    return subscribeKeyedListener(
      this.#workerLinkListeners,
      workerId,
      listener,
    );
  }

  subscribeWorkerDisconnect(
    workerId: string,
    listener: () => void,
  ): () => void {
    return subscribeKeyedListener(
      this.#workerDisconnectListeners,
      workerId,
      listener,
    );
  }

  subscribeWorkerOffline(workerId: string, listener: () => void): () => void {
    return subscribeKeyedListener(
      this.#workerOfflineListeners,
      workerId,
      listener,
    );
  }

  request(
    workerId: string,
    command: WorkerCommand,
    options: WorkerRequestOptions = {},
  ): Promise<unknown> {
    const socket = this.#sockets.get(workerId);
    if (!socket || socket.readyState !== 1) {
      this.logger.rateLimited(
        `worker-command-offline:${workerId}:${command.type}`,
        "warn",
        "Worker command could not be dispatched",
        {
          event: "worker.command.rejected",
          subsystem: "worker-command",
          operation: command.type,
          reasonCode: "worker-offline",
          status: "rejected",
          workerId,
        },
      );
      return Promise.reject(
        new WorkerUnavailableError(`Worker ${workerId} is offline.`),
      );
    }

    const requestId = randomUUID();
    const envelope = encodeWorkerRequestEnvelope({
      kind: "request",
      requestId,
      command,
    });

    return new Promise((resolve, reject) => {
      const startedAtMs = Date.now();
      this.#routedRequests += 1;
      this.logger.event("debug", "Worker command dispatched", {
        event: "worker.command.dispatched",
        subsystem: "worker-command",
        operation: command.type,
        requestId,
        status: "dispatched",
        workerId,
      });
      const timeout =
        options.timeoutMs === null
          ? null
          : setTimeout(
              () => {
                this.#pending.delete(requestId);
                this.#failedRequests += 1;
                this.logger.event("warn", "Worker command timed out", {
                  event: "worker.command.timed-out",
                  subsystem: "worker-command",
                  operation: command.type,
                  requestId,
                  reasonCode: "timeout",
                  status: "failed",
                  durationMs: Math.max(0, Date.now() - startedAtMs),
                  workerId,
                });
                reject(new Error(`Worker command ${command.type} timed out.`));
              },
              options.timeoutMs ?? 10 * 60_000,
            );
      this.#pending.set(requestId, {
        commandType: command.type,
        eventQueue: Promise.resolve(),
        onEvent: options.onEvent,
        reject,
        resolve,
        startedAtMs,
        timeout,
        workerId,
      });

      try {
        socket.send(envelope);
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        this.#pending.delete(requestId);
        this.#failedRequests += 1;
        this.logger.event("error", "Worker command dispatch failed", {
          event: "worker.command.dispatch-failed",
          subsystem: "worker-command",
          operation: command.type,
          requestId,
          reasonCode: "socket-send-failed",
          status: "failed",
          durationMs: Math.max(0, Date.now() - startedAtMs),
          workerId,
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.logger.event("info", "Worker bridge shutting down", {
      event: "worker.bridge.shutdown-started",
      subsystem: "worker-connection",
      status: "stopping",
      counts: {
        connectedWorkers: this.#sockets.size,
        pendingRequests: this.#pending.size,
      },
    });
    const workers = new Set([
      ...this.#sockets.keys(),
      ...this.#disconnectedAt.keys(),
      ...this.#continuityIdentities.keys(),
    ]);
    for (const workerId of workers) {
      this.terminateWorkerLifecycle(
        workerId,
        new WorkerUnavailableError("Server is shutting down."),
        1001,
        "Server shutting down",
      );
    }
    this.#sockets.clear();
    for (const timer of this.#disconnectTimers.values()) clearTimeout(timer);
    this.#disconnectTimers.clear();
    this.#disconnectedAt.clear();
    this.#interruptionGenerations.clear();
    this.#continuityIdentities.clear();
    this.#surfaceListeners.clear();
    this.#tunnelDataPlaneListeners.clear();
    this.#workerLinkListeners.clear();
    this.#notificationListeners.clear();
    this.#workerDisconnectListeners.clear();
    this.#workerOfflineListeners.clear();
    for (const pending of this.#pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new WorkerUnavailableError("Server is shutting down."));
    }
    this.#pending.clear();
    this.logger.event("info", "Worker bridge stopped", {
      event: "worker.bridge.shutdown-completed",
      subsystem: "worker-connection",
      status: "stopped",
    });
  }

  private rejectWorkerRequests(workerId: string, error: Error): void {
    let rejected = 0;
    for (const [requestId, pending] of this.#pending) {
      if (pending.workerId !== workerId) {
        continue;
      }
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
      this.#pending.delete(requestId);
      rejected += 1;
    }
    if (rejected > 0) {
      this.#failedRequests += rejected;
      this.logger.event("warn", "Worker commands abandoned", {
        event: "worker.command.abandoned",
        subsystem: "worker-command",
        reasonCode: "worker-offline",
        status: "failed",
        counts: { requests: rejected },
        workerId,
      });
    }
  }

  private scheduleDisconnectedRequestRejection(
    workerId: string,
    interruptionGeneration: symbol,
  ): void {
    this.clearDisconnectTimer(workerId);
    if (this.reconnectGraceMs <= 0) {
      this.terminateWorkerLifecycle(
        workerId,
        new WorkerUnavailableError(`Worker ${workerId} disconnected.`),
      );
      return;
    }
    const timer = setTimeout(() => {
      this.#disconnectTimers.delete(workerId);
      if (
        this.#sockets.has(workerId) ||
        this.#interruptionGenerations.get(workerId) !== interruptionGeneration
      ) {
        return;
      }
      this.logger.event("warn", "Worker reconnect grace expired", {
        event: "worker.connection.offline",
        subsystem: "worker-connection",
        reasonCode: "reconnect-grace-expired",
        status: "offline",
        durationMs: this.reconnectGraceMs,
        workerId,
      });
      this.terminateWorkerLifecycle(
        workerId,
        new WorkerUnavailableError(`Worker ${workerId} disconnected.`),
      );
    }, this.reconnectGraceMs);
    timer.unref();
    this.#disconnectTimers.set(workerId, timer);
  }

  private clearDisconnectTimer(workerId: string): void {
    const timer = this.#disconnectTimers.get(workerId);
    if (!timer) return;
    clearTimeout(timer);
    this.#disconnectTimers.delete(workerId);
  }

  private terminateWorkerLifecycle(
    workerId: string,
    error: Error,
    closeCode?: number,
    closeReason?: string,
  ): boolean {
    const socket = this.#sockets.get(workerId);
    const hadLifecycle = Boolean(
      socket ||
      this.#disconnectedAt.has(workerId) ||
      this.#continuityIdentities.has(workerId) ||
      this.#interruptionGenerations.has(workerId),
    );
    this.#sockets.delete(workerId);
    this.clearDisconnectTimer(workerId);
    this.#disconnectedAt.delete(workerId);
    this.#interruptionGenerations.delete(workerId);
    this.#continuityIdentities.delete(workerId);
    this.rejectWorkerRequests(workerId, error);
    if (socket) {
      for (const listener of this.#workerDisconnectListeners.get(workerId) ??
        []) {
        listener();
      }
    }
    if (socket && closeCode !== undefined) {
      socket.close(closeCode, closeReason);
    }
    if (hadLifecycle) {
      for (const listener of this.#workerOfflineListeners.get(workerId) ?? []) {
        listener();
      }
    }
    return hadLifecycle;
  }
}
