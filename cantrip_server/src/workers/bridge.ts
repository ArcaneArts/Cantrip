import { randomUUID } from "node:crypto";

import {
  decodeCodeTunnelFrame,
  decodeProjectShareTunnelFrame,
  decodeRemoteSurfaceFrame,
  encodeCodeTunnelFrame,
  encodeProjectShareTunnelFrame,
  encodeRemoteSurfaceFrame,
  isCodeTunnelFrame,
  isProjectShareTunnelFrame,
  type CodeTunnelFrameHeader,
  type ProjectShareTunnelFrameHeader,
  type RemoteSurfaceFrameHeader,
  type WorkerCommand,
  workerEventEnvelopeSchema,
  type WorkerEvent,
  workerNotificationEnvelopeSchema,
  type WorkerNotification,
  workerRequestEnvelopeSchema,
  workerResponseEnvelopeSchema,
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

export type WorkerCodeTunnelFrameListener = (
  header: CodeTunnelFrameHeader,
  payload: Uint8Array,
) => void;

export type WorkerProjectShareTunnelFrameListener = (
  header: ProjectShareTunnelFrameHeader,
  payload: Uint8Array,
) => void;

export type WorkerNotificationListener = (
  notification: WorkerNotification,
) => Promise<void> | void;

export interface WorkerCommandBus {
  attach(workerId: string, socket: WorkerSocket): void;
  close(): void;
  disconnect?(workerId: string, reason?: string, code?: number): void;
  isConnected(workerId: string): boolean;
  sendSurfaceFrame(
    workerId: string,
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): boolean;
  sendCodeTunnelFrame?(
    workerId: string,
    header: CodeTunnelFrameHeader,
    payload: Uint8Array,
  ): boolean;
  sendProjectShareTunnelFrame?(
    workerId: string,
    header: ProjectShareTunnelFrameHeader,
    payload: Uint8Array,
  ): boolean;
  subscribeWorkerDisconnect(workerId: string, listener: () => void): () => void;
  subscribeSurfaceFrames(
    workerId: string,
    listener: WorkerSurfaceFrameListener,
  ): () => void;
  subscribeCodeTunnelFrames?(
    workerId: string,
    listener: WorkerCodeTunnelFrameListener,
  ): () => void;
  subscribeProjectShareTunnelFrames?(
    workerId: string,
    listener: WorkerProjectShareTunnelFrameListener,
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
}

export interface WorkerRequestOptions {
  onEvent?(event: WorkerEvent): Promise<void> | void;
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

export class WorkerBridge implements WorkerCommandBus {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #codeTunnelListeners = new Map<
    string,
    Set<WorkerCodeTunnelFrameListener>
  >();
  readonly #projectShareTunnelListeners = new Map<
    string,
    Set<WorkerProjectShareTunnelFrameListener>
  >();
  readonly #sockets = new Map<string, WorkerSocket>();
  readonly #surfaceListeners = new Map<
    string,
    Set<WorkerSurfaceFrameListener>
  >();
  readonly #notificationListeners = new Map<
    string,
    Set<WorkerNotificationListener>
  >();
  readonly #workerDisconnectListeners = new Map<string, Set<() => void>>();

  attach(workerId: string, socket: WorkerSocket): void {
    const existing = this.#sockets.get(workerId);
    if (existing && existing !== socket) {
      existing.close(1012, "Worker reconnected");
    }
    this.#sockets.set(workerId, socket);

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        try {
          const bytes = workerFrameBytes(data);
          if (isProjectShareTunnelFrame(bytes)) {
            const frame = decodeProjectShareTunnelFrame(bytes);
            for (const listener of this.#projectShareTunnelListeners.get(
              workerId,
            ) ?? []) {
              listener(frame.header, frame.payload);
            }
          } else if (isCodeTunnelFrame(bytes)) {
            const frame = decodeCodeTunnelFrame(bytes);
            for (const listener of this.#codeTunnelListeners.get(workerId) ??
              []) {
              listener(frame.header, frame.payload);
            }
          } else {
            const frame = decodeRemoteSurfaceFrame(bytes);
            for (const listener of this.#surfaceListeners.get(workerId) ?? []) {
              listener(frame.header, frame.payload);
            }
          }
        } catch {
          // Malformed binary data is isolated to the worker connection.
        }
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }
      const response = workerResponseEnvelopeSchema.safeParse(payload);
      if (!response.success) {
        const notification =
          workerNotificationEnvelopeSchema.safeParse(payload);
        if (notification.success) {
          for (const listener of this.#notificationListeners.get(workerId) ??
            []) {
            void Promise.resolve(
              listener(notification.data.notification),
            ).catch(() => undefined);
          }
          return;
        }
        const event = workerEventEnvelopeSchema.safeParse(payload);
        if (!event.success) {
          return;
        }
        const pending = this.#pending.get(event.data.requestId);
        if (!pending || pending.workerId !== workerId || !pending.onEvent) {
          return;
        }
        pending.eventQueue = pending.eventQueue.then(() =>
          pending.onEvent?.(event.data.event),
        );
        return;
      }
      const pending = this.#pending.get(response.data.requestId);
      if (!pending || pending.workerId !== workerId) {
        return;
      }
      this.#pending.delete(response.data.requestId);
      if (pending.timeout) clearTimeout(pending.timeout);
      void pending.eventQueue.then(
        () => {
          if (response.data.ok) {
            pending.resolve(response.data.result);
          } else {
            pending.reject(new Error(response.data.error.message));
          }
        },
        (error: unknown) => {
          pending.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      );
    });

    const disconnect = () => {
      if (this.#sockets.get(workerId) !== socket) {
        return;
      }
      this.#sockets.delete(workerId);
      for (const listener of this.#workerDisconnectListeners.get(workerId) ??
        []) {
        listener();
      }
      this.rejectWorkerRequests(
        workerId,
        new WorkerUnavailableError(`Worker ${workerId} disconnected.`),
      );
    };
    socket.on("close", disconnect);
    socket.on("error", disconnect);
  }

  disconnect(
    workerId: string,
    reason = "Worker credential was revoked",
    code = 1008,
  ): void {
    this.#sockets.get(workerId)?.close(code, reason);
  }

  isConnected(workerId: string): boolean {
    return this.#sockets.get(workerId)?.readyState === 1;
  }

  subscribeNotifications(
    workerId: string,
    listener: WorkerNotificationListener,
  ): () => void {
    let listeners = this.#notificationListeners.get(workerId);
    if (!listeners) {
      listeners = new Set();
      this.#notificationListeners.set(workerId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#notificationListeners.delete(workerId);
    };
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

  sendCodeTunnelFrame(
    workerId: string,
    header: CodeTunnelFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const socket = this.#sockets.get(workerId);
    if (!socket || socket.readyState !== 1) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) return false;
    try {
      socket.send(encodeCodeTunnelFrame(header, payload), { binary: true });
      return true;
    } catch {
      return false;
    }
  }

  sendProjectShareTunnelFrame(
    workerId: string,
    header: ProjectShareTunnelFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const socket = this.#sockets.get(workerId);
    if (!socket || socket.readyState !== 1) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) return false;
    try {
      socket.send(encodeProjectShareTunnelFrame(header, payload), {
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
    let listeners = this.#surfaceListeners.get(workerId);
    if (!listeners) {
      listeners = new Set();
      this.#surfaceListeners.set(workerId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#surfaceListeners.delete(workerId);
    };
  }

  subscribeCodeTunnelFrames(
    workerId: string,
    listener: WorkerCodeTunnelFrameListener,
  ): () => void {
    let listeners = this.#codeTunnelListeners.get(workerId);
    if (!listeners) {
      listeners = new Set();
      this.#codeTunnelListeners.set(workerId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#codeTunnelListeners.delete(workerId);
    };
  }

  subscribeProjectShareTunnelFrames(
    workerId: string,
    listener: WorkerProjectShareTunnelFrameListener,
  ): () => void {
    let listeners = this.#projectShareTunnelListeners.get(workerId);
    if (!listeners) {
      listeners = new Set();
      this.#projectShareTunnelListeners.set(workerId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.#projectShareTunnelListeners.delete(workerId);
      }
    };
  }

  subscribeWorkerDisconnect(
    workerId: string,
    listener: () => void,
  ): () => void {
    let listeners = this.#workerDisconnectListeners.get(workerId);
    if (!listeners) {
      listeners = new Set();
      this.#workerDisconnectListeners.set(workerId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.#workerDisconnectListeners.delete(workerId);
      }
    };
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
    const envelope = workerRequestEnvelopeSchema.parse({
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
        socket.send(JSON.stringify(envelope));
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
    this.#codeTunnelListeners.clear();
    this.#projectShareTunnelListeners.clear();
    this.#surfaceListeners.clear();
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
}
