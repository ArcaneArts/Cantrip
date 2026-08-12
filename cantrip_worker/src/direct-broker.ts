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
  type WorkerCommand,
} from "@cantrip/protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";

type PrepareCommand = Extract<
  WorkerCommand,
  { type: "direct.capability.prepare" }
>;

interface PreparedCapability {
  binding: DirectCapabilityBinding;
  tunnelRoute: PrepareCommand["tunnelRoute"];
  secretHash: Buffer;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveSession {
  binding: DirectCapabilityBinding;
  capabilityId: string;
  connections: Map<string, TunnelDataPlaneFrameHeader>;
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
) => void;

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
      protocol: "ws-v1",
      loopbackHost: "127.0.0.1",
      loopbackPort: address.port,
      instanceId: this.#instanceId,
      publicKey: publicKey.toString("base64url"),
      fingerprint: createHash("sha256").update(publicKey).digest("hex"),
    };
    return this.#advertisement;
  }

  prepare(command: PrepareCommand): { accepted: true; capabilityId: string } {
    const now = Date.now();
    const tunnelRoute = command.tunnelRoute ?? null;
    const expiresAt = Date.parse(command.binding.expiresAt);
    const leaseExpiresAt = Date.parse(command.binding.leaseExpiresAt);
    const tunnelResource = new Set([
      "tunnel",
      "project-share",
      "terminal",
      "code",
    ]).has(command.binding.resourceKind);
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
    const timer = setTimeout(
      () => this.revoke(command.binding.capabilityId, "Capability expired"),
      Math.max(1, expiresAt - now),
    );
    timer.unref();
    this.#prepared.set(command.binding.capabilityId, {
      binding: command.binding,
      secretHash: secretHash(command.secret),
      timer,
      tunnelRoute,
    });
    return directCapabilityPrepareResultSchema.parse({
      accepted: true,
      capabilityId: command.binding.capabilityId,
    });
  }

  renew(capabilityId: string, leaseExpiresAt: string): boolean {
    const active = this.#active.get(capabilityId);
    if (!active) return false;
    const expiry = Date.parse(leaseExpiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      this.revoke(capabilityId, "Lease expired");
      return false;
    }
    clearTimeout(active.timer);
    active.timer = this.#leaseTimer(capabilityId, expiry);
    return true;
  }

  revoke(capabilityId: string, reason: string): boolean {
    let revoked = false;
    const prepared = this.#prepared.get(capabilityId);
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
      return false;
    }
    try {
      active.socket.send(encodeTunnelDataPlaneFrame(header, payload), {
        binary: true,
      });
      if (header.kind === "close" || header.kind === "error") {
        active.connections.delete(header.connectionId);
      }
      return true;
    } catch {
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
    this.#webSockets?.close();
    this.#webSockets = null;
    const server = this.#server;
    this.#server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  #accept(socket: WebSocket): void {
    let initialized = false;
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
          binding: capability.binding,
          capabilityId: capability.binding.capabilityId,
          connections: new Map(),
          socket,
          timer: this.#leaseTimer(capability.binding.capabilityId, leaseExpiry),
          tunnelRoute: capability.tunnelRoute,
        };
        this.#active.set(capability.binding.capabilityId, active);
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
        });
        socket.on("message", (data, isBinary) => {
          if (!isBinary) {
            socket.close(1003, "Direct data frames must be binary");
            return;
          }
          this.#handleDirectFrame(active, data);
        });
      } catch {
        socket.close(1008, "Direct initialization is invalid");
      }
    });
    socket.on("error", () => {
      clearTimeout(timeout);
      if (!initialized && socket.readyState === WebSocket.OPEN) socket.close();
    });
  }

  #handleDirectFrame(active: ActiveSession, data: RawData): void {
    const route = active.tunnelRoute;
    if (!route || !active.binding.channels.includes("tunnel-data")) {
      active.socket.close(1008, "Direct tunnel channel is not authorized");
      return;
    }
    try {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? Buffer.concat(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const frame = decodeTunnelDataPlaneFrame(bytes);
      const { header } = frame;
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
        if (
          header.sequence !== 0 ||
          active.connections.has(header.connectionId)
        ) {
          throw new Error("Direct tunnel connection identity is invalid.");
        }
        routed = { ...header, kind: "connect", target: route.target };
        active.connections.set(header.connectionId, routed);
      } else {
        const previous = active.connections.get(header.connectionId);
        if (!previous || header.sequence !== previous.sequence + 1) {
          throw new Error("Direct tunnel frame sequence is invalid.");
        }
        active.connections.set(header.connectionId, header);
        if (header.kind === "close" || header.kind === "error") {
          active.connections.delete(header.connectionId);
        }
      }
      this.#handleTunnelFrame(routed, frame.payload);
    } catch {
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
          message: null,
        },
        new Uint8Array(),
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
