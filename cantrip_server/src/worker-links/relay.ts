import {
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
  type WorkerLinkFrameHeader,
  type WorkerLinkPeerLaneLimits,
  type WorkerLinkQosLane,
  type WorkerLinkSession,
} from "@cantrip/protocol/worker-link";
import type { AccountBandwidthChannel } from "@cantrip/protocol/resource-usage";

import type { AccountUsageRecorder } from "../account-usage/bandwidth-meter.js";
import { recordEncodedFrame } from "../account-usage/frame-bandwidth.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

const MAX_RELAY_BUFFERED_BYTES = 8 * 1_024 * 1_024;
const RELAY_DRAIN_INTERVAL_MS = 5;
const RELAY_STALL_TIMEOUT_MS = 5_000;
const EMPTY_PAYLOAD = new Uint8Array();
const RELAY_LANE_PRIORITY = [
  "interactive",
  "realtime",
  "events",
  "stream",
  "bulk",
] as const satisfies readonly WorkerLinkQosLane[];
const DEFAULT_RELAY_LANE_LIMITS: WorkerLinkPeerLaneLimits = {
  events: {
    maxChannels: 64,
    maxQueuedFrames: 256,
    maxQueuedBytes: 4 * 1_024 * 1_024,
    maxBytesPerSecond: 16 * 1_024 * 1_024,
  },
  interactive: {
    maxChannels: 64,
    maxQueuedFrames: 128,
    maxQueuedBytes: 2 * 1_024 * 1_024,
    maxBytesPerSecond: 16 * 1_024 * 1_024,
  },
  stream: {
    maxChannels: 256,
    maxQueuedFrames: 256,
    maxQueuedBytes: 16 * 1_024 * 1_024,
    maxBytesPerSecond: 128 * 1_024 * 1_024,
  },
  realtime: {
    maxChannels: 64,
    maxQueuedFrames: 64,
    maxQueuedBytes: 4 * 1_024 * 1_024,
    maxBytesPerSecond: 64 * 1_024 * 1_024,
  },
  bulk: {
    maxChannels: 32,
    maxQueuedFrames: 128,
    maxQueuedBytes: 16 * 1_024 * 1_024,
    maxBytesPerSecond: 64 * 1_024 * 1_024,
  },
};

export interface WorkerLinkRelaySocket {
  bufferedAmount: number;
  close(code?: number, reason?: string): void;
  on(
    event: "message",
    listener: (data: unknown, isBinary?: boolean) => void,
  ): void;
  on(event: "close" | "error", listener: () => void): void;
  readyState: number;
  send(data: Uint8Array, options?: { binary?: boolean }): void;
}

interface RelayChannelState {
  bandwidthChannel: AccountBandwidthChannel;
  clientDeliveredSequence: number;
  clientSequence: number;
  grantId: string;
  header: Extract<WorkerLinkFrameHeader, { kind: "open" }>;
  workerSequence: number;
}

interface QueuedClientFrame {
  bandwidthChannel: AccountBandwidthChannel;
  encoded: Uint8Array;
}

interface RelayLaneQueue {
  bytes: number;
  frames: QueuedClientFrame[];
}

interface RemoteSurfaceGrantState {
  channelIds: Set<string>;
  release: () => void;
}

interface RelayConnection {
  channels: Map<string, RelayChannelState>;
  closed: boolean;
  drainTimer: ReturnType<typeof setTimeout> | null;
  lanes: Record<WorkerLinkQosLane, RelayLaneQueue>;
  queuedBytes: number;
  queuedFrames: number;
  remoteSurfaceGrants: Map<string, RemoteSurfaceGrantState>;
  session: WorkerLinkSession;
  socket: WorkerLinkRelaySocket;
  stalledAt: number | null;
  unsubscribers: Array<() => void>;
}

export interface WorkerLinkRelayStats {
  channels: number;
  connections: number;
  queuedBytes: number;
  queuedFrames: number;
  queuedFramesByLane: Record<WorkerLinkQosLane, number>;
}

export interface WorkerLinkRelayOptions {
  acquireRemoteSurface?(ownerId: string, workerId: string): () => void;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
  consumeRelayBytes?(ownerId: string, workerId: string, bytes: number): boolean;
  laneLimits?: WorkerLinkPeerLaneLimits;
  now?(): number;
  setTimer?(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  usageRecorder?: AccountUsageRecorder;
}

export class WorkerLinkRelay {
  readonly #connections = new Map<string, RelayConnection>();
  readonly #laneLimits: WorkerLinkPeerLaneLimits;
  readonly #now: () => number;
  #closed = false;

  constructor(
    private readonly workers: WorkerCommandBus,
    private readonly options: WorkerLinkRelayOptions = {},
  ) {
    this.#laneLimits = options.laneLimits ?? DEFAULT_RELAY_LANE_LIMITS;
    this.#now = options.now ?? Date.now;
  }

  attach(session: WorkerLinkSession, socket: WorkerLinkRelaySocket): boolean {
    if (
      this.#closed ||
      socket.readyState !== 1 ||
      !session.routePolicy.enabled.includes("relay") ||
      !this.workers.sendWorkerLinkFrame ||
      !this.workers.subscribeWorkerLinkFrames
    ) {
      socket.close(1013, "WorkerLink relay is unavailable");
      return false;
    }
    const previous = this.#connections.get(session.sessionId);
    previous?.socket.close(1012, "WorkerLink relay was replaced");
    const connection: RelayConnection = {
      channels: new Map(),
      closed: false,
      drainTimer: null,
      lanes: createLaneQueues(),
      queuedBytes: 0,
      queuedFrames: 0,
      remoteSurfaceGrants: new Map(),
      session,
      socket,
      stalledAt: null,
      unsubscribers: [],
    };
    this.#connections.set(session.sessionId, connection);
    connection.unsubscribers.push(
      this.workers.subscribeWorkerLinkFrames?.(
        session.identity.workerId,
        (header, payload) => {
          if (
            this.#connections.get(session.sessionId) !== connection ||
            header.sessionId !== session.sessionId ||
            header.routeGeneration !== session.routeGeneration ||
            header.effectiveRoute !== "relay"
          ) {
            return;
          }
          const channel = connection.channels.get(header.channel.channelId);
          if (
            !channel ||
            canonicalChannel(channel.header) !== canonicalChannel(header) ||
            header.sequence !== channel.workerSequence + 1 ||
            (channel.workerSequence < 0
              ? header.kind !== "accept" && header.kind !== "reject"
              : header.kind === "accept" || header.kind === "reject")
          ) {
            socket.close(1008, "WorkerLink worker frame is out of sequence");
            return;
          }
          channel.workerSequence = header.sequence;
          const encoded = encodeWorkerLinkFrame(header, payload);
          this.#record(
            connection,
            channel.bandwidthChannel,
            "ingress",
            encoded,
          );
          if (!this.#consumeRelay(connection, payload.byteLength)) return;
          const accepted = this.#sendOrQueue(
            connection,
            header.lane,
            channel.bandwidthChannel,
            encoded,
          );
          if (
            accepted &&
            (header.kind === "close" || header.kind === "reject")
          ) {
            this.#releaseChannel(connection, header.channel.channelId);
          }
        },
      ) ?? (() => undefined),
      this.workers.subscribeWorkerOffline?.(session.identity.workerId, () =>
        socket.close(1013, "Worker is offline"),
      ) ??
        this.workers.subscribeWorkerDisconnect(session.identity.workerId, () =>
          socket.close(1013, "Worker is offline"),
        ),
    );
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        socket.close(1003, "WorkerLink relay requires binary frames");
        return;
      }
      this.#receive(connection, data);
    });
    const close = () => this.#retire(connection);
    socket.on("close", close);
    socket.on("error", close);
    return true;
  }

  stats(): WorkerLinkRelayStats {
    let channels = 0;
    let queuedBytes = 0;
    let queuedFrames = 0;
    const queuedFramesByLane = Object.fromEntries(
      RELAY_LANE_PRIORITY.map((lane) => [lane, 0]),
    ) as Record<WorkerLinkQosLane, number>;
    for (const connection of this.#connections.values()) {
      channels += connection.channels.size;
      queuedBytes += connection.queuedBytes;
      queuedFrames += connection.queuedFrames;
      for (const lane of RELAY_LANE_PRIORITY) {
        queuedFramesByLane[lane] += connection.lanes[lane].frames.length;
      }
    }
    return {
      channels,
      connections: this.#connections.size,
      queuedBytes,
      queuedFrames,
      queuedFramesByLane,
    };
  }

  revokeSession(sessionId: string, reason = "WorkerLink session ended"): void {
    this.#connections.get(sessionId)?.socket.close(1008, reason);
  }

  revokeAccountSession(accountSessionId: string): void {
    for (const connection of this.#connections.values()) {
      if (connection.session.identity.accountSessionId === accountSessionId) {
        connection.socket.close(1008, "Account session ended");
      }
    }
  }

  revokeOwner(ownerId: string): void {
    for (const connection of this.#connections.values()) {
      if (connection.session.identity.ownerId === ownerId) {
        connection.socket.close(1008, "Account sessions ended");
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const connection of [...this.#connections.values()]) {
      connection.socket.close(1001, "Server is shutting down");
      this.#retire(connection);
    }
  }

  #receive(connection: RelayConnection, data: unknown): void {
    if (
      connection.closed ||
      this.#connections.get(connection.session.sessionId) !== connection
    ) {
      return;
    }
    let frame: ReturnType<typeof decodeWorkerLinkFrame>;
    try {
      frame = decodeWorkerLinkFrame(frameBytes(data));
    } catch {
      connection.socket.close(1003, "WorkerLink frame is invalid");
      return;
    }
    const { header } = frame;
    if (
      header.sessionId !== connection.session.sessionId ||
      header.routeGeneration !== connection.session.routeGeneration ||
      header.effectiveRoute !== "relay"
    ) {
      connection.socket.close(1008, "WorkerLink frame identity is stale");
      return;
    }
    const channelId = header.channel.channelId;
    let channel: RelayChannelState;
    if (header.kind === "open") {
      if (connection.channels.has(channelId)) {
        connection.socket.close(1008, "WorkerLink channel was replayed");
        return;
      }
      try {
        this.#retainRemoteSurfaceGrant(connection, header);
        channel = {
          bandwidthChannel: relayBandwidthChannel(header),
          clientDeliveredSequence: -1,
          clientSequence: header.sequence,
          grantId: header.grant.binding.grantId,
          header,
          workerSequence: -1,
        };
        connection.channels.set(channelId, channel);
      } catch {
        connection.socket.close(
          1013,
          "WorkerLink Remote Surface relay quota reached",
        );
        return;
      }
    } else {
      const current = connection.channels.get(channelId);
      if (!current || header.sequence !== current.clientSequence + 1) {
        connection.socket.close(1008, "WorkerLink channel sequence is invalid");
        return;
      }
      current.clientSequence = header.sequence;
      channel = current;
    }
    const bandwidthChannel = channel.bandwidthChannel;
    const encoded = encodeWorkerLinkFrame(header, frame.payload);
    this.#record(connection, bandwidthChannel, "ingress", encoded);
    if (!this.#consumeRelay(connection, frame.payload.byteLength)) return;
    const delivered =
      this.workers.sendWorkerLinkFrame?.(
        connection.session.identity.workerId,
        header,
        frame.payload,
      ) ?? false;
    if (!delivered) {
      connection.socket.close(1013, "WorkerLink worker route is unavailable");
      return;
    }
    channel.clientDeliveredSequence = header.sequence;
    this.#record(connection, bandwidthChannel, "egress", encoded);
    if (header.kind === "close") this.#releaseChannel(connection, channelId);
  }

  #sendOrQueue(
    connection: RelayConnection,
    lane: WorkerLinkQosLane,
    bandwidthChannel: AccountBandwidthChannel,
    encoded: Uint8Array,
  ): boolean {
    if (connection.socket.readyState !== 1) {
      return false;
    }
    const queue = connection.lanes[lane];
    if (
      queue.frames.length > 0 ||
      connection.socket.bufferedAmount > MAX_RELAY_BUFFERED_BYTES
    ) {
      const limit = this.#laneLimits[lane];
      if (
        queue.frames.length >= limit.maxQueuedFrames ||
        queue.bytes + encoded.byteLength > limit.maxQueuedBytes
      ) {
        connection.socket.close(1013, "WorkerLink relay lane is congested");
        return false;
      }
      queue.frames.push({ bandwidthChannel, encoded });
      queue.bytes += encoded.byteLength;
      connection.queuedBytes += encoded.byteLength;
      connection.queuedFrames += 1;
      connection.stalledAt ??= this.#now();
      this.#scheduleDrain(connection);
      return true;
    }
    return this.#sendNow(connection, bandwidthChannel, encoded);
  }

  #sendNow(
    connection: RelayConnection,
    bandwidthChannel: AccountBandwidthChannel,
    encoded: Uint8Array,
  ): boolean {
    try {
      connection.socket.send(encoded, { binary: true });
      this.#record(connection, bandwidthChannel, "egress", encoded);
      return true;
    } catch {
      connection.socket.close(1011, "WorkerLink relay send failed");
      return false;
    }
  }

  #scheduleDrain(connection: RelayConnection): void {
    if (connection.closed || connection.drainTimer) return;
    const setTimer =
      this.options.setTimer ??
      ((callback: () => void, delayMs: number) =>
        globalThis.setTimeout(callback, delayMs));
    connection.drainTimer = setTimer(() => {
      connection.drainTimer = null;
      this.#drain(connection);
    }, RELAY_DRAIN_INTERVAL_MS);
    connection.drainTimer.unref?.();
  }

  #drain(connection: RelayConnection): void {
    if (
      connection.closed ||
      this.#connections.get(connection.session.sessionId) !== connection
    ) {
      return;
    }
    if (connection.socket.readyState !== 1) {
      this.#retire(connection);
      return;
    }
    if (connection.socket.bufferedAmount > MAX_RELAY_BUFFERED_BYTES) {
      if (
        connection.stalledAt !== null &&
        this.#now() - connection.stalledAt >= RELAY_STALL_TIMEOUT_MS
      ) {
        connection.socket.close(1013, "WorkerLink relay client is too slow");
        return;
      }
      this.#scheduleDrain(connection);
      return;
    }
    while (connection.socket.bufferedAmount <= MAX_RELAY_BUFFERED_BYTES) {
      let sent = false;
      for (const lane of RELAY_LANE_PRIORITY) {
        const queue = connection.lanes[lane];
        const next = queue.frames.shift();
        if (!next) continue;
        queue.bytes -= next.encoded.byteLength;
        connection.queuedBytes -= next.encoded.byteLength;
        connection.queuedFrames -= 1;
        if (!this.#sendNow(connection, next.bandwidthChannel, next.encoded)) {
          return;
        }
        connection.stalledAt = this.#now();
        sent = true;
        if (connection.socket.bufferedAmount > MAX_RELAY_BUFFERED_BYTES) break;
      }
      if (!sent) break;
    }
    if (connection.queuedFrames === 0) {
      connection.stalledAt = null;
      return;
    }
    this.#scheduleDrain(connection);
  }

  #consumeRelay(connection: RelayConnection, bytes: number): boolean {
    if (
      bytes <= 0 ||
      !this.options.consumeRelayBytes ||
      this.options.consumeRelayBytes(
        connection.session.identity.ownerId,
        connection.session.identity.workerId,
        bytes,
      )
    ) {
      return true;
    }
    connection.socket.close(1013, "WorkerLink relay bandwidth quota reached");
    return false;
  }

  #record(
    connection: RelayConnection,
    channel: AccountBandwidthChannel,
    direction: "egress" | "ingress",
    data: unknown,
  ): void {
    recordEncodedFrame(this.options.usageRecorder, {
      ownerId: connection.session.identity.ownerId,
      direction,
      channel,
      data,
    });
  }

  #retainRemoteSurfaceGrant(
    connection: RelayConnection,
    header: Extract<WorkerLinkFrameHeader, { kind: "open" }>,
  ): void {
    if (!isRemoteSurfaceKind(header.grant.binding.resource.kind)) return;
    const grantId = header.grant.binding.grantId;
    const current = connection.remoteSurfaceGrants.get(grantId);
    if (current) {
      current.channelIds.add(header.channel.channelId);
      return;
    }
    const release =
      this.options.acquireRemoteSurface?.(
        connection.session.identity.ownerId,
        connection.session.identity.workerId,
      ) ?? (() => undefined);
    connection.remoteSurfaceGrants.set(grantId, {
      channelIds: new Set([header.channel.channelId]),
      release,
    });
  }

  #releaseChannel(connection: RelayConnection, channelId: string): void {
    const channel = connection.channels.get(channelId);
    if (!channel) return;
    connection.channels.delete(channelId);
    const remoteSurface = connection.remoteSurfaceGrants.get(channel.grantId);
    if (!remoteSurface) return;
    remoteSurface.channelIds.delete(channelId);
    if (remoteSurface.channelIds.size > 0) return;
    connection.remoteSurfaceGrants.delete(channel.grantId);
    remoteSurface.release();
  }

  #retire(connection: RelayConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    if (this.#connections.get(connection.session.sessionId) === connection) {
      this.#connections.delete(connection.session.sessionId);
    }
    for (const unsubscribe of connection.unsubscribers) unsubscribe();
    connection.unsubscribers.length = 0;
    if (connection.drainTimer) {
      if (this.options.clearTimer) {
        this.options.clearTimer(connection.drainTimer);
      } else {
        globalThis.clearTimeout(connection.drainTimer);
      }
      connection.drainTimer = null;
    }
    for (const queue of Object.values(connection.lanes)) {
      queue.frames.length = 0;
      queue.bytes = 0;
    }
    connection.queuedBytes = 0;
    connection.queuedFrames = 0;
    for (const remoteSurface of connection.remoteSurfaceGrants.values()) {
      remoteSurface.release();
    }
    connection.remoteSurfaceGrants.clear();
    for (const channel of connection.channels.values()) {
      if (channel.clientDeliveredSequence < 0) continue;
      this.workers.sendWorkerLinkFrame?.(
        connection.session.identity.workerId,
        {
          protocolVersion: channel.header.protocolVersion,
          sessionId: channel.header.sessionId,
          routeGeneration: channel.header.routeGeneration,
          effectiveRoute: channel.header.effectiveRoute,
          channel: channel.header.channel,
          lane: channel.header.lane,
          sequence: channel.clientDeliveredSequence + 1,
          kind: "close",
          code: "endpoint-disconnected",
        },
        EMPTY_PAYLOAD,
      );
    }
    connection.channels.clear();
  }
}

function createLaneQueues(): Record<WorkerLinkQosLane, RelayLaneQueue> {
  return {
    events: { bytes: 0, frames: [] },
    interactive: { bytes: 0, frames: [] },
    stream: { bytes: 0, frames: [] },
    realtime: { bytes: 0, frames: [] },
    bulk: { bytes: 0, frames: [] },
  };
}

function isRemoteSurfaceKind(kind: string): boolean {
  return kind === "browser" || kind === "remote-desktop";
}

function relayBandwidthChannel(
  header: Extract<WorkerLinkFrameHeader, { kind: "open" }>,
): AccountBandwidthChannel {
  switch (header.grant.binding.resource.kind) {
    case "terminal":
      return "terminal-relay";
    case "browser":
    case "remote-desktop":
      return "remote-surface-relay";
    case "code":
      return "code-relay";
    case "project-share":
      return "project-share-relay";
    case "tunnel":
      return "tunnel-relay";
    case "observations":
      return "other";
  }
}

function canonicalChannel(
  header: Pick<WorkerLinkFrameHeader, "channel" | "lane">,
): string {
  return JSON.stringify([header.channel, header.lane]);
}

function frameBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const chunks = data.map(frameBytes);
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }
  throw new Error("WorkerLink relay received unsupported binary data.");
}
