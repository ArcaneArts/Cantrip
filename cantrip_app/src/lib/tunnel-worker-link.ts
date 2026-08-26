import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
  type WorkerLinkChannelCloseCode,
  type WorkerLinkLease,
  type WorkerLinkRoute,
  type WorkerLinkTunnelGrant,
  type WorkerLinkTunnelRoute,
} from "@cantrip/protocol";

import {
  createTunnelWorkerLinkGrant,
  deleteWorkerLinkGrant,
  renewWorkerLinkGrant,
} from "@/lib/api";
import {
  workerLinkManager,
  type WorkerLinkManager,
  type WorkerLinkReference,
  type WorkerLinkStream,
} from "@/lib/worker-link";

const MAX_PENDING_FRAMES = 256;
const MAX_PENDING_BYTES = 8 * 1_024 * 1_024;
const RENEW_AHEAD_MS = 20_000;
const MIN_RENEW_DELAY_MS = 1_000;

export interface TunnelWorkerLinkConnection {
  readonly bridgeAuthority: TunnelWorkerLinkBridgeAuthority;
  readonly bufferedAmount: number;
  readonly route: WorkerLinkRoute;
  readonly tunnelRoute: WorkerLinkTunnelRoute;
  activate(): void;
  close(code?: WorkerLinkChannelCloseCode): void;
  send(frame: Uint8Array): boolean;
}

export interface TunnelWorkerLinkBridgeAuthority {
  accountSessionId: string;
  channelId: string;
  clientInstanceId: string;
  connectionId: string;
  grantGeneration: number;
  grantId: string;
  ownerId: string;
  routeGeneration: number;
  serverGeneration: string;
  serverId: string;
  sessionId: string;
  workerId: string;
  workerProcessGeneration: string;
}

export interface OpenTunnelWorkerLinkOptions {
  attachmentId: string;
  diagnosticTraceId?: string;
  onClose(code: WorkerLinkChannelCloseCode): void;
  onFrame(frame: Uint8Array): Promise<void> | void;
  onRouteChanged?(route: WorkerLinkRoute): void;
  workerId: string;
}

export interface TunnelWorkerLinkDependencies {
  createGrant(
    sessionId: string,
    attachmentId: string,
    input: { diagnosticTraceId?: string },
  ): Promise<WorkerLinkTunnelGrant>;
  manager: Pick<WorkerLinkManager, "acquire">;
  now(): number;
  renewGrant(sessionId: string, grantId: string): Promise<WorkerLinkLease>;
  revokeGrant(sessionId: string, grantId: string): Promise<void>;
}

const defaultDependencies: TunnelWorkerLinkDependencies = {
  createGrant: createTunnelWorkerLinkGrant,
  manager: workerLinkManager,
  now: Date.now,
  renewGrant: renewWorkerLinkGrant,
  revokeGrant: deleteWorkerLinkGrant,
};

export async function openTunnelWorkerLink(
  options: OpenTunnelWorkerLinkOptions,
  dependencies: TunnelWorkerLinkDependencies = defaultDependencies,
): Promise<TunnelWorkerLinkConnection> {
  const reference = await dependencies.manager.acquire(options.workerId);
  const sessionId = reference.link.session.sessionId;
  let issued: WorkerLinkTunnelGrant | null = null;
  try {
    issued = await dependencies.createGrant(sessionId, options.attachmentId, {
      ...(options.diagnosticTraceId
        ? { diagnosticTraceId: options.diagnosticTraceId }
        : {}),
    });
    const stream = await reference.link.openStream(issued.grant, "stream");
    return new ActiveTunnelWorkerLink(
      options,
      dependencies,
      reference,
      stream,
      issued,
    );
  } catch (error) {
    if (issued) {
      await dependencies
        .revokeGrant(sessionId, issued.grant.binding.grantId)
        .catch(() => undefined);
    }
    reference.release();
    throw error;
  }
}

class ActiveTunnelWorkerLink implements TunnelWorkerLinkConnection {
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
  readonly bridgeAuthority: TunnelWorkerLinkBridgeAuthority;

  constructor(
    private readonly options: OpenTunnelWorkerLinkOptions,
    private readonly dependencies: TunnelWorkerLinkDependencies,
    private readonly reference: WorkerLinkReference,
    private readonly stream: WorkerLinkStream,
    private readonly issued: WorkerLinkTunnelGrant,
  ) {
    this.#sessionId = issued.grant.binding.sessionId;
    this.#route = stream.route;
    const identity = issued.grant.binding.identity;
    this.bridgeAuthority = {
      accountSessionId: identity.accountSessionId,
      channelId: stream.channelId,
      clientInstanceId: identity.clientInstanceId,
      connectionId: stream.connectionId,
      grantGeneration: issued.grant.binding.grantGeneration,
      grantId: issued.grant.binding.grantId,
      ownerId: identity.ownerId,
      routeGeneration: reference.link.session.routeGeneration,
      serverGeneration: identity.serverGeneration,
      serverId: identity.serverId,
      sessionId: issued.grant.binding.sessionId,
      workerId: identity.workerId,
      workerProcessGeneration: identity.workerProcessGeneration,
    };
    this.#unsubscribe = [
      stream.onData((payload) => this.#receive(payload)),
      stream.onWritable(() => this.#drainOutbound()),
      stream.onError(() => this.#retire("protocol-error", false)),
      stream.onClose((code) => this.#retire(code, false)),
    ];
    this.#scheduleRenewal(issued.grant.binding.lease);
  }

  get route(): WorkerLinkRoute {
    return this.#route;
  }

  get bufferedAmount(): number {
    return this.#outboundBytes;
  }

  get tunnelRoute(): WorkerLinkTunnelRoute {
    return this.issued.route;
  }

  activate(): void {
    if (this.#closed || this.#activated) return;
    this.#activated = true;
    this.#drainInbound();
  }

  send(frame: Uint8Array): boolean {
    if (this.#closed) return false;
    let encoded: Uint8Array;
    try {
      const decoded = decodeTunnelDataPlaneFrame(frame);
      const header = this.#outboundHeader(decoded.header);
      encoded = encodeTunnelDataPlaneFrame(header, decoded.payload);
    } catch {
      this.#retire("protocol-error", true);
      return false;
    }
    if (
      this.#outbound.length >= MAX_PENDING_FRAMES ||
      this.#outboundBytes + encoded.byteLength > MAX_PENDING_BYTES
    ) {
      return false;
    }
    this.#outbound.push(encoded);
    this.#outboundBytes += encoded.byteLength;
    this.#drainOutbound();
    return true;
  }

  close(code: WorkerLinkChannelCloseCode = "normal"): void {
    this.#retire(code, true);
  }

  #outboundHeader(
    header: TunnelDataPlaneFrameHeader,
  ): TunnelDataPlaneFrameHeader {
    this.#assertIdentity(header);
    if (header.kind !== "open") return header;
    return {
      ...header,
      kind: "connect",
      target: this.issued.route.target,
      ...(this.options.diagnosticTraceId
        ? { diagnosticTraceId: this.options.diagnosticTraceId }
        : {}),
    };
  }

  #assertIdentity(header: TunnelDataPlaneFrameHeader): void {
    const route = this.issued.route;
    if (
      header.tunnelId !== route.tunnelId ||
      header.attachmentId !== route.attachmentId ||
      header.sourceEndpointId !== route.sourceEndpointId ||
      header.destinationEndpointId !== route.destinationEndpointId
    ) {
      throw new Error("Tunnel frame escaped its WorkerLink grant binding.");
    }
  }

  #receive(payload: Uint8Array): void {
    if (this.#closed) return;
    try {
      this.#assertIdentity(decodeTunnelDataPlaneFrame(payload).header);
    } catch {
      this.#retire("protocol-error", true);
      return;
    }
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
          const frame = this.#inbound.shift()!;
          this.#inboundBytes -= frame.byteLength;
          await this.options.onFrame(frame);
          if (!this.#closed && !this.stream.acknowledge(frame.byteLength)) {
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
        const frame = this.#outbound[0]!;
        if (!this.stream.write(frame, "tunnel-data-plane-v1")) return;
        this.#outbound.shift();
        this.#outboundBytes -= frame.byteLength;
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
        .renewGrant(this.#sessionId, this.issued.grant.binding.grantId)
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
      .revokeGrant(this.#sessionId, this.issued.grant.binding.grantId)
      .catch(() => undefined);
    this.reference.release();
    this.options.onClose(code);
  }
}
