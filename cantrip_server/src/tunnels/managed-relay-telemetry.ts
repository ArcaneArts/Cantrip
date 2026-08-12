import type { ServerRepository } from "../db/repository.js";

interface ManagedRelayIdentity {
  attachmentId: string;
  ownerId: string;
  projectId: string | null;
  tunnelId: string;
}

interface ManagedRelayMetrics {
  bytesFromSource: number;
  bytesToSource: number;
  connectionDelta: number;
}

type ManagedRelayChange = (identity: ManagedRelayIdentity) => void;

/** Batches durable counters shared by server-owned tunnel adapters. */
export class ManagedServerRelayTelemetry {
  readonly #pending: ManagedRelayMetrics = {
    bytesFromSource: 0,
    bytesToSource: 0,
    connectionDelta: 0,
  };
  #closed = false;
  #expiresAt = new Date(0);
  #flushTail: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly repository: ServerRepository,
    private readonly identity: ManagedRelayIdentity,
    private readonly changed: ManagedRelayChange | null,
  ) {}

  renew(expiresAt: Date): void {
    if (this.#closed) return;
    this.#expiresAt = expiresAt;
    void this.repository
      .touchManagedServerRelay(
        this.identity.ownerId,
        this.identity.attachmentId,
        { expiresAt },
      )
      .catch(() => undefined);
  }

  record(metrics: ManagedRelayMetrics, expiresAt: Date): void {
    if (this.#closed) return;
    this.#expiresAt = expiresAt;
    this.#pending.bytesFromSource += metrics.bytesFromSource;
    this.#pending.bytesToSource += metrics.bytesToSource;
    this.#pending.connectionDelta += metrics.connectionDelta;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#queueFlush();
    }, 250);
    this.#timer.unref();
  }

  async close(expiresAt: Date): Promise<void> {
    if (this.#closed) return this.#flushTail;
    this.#closed = true;
    this.#expiresAt = expiresAt;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#queueFlush();
  }

  #queueFlush(): Promise<void> {
    const metrics = {
      activeConnectionDelta: this.#pending.connectionDelta,
      bytesFromSource: this.#pending.bytesFromSource,
      bytesToSource: this.#pending.bytesToSource,
      expiresAt: this.#expiresAt,
    };
    this.#pending.connectionDelta = 0;
    this.#pending.bytesFromSource = 0;
    this.#pending.bytesToSource = 0;
    if (
      metrics.activeConnectionDelta === 0 &&
      metrics.bytesFromSource === 0 &&
      metrics.bytesToSource === 0
    ) {
      return this.#flushTail;
    }
    this.#flushTail = this.#flushTail
      .then(async () => {
        await this.repository.touchManagedServerRelay(
          this.identity.ownerId,
          this.identity.attachmentId,
          metrics,
        );
        this.changed?.(this.identity);
      })
      .catch(() => undefined);
    return this.#flushTail;
  }
}
