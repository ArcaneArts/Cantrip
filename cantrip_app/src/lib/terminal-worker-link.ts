import {
  terminalClientMessageSchema,
  terminalServerMessageSchema,
  type TerminalClientMessage,
  type TerminalServerMessage,
  type WorkerLinkChannelCloseCode,
  type WorkerLinkLease,
  type WorkerLinkRoute,
  type WorkerLinkResourceGrant,
} from "@cantrip/protocol";

import {
  createTerminalWorkerLinkGrant,
  deleteWorkerLinkGrant,
  renewWorkerLinkGrant,
} from "@/lib/api";
import {
  workerLinkManager,
  type WorkerLinkManager,
  type WorkerLinkReference,
  type WorkerLinkStream,
} from "@/lib/worker-link";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_PENDING_FRAMES = 256;
const MAX_PENDING_BYTES = 4 * 1_024 * 1_024;
const RENEW_AHEAD_MS = 20_000;
const MIN_RENEW_DELAY_MS = 1_000;

export interface TerminalWorkerLinkConnection {
  readonly route: WorkerLinkRoute;
  activate(): void;
  close(code?: WorkerLinkChannelCloseCode): void;
  send(message: TerminalClientMessage): boolean;
}

export interface OpenTerminalWorkerLinkOptions {
  onClose(code: WorkerLinkChannelCloseCode): void;
  onMessage(message: TerminalServerMessage): Promise<void> | void;
  operationId: string;
  terminalId: string;
  workerId: string;
}

export interface TerminalWorkerLinkDependencies {
  createGrant(
    sessionId: string,
    terminalId: string,
    operationId: string,
  ): Promise<WorkerLinkResourceGrant>;
  manager: Pick<WorkerLinkManager, "acquire">;
  now(): number;
  renewGrant(sessionId: string, grantId: string): Promise<WorkerLinkLease>;
  revokeGrant(sessionId: string, grantId: string): Promise<void>;
}

const defaultDependencies: TerminalWorkerLinkDependencies = {
  createGrant: createTerminalWorkerLinkGrant,
  manager: workerLinkManager,
  now: Date.now,
  renewGrant: renewWorkerLinkGrant,
  revokeGrant: deleteWorkerLinkGrant,
};

export async function openTerminalWorkerLink(
  options: OpenTerminalWorkerLinkOptions,
  dependencies: TerminalWorkerLinkDependencies = defaultDependencies,
): Promise<TerminalWorkerLinkConnection> {
  const reference = await dependencies.manager.acquire(options.workerId);
  const sessionId = reference.link.session.sessionId;
  let grant: WorkerLinkResourceGrant | null = null;
  try {
    grant = await dependencies.createGrant(
      sessionId,
      options.terminalId,
      options.operationId,
    );
    const stream = await reference.link.openStream(grant, "interactive");
    return new ActiveTerminalWorkerLink(
      options,
      dependencies,
      reference,
      stream,
      grant,
    );
  } catch (error) {
    if (grant) {
      await dependencies
        .revokeGrant(sessionId, grant.binding.grantId)
        .catch(() => undefined);
    }
    reference.release();
    throw error;
  }
}

class ActiveTerminalWorkerLink implements TerminalWorkerLinkConnection {
  #activated = false;
  #closed = false;
  #drainingInbound = false;
  #drainingOutbound = false;
  #inboundBytes = 0;
  readonly #inbound: Uint8Array[] = [];
  #outboundBytes = 0;
  readonly #outbound: Uint8Array[] = [];
  #renewTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #route: WorkerLinkRoute;
  readonly #sessionId: string;
  readonly #unsubscribe: Array<() => void>;

  constructor(
    private readonly options: OpenTerminalWorkerLinkOptions,
    private readonly dependencies: TerminalWorkerLinkDependencies,
    private readonly reference: WorkerLinkReference,
    private readonly stream: WorkerLinkStream,
    private readonly grant: WorkerLinkResourceGrant,
  ) {
    this.#sessionId = grant.binding.sessionId;
    this.#route = stream.route;
    this.#unsubscribe = [
      stream.onData((payload) => this.#receive(payload)),
      stream.onWritable(() => this.#drainOutbound()),
      stream.onError(() => this.#retire("protocol-error", false)),
      stream.onClose((code) => this.#retire(code, false)),
    ];
    this.#scheduleRenewal(grant.binding.lease);
  }

  get route(): WorkerLinkRoute {
    return this.#route;
  }

  activate(): void {
    if (this.#closed || this.#activated) return;
    this.#activated = true;
    this.#drainInbound();
  }

  send(message: TerminalClientMessage): boolean {
    if (this.#closed) return false;
    const payload = encoder.encode(
      JSON.stringify(terminalClientMessageSchema.parse(message)),
    );
    if (
      this.#outbound.length >= MAX_PENDING_FRAMES ||
      this.#outboundBytes + payload.byteLength > MAX_PENDING_BYTES
    ) {
      return false;
    }
    this.#outbound.push(payload);
    this.#outboundBytes += payload.byteLength;
    this.#drainOutbound();
    return true;
  }

  close(code: WorkerLinkChannelCloseCode = "normal"): void {
    this.#retire(code, true);
  }

  #receive(payload: Uint8Array): void {
    if (this.#closed) return;
    if (
      this.#inbound.length >= MAX_PENDING_FRAMES ||
      this.#inboundBytes + payload.byteLength > MAX_PENDING_BYTES
    ) {
      this.#retire("congested", true);
      return;
    }
    const copy = payload.slice();
    this.#inbound.push(copy);
    this.#inboundBytes += copy.byteLength;
    this.#drainInbound();
  }

  #drainInbound(): void {
    if (
      !this.#activated ||
      this.#closed ||
      this.#drainingInbound ||
      this.#inbound.length === 0
    ) {
      return;
    }
    this.#drainingInbound = true;
    void (async () => {
      try {
        while (!this.#closed && this.#inbound.length > 0) {
          const payload = this.#inbound.shift()!;
          this.#inboundBytes -= payload.byteLength;
          let message: TerminalServerMessage;
          try {
            message = terminalServerMessageSchema.parse(
              JSON.parse(decoder.decode(payload)),
            );
          } catch {
            this.#retire("protocol-error", true);
            return;
          }
          await this.options.onMessage(message);
          if (!this.#closed && !this.stream.acknowledge(payload.byteLength)) {
            this.#retire("protocol-error", true);
            return;
          }
        }
      } catch {
        this.#retire("protocol-error", true);
      } finally {
        this.#drainingInbound = false;
        if (!this.#closed && this.#inbound.length > 0) this.#drainInbound();
      }
    })();
  }

  #drainOutbound(): void {
    if (this.#closed || this.#drainingOutbound) return;
    this.#drainingOutbound = true;
    try {
      while (this.#outbound.length > 0) {
        const payload = this.#outbound[0]!;
        if (!this.stream.write(payload)) return;
        this.#outbound.shift();
        this.#outboundBytes -= payload.byteLength;
      }
    } finally {
      this.#drainingOutbound = false;
    }
  }

  #scheduleRenewal(lease: WorkerLinkLease): void {
    if (this.#closed) return;
    if (this.#renewTimer) clearTimeout(this.#renewTimer);
    const delay = Math.max(
      MIN_RENEW_DELAY_MS,
      Date.parse(lease.expiresAt) - this.dependencies.now() - RENEW_AHEAD_MS,
    );
    this.#renewTimer = setTimeout(() => {
      this.#renewTimer = null;
      void this.dependencies
        .renewGrant(this.#sessionId, this.grant.binding.grantId)
        .then((renewed) => this.#scheduleRenewal(renewed))
        .catch(() => this.#retire("revoked", true));
    }, delay);
  }

  #retire(code: WorkerLinkChannelCloseCode, closeStream: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#renewTimer) clearTimeout(this.#renewTimer);
    this.#renewTimer = null;
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#inbound.length = 0;
    this.#outbound.length = 0;
    this.#inboundBytes = 0;
    this.#outboundBytes = 0;
    if (closeStream) this.stream.close(code);
    void this.dependencies
      .revokeGrant(this.#sessionId, this.grant.binding.grantId)
      .catch(() => undefined);
    this.reference.release();
    this.options.onClose(code);
  }
}
