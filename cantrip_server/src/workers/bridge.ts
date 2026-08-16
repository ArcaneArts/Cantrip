import { randomUUID } from "node:crypto";

import {
  decodeWorkerServerEnvelope,
  decodeRemoteSurfaceFrame,
  decodeTunnelDataPlaneFrame,
  encodeWorkerRequestEnvelope,
  encodeRemoteSurfaceFrame,
  encodeTunnelDataPlaneFrame,
  isTunnelDataPlaneFrame,
  type RemoteSurfaceFrameHeader,
  type TunnelDataPlaneFrameHeader,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerNotification,
  type WorkerServerEnvelope,
} from "@cantrip/protocol";
import type { ServiceLogger } from "@cantrip/logging";

import { serverLogger } from "../logger.js";

interface WorkerSocket {
  bufferedAmount: number;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "message",
    listener: (data: unknown, isBinary?: boolean) => void,
  ): void;
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

export type WorkerNotificationListener = (
  notification: WorkerNotification,
) => Promise<void> | void;

export interface WorkerCommandBus {
  attach(
    workerId: string,
    socket: WorkerSocket,
    ownerId?: string,
  ): Promise<void> | void;
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
  subscribeWorkerDisconnect(workerId: string, listener: () => void): () => void;
  subscribeSurfaceFrames(
    workerId: string,
    listener: WorkerSurfaceFrameListener,
  ): () => void;
  subscribeTunnelDataPlaneFrames?(
    workerId: string,
    listener: WorkerTunnelDataPlaneFrameListener,
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

export class WorkerBridge implements WorkerCommandBus {
  readonly #disconnectedAt = new Map<string, number>();
  readonly #disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
  readonly #notificationListeners = new Map<
    string,
    Set<WorkerNotificationListener>
  >();
  readonly #workerDisconnectListeners = new Map<string, Set<() => void>>();
  #failedRequests = 0;
  #routedRequests = 0;
  #succeededRequests = 0;

  constructor(
    private readonly reconnectGraceMs = 15_000,
    private readonly logger: ServiceLogger = serverLogger,
  ) {}

  attach(workerId: string, socket: WorkerSocket): void {
    const existing = this.#sockets.get(workerId);
    if (existing && existing !== socket) {
      this.logger.event("warn", "Worker connection replaced", {
        event: "worker.connection.replaced",
        subsystem: "worker-connection",
        status: "replaced",
        workerId,
      });
      existing.close(1012, "Worker reconnected");
    }
    const disconnectedAt = this.#disconnectedAt.get(workerId);
    this.#sockets.set(workerId, socket);
    this.clearDisconnectTimer(workerId);
    this.#disconnectedAt.delete(workerId);
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

    socket.on("message", (data, isBinary) =>
      this.handleSocketMessage(workerId, data, Boolean(isBinary)),
    );

    const disconnect = () => this.handleSocketDisconnect(workerId, socket);
    socket.on("close", disconnect);
    socket.on("error", disconnect);
  }

  private handleSocketMessage(
    workerId: string,
    data: unknown,
    isBinary: boolean,
  ): void {
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
    pending.eventQueue = pending.eventQueue.then(() =>
      pending.onEvent?.(event),
    );
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
          pending.reject(new Error(response.error.message));
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
    this.logger.event("warn", "Worker connection interrupted", {
      event: "worker.connection.interrupted",
      subsystem: "worker-connection",
      status: "reconnecting",
      reasonCode: "socket-disconnected",
      workerId,
    });
    for (const listener of this.#workerDisconnectListeners.get(workerId) ??
      []) {
      listener();
    }
    this.scheduleDisconnectedRequestRejection(workerId);
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
    this.clearDisconnectTimer(workerId);
    this.rejectWorkerRequests(
      workerId,
      new WorkerUnavailableError(`Worker ${workerId} disconnected.`),
    );
    this.#sockets.get(workerId)?.close(code, reason);
    this.clearDisconnectTimer(workerId);
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
    for (const socket of this.#sockets.values()) {
      socket.close(1001, "Server shutting down");
    }
    this.#sockets.clear();
    for (const timer of this.#disconnectTimers.values()) clearTimeout(timer);
    this.#disconnectTimers.clear();
    this.#disconnectedAt.clear();
    this.#surfaceListeners.clear();
    this.#tunnelDataPlaneListeners.clear();
    this.#notificationListeners.clear();
    for (const listeners of this.#workerDisconnectListeners.values()) {
      for (const listener of listeners) listener();
    }
    this.#workerDisconnectListeners.clear();
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

  private scheduleDisconnectedRequestRejection(workerId: string): void {
    this.clearDisconnectTimer(workerId);
    if (this.reconnectGraceMs <= 0) {
      this.rejectWorkerRequests(
        workerId,
        new WorkerUnavailableError(`Worker ${workerId} disconnected.`),
      );
      return;
    }
    const timer = setTimeout(() => {
      this.#disconnectTimers.delete(workerId);
      if (this.#sockets.has(workerId)) return;
      this.logger.event("warn", "Worker reconnect grace expired", {
        event: "worker.connection.offline",
        subsystem: "worker-connection",
        reasonCode: "reconnect-grace-expired",
        status: "offline",
        durationMs: this.reconnectGraceMs,
        workerId,
      });
      this.rejectWorkerRequests(
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
}
