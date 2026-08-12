import type {
  CodeTunnelFrameHeader,
  ProjectShareTunnelFrameHeader,
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
  WorkerProjectShareTunnelFrameListener,
  WorkerRequestOptions,
  WorkerSurfaceFrameListener,
  WorkerTunnelDataPlaneFrameListener,
} from "./bridge.js";

interface LimitedWorkerCommandBusOptions {
  accountConcurrency: number;
  accountRatePerMinute: number;
  resolveOwnerId(workerId: string): Promise<string | null>;
  workerConcurrency: number;
  workerRatePerMinute: number;
}

export class LimitedWorkerCommandBus implements WorkerCommandBus {
  readonly #accountActive: ActiveLimit;
  readonly #accountRate: SlidingWindowRateLimiter;
  readonly #ownerIds = new Map<string, string>();
  readonly #workerActive: ActiveLimit;
  readonly #workerRate: SlidingWindowRateLimiter;

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

  sendProjectShareTunnelFrame(
    workerId: string,
    header: ProjectShareTunnelFrameHeader,
    payload: Uint8Array,
  ): boolean {
    return (
      this.delegate.sendProjectShareTunnelFrame?.(workerId, header, payload) ??
      false
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

  subscribeProjectShareTunnelFrames(
    workerId: string,
    listener: WorkerProjectShareTunnelFrameListener,
  ) {
    return (
      this.delegate.subscribeProjectShareTunnelFrames?.(workerId, listener) ??
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
    const accountRetry = this.#accountRate.consume(ownerId);
    const workerRetry = this.#workerRate.consume(workerId);
    const retryAfter = Math.max(accountRetry ?? 0, workerRetry ?? 0);
    if (retryAfter > 0) {
      throw new RelayLimitError(
        "Worker command rate limit reached. Retry shortly.",
        retryAfter,
      );
    }
    const releaseAccount = this.#accountActive.acquire(ownerId);
    if (!releaseAccount) {
      throw new RelayLimitError(
        "Account worker-command concurrency limit reached.",
      );
    }
    const releaseWorker = this.#workerActive.acquire(workerId);
    if (!releaseWorker) {
      releaseAccount();
      throw new RelayLimitError("Worker command concurrency limit reached.");
    }
    try {
      return await this.delegate.request(workerId, command, options);
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
