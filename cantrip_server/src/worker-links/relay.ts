import {
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
  type WorkerLinkFrameHeader,
  type WorkerLinkSession,
} from "@cantrip/protocol/worker-link";

import type { WorkerCommandBus } from "../workers/bridge.js";

const MAX_RELAY_BUFFERED_BYTES = 8 * 1_024 * 1_024;
const EMPTY_PAYLOAD = new Uint8Array();

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
  clientSequence: number;
  header: Extract<WorkerLinkFrameHeader, { kind: "open" }>;
  workerSequence: number;
}

interface RelayConnection {
  channels: Map<string, RelayChannelState>;
  closed: boolean;
  session: WorkerLinkSession;
  socket: WorkerLinkRelaySocket;
  unsubscribers: Array<() => void>;
}

export interface WorkerLinkRelayStats {
  channels: number;
  connections: number;
}

export class WorkerLinkRelay {
  readonly #connections = new Map<string, RelayConnection>();
  #closed = false;

  constructor(private readonly workers: WorkerCommandBus) {}

  attach(session: WorkerLinkSession, socket: WorkerLinkRelaySocket): boolean {
    if (
      this.#closed ||
      socket.readyState !== 1 ||
      session.preferredRoute !== "relay"
    ) {
      socket.close(1013, "WorkerLink relay is unavailable");
      return false;
    }
    const previous = this.#connections.get(session.sessionId);
    previous?.socket.close(1012, "WorkerLink relay was replaced");
    const connection: RelayConnection = {
      channels: new Map(),
      closed: false,
      session,
      socket,
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
          if (header.kind === "close" || header.kind === "reject") {
            connection.channels.delete(header.channel.channelId);
          }
          this.#send(connection, header, payload);
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
    for (const connection of this.#connections.values()) {
      channels += connection.channels.size;
    }
    return { channels, connections: this.#connections.size };
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
    if (header.kind === "open") {
      if (connection.channels.has(channelId)) {
        connection.socket.close(1008, "WorkerLink channel was replayed");
        return;
      }
      connection.channels.set(channelId, {
        clientSequence: header.sequence,
        header,
        workerSequence: -1,
      });
    } else {
      const channel = connection.channels.get(channelId);
      if (!channel || header.sequence !== channel.clientSequence + 1) {
        connection.socket.close(1008, "WorkerLink channel sequence is invalid");
        return;
      }
      channel.clientSequence = header.sequence;
      if (header.kind === "close") connection.channels.delete(channelId);
    }
    const delivered = this.workers.sendWorkerLinkFrame?.(
      connection.session.identity.workerId,
      header,
      frame.payload,
    );
    if (!delivered) {
      connection.socket.close(1013, "WorkerLink worker route is unavailable");
    }
  }

  #send(
    connection: RelayConnection,
    header: WorkerLinkFrameHeader,
    payload: Uint8Array,
  ): boolean {
    if (
      connection.socket.readyState !== 1 ||
      connection.socket.bufferedAmount > MAX_RELAY_BUFFERED_BYTES
    ) {
      connection.socket.close(1013, "WorkerLink relay is congested");
      return false;
    }
    try {
      connection.socket.send(encodeWorkerLinkFrame(header, payload), {
        binary: true,
      });
      return true;
    } catch {
      connection.socket.close(1011, "WorkerLink relay send failed");
      return false;
    }
  }

  #retire(connection: RelayConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    if (this.#connections.get(connection.session.sessionId) === connection) {
      this.#connections.delete(connection.session.sessionId);
    }
    for (const unsubscribe of connection.unsubscribers) unsubscribe();
    connection.unsubscribers.length = 0;
    for (const channel of connection.channels.values()) {
      this.workers.sendWorkerLinkFrame?.(
        connection.session.identity.workerId,
        {
          protocolVersion: channel.header.protocolVersion,
          sessionId: channel.header.sessionId,
          routeGeneration: channel.header.routeGeneration,
          effectiveRoute: channel.header.effectiveRoute,
          channel: channel.header.channel,
          lane: channel.header.lane,
          sequence: channel.clientSequence + 1,
          kind: "close",
          code: "endpoint-disconnected",
        },
        EMPTY_PAYLOAD,
      );
    }
    connection.channels.clear();
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
