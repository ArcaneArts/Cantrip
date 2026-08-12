import type {
  CodeTunnelFrameHeader,
  RemoteSurfaceFrameHeader,
  TunnelDataPlaneFrameHeader,
  WorkerCommand,
} from "@cantrip/protocol";

import {
  ActiveLimit,
  RelayLimitError,
  SlidingWindowRateLimiter,
} from "../security/abuse-limits.js";
import type {
  WorkerCodeTunnelFrameListener,
  WorkerCommandBus,
  WorkerNotificationListener,
  WorkerRequestOptions,
  WorkerSurfaceFrameListener,
  WorkerTunnelDataPlaneFrameListener,
  WorkerCommandBusStats,
} from "./bridge.js";

interface LimitedWorkerCommandBusOptions {
  accountConcurrency: number;
  accountRatePerMinute: number;
  consumeRelayBytes?(ownerId: string, workerId: string, bytes: number): boolean;
  resolveOwnerId(workerId: string): Promise<string | null>;
  workerConcurrency: number;
  workerRatePerMinute: number;
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

export class LimitedWorkerCommandBus implements WorkerCommandBus {
  readonly #accountActive: ActiveLimit;
  readonly #accountRate: SlidingWindowRateLimiter;
  readonly #ownerIds = new Map<string, string>();
  readonly #workerActive: ActiveLimit;
  readonly #workerRate: SlidingWindowRateLimiter;
  #failedRequests = 0;
  #routedRequests = 0;
  #succeededRequests = 0;

  constructor(
    readonly delegate: WorkerCommandBus,
    readonly options: LimitedWorkerCommandBusOptions,
  ) {
    this.#accountActive = new ActiveLimit(options.accountConcurrency);
    this.#accountRate = new SlidingWindowRateLimiter(
      options.accountRatePerMinute,
    );
    this.#workerActive = new ActiveLimit(options.workerConcurrency);
    this.#workerRate = new SlidingWindowRateLimiter(
      options.workerRatePerMinute,
    );
  }

  attach(workerId: string, socket: Parameters<WorkerCommandBus["attach"]>[1]) {
    this.delegate.attach(workerId, socket);
  }

  close(): void {
    this.delegate.close();
  }

  disconnect(workerId: string, reason?: string, code?: number): void {
    if (code === undefined) this.delegate.disconnect?.(workerId, reason);
    else this.delegate.disconnect?.(workerId, reason, code);
  }

  isConnected(workerId: string): boolean {
    return this.delegate.isConnected(workerId);
  }

  stats(): WorkerCommandBusStats {
    const delegate = this.delegate.stats?.();
    return {
      activeRequests: this.#accountActive.total(),
      connectedWorkers: delegate?.connectedWorkers ?? 0,
      failedRequests: this.#failedRequests,
      routedRequests: this.#routedRequests,
      succeededRequests: this.#succeededRequests,
    };
  }

  sendSurfaceFrame(
    workerId: string,
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): boolean {
    return this.delegate.sendSurfaceFrame(workerId, header, payload);
  }

  sendCodeTunnelFrame(
    workerId: string,
    header: CodeTunnelFrameHeader,
    payload: Uint8Array,
  ): boolean {
    return (
      this.delegate.sendCodeTunnelFrame?.(workerId, header, payload) ?? false
    );
  }

  sendTunnelDataPlaneFrame(
    workerId: string,
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): boolean {
    return (
      this.delegate.sendTunnelDataPlaneFrame?.(workerId, header, payload) ??
      false
    );
  }

  subscribeWorkerDisconnect(workerId: string, listener: () => void) {
    return this.delegate.subscribeWorkerDisconnect(workerId, listener);
  }

  subscribeSurfaceFrames(
    workerId: string,
    listener: WorkerSurfaceFrameListener,
  ) {
    return this.delegate.subscribeSurfaceFrames(workerId, listener);
  }

  subscribeCodeTunnelFrames(
    workerId: string,
    listener: WorkerCodeTunnelFrameListener,
  ) {
    return (
      this.delegate.subscribeCodeTunnelFrames?.(workerId, listener) ??
      (() => undefined)
    );
  }

  subscribeTunnelDataPlaneFrames(
    workerId: string,
    listener: WorkerTunnelDataPlaneFrameListener,
  ) {
    return (
      this.delegate.subscribeTunnelDataPlaneFrames?.(workerId, listener) ??
      (() => undefined)
    );
  }

  subscribeNotifications(
    workerId: string,
    listener: WorkerNotificationListener,
  ) {
    return (
      this.delegate.subscribeNotifications?.(workerId, listener) ??
      (() => undefined)
    );
  }

  async request(
    workerId: string,
    command: WorkerCommand,
    options?: WorkerRequestOptions,
  ): Promise<unknown> {
    const ownerId = await this.#ownerId(workerId);
    if (
      this.options.consumeRelayBytes &&
      !this.options.consumeRelayBytes(
        ownerId,
        workerId,
        serializedBytes(command),
      )
    ) {
      this.#failedRequests += 1;
      throw new RelayLimitError("Relay bandwidth quota reached. Retry later.");
    }
    const accountRetry = this.#accountRate.consume(ownerId);
    const workerRetry = this.#workerRate.consume(workerId);
    const retryAfter = Math.max(accountRetry ?? 0, workerRetry ?? 0);
    if (retryAfter > 0) {
      this.#failedRequests += 1;
      throw new RelayLimitError(
        "Worker command rate limit reached. Retry shortly.",
        retryAfter,
      );
    }
    const releaseAccount = this.#accountActive.acquire(ownerId);
    if (!releaseAccount) {
      this.#failedRequests += 1;
      throw new RelayLimitError(
        "Account worker-command concurrency limit reached.",
      );
    }
    const releaseWorker = this.#workerActive.acquire(workerId);
    if (!releaseWorker) {
      releaseAccount();
      this.#failedRequests += 1;
      throw new RelayLimitError("Worker command concurrency limit reached.");
    }
    this.#routedRequests += 1;
    try {
      const delegatedOptions =
        options?.onEvent && this.options.consumeRelayBytes
          ? {
              ...options,
              onEvent: async (
                event: Parameters<
                  NonNullable<WorkerRequestOptions["onEvent"]>
                >[0],
              ) => {
                if (
                  !this.options.consumeRelayBytes!(
                    ownerId,
                    workerId,
                    serializedBytes(event),
                  )
                ) {
                  throw new RelayLimitError(
                    "Relay bandwidth quota reached. Retry later.",
                  );
                }
                await options.onEvent!(event);
              },
            }
          : options;
      const result = await this.delegate.request(
        workerId,
        command,
        delegatedOptions,
      );
      if (
        this.options.consumeRelayBytes &&
        !this.options.consumeRelayBytes(
          ownerId,
          workerId,
          serializedBytes(result),
        )
      ) {
        throw new RelayLimitError(
          "Relay bandwidth quota reached. Retry later.",
        );
      }
      this.#succeededRequests += 1;
      return result;
    } catch (error) {
      this.#failedRequests += 1;
      throw error;
    } finally {
      releaseWorker();
      releaseAccount();
    }
  }

  async #ownerId(workerId: string): Promise<string> {
    const cached = this.#ownerIds.get(workerId);
    if (cached) return cached;
    const ownerId = await this.options.resolveOwnerId(workerId);
    if (!ownerId) {
      throw new Error(`Worker ${workerId} is not enrolled.`);
    }
    this.#ownerIds.set(workerId, ownerId);
    return ownerId;
  }
}
