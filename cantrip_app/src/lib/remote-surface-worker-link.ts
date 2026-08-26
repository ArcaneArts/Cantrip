import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  encodeWorkerLinkRemoteSurfaceChunk,
  WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES,
  WorkerLinkRemoteSurfaceFrameAssembler,
  type RemoteSurfaceChannel,
  type RemoteSurfaceFrameHeader,
  type RemoteSurfaceViewport,
  type WorkerLinkChannelCloseCode,
  type WorkerLinkLease,
  type WorkerLinkResourceGrant,
  type WorkerLinkRoute,
} from "@cantrip/protocol";
import type {
  RemoteSurfaceStreamContext,
  RemoteSurfaceStreamKind,
} from "@cantrip/protocol/remote-surface-stream";

import {
  createRemoteSurfaceWorkerLinkGrant,
  deleteWorkerLinkGrant,
  renewWorkerLinkGrant,
} from "@/lib/api";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import {
  openRemoteSurfaceStreamPayload,
  protectRemoteSurfaceStreamPayload,
} from "@/lib/remote-surface-stream-encryption";
import {
  workerLinkManager,
  type WorkerLinkManager,
  type WorkerLinkReference,
  type WorkerLinkStream,
} from "@/lib/worker-link";

const MAX_PENDING_OUTBOUND_FRAMES = 128;
const MAX_PENDING_OUTBOUND_BYTES = 4 * 1_024 * 1_024;
const MAX_PENDING_INBOUND_FRAMES = 128;
const MAX_PENDING_INBOUND_BYTES = 12 * 1_024 * 1_024;
const RENEW_AHEAD_MS = 20_000;
const MIN_RENEW_DELAY_MS = 1_000;

export type RemoteSurfaceWorkerLinkConnectionState =
  "connecting" | "ready" | "reconnecting";

export interface RemoteSurfaceWorkerLinkRoutes {
  interactive: WorkerLinkRoute;
  realtime: WorkerLinkRoute;
}

export interface RemoteSurfaceWorkerLinkInboundFrame {
  header: RemoteSurfaceFrameHeader;
  payload: Uint8Array;
}

export interface RemoteSurfaceWorkerLinkFrameContext {
  isCurrent(): boolean;
  reportError(message: string | null): void;
}

export interface RemoteSurfaceWorkerLinkMessages {
  connectionError: string;
  invalidFrame: string;
}

export interface RemoteSurfaceWorkerLinkClientOptions {
  messages: RemoteSurfaceWorkerLinkMessages;
  onConnecting?(
    state: Exclude<RemoteSurfaceWorkerLinkConnectionState, "ready">,
  ): void;
  onConnectionState(state: RemoteSurfaceWorkerLinkConnectionState): void;
  onError(message: string | null): void;
  onFrame(
    frame: RemoteSurfaceWorkerLinkInboundFrame,
    context: RemoteSurfaceWorkerLinkFrameContext,
  ): Promise<void> | void;
  onReady?(routes: RemoteSurfaceWorkerLinkRoutes): void;
  streamKind: RemoteSurfaceStreamKind;
  surfaceId: string;
  surfaceKind?: string;
  viewport(): RemoteSurfaceViewport;
  workerId: string;
}

export interface RemoteSurfaceWorkerLinkDependencies {
  createGrant(
    sessionId: string,
    surfaceId: string,
    viewport: RemoteSurfaceViewport,
  ): Promise<WorkerLinkResourceGrant>;
  manager: Pick<WorkerLinkManager, "acquire">;
  now(): number;
  openPayload(input: {
    context: Omit<RemoteSurfaceStreamContext, "serverId">;
    protectedPayload: Uint8Array;
  }): Promise<Uint8Array>;
  protectPayload(input: {
    context: Omit<RemoteSurfaceStreamContext, "serverId">;
    payload: Uint8Array;
  }): Promise<Uint8Array>;
  renewGrant(sessionId: string, grantId: string): Promise<WorkerLinkLease>;
  revokeGrant(sessionId: string, grantId: string): Promise<void>;
}

const defaultDependencies: RemoteSurfaceWorkerLinkDependencies = {
  createGrant: createRemoteSurfaceWorkerLinkGrant,
  manager: workerLinkManager,
  now: Date.now,
  openPayload: openRemoteSurfaceStreamPayload,
  protectPayload: protectRemoteSurfaceStreamPayload,
  renewGrant: renewWorkerLinkGrant,
  revokeGrant: deleteWorkerLinkGrant,
};

export function remoteSurfaceWorkerLinkReconnectDelay(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt), 5_000);
}

export function remoteSurfaceWorkerLinkRouteLabel(
  routes: RemoteSurfaceWorkerLinkRoutes | null,
): string | null {
  if (!routes) return null;
  return routes.interactive === routes.realtime
    ? routes.interactive
    : `interactive:${routes.interactive},realtime:${routes.realtime}`;
}

export class RemoteSurfaceWorkerLinkClient {
  #active: ActiveRemoteSurfaceWorkerLink | null = null;
  #connectRevision = 0;
  #disposed = false;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;

  constructor(
    private readonly options: RemoteSurfaceWorkerLinkClientOptions,
    private readonly dependencies: RemoteSurfaceWorkerLinkDependencies = defaultDependencies,
  ) {}

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    clientLogger.info("Remote Surface WorkerLink started", {
      event: "surface.worker-link.started",
      operation: "connect",
      subsystem: this.options.surfaceKind ?? "remote-surface",
      surfaceId: this.options.surfaceId,
    });
    this.#beginConnect();
  }

  retry(): void {
    if (this.#disposed) return;
    this.#reconnectAttempt = 0;
    this.#cancelReconnect();
    this.#beginConnect();
  }

  send(channel: RemoteSurfaceChannel, payload: Uint8Array): boolean {
    return this.#active?.send(channel, payload) ?? false;
  }

  close(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#connectRevision += 1;
    this.#cancelReconnect();
    this.#active?.close("normal");
    this.#active = null;
    clientLogger.info("Remote Surface WorkerLink closed", {
      event: "surface.worker-link.closed",
      operation: "disconnect",
      status: "closed",
      subsystem: this.options.surfaceKind ?? "remote-surface",
      surfaceId: this.options.surfaceId,
    });
  }

  #beginConnect(): void {
    if (this.#disposed) return;
    const revision = ++this.#connectRevision;
    const previous = this.#active;
    this.#active = null;
    previous?.close("route-replaced");
    const state = this.#reconnectAttempt ? "reconnecting" : "connecting";
    this.options.onConnectionState(state);
    this.options.onConnecting?.(state);
    const startedAt = performance.now();
    void this.#connect(revision)
      .then((active) => {
        if (this.#disposed || revision !== this.#connectRevision) {
          active?.close("route-replaced");
          return;
        }
        if (!active) return;
        if (active.closed) {
          throw new Error("Remote Surface WorkerLink closed while opening.");
        }
        this.#active = active;
        this.#reconnectAttempt = 0;
        this.options.onError(null);
        this.options.onConnectionState("ready");
        this.options.onReady?.(active.routes);
        clientLogger.info("Remote Surface WorkerLink is ready", {
          durationMs: Math.round(performance.now() - startedAt),
          event: "surface.worker-link.ready",
          operation: "attach",
          status: "ready",
          subsystem: this.options.surfaceKind ?? "remote-surface",
          surfaceId: this.options.surfaceId,
          routes: active.routes,
        });
      })
      .catch((error: unknown) => {
        if (this.#disposed || revision !== this.#connectRevision) return;
        this.options.onError(this.options.messages.connectionError);
        clientLogger.rateLimited(
          `surface-worker-link-connect:${this.options.surfaceKind ?? "remote"}:${this.options.surfaceId}`,
          "warn",
          "Remote Surface WorkerLink connection failed",
          {
            ...operationalErrorMetadata(error),
            attempt: this.#reconnectAttempt + 1,
            durationMs: Math.round(performance.now() - startedAt),
            event: "surface.worker-link.connect.failed",
            operation: "connect",
            reasonCode: "transport-error",
            status: "failed",
            subsystem: this.options.surfaceKind ?? "remote-surface",
            surfaceId: this.options.surfaceId,
          },
        );
        this.#scheduleReconnect();
      });
  }

  async #connect(
    revision: number,
  ): Promise<ActiveRemoteSurfaceWorkerLink | null> {
    const reference = await this.dependencies.manager.acquire(
      this.options.workerId,
    );
    const sessionId = reference.link.session.sessionId;
    let grant: WorkerLinkResourceGrant | null = null;
    let interactive: WorkerLinkStream | null = null;
    let realtime: WorkerLinkStream | null = null;
    try {
      grant = await this.dependencies.createGrant(
        sessionId,
        this.options.surfaceId,
        this.options.viewport(),
      );
      validateRemoteSurfaceGrant(
        grant,
        this.options.surfaceId,
        this.options.streamKind,
      );
      interactive = await reference.link.openStream(grant, "interactive");
      realtime = await reference.link.openStream(grant, "realtime");
      if (this.#disposed || revision !== this.#connectRevision) {
        interactive.close("route-replaced");
        realtime.close("route-replaced");
        await this.dependencies
          .revokeGrant(sessionId, grant.binding.grantId)
          .catch(() => undefined);
        reference.release();
        return null;
      }
      let active!: ActiveRemoteSurfaceWorkerLink;
      active = new ActiveRemoteSurfaceWorkerLink(
        this.options,
        this.dependencies,
        reference,
        grant,
        interactive,
        realtime,
        (code, failure) => {
          if (this.#active !== active || this.#disposed) return;
          this.#active = null;
          if (failure === "invalid-frame") {
            this.options.onError(this.options.messages.invalidFrame);
          }
          this.#scheduleReconnect(code);
        },
        () =>
          !this.#disposed &&
          revision === this.#connectRevision &&
          this.#active === active,
      );
      return active;
    } catch (error) {
      interactive?.close("protocol-error");
      realtime?.close("protocol-error");
      if (grant) {
        await this.dependencies
          .revokeGrant(sessionId, grant.binding.grantId)
          .catch(() => undefined);
      }
      reference.release();
      throw error;
    }
  }

  #scheduleReconnect(
    code: WorkerLinkChannelCloseCode = "endpoint-disconnected",
  ) {
    if (this.#disposed || this.#reconnectTimer) return;
    const delay = remoteSurfaceWorkerLinkReconnectDelay(this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    this.options.onConnectionState("reconnecting");
    this.options.onConnecting?.("reconnecting");
    clientLogger.rateLimited(
      `surface-worker-link-reconnect:${this.options.surfaceKind ?? "remote"}:${this.options.surfaceId}`,
      "info",
      "Remote Surface WorkerLink reconnect scheduled",
      {
        attempt: this.#reconnectAttempt,
        delayMs: delay,
        event: "surface.worker-link.reconnect-scheduled",
        operation: "reconnect",
        reasonCode: code,
        subsystem: this.options.surfaceKind ?? "remote-surface",
        surfaceId: this.options.surfaceId,
      },
      { summaryEvery: 10, windowMs: 30_000 },
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#beginConnect();
    }, delay);
  }

  #cancelReconnect(): void {
    if (!this.#reconnectTimer) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }
}

interface PendingOutboundFrame {
  bytes: Uint8Array | null;
  readonly channel: RemoteSurfaceChannel;
  frameId: number | null;
  offset: number;
  readonly payload: Uint8Array;
  readonly sequence: number;
}

class ActiveRemoteSurfaceWorkerLink {
  #closed = false;
  #drainingOutbound = false;
  readonly #inboundAssemblers = {
    interactive: new WorkerLinkRemoteSurfaceFrameAssembler(),
    realtime: new WorkerLinkRemoteSurfaceFrameAssembler(true),
  };
  #pendingInboundBytes = 0;
  #pendingInboundFrames = 0;
  readonly #inboundQueues = new Map<RemoteSurfaceChannel, Promise<void>>();
  readonly #lastInboundSequences = new Map<RemoteSurfaceChannel, number>();
  readonly #latestRealtimeSequences = new Map<RemoteSurfaceChannel, number>();
  #nextOutboundFrameId = 0;
  readonly #outbound: PendingOutboundFrame[] = [];
  #outboundBytes = 0;
  readonly #outboundSequences = new Map<RemoteSurfaceChannel, number>();
  #renewTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #unsubscribers: Array<() => void>;
  readonly routes: RemoteSurfaceWorkerLinkRoutes;

  get closed(): boolean {
    return this.#closed;
  }

  constructor(
    private readonly options: RemoteSurfaceWorkerLinkClientOptions,
    private readonly dependencies: RemoteSurfaceWorkerLinkDependencies,
    private readonly reference: WorkerLinkReference,
    private readonly grant: WorkerLinkResourceGrant,
    private readonly interactive: WorkerLinkStream,
    private readonly realtime: WorkerLinkStream,
    private readonly onRetired: (
      code: WorkerLinkChannelCloseCode,
      failure: "connection" | "invalid-frame",
    ) => void,
    private readonly isCurrent: () => boolean,
  ) {
    this.routes = {
      interactive: interactive.route,
      realtime: realtime.route,
    };
    this.#unsubscribers = [
      interactive.onData((payload) =>
        this.#receive("interactive", interactive, payload),
      ),
      realtime.onData((payload) =>
        this.#receive("realtime", realtime, payload),
      ),
      interactive.onWritable(() => this.#drainOutbound()),
      interactive.onError(() => this.#retire("protocol-error", true)),
      realtime.onError(() => this.#retire("protocol-error", true)),
      interactive.onClose((code) => this.#retire(code, false)),
      realtime.onClose((code) => this.#retire(code, false)),
    ];
    this.#scheduleRenewal(grant.binding.lease);
  }

  send(channel: RemoteSurfaceChannel, payload: Uint8Array): boolean {
    if (this.#closed || channel !== "control") return false;
    if (
      this.#outbound.length >= MAX_PENDING_OUTBOUND_FRAMES ||
      this.#outboundBytes + payload.byteLength > MAX_PENDING_OUTBOUND_BYTES
    ) {
      return false;
    }
    const sequence = this.#outboundSequences.get(channel) ?? 0;
    this.#outboundSequences.set(channel, sequence + 1);
    const copy = payload.slice();
    this.#outbound.push({
      bytes: null,
      channel,
      frameId: null,
      offset: 0,
      payload: copy,
      sequence,
    });
    this.#outboundBytes += copy.byteLength;
    this.#drainOutbound();
    return true;
  }

  close(code: WorkerLinkChannelCloseCode): void {
    this.#retire(code, true, false);
  }

  #receive(
    lane: "interactive" | "realtime",
    stream: WorkerLinkStream,
    payload: Uint8Array,
  ): void {
    if (this.#closed) return;
    try {
      const assembled = this.#inboundAssemblers[lane].push(payload);
      if (
        assembled &&
        (this.#pendingInboundFrames >= MAX_PENDING_INBOUND_FRAMES ||
          this.#pendingInboundBytes + assembled.byteLength >
            MAX_PENDING_INBOUND_BYTES)
      ) {
        this.#retire("congested", true, true);
        return;
      }
      if (!stream.acknowledge(payload.byteLength)) {
        this.#retire("protocol-error", true, true);
        return;
      }
      if (assembled) this.#queueInbound(lane, assembled);
    } catch {
      this.#retire("protocol-error", true, true);
    }
  }

  #queueInbound(lane: "interactive" | "realtime", encoded: Uint8Array): void {
    let frame: ReturnType<typeof decodeRemoteSurfaceFrame>;
    try {
      frame = decodeRemoteSurfaceFrame(encoded);
      const expectedLane =
        frame.header.channel === "control" ||
        frame.header.channel === "clipboard"
          ? "interactive"
          : frame.header.channel === "frame" ||
              frame.header.channel === "cursor"
            ? "realtime"
            : null;
      if (
        expectedLane !== lane ||
        frame.header.surfaceId !== this.options.surfaceId ||
        frame.header.attachmentId !== this.grant.binding.resource.attachmentId
      ) {
        throw new Error("Remote Surface frame escaped its WorkerLink lane.");
      }
      if (
        frame.header.sequence <=
        (this.#lastInboundSequences.get(frame.header.channel) ?? -1)
      ) {
        return;
      }
      this.#lastInboundSequences.set(
        frame.header.channel,
        frame.header.sequence,
      );
    } catch {
      this.#retire("protocol-error", true, true);
      return;
    }
    this.#pendingInboundFrames += 1;
    this.#pendingInboundBytes += encoded.byteLength;
    if (lane === "realtime") {
      this.#latestRealtimeSequences.set(
        frame.header.channel,
        frame.header.sequence,
      );
    }
    const previous =
      this.#inboundQueues.get(frame.header.channel) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        if (
          this.#closed ||
          (lane === "realtime" &&
            this.#latestRealtimeSequences.get(frame.header.channel) !==
              frame.header.sequence)
        ) {
          return;
        }
        const plaintext = await this.dependencies.openPayload({
          context: {
            surfaceKind: this.options.streamKind,
            surfaceId: frame.header.surfaceId,
            attachmentId: frame.header.attachmentId,
            direction: "worker-to-client",
            channel: frame.header.channel,
            sequence: frame.header.sequence,
          },
          protectedPayload: frame.payload,
        });
        if (this.#closed || !this.isCurrent()) return;
        await this.options.onFrame(
          { header: frame.header, payload: plaintext },
          {
            isCurrent: this.isCurrent,
            reportError: this.options.onError,
          },
        );
      })
      .catch(() => this.#retire("protocol-error", true, true))
      .finally(() => {
        this.#pendingInboundFrames -= 1;
        this.#pendingInboundBytes -= encoded.byteLength;
        if (this.#inboundQueues.get(frame.header.channel) === queued) {
          this.#inboundQueues.delete(frame.header.channel);
        }
      });
    this.#inboundQueues.set(frame.header.channel, queued);
  }

  #drainOutbound(): void {
    if (this.#closed || this.#drainingOutbound) return;
    this.#drainingOutbound = true;
    void (async () => {
      try {
        while (!this.#closed && this.#outbound.length > 0) {
          const pending = this.#outbound[0]!;
          if (!pending.bytes) {
            const protectedPayload = await this.dependencies.protectPayload({
              context: {
                surfaceKind: this.options.streamKind,
                surfaceId: this.options.surfaceId,
                attachmentId: this.grant.binding.resource.attachmentId!,
                direction: "client-to-worker",
                channel: pending.channel,
                sequence: pending.sequence,
              },
              payload: pending.payload,
            });
            if (this.#closed) return;
            pending.bytes = encodeRemoteSurfaceFrame(
              {
                protocolVersion: 1,
                surfaceId: this.options.surfaceId,
                attachmentId: this.grant.binding.resource.attachmentId!,
                sequence: pending.sequence,
                channel: pending.channel,
              },
              protectedPayload,
            );
            pending.frameId = this.#nextOutboundFrameId;
            this.#nextOutboundFrameId = (this.#nextOutboundFrameId + 1) >>> 0;
          }
          const end = Math.min(
            pending.bytes.byteLength,
            pending.offset + WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES,
          );
          if (
            !this.interactive.write(
              encodeWorkerLinkRemoteSurfaceChunk({
                frameId: pending.frameId!,
                frameLength: pending.bytes.byteLength,
                offset: pending.offset,
                payload: pending.bytes.subarray(pending.offset, end),
              }),
            )
          ) {
            return;
          }
          pending.offset = end;
          if (pending.offset < pending.bytes.byteLength) continue;
          this.#outbound.shift();
          this.#outboundBytes -= pending.payload.byteLength;
        }
      } catch {
        this.#retire("protocol-error", true, true);
      } finally {
        this.#drainingOutbound = false;
      }
    })();
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
        .renewGrant(this.grant.binding.sessionId, this.grant.binding.grantId)
        .then((renewed) => this.#scheduleRenewal(renewed))
        .catch(() => this.#retire("revoked", true));
    }, delay);
  }

  #retire(
    code: WorkerLinkChannelCloseCode,
    closeStreams: boolean,
    invalidFrame = false,
  ): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#renewTimer) clearTimeout(this.#renewTimer);
    this.#renewTimer = null;
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#inboundAssemblers.interactive.reset();
    this.#inboundAssemblers.realtime.reset();
    this.#inboundQueues.clear();
    this.#outbound.length = 0;
    this.#outboundBytes = 0;
    if (closeStreams) {
      this.interactive.close(code);
      this.realtime.close(code);
    }
    void this.dependencies
      .revokeGrant(this.grant.binding.sessionId, this.grant.binding.grantId)
      .catch(() => undefined);
    this.reference.release();
    this.onRetired(code, invalidFrame ? "invalid-frame" : "connection");
  }
}

function validateRemoteSurfaceGrant(
  grant: WorkerLinkResourceGrant,
  surfaceId: string,
  streamKind: RemoteSurfaceStreamKind,
): void {
  const expectedKind = streamKind === "browser" ? "browser" : "remote-desktop";
  if (
    grant.binding.resource.kind !== expectedKind ||
    grant.binding.resource.resourceId !== surfaceId ||
    !grant.binding.resource.attachmentId ||
    !grant.binding.lanes.includes("interactive") ||
    !grant.binding.lanes.includes("realtime") ||
    !grant.binding.operations.includes("stream:open") ||
    !grant.binding.operations.includes("stream:read") ||
    !grant.binding.operations.includes("stream:write") ||
    grant.binding.maxChannels !== 2
  ) {
    throw new Error("WorkerLink returned an invalid Remote Surface grant.");
  }
}
