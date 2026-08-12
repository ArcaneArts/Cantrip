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
  type DirectBrokerAdvertisement,
  type DirectCapabilityBinding,
  type WorkerCommand,
} from "@cantrip/protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";

type PrepareCommand = Extract<
  WorkerCommand,
  { type: "direct.capability.prepare" }
>;

interface PreparedCapability {
  binding: DirectCapabilityBinding;
  secretHash: Buffer;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveSession {
  capabilityId: string;
  socket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

const INITIALIZE_TIMEOUT_MS = 5_000;
const MAX_PREPARED_CAPABILITIES = 128;

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
      maxPayload: 16_384,
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
    const expiresAt = Date.parse(command.binding.expiresAt);
    const leaseExpiresAt = Date.parse(command.binding.leaseExpiresAt);
    if (
      command.binding.workerId.length === 0 ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(leaseExpiresAt) ||
      expiresAt <= now ||
      leaseExpiresAt <= now
    ) {
      throw new Error("Direct capability has already expired.");
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
          capabilityId: capability.binding.capabilityId,
          socket,
          timer: this.#leaseTimer(capability.binding.capabilityId, leaseExpiry),
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
