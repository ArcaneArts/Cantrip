import {
  TUNNEL_DATA_PLANE_AUTH_TAG_BYTES,
  TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES,
  TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES,
  TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES,
  tunnelDataPlaneCloseCodeSchema,
  type TunnelDataPlaneCloseCode,
  type TunnelDataPlaneFrameHeader,
  type TunnelDataPlaneTarget,
} from "@cantrip/protocol";

const EMPTY_PAYLOAD = new Uint8Array();

export type TunnelEndpointPlacement =
  | { kind: "desktop-client"; clientId: string }
  | { kind: "worker"; workerId: string }
  | { kind: "server-adapter"; adapterId: string };

export type TunnelEndpointFrameListener = (
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
) => void;

export interface TunnelDataPlaneEndpoint {
  readonly endpointId: string;
  readonly placement: TunnelEndpointPlacement;
  send(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): boolean;
  subscribe(listener: TunnelEndpointFrameListener): () => void;
  subscribeDisconnect(listener: () => void): () => void;
}

export interface TunnelRouteRegistration {
  attachmentId: string;
  destination: TunnelDataPlaneEndpoint;
  destinationTarget: TunnelDataPlaneTarget;
  source: TunnelDataPlaneEndpoint;
  tunnelId: string;
  ownerId?: string;
  workerId?: string;
}

export interface TunnelRouteHandle {
  close(): void;
}

export interface TunnelStreamBrokerOptions {
  consumeRelayBytes?(ownerId: string, workerId: string, bytes: number): boolean;
  idleTimeoutMs?: number;
  maxBytesPerSecond?: number;
  maxConnections?: number;
  maxConnectionsPerTunnel?: number;
  maxLifetimeMs?: number;
  maxRoutes?: number;
  now?: () => number;
  onActivity?(tunnelId: string): boolean;
  sweepIntervalMs?: number;
}

export interface TunnelStreamBrokerStats {
  activeConnections: number;
  activeRoutes: number;
  bytesFromSource: number;
  bytesToSource: number;
  closedConnections: number;
  openedConnections: number;
  rejectedConnections: number;
  terminationsByReason: Record<TunnelDataPlaneCloseCode, number>;
}

interface Route {
  attachmentId: string;
  destination: TunnelDataPlaneEndpoint;
  destinationTarget: TunnelDataPlaneTarget;
  key: string;
  ownerId?: string;
  source: TunnelDataPlaneEndpoint;
  tunnelId: string;
  unsubscribe: Array<() => void>;
  workerId?: string;
}

interface Connection {
  bandwidthBytes: number;
  bandwidthWindowStartedAt: number;
  createdAt: number;
  destinationHalfClosed: boolean;
  destinationSequence: number;
  destinationToSourceCredit: number;
  id: string;
  lastActivityAt: number;
  route: Route;
  sourceHalfClosed: boolean;
  sourceSequence: number;
  sourceToDestinationCredit: number;
  state: "opening" | "open";
}

function routeKey(tunnelId: string, attachmentId: string): string {
  return `${tunnelId}\0${attachmentId}`;
}

function connectionKey(route: Route, connectionId: string): string {
  return `${route.key}\0${connectionId}`;
}

function flowControlBytes(
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
): number {
  return header.kind === "data" && header.protection
    ? payload.byteLength - TUNNEL_DATA_PLANE_AUTH_TAG_BYTES
    : payload.byteLength;
}

function identities(route: Route, connectionId: string, sequence: number) {
  return {
    protocolVersion: 1 as const,
    tunnelId: route.tunnelId,
    attachmentId: route.attachmentId,
    sourceEndpointId: route.source.endpointId,
    destinationEndpointId: route.destination.endpointId,
    connectionId,
    sequence,
  };
}

export class TunnelStreamBroker {
  readonly #connections = new Map<string, Connection>();
  readonly #consumeRelayBytes: NonNullable<
    TunnelStreamBrokerOptions["consumeRelayBytes"]
  >;
  readonly #idleTimeoutMs: number;
  readonly #maxBytesPerSecond: number;
  readonly #maxConnections: number;
  readonly #maxConnectionsPerTunnel: number;
  readonly #maxLifetimeMs: number;
  readonly #maxRoutes: number;
  readonly #now: () => number;
  readonly #onActivity: NonNullable<TunnelStreamBrokerOptions["onActivity"]>;
  readonly #routes = new Map<string, Route>();
  readonly #sweepTimer: ReturnType<typeof setInterval>;
  #bytesFromSource = 0;
  #bytesToSource = 0;
  #closedConnections = 0;
  #openedConnections = 0;
  #rejectedConnections = 0;
  readonly #terminationsByReason = Object.fromEntries(
    tunnelDataPlaneCloseCodeSchema.options.map((code) => [code, 0]),
  ) as Record<TunnelDataPlaneCloseCode, number>;

  constructor(options: TunnelStreamBrokerOptions = {}) {
    this.#consumeRelayBytes = options.consumeRelayBytes ?? (() => true);
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
    this.#maxLifetimeMs = options.maxLifetimeMs ?? 12 * 60 * 60_000;
    this.#maxBytesPerSecond = options.maxBytesPerSecond ?? 64 * 1_024 * 1_024;
    this.#maxConnections = options.maxConnections ?? 1_024;
    this.#maxConnectionsPerTunnel = options.maxConnectionsPerTunnel ?? 64;
    this.#maxRoutes = options.maxRoutes ?? 2_048;
    this.#now = options.now ?? Date.now;
    this.#onActivity = options.onActivity ?? (() => true);
    this.#sweepTimer = setInterval(
      () => this.sweep(),
      options.sweepIntervalMs ??
        Math.max(1_000, Math.min(60_000, this.#idleTimeoutMs)),
    );
    this.#sweepTimer.unref();
  }

  registerRoute(registration: TunnelRouteRegistration): TunnelRouteHandle {
    if (
      registration.source.endpointId === registration.destination.endpointId
    ) {
      throw new Error("Tunnel route endpoints require distinct identities.");
    }
    const key = routeKey(registration.tunnelId, registration.attachmentId);
    if (this.#routes.has(key)) {
      throw new Error("Tunnel attachment route is already registered.");
    }
    if (this.#routes.size >= this.#maxRoutes) {
      throw new Error("Tunnel route limit reached.");
    }
    const route: Route = { ...registration, key, unsubscribe: [] };
    this.#routes.set(key, route);
    try {
      route.unsubscribe.push(
        route.source.subscribe((header, payload) =>
          this.#receive(route, "source", header, payload),
        ),
        route.destination.subscribe((header, payload) =>
          this.#receive(route, "destination", header, payload),
        ),
        route.source.subscribeDisconnect(() =>
          this.#removeRoute(route, "endpoint-disconnected"),
        ),
        route.destination.subscribeDisconnect(() =>
          this.#removeRoute(route, "endpoint-disconnected"),
        ),
      );
    } catch (error) {
      this.#routes.delete(key);
      for (const unsubscribe of route.unsubscribe) unsubscribe();
      throw error;
    }
    return { close: () => this.#removeRoute(route, "normal") };
  }

  revokeAttachment(attachmentId: string): number {
    const routes = [...this.#routes.values()].filter(
      (route) => route.attachmentId === attachmentId,
    );
    for (const route of routes) this.#removeRoute(route, "revoked");
    return routes.length;
  }

  sweep(now = this.#now()): void {
    for (const connection of [...this.#connections.values()]) {
      if (now - connection.createdAt >= this.#maxLifetimeMs) {
        this.#terminate(connection, "lifetime-expired");
      } else if (now - connection.lastActivityAt >= this.#idleTimeoutMs) {
        this.#terminate(connection, "idle-timeout");
      }
    }
  }

  stats(): TunnelStreamBrokerStats {
    return {
      activeConnections: this.#connections.size,
      activeRoutes: this.#routes.size,
      bytesFromSource: this.#bytesFromSource,
      bytesToSource: this.#bytesToSource,
      closedConnections: this.#closedConnections,
      openedConnections: this.#openedConnections,
      rejectedConnections: this.#rejectedConnections,
      terminationsByReason: { ...this.#terminationsByReason },
    };
  }

  close(): void {
    clearInterval(this.#sweepTimer);
    for (const route of [...this.#routes.values()]) {
      this.#removeRoute(route, "endpoint-disconnected");
    }
  }

  #receive(
    route: Route,
    sender: "source" | "destination",
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): void {
    const payloadValid =
      header.kind === "data"
        ? payload.byteLength > 0 &&
          payload.byteLength <= TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES &&
          (header.protection
            ? payload.byteLength > TUNNEL_DATA_PLANE_AUTH_TAG_BYTES
            : payload.byteLength <= TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES)
        : payload.byteLength === 0;
    if (
      header.tunnelId !== route.tunnelId ||
      header.attachmentId !== route.attachmentId ||
      header.sourceEndpointId !== route.source.endpointId ||
      header.destinationEndpointId !== route.destination.endpointId
    ) {
      return;
    }
    const key = connectionKey(route, header.connectionId);
    let connection = this.#connections.get(key);
    if (!connection) {
      if (sender !== "source" || header.kind !== "open") return;
      if (header.sequence !== 0 || !payloadValid) {
        this.#rejectOpen(route, header, "protocol-error");
        return;
      }
      const tunnelConnections = [...this.#connections.values()].filter(
        (candidate) => candidate.route.tunnelId === route.tunnelId,
      ).length;
      if (
        this.#connections.size >= this.#maxConnections ||
        tunnelConnections >= this.#maxConnectionsPerTunnel
      ) {
        this.#rejectOpen(route, header, "limit-exceeded");
        return;
      }
      if (!this.#onActivity(route.tunnelId)) return;
      if (this.#routes.get(route.key) !== route) return;
      const now = this.#now();
      connection = {
        bandwidthBytes: 0,
        bandwidthWindowStartedAt: now,
        createdAt: now,
        destinationHalfClosed: false,
        destinationSequence: 0,
        destinationToSourceCredit: header.initialCreditBytes,
        id: header.connectionId,
        lastActivityAt: now,
        route,
        sourceHalfClosed: false,
        sourceSequence: 1,
        sourceToDestinationCredit: 0,
        state: "opening",
      };
      this.#connections.set(key, connection);
      this.#openedConnections += 1;
      const sent = route.destination.send(
        {
          ...identities(route, header.connectionId, 0),
          kind: "connect",
          target: route.destinationTarget,
          initialCreditBytes: header.initialCreditBytes,
        },
        EMPTY_PAYLOAD,
      );
      if (!sent) this.#terminate(connection, "congested");
      return;
    }

    if (!payloadValid) {
      this.#terminate(connection, "protocol-error");
      return;
    }

    const expectedSequence =
      sender === "source"
        ? connection.sourceSequence
        : connection.destinationSequence;
    if (header.sequence !== expectedSequence) {
      this.#terminate(connection, "protocol-error");
      return;
    }
    if (sender === "source") connection.sourceSequence += 1;
    else connection.destinationSequence += 1;
    connection.lastActivityAt = this.#now();

    if (!this.#frameAllowed(sender, connection, header)) {
      this.#terminate(connection, "protocol-error");
      return;
    }
    if (!this.#onActivity(route.tunnelId)) {
      this.#terminate(connection, "endpoint-disconnected");
      return;
    }
    if (
      this.#routes.get(route.key) !== route ||
      this.#connections.get(key) !== connection
    ) {
      return;
    }
    if (header.kind === "accepted") {
      connection.state = "open";
      connection.sourceToDestinationCredit = header.initialCreditBytes;
      this.#forward(connection, "source", header, payload);
      return;
    }
    if (header.kind === "rejected") {
      this.#rejectedConnections += 1;
      this.#forward(connection, "source", header, payload);
      this.#finish(connection);
      return;
    }
    if (header.kind === "data") {
      const flowBytes = flowControlBytes(header, payload);
      if (!this.#consumeBandwidth(connection, payload.byteLength)) {
        this.#terminate(connection, "bandwidth-limit");
        return;
      }
      if (
        route.ownerId &&
        route.workerId &&
        !this.#consumeRelayBytes(
          route.ownerId,
          route.workerId,
          payload.byteLength,
        )
      ) {
        this.#terminate(connection, "bandwidth-limit");
        return;
      }
      if (sender === "source") {
        if (flowBytes > connection.sourceToDestinationCredit) {
          this.#terminate(connection, "protocol-error");
          return;
        }
        connection.sourceToDestinationCredit -= flowBytes;
        this.#bytesFromSource += payload.byteLength;
        this.#forward(connection, "destination", header, payload);
      } else {
        if (flowBytes > connection.destinationToSourceCredit) {
          this.#terminate(connection, "protocol-error");
          return;
        }
        connection.destinationToSourceCredit -= flowBytes;
        this.#bytesToSource += payload.byteLength;
        this.#forward(connection, "source", header, payload);
      }
      return;
    }
    if (header.kind === "credit") {
      const credit =
        sender === "source"
          ? connection.destinationToSourceCredit
          : connection.sourceToDestinationCredit;
      if (credit + header.bytes > TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES) {
        this.#terminate(connection, "protocol-error");
        return;
      }
      if (sender === "source") {
        connection.destinationToSourceCredit += header.bytes;
        this.#forward(connection, "destination", header, payload);
      } else {
        connection.sourceToDestinationCredit += header.bytes;
        this.#forward(connection, "source", header, payload);
      }
      return;
    }
    if (header.kind === "half-close") {
      if (sender === "source") connection.sourceHalfClosed = true;
      else connection.destinationHalfClosed = true;
      this.#forward(
        connection,
        sender === "source" ? "destination" : "source",
        header,
        payload,
      );
      return;
    }
    if (header.kind === "close" || header.kind === "error") {
      this.#forward(
        connection,
        sender === "source" ? "destination" : "source",
        header,
        payload,
      );
      this.#finish(connection);
    }
  }

  #frameAllowed(
    sender: "source" | "destination",
    connection: Connection,
    header: TunnelDataPlaneFrameHeader,
  ): boolean {
    if (header.kind === "connect" || header.kind === "open") return false;
    if (sender === "source") {
      if (header.kind === "accepted" || header.kind === "rejected")
        return false;
      if (header.kind === "data") {
        return (
          connection.state === "open" &&
          !connection.sourceHalfClosed &&
          header.direction === "source-to-destination"
        );
      }
      if (header.kind === "credit") {
        return header.direction === "destination-to-source";
      }
      if (header.kind === "half-close") {
        return (
          !connection.sourceHalfClosed &&
          header.direction === "source-to-destination"
        );
      }
      return true;
    }
    if (header.kind === "accepted" || header.kind === "rejected") {
      return connection.state === "opening";
    }
    if (header.kind === "data") {
      return (
        connection.state === "open" &&
        !connection.destinationHalfClosed &&
        header.direction === "destination-to-source"
      );
    }
    if (header.kind === "credit") {
      return header.direction === "source-to-destination";
    }
    if (header.kind === "half-close") {
      return (
        !connection.destinationHalfClosed &&
        header.direction === "destination-to-source"
      );
    }
    return true;
  }

  #consumeBandwidth(connection: Connection, bytes: number): boolean {
    const now = this.#now();
    if (now - connection.bandwidthWindowStartedAt >= 1_000) {
      connection.bandwidthWindowStartedAt = now;
      connection.bandwidthBytes = 0;
    }
    connection.bandwidthBytes += bytes;
    return connection.bandwidthBytes <= this.#maxBytesPerSecond;
  }

  #forward(
    connection: Connection,
    recipient: "source" | "destination",
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): void {
    const endpoint =
      recipient === "source"
        ? connection.route.source
        : connection.route.destination;
    if (!endpoint.send(header, payload)) {
      this.#terminate(connection, "congested");
    }
  }

  #rejectOpen(
    route: Route,
    header: Extract<TunnelDataPlaneFrameHeader, { kind: "open" }>,
    code: Extract<TunnelDataPlaneFrameHeader, { kind: "rejected" }>["code"],
  ): void {
    this.#rejectedConnections += 1;
    route.source.send(
      {
        ...identities(route, header.connectionId, 0),
        kind: "rejected",
        code,
      },
      EMPTY_PAYLOAD,
    );
  }

  #terminate(connection: Connection, code: TunnelDataPlaneCloseCode): void {
    if (
      !this.#connections.has(connectionKey(connection.route, connection.id))
    ) {
      return;
    }
    this.#terminationsByReason[code] += 1;
    const route = connection.route;
    route.source.send(
      {
        ...identities(route, connection.id, connection.destinationSequence),
        kind: "close",
        code,
      },
      EMPTY_PAYLOAD,
    );
    route.destination.send(
      {
        ...identities(route, connection.id, connection.sourceSequence),
        kind: "close",
        code,
      },
      EMPTY_PAYLOAD,
    );
    this.#finish(connection);
  }

  #finish(connection: Connection): void {
    if (
      !this.#connections.delete(connectionKey(connection.route, connection.id))
    ) {
      return;
    }
    this.#closedConnections += 1;
  }

  #removeRoute(route: Route, code: TunnelDataPlaneCloseCode): void {
    if (this.#routes.get(route.key) !== route) return;
    this.#routes.delete(route.key);
    for (const connection of [...this.#connections.values()]) {
      if (connection.route === route) this.#terminate(connection, code);
    }
    for (const unsubscribe of route.unsubscribe.splice(0)) unsubscribe();
  }
}
