import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";

import {
  directBrokerInitializeSchema,
  directBrokerReadySchema,
  directCapabilityPrepareResultSchema,
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  type DirectBrokerAdvertisement,
  type DirectCapabilityBinding,
  type TunnelDataPlaneFrameHeader,
  type TunnelDataPlaneTarget,
  type WorkerCommand,
} from "@cantrip/protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { workerLogErrorIdentity, workerLogger } from "./logger.js";

type PrepareCommand = Extract<
  WorkerCommand,
  { type: "direct.capability.prepare" }
>;

interface PreparedCapability {
  binding: DirectCapabilityBinding;
  diagnosticTraceId?: string;
  tunnelRoute: PrepareCommand["tunnelRoute"];
  secretHash: Buffer;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveSession {
  acceptanceDiagnosticEmitted: boolean;
  binding: DirectCapabilityBinding;
  connections: Map<string, TunnelDataPlaneFrameHeader>;
  diagnosticTraceId?: string;
  socket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
  tunnelRoute: NonNullable<PrepareCommand["tunnelRoute"]> | null;
}

const INITIALIZE_TIMEOUT_MS = 5_000;
const MAX_PREPARED_CAPABILITIES = 128;
const MAX_BUFFERED_TUNNEL_BYTES = 8 * 1_024 * 1_024;
const TUNNEL_LOW_WATER_BYTES = 256 * 1_024;

type TunnelFrameHandler = (
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
  context: { diagnosticTraceId?: string },
) => void;
type TunnelTargetResolver = (
  binding: DirectCapabilityBinding,
  target: TunnelDataPlaneTarget,
) => Promise<TunnelDataPlaneTarget>;
type CapabilityRevoker = (capabilityId: string, reason: string) => void;

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
    "utf8",
  );
}

function secretHash(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function signaturePayload(capabilityId: string, challenge: string): Buffer {
  return Buffer.from(
    `cantrip-direct-v1\0${capabilityId}\0${challenge}`,
    "utf8",
  );
}

export class DirectBroker {
  readonly #instanceId = randomUUID();
  readonly #keyPair = generateKeyPairSync("ed25519");
  readonly #prepared = new Map<string, PreparedCapability>();
  readonly #active = new Map<string, ActiveSession>();
  #server: HttpServer | null = null;
  #webSockets: WebSocketServer | null = null;
  #advertisement: DirectBrokerAdvertisement = { available: false };
  #handleTunnelFrame: TunnelFrameHandler = () => undefined;
  #resolveTunnelTarget: TunnelTargetResolver = async (_binding, target) =>
    target;
  #revokeCapability: CapabilityRevoker = () => undefined;

  get advertisement(): DirectBrokerAdvertisement {
    return this.#advertisement;
  }

  async start(): Promise<DirectBrokerAdvertisement> {
    if (this.#server) return this.#advertisement;
    const publicKeyDer = this.#keyPair.publicKey.export({
      format: "der",
      type: "spki",
    });
    const publicKey = publicKeyDer.subarray(publicKeyDer.length - 32);
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: 80 * 1_024,
    });
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/direct/v1") {
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (client) => {
        webSockets.emit("connection", client, request);
      });
    });
    webSockets.on("connection", (socket) => this.#accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Direct broker did not bind a loopback TCP port.");
    }
    this.#server = server;
    this.#webSockets = webSockets;
    this.#advertisement = {
      available: true,
      leaseRenewal: true,
      protocol: "ws-v1",
      loopbackHost: "127.0.0.1",
      loopbackPort: address.port,
      instanceId: this.#instanceId,
      publicKey: publicKey.toString("base64url"),
      fingerprint: createHash("sha256").update(publicKey).digest("hex"),
    };
    workerLogger.event("info", "Direct capability broker started", {
      event: "direct.broker.started",
      subsystem: "direct-broker",
      operation: "start",
      status: "completed",
      protocol: "ws-v1",
    });
    return this.#advertisement;
  }

  async prepare(
    command: PrepareCommand,
  ): Promise<{ accepted: true; capabilityId: string }> {
    const now = Date.now();
    let tunnelRoute = command.tunnelRoute ?? null;
    const expiresAt = Date.parse(command.binding.expiresAt);
    const leaseExpiresAt = Date.parse(command.binding.leaseExpiresAt);
    const tunnelResource = new Set(["tunnel", "project-share", "terminal"]).has(
      command.binding.resourceKind,
    );
    if (
      command.binding.workerId.length === 0 ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(leaseExpiresAt) ||
      expiresAt <= now ||
      leaseExpiresAt <= now
    ) {
      throw new Error("Direct capability has already expired.");
    }
    if (
      tunnelResource !== (tunnelRoute !== null) ||
      (tunnelRoute !== null &&
        (tunnelRoute.attachmentId !== command.binding.attachmentId ||
          !command.binding.channels.includes("tunnel-data")))
    ) {
      throw new Error("Direct tunnel route does not match its capability.");
    }
    if (this.#prepared.size >= MAX_PREPARED_CAPABILITIES) {
      throw new Error("Direct capability queue is full.");
    }
    this.revoke(command.binding.capabilityId, "Capability rotated");
    if (tunnelRoute) {
      tunnelRoute = {
        ...tunnelRoute,
        target: await this.#resolveTunnelTarget(
          command.binding,
          tunnelRoute.target,
        ),
      };
    }
    const timer = setTimeout(
      () => this.revoke(command.binding.capabilityId, "Capability expired"),
      Math.max(1, expiresAt - now),
    );
    timer.unref();
    this.#prepared.set(command.binding.capabilityId, {
      binding: command.binding,
      diagnosticTraceId: command.diagnosticTraceId,
      secretHash: secretHash(command.secret),
      timer,
      tunnelRoute,
    });
    workerLogger.event("debug", "Direct capability prepared", {
      event: "direct.capability.prepared",
      subsystem: "direct-broker",
      operation: "prepare",
      status: "completed",
      resourceKind: command.binding.resourceKind,
      attachmentId: command.binding.attachmentId,
      ...(command.diagnosticTraceId
        ? { diagnosticTraceId: command.diagnosticTraceId }
        : {}),
      tunnelRouted: tunnelRoute !== null,
      counts: { prepared: this.#prepared.size, active: this.#active.size },
    });
    return directCapabilityPrepareResultSchema.parse({
      accepted: true,
      capabilityId: command.binding.capabilityId,
    });
  }

  renew(capabilityId: string, leaseExpiresAt: string): string | null {
    const active = this.#active.get(capabilityId);
    if (!active) return null;
    const now = Date.now();
    const currentExpiry = Date.parse(active.binding.leaseExpiresAt);
    const requestedExpiry = Date.parse(leaseExpiresAt);
    if (
      !Number.isFinite(currentExpiry) ||
      !Number.isFinite(requestedExpiry) ||
      currentExpiry <= now ||
      requestedExpiry <= now
    ) {
      this.revoke(capabilityId, "Lease expired");
      return null;
    }
    if (requestedExpiry <= currentExpiry) {
      return active.binding.leaseExpiresAt;
    }
    const acceptedLeaseExpiresAt = new Date(requestedExpiry).toISOString();
    active.binding = {
      ...active.binding,
      leaseExpiresAt: acceptedLeaseExpiresAt,
    };
    clearTimeout(active.timer);
    active.timer = this.#leaseTimer(capabilityId, requestedExpiry);
    workerLogger.event("debug", "Direct capability lease renewed", {
      event: "direct.capability.renewed",
      subsystem: "direct-broker",
      operation: "renew",
      status: "completed",
      resourceKind: active.binding.resourceKind,
      attachmentId: active.binding.attachmentId,
      ...(active.diagnosticTraceId
        ? { diagnosticTraceId: active.diagnosticTraceId }
        : {}),
      leaseDurationMs: requestedExpiry - now,
      counts: { prepared: this.#prepared.size, active: this.#active.size },
    });
    return acceptedLeaseExpiresAt;
  }

  revoke(capabilityId: string, reason: string): boolean {
    let revoked = false;
    const prepared = this.#prepared.get(capabilityId);
    const diagnosticTraceId =
      prepared?.diagnosticTraceId ??
      this.#active.get(capabilityId)?.diagnosticTraceId;
    if (prepared) {
      clearTimeout(prepared.timer);
      prepared.secretHash.fill(0);
      this.#prepared.delete(capabilityId);
      revoked = true;
    }
    const active = this.#active.get(capabilityId);
    if (active) {
      clearTimeout(active.timer);
      this.#active.delete(capabilityId);
      this.#closeTunnelConnections(active);
      active.socket.close(1008, reason.slice(0, 123));
      revoked = true;
    }
    if (revoked) this.#revokeCapability(capabilityId, reason);
    if (revoked) {
      workerLogger.event("debug", "Direct capability revoked", {
        event: "direct.capability.revoked",
        subsystem: "direct-broker",
        operation: "revoke",
        status: "completed",
        reasonCode: "capability-revoked",
        ...(diagnosticTraceId ? { diagnosticTraceId } : {}),
        counts: { prepared: this.#prepared.size, active: this.#active.size },
      });
    }
    return revoked;
  }

  revokeAll(reason = "Server control connection closed"): void {
    for (const capabilityId of [
      ...this.#prepared.keys(),
      ...this.#active.keys(),
    ]) {
      this.revoke(capabilityId, reason);
    }
  }

  setTunnelFrameHandler(handler: TunnelFrameHandler): void {
    this.#handleTunnelFrame = handler;
  }

  setTunnelTargetResolver(resolver: TunnelTargetResolver): void {
    this.#resolveTunnelTarget = resolver;
  }

  setCapabilityRevoker(revoker: CapabilityRevoker): void {
    this.#revokeCapability = revoker;
  }

  routeTunnelFrame(
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): boolean | null {
    const active = [...this.#active.values()].find(
      (session) =>
        session.tunnelRoute?.attachmentId === header.attachmentId &&
        session.tunnelRoute.tunnelId === header.tunnelId &&
        session.tunnelRoute.sourceEndpointId === header.sourceEndpointId &&
        session.tunnelRoute.destinationEndpointId ===
          header.destinationEndpointId &&
        session.connections.has(header.connectionId),
    );
    if (!active) return null;
    if (
      active.socket.readyState !== WebSocket.OPEN ||
      active.socket.bufferedAmount > MAX_BUFFERED_TUNNEL_BYTES
    ) {
      workerLogger.event("warn", "Direct tunnel response was not routed", {
        event: "direct.frame.return-failed",
        subsystem: "direct-broker",
        operation: "route-frame",
        reasonCode:
          active.socket.readyState !== WebSocket.OPEN
            ? "socket-unavailable"
            : "socket-congested",
        status: "failed",
        mode: header.kind,
        resourceKind: active.binding.resourceKind,
        tunnelId: header.tunnelId,
        attachmentId: header.attachmentId,
        connectionId: header.connectionId,
        ...(active.diagnosticTraceId
          ? { diagnosticTraceId: active.diagnosticTraceId }
          : {}),
      });
      return false;
    }
    try {
      active.socket.send(encodeTunnelDataPlaneFrame(header, payload), {
        binary: true,
      });
      if (header.kind === "accepted" && !active.acceptanceDiagnosticEmitted) {
        active.acceptanceDiagnosticEmitted = true;
        workerLogger.event("info", "Direct tunnel connection accepted", {
          event: "direct.connection.accepted",
          subsystem: "direct-broker",
          operation: "open-connection",
          status: "completed",
          resourceKind: active.binding.resourceKind,
          tunnelId: header.tunnelId,
          attachmentId: header.attachmentId,
          connectionId: header.connectionId,
          ...(active.diagnosticTraceId
            ? { diagnosticTraceId: active.diagnosticTraceId }
            : {}),
        });
      }
      // Keep the source-side sequence state until the desktop acknowledges the
      // destination close. The desktop tunnel forwarder always sends its own
      // terminal close after receiving a destination close/error. Deleting the
      // entry here made that valid acknowledgement look like an unknown
      // connection and closed the entire direct capability, including every
      // unrelated workbench HTTP and WebSocket stream sharing it.
      return true;
    } catch (error) {
      workerLogger.event("warn", "Direct tunnel response was not routed", {
        event: "direct.frame.return-failed",
        subsystem: "direct-broker",
        operation: "route-frame",
        reasonCode: "response-forward-failed",
        status: "failed",
        mode: header.kind,
        resourceKind: active.binding.resourceKind,
        tunnelId: header.tunnelId,
        attachmentId: header.attachmentId,
        connectionId: header.connectionId,
        ...(active.diagnosticTraceId
          ? { diagnosticTraceId: active.diagnosticTraceId }
          : {}),
        ...workerLogErrorIdentity(error),
      });
      return false;
    }
  }

  async waitForTunnelCapacity(attachmentId: string): Promise<boolean | null> {
    const active = [...this.#active.values()].find(
      (session) => session.tunnelRoute?.attachmentId === attachmentId,
    );
    if (!active) return null;
    while (active.socket.readyState === WebSocket.OPEN) {
      if (active.socket.bufferedAmount <= TUNNEL_LOW_WATER_BYTES) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    return false;
  }

  async close(): Promise<void> {
    this.revokeAll("Worker stopping");
    this.#advertisement = { available: false };
    for (const socket of this.#webSockets?.clients ?? []) socket.terminate();
    this.#webSockets?.close();
    this.#webSockets = null;
    const server = this.#server;
    this.#server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    workerLogger.event("info", "Direct capability broker stopped", {
      event: "direct.broker.stopped",
      subsystem: "direct-broker",
      operation: "stop",
      status: "completed",
    });
  }

  #accept(socket: WebSocket): void {
    let initialized = false;
    let diagnosticTraceId: string | undefined;
    const timeout = setTimeout(
      () => socket.close(1008, "Direct initialization timed out"),
      INITIALIZE_TIMEOUT_MS,
    );
    timeout.unref();
    socket.once("message", (data, isBinary) => {
      clearTimeout(timeout);
      if (isBinary) {
        socket.close(1008, "Direct initialization must be JSON");
        return;
      }
      try {
        const initialize = directBrokerInitializeSchema.parse(
          JSON.parse(rawText(data)),
        );
        const capability = this.#prepared.get(initialize.binding.capabilityId);
        diagnosticTraceId = capability?.diagnosticTraceId;
        const candidateHash = secretHash(initialize.secret);
        if (
          !capability ||
          JSON.stringify(capability.binding) !==
            JSON.stringify(initialize.binding) ||
          candidateHash.length !== capability.secretHash.length ||
          !timingSafeEqual(candidateHash, capability.secretHash) ||
          Date.parse(capability.binding.expiresAt) <= Date.now() ||
          Date.parse(capability.binding.leaseExpiresAt) <= Date.now()
        ) {
          candidateHash.fill(0);
          socket.close(1008, "Direct capability authentication failed");
          return;
        }
        candidateHash.fill(0);
        clearTimeout(capability.timer);
        capability.secretHash.fill(0);
        this.#prepared.delete(initialize.binding.capabilityId);
        initialized = true;
        const leaseExpiry = Date.parse(capability.binding.leaseExpiresAt);
        const active: ActiveSession = {
          acceptanceDiagnosticEmitted: false,
          binding: capability.binding,
          connections: new Map(),
          diagnosticTraceId: capability.diagnosticTraceId,
          socket,
          timer: this.#leaseTimer(capability.binding.capabilityId, leaseExpiry),
          tunnelRoute: capability.tunnelRoute,
        };
        this.#active.set(capability.binding.capabilityId, active);
        workerLogger.event("info", "Direct capability connected", {
          event: "direct.capability.connected",
          subsystem: "direct-broker",
          operation: "connect",
          status: "completed",
          resourceKind: capability.binding.resourceKind,
          attachmentId: capability.binding.attachmentId,
          ...(capability.diagnosticTraceId
            ? { diagnosticTraceId: capability.diagnosticTraceId }
            : {}),
          counts: { active: this.#active.size },
        });
        socket.send(
          JSON.stringify(
            directBrokerReadySchema.parse({
              type: "ready",
              directSessionId: randomUUID(),
              brokerInstanceId: this.#instanceId,
              fingerprint: this.#advertisement.available
                ? this.#advertisement.fingerprint
                : "",
              challenge: initialize.challenge,
              signature: sign(
                null,
                signaturePayload(
                  capability.binding.capabilityId,
                  initialize.challenge,
                ),
                this.#keyPair.privateKey,
              ).toString("base64url"),
              leaseExpiresAt: capability.binding.leaseExpiresAt,
            }),
          ),
        );
        socket.once("close", () => {
          const current = this.#active.get(capability.binding.capabilityId);
          if (current?.socket !== socket) return;
          clearTimeout(current.timer);
          this.#active.delete(capability.binding.capabilityId);
          this.#closeTunnelConnections(current);
          this.#revokeCapability(
            capability.binding.capabilityId,
            "Direct connection closed",
          );
        });
        socket.once("close", (code) => {
          workerLogger.event("info", "Direct capability connection closed", {
            event: "direct.capability.disconnected",
            subsystem: "direct-broker",
            operation: "connect",
            status: "completed",
            code,
            resourceKind: capability.binding.resourceKind,
            ...(capability.diagnosticTraceId
              ? { diagnosticTraceId: capability.diagnosticTraceId }
              : {}),
          });
        });
        socket.on("message", (data, isBinary) => {
          if (!isBinary) {
            socket.close(1003, "Direct data frames must be binary");
            return;
          }
          this.#handleDirectFrame(active, data);
        });
      } catch (error) {
        workerLogger.rateLimited(
          "direct-capability-initialization-rejected",
          "warn",
          "Direct capability initialization rejected",
          {
            event: "direct.capability.rejected",
            subsystem: "direct-broker",
            operation: "connect",
            reasonCode: "invalid-initialization",
            status: "rejected",
            ...(diagnosticTraceId ? { diagnosticTraceId } : {}),
            ...workerLogErrorIdentity(error),
          },
        );
        socket.close(1008, "Direct initialization is invalid");
      }
    });
    socket.on("error", () => {
      clearTimeout(timeout);
      if (!initialized && socket.readyState === WebSocket.OPEN) socket.close();
    });
  }

  #handleDirectFrame(active: ActiveSession, data: RawData): void {
    if (this.#active.get(active.binding.capabilityId) !== active) {
      workerLogger.rateLimited(
        `direct-frame-discarded:retired-capability:${active.binding.resourceKind}`,
        "debug",
        "Direct tunnel frame discarded after capability retirement",
        {
          event: "direct.frame.discarded",
          subsystem: "direct-broker",
          operation: "route-frame",
          reasonCode: "retired-capability",
          status: "discarded",
          resourceKind: active.binding.resourceKind,
          ...(active.tunnelRoute
            ? {
                tunnelId: active.tunnelRoute.tunnelId,
                attachmentId: active.tunnelRoute.attachmentId,
              }
            : {}),
          ...(active.diagnosticTraceId
            ? { diagnosticTraceId: active.diagnosticTraceId }
            : {}),
        },
      );
      return;
    }
    const route = active.tunnelRoute;
    if (!route || !active.binding.channels.includes("tunnel-data")) {
      workerLogger.rateLimited(
        `direct-frame-rejected:unauthorized-channel:${active.binding.resourceKind}`,
        "warn",
        "Direct tunnel frame rejected",
        {
          event: "direct.frame.rejected",
          subsystem: "direct-broker",
          operation: "route-frame",
          reasonCode: "unauthorized-channel",
          status: "rejected",
          resourceKind: active.binding.resourceKind,
          ...(route
            ? {
                tunnelId: route.tunnelId,
                attachmentId: route.attachmentId,
              }
            : {}),
          ...(active.diagnosticTraceId
            ? { diagnosticTraceId: active.diagnosticTraceId }
            : {}),
        },
      );
      active.socket.close(1008, "Direct tunnel channel is not authorized");
      return;
    }
    let reasonCode = "malformed-frame";
    let observedHeader: TunnelDataPlaneFrameHeader | null = null;
    try {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? Buffer.concat(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const frame = decodeTunnelDataPlaneFrame(bytes);
      const { header } = frame;
      observedHeader = header;
      reasonCode = "capability-binding-mismatch";
      if (
        header.tunnelId !== route.tunnelId ||
        header.attachmentId !== route.attachmentId ||
        header.sourceEndpointId !== route.sourceEndpointId ||
        header.destinationEndpointId !== route.destinationEndpointId ||
        header.kind === "connect"
      ) {
        throw new Error("Direct tunnel frame escaped its capability binding.");
      }
      let routed: TunnelDataPlaneFrameHeader = header;
      if (header.kind === "open") {
        reasonCode = "invalid-connection-identity";
        if (
          header.sequence !== 0 ||
          active.connections.has(header.connectionId)
        ) {
          throw new Error("Direct tunnel connection identity is invalid.");
        }
        routed = { ...header, kind: "connect", target: route.target };
        active.connections.set(header.connectionId, routed);
      } else {
        reasonCode = "invalid-frame-sequence";
        const previous = active.connections.get(header.connectionId);
        if (!previous || header.sequence !== previous.sequence + 1) {
          throw new Error(
            `Direct tunnel frame sequence is invalid (connection=${header.connectionId}, kind=${header.kind}, actual=${header.sequence}, previous=${previous?.sequence ?? "missing"}, previousKind=${previous?.kind ?? "missing"}).`,
          );
        }
        active.connections.set(header.connectionId, header);
        if (header.kind === "close" || header.kind === "error") {
          active.connections.delete(header.connectionId);
        }
      }
      this.#handleTunnelFrame(routed, frame.payload, {
        diagnosticTraceId: active.diagnosticTraceId,
      });
    } catch (error) {
      workerLogger.rateLimited(
        `direct-frame-rejected:${route.tunnelId}:${reasonCode}`,
        "warn",
        "Direct tunnel frame rejected",
        {
          event: "direct.frame.rejected",
          subsystem: "direct-broker",
          operation: "route-frame",
          reasonCode,
          status: "rejected",
          ...workerLogErrorIdentity(error),
          resourceKind: active.binding.resourceKind,
          tunnelId: route.tunnelId,
          attachmentId: route.attachmentId,
          ...(observedHeader
            ? { connectionId: observedHeader.connectionId }
            : {}),
          ...(active.diagnosticTraceId
            ? { diagnosticTraceId: active.diagnosticTraceId }
            : {}),
        },
      );
      active.socket.close(1003, "Invalid direct tunnel frame");
    }
  }

  #closeTunnelConnections(active: ActiveSession): void {
    for (const header of active.connections.values()) {
      this.#handleTunnelFrame(
        {
          protocolVersion: 1,
          tunnelId: header.tunnelId,
          attachmentId: header.attachmentId,
          sourceEndpointId: header.sourceEndpointId,
          destinationEndpointId: header.destinationEndpointId,
          connectionId: header.connectionId,
          sequence: header.sequence + 1,
          kind: "close",
          code: "endpoint-disconnected",
        },
        new Uint8Array(),
        { diagnosticTraceId: active.diagnosticTraceId },
      );
    }
    active.connections.clear();
  }

  #leaseTimer(
    capabilityId: string,
    expiry: number,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(
      () => this.revoke(capabilityId, "Direct lease expired"),
      Math.max(1, expiry - Date.now()),
    );
    timer.unref();
    return timer;
  }
}
