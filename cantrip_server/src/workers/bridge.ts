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
  eventQueue: Promise<void>;
  onEvent?: WorkerRequestOptions["onEvent"];
  reject(error: Error): void;
  resolve(value: unknown): void;
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

  constructor(private readonly reconnectGraceMs = 15_000) {}

  attach(workerId: string, socket: WorkerSocket): void {
    const existing = this.#sockets.get(workerId);
    if (existing && existing !== socket) {
      existing.close(1012, "Worker reconnected");
    }
    this.#sockets.set(workerId, socket);
    this.clearDisconnectTimer(workerId);

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
    if (decoded.success) this.handleServerEnvelope(workerId, decoded.data);
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
    void pending.eventQueue.then(
      () => {
        if (response.ok) pending.resolve(response.result);
        else pending.reject(new Error(response.error.message));
      },
      (error: unknown) => {
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
    );
  }

  private handleSocketDisconnect(workerId: string, socket: WorkerSocket): void {
    if (this.#sockets.get(workerId) !== socket) return;
    this.#sockets.delete(workerId);
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
      failedRequests: 0,
      routedRequests: 0,
      succeededRequests: 0,
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
      const timeout =
        options.timeoutMs === null
          ? null
          : setTimeout(
              () => {
                this.#pending.delete(requestId);
                reject(new Error(`Worker command ${command.type} timed out.`));
              },
              options.timeoutMs ?? 10 * 60_000,
            );
      this.#pending.set(requestId, {
        eventQueue: Promise.resolve(),
        onEvent: options.onEvent,
        reject,
        resolve,
        timeout,
        workerId,
      });

      try {
        socket.send(envelope);
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        this.#pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    for (const socket of this.#sockets.values()) {
      socket.close(1001, "Server shutting down");
    }
    this.#sockets.clear();
    for (const timer of this.#disconnectTimers.values()) clearTimeout(timer);
    this.#disconnectTimers.clear();
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
  }

  private rejectWorkerRequests(workerId: string, error: Error): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.workerId !== workerId) {
        continue;
      }
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
      this.#pending.delete(requestId);
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
