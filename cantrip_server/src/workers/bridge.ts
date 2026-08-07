import { randomUUID } from "node:crypto";

import {
  type WorkerCommand,
  workerEventEnvelopeSchema,
  type WorkerEvent,
  workerRequestEnvelopeSchema,
  workerResponseEnvelopeSchema,
} from "@cantrip/protocol";

interface WorkerSocket {
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "message", listener: (data: { toString(): string }) => void): void;
  readyState: number;
  send(data: string): void;
}

export interface WorkerCommandBus {
  attach(workerId: string, socket: WorkerSocket): void;
  close(): void;
  isConnected(workerId: string): boolean;
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

export class WorkerBridge implements WorkerCommandBus {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #sockets = new Map<string, WorkerSocket>();

  attach(workerId: string, socket: WorkerSocket): void {
    const existing = this.#sockets.get(workerId);
    if (existing && existing !== socket) {
      existing.close(1012, "Worker reconnected");
    }
    this.#sockets.set(workerId, socket);

    socket.on("message", (data) => {
      let payload: unknown;
      try {
        payload = JSON.parse(data.toString());
      } catch {
        return;
      }
      const response = workerResponseEnvelopeSchema.safeParse(payload);
      if (!response.success) {
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
      this.rejectWorkerRequests(
        workerId,
        new WorkerUnavailableError(`Worker ${workerId} disconnected.`),
      );
    };
    socket.on("close", disconnect);
    socket.on("error", disconnect);
  }

  isConnected(workerId: string): boolean {
    return this.#sockets.get(workerId)?.readyState === 1;
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
