import type { ServerConfig } from "../config.js";
import {
  ActiveLimit,
  RelayLimitError,
  SlidingWindowByteLimiter,
} from "../security/abuse-limits.js";

export type RelayQuotaKind = "relay-bandwidth" | "remote-surface" | "upload";

export interface RelayQuotaStats {
  activeRemoteSurfaces: number;
  rejectedRelayBandwidth: number;
  rejectedRemoteSurfaces: number;
  rejectedUploads: number;
  relayBytes: number;
  uploadBytes: number;
}

export class RelayQuotaManager {
  readonly #accountRelayBytes: SlidingWindowByteLimiter;
  readonly #accountRemoteSurfaces: ActiveLimit;
  readonly #accountUploadBytes: SlidingWindowByteLimiter;
  readonly #workerRelayBytes: SlidingWindowByteLimiter;
  readonly #workerRemoteSurfaces: ActiveLimit;
  readonly #workerUploadBytes: SlidingWindowByteLimiter;
  #rejectedRelayBandwidth = 0;
  #rejectedRemoteSurfaces = 0;
  #rejectedUploads = 0;
  #relayBytes = 0;
  #uploadBytes = 0;

  constructor(config: ServerConfig) {
    this.#accountRelayBytes = new SlidingWindowByteLimiter(
      config.accountRelayBytesPerMinute ?? 512 * 1_024 * 1_024,
    );
    this.#workerRelayBytes = new SlidingWindowByteLimiter(
      config.workerRelayBytesPerMinute ?? 256 * 1_024 * 1_024,
    );
    this.#accountUploadBytes = new SlidingWindowByteLimiter(
      config.accountUploadBytesPerMinute ?? 256 * 1_024 * 1_024,
    );
    this.#workerUploadBytes = new SlidingWindowByteLimiter(
      config.workerUploadBytesPerMinute ?? 128 * 1_024 * 1_024,
    );
    this.#accountRemoteSurfaces = new ActiveLimit(
      config.accountRemoteSurfaceLimit ?? 16,
    );
    this.#workerRemoteSurfaces = new ActiveLimit(
      config.workerRemoteSurfaceLimit ?? 8,
    );
  }

  acquireRemoteSurface(ownerId: string, workerId: string): () => void {
    const releaseAccount = this.#accountRemoteSurfaces.acquire(ownerId);
    if (!releaseAccount) {
      this.#rejectedRemoteSurfaces += 1;
      throw new RelayLimitError(
        "Account Remote Surface connection quota reached.",
      );
    }
    const releaseWorker = this.#workerRemoteSurfaces.acquire(workerId);
    if (!releaseWorker) {
      releaseAccount();
      this.#rejectedRemoteSurfaces += 1;
      throw new RelayLimitError(
        "Worker Remote Surface connection quota reached.",
      );
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseWorker();
      releaseAccount();
    };
  }

  consumeUpload(ownerId: string, workerId: string, bytes: number): void {
    const now = Date.now();
    const accountRetry = this.#accountUploadBytes.retryAfter(
      ownerId,
      bytes,
      now,
    );
    const workerRetry = this.#workerUploadBytes.retryAfter(
      workerId,
      bytes,
      now,
    );
    const retryAfter = Math.max(accountRetry ?? 0, workerRetry ?? 0);
    if (retryAfter > 0) {
      this.#rejectedUploads += 1;
      throw new RelayLimitError(
        "Attachment upload byte quota reached. Retry later.",
        retryAfter,
      );
    }
    this.#accountUploadBytes.consume(ownerId, bytes, now);
    this.#workerUploadBytes.consume(workerId, bytes, now);
    this.#uploadBytes += bytes;
  }

  consumeRelay(ownerId: string, workerId: string, bytes: number): boolean {
    const now = Date.now();
    const accountRetry = this.#accountRelayBytes.retryAfter(
      ownerId,
      bytes,
      now,
    );
    const workerRetry = this.#workerRelayBytes.retryAfter(workerId, bytes, now);
    if (accountRetry !== null || workerRetry !== null) {
      this.#rejectedRelayBandwidth += 1;
      return false;
    }
    this.#accountRelayBytes.consume(ownerId, bytes, now);
    this.#workerRelayBytes.consume(workerId, bytes, now);
    this.#relayBytes += bytes;
    return true;
  }

  stats(): RelayQuotaStats {
    return {
      activeRemoteSurfaces: this.#accountRemoteSurfaces.total(),
      rejectedRelayBandwidth: this.#rejectedRelayBandwidth,
      rejectedRemoteSurfaces: this.#rejectedRemoteSurfaces,
      rejectedUploads: this.#rejectedUploads,
      relayBytes: this.#relayBytes,
      uploadBytes: this.#uploadBytes,
    };
  }
}
