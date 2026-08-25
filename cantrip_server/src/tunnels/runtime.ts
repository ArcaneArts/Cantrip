import { randomBytes } from "node:crypto";

import type {
  TunnelAttachmentInitialize,
  TunnelAttachmentReady,
} from "@cantrip/protocol";
import type { AccountBandwidthChannel } from "@cantrip/protocol/resource-usage";

import type { AccountUsageRecorder } from "../account-usage/bandwidth-meter.js";
import type {
  DesktopTunnelAttachmentStopFence,
  ServerRepository,
  TunnelAttachmentAuthorization,
} from "../db/repository.js";
import { serverLogger } from "../logger.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import { TunnelStreamBroker, type TunnelRouteHandle } from "./broker.js";
import {
  DesktopTunnelEndpoint,
  type DesktopTunnelSocket,
} from "./desktop-endpoint.js";
import {
  subscribeWorkerTerminalOffline,
  WorkerTunnelEndpoint,
} from "./worker-endpoint.js";

interface ActiveAttachment {
  activatedAt: Date | null;
  activated: boolean;
  authorization: TunnelAttachmentAuthorization;
  diagnosticTraceId?: string;
  endpoint: DesktopTunnelEndpoint;
  expires: ReturnType<typeof setTimeout>;
  heartbeatTimeout: ReturnType<typeof setTimeout> | null;
  heartbeatToken: Uint8Array | null;
  route: TunnelRouteHandle;
  socket: DesktopTunnelSocket;
  unsubscribePong: () => void;
  unsubscribeWorker: () => void;
}

export interface TunnelRuntimeOptions {
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

export interface TunnelRuntimeChange {
  attachmentId: string;
  ownerId: string;
  projectId: string | null;
  tunnelId: string;
}

export class TunnelRuntimeManager {
  readonly #activationTails = new Map<string, Promise<void>>();
  readonly #active = new Map<string, ActiveAttachment>();
  readonly #broker: TunnelStreamBroker;
  readonly #heartbeatTimeoutMs: number;
  readonly #heartbeatTimer: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(
    private readonly repository: ServerRepository,
    private readonly bridge: WorkerCommandBus,
    private readonly changed: (change: TunnelRuntimeChange) => void,
    broker = new TunnelStreamBroker(),
    private readonly usageRecorder?: AccountUsageRecorder,
    options: TunnelRuntimeOptions = {},
  ) {
    this.#broker = broker;
    const heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(heartbeatIntervalMs) ||
      heartbeatIntervalMs <= 0 ||
      !Number.isSafeInteger(this.#heartbeatTimeoutMs) ||
      this.#heartbeatTimeoutMs <= 0
    ) {
      throw new Error("Tunnel heartbeat intervals must be positive integers.");
    }
    this.#heartbeatTimer = setInterval(
      () => this.#heartbeatSweep(),
      heartbeatIntervalMs,
    );
    this.#heartbeatTimer.unref();
  }

  async attach(
    socket: DesktopTunnelSocket,
    authorization: TunnelAttachmentAuthorization,
    initialize: TunnelAttachmentInitialize,
  ): Promise<TunnelAttachmentReady> {
    const startedAtMs = Date.now();
    serverLogger.debug("Tunnel attachment requested", {
      event: "tunnel.attachment.started",
      subsystem: "tunnel",
      operation: "attach",
      status: "started",
      attachmentId: authorization.attachmentId,
      projectId: authorization.projectId,
      tunnelId: authorization.tunnelId,
      workerId: authorization.destination.workerId,
      ...(initialize.diagnosticTraceId
        ? { diagnosticTraceId: initialize.diagnosticTraceId }
        : {}),
    });
    if (this.#closed) throw new Error("The tunnel runtime is shutting down.");
    if (initialize.clientId !== authorization.clientId) {
      throw new Error("Tunnel attachment client identity does not match.");
    }
    if (!this.bridge.isConnected(authorization.destination.workerId)) {
      throw new Error("The destination worker is offline.");
    }
    this.closeActive(authorization.attachmentId, "Attachment replaced");
    const usageChannel = tunnelBandwidthChannel(authorization);
    const usage = this.usageRecorder
      ? {
          channel: usageChannel,
          ownerId: authorization.ownerId,
          recorder: this.usageRecorder,
        }
      : undefined;
    const source = new DesktopTunnelEndpoint(
      socket,
      authorization.clientId,
      authorization.attachmentId,
      usage,
    );
    const destination = new WorkerTunnelEndpoint(
      this.bridge,
      authorization.destination.workerId,
      undefined,
      usage
        ? { ...usage, attachmentId: authorization.attachmentId }
        : undefined,
    );
    const route = this.#broker.registerRoute({
      attachmentId: authorization.attachmentId,
      authoritativeRootRequired: authorization.origin === "code",
      diagnosticTraceId: initialize.diagnosticTraceId,
      destination,
      destinationTarget: {
        kind: "protected-tunnel",
        targetKind:
          authorization.destination.kind === "worker-tcp"
            ? "tcp"
            : authorization.destination.adapter === "code"
              ? "code"
              : "project-share",
        recordId: authorization.tunnelId,
        protectedRecord: authorization.protectedRecord,
      },
      source,
      tunnelId: authorization.tunnelId,
      ownerId: authorization.ownerId,
      workerId: authorization.destination.workerId,
    });
    let active!: ActiveAttachment;
    const expiresIn = Math.max(
      1,
      authorization.expiresAt.getTime() - Date.now(),
    );
    const expires = setTimeout(() => {
      if (!this.#closeExact(active, "Attachment expired", 1008)) return;
      void this.#expire(active).catch(() => undefined);
    }, expiresIn);
    expires.unref();
    const unsubscribeWorker = subscribeWorkerTerminalOffline(
      this.bridge,
      authorization.destination.workerId,
      () => {
        if (this.#active.get(authorization.attachmentId) !== active) return;
        this.#retireOffline(active, "Destination worker disconnected", 1012);
      },
    );
    const pong = (data: unknown): void => this.#pong(active, data);
    active = {
      activatedAt: null,
      activated: false,
      authorization,
      diagnosticTraceId: initialize.diagnosticTraceId,
      endpoint: source,
      expires,
      heartbeatTimeout: null,
      heartbeatToken: null,
      route,
      socket,
      unsubscribePong: () => socket.off("pong", pong),
      unsubscribeWorker,
    };
    socket.on("pong", pong);
    this.#active.set(authorization.attachmentId, active);
    const disconnected = (): void => {
      this.#retireOffline(active, "Attachment disconnected", 1012);
    };
    socket.on("close", disconnected);
    socket.on("error", disconnected);
    await this.#activate(active, source);
    this.changed(this.#change(authorization));
    serverLogger.info("Tunnel attachment active", {
      event: "tunnel.attachment.active",
      subsystem: "tunnel",
      operation: "attach",
      status: "completed",
      attachmentId: authorization.attachmentId,
      projectId: authorization.projectId,
      tunnelId: authorization.tunnelId,
      workerId: authorization.destination.workerId,
      ...(initialize.diagnosticTraceId
        ? { diagnosticTraceId: initialize.diagnosticTraceId }
        : {}),
      durationMs: Date.now() - startedAtMs,
    });
    return {
      type: "ready",
      attachmentId: authorization.attachmentId,
      tunnelId: authorization.tunnelId,
      sourceEndpointId: source.endpointId,
      destinationEndpointId: destination.endpointId,
      expiresAt: authorization.expiresAt.toISOString(),
    };
  }

  closeActive(attachmentId: string, reason: string, code = 1012): void {
    const active = this.#active.get(attachmentId);
    if (!active) return;
    this.#closeExact(active, reason, code);
  }

  #closeExact(active: ActiveAttachment, reason: string, code: number): boolean {
    const attachmentId = active.authorization.attachmentId;
    if (this.#active.get(attachmentId) !== active) return false;
    this.#active.delete(attachmentId);
    clearTimeout(active.expires);
    this.#clearHeartbeat(active);
    active.unsubscribePong();
    active.unsubscribeWorker();
    active.route.close();
    active.endpoint.close(code, reason);
    serverLogger.info("Tunnel attachment closed", {
      event: "tunnel.attachment.closed",
      subsystem: "tunnel",
      operation: "close",
      status: "completed",
      reasonCode: tunnelCloseReasonCode(reason),
      attachmentId,
      projectId: active.authorization.projectId,
      tunnelId: active.authorization.tunnelId,
      workerId: active.authorization.destination.workerId,
      ...(active.diagnosticTraceId
        ? { diagnosticTraceId: active.diagnosticTraceId }
        : {}),
    });
    return true;
  }

  closeTunnel(tunnelId: string, reason: string, code = 1012): number {
    const attachmentIds = [...this.#active.values()]
      .filter((active) => active.authorization.tunnelId === tunnelId)
      .map((active) => active.authorization.attachmentId);
    for (const attachmentId of attachmentIds) {
      this.closeActive(attachmentId, reason, code);
    }
    return attachmentIds.length;
  }

  async revoke(
    ownerId: string,
    attachmentId: string,
    options: {
      expected?: DesktopTunnelAttachmentStopFence;
      preserveTunnelState?: boolean;
    } = {},
  ): Promise<boolean> {
    const stopped = await this.repository.stopDesktopTunnelAttachment(
      ownerId,
      attachmentId,
      null,
      options.preserveTunnelState ?? false,
      options.expected,
    );
    if (!stopped) return false;
    this.closeActive(attachmentId, "Attachment revoked", 1008);
    this.#broker.revokeAttachment(attachmentId);
    this.changed({ attachmentId, ownerId, ...stopped });
    return true;
  }

  stats() {
    return this.#broker.stats();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeatTimer);
    const activeCount = this.#active.size;
    const aggregate = this.#broker.stats();
    for (const attachmentId of [...this.#active.keys()]) {
      this.closeActive(attachmentId, "Server is shutting down", 1012);
    }
    this.#broker.close();
    serverLogger.info("Tunnel runtime stopped", {
      event: "tunnel.runtime.stopped",
      subsystem: "tunnel",
      operation: "shutdown",
      status: "completed",
      counts: {
        activeAttachments: activeCount,
        openedConnections: aggregate.openedConnections,
        closedConnections: aggregate.closedConnections,
        rejectedConnections: aggregate.rejectedConnections,
      },
      bytesFromSource: aggregate.bytesFromSource,
      bytesToSource: aggregate.bytesToSource,
    });
  }

  #change(authorization: TunnelAttachmentAuthorization): TunnelRuntimeChange {
    return {
      attachmentId: authorization.attachmentId,
      ownerId: authorization.ownerId,
      projectId: authorization.projectId,
      tunnelId: authorization.tunnelId,
    };
  }

  async #activate(
    active: ActiveAttachment,
    source: DesktopTunnelEndpoint,
  ): Promise<void> {
    const authorization = active.authorization;
    const release = await this.#acquireActivation(authorization.attachmentId);
    try {
      const before = this.#active.get(authorization.attachmentId);
      if (before !== active || active.socket.readyState !== 1) {
        this.#closeExact(
          active,
          "Attachment disconnected while activating",
          1012,
        );
        throw new Error(
          before && before !== active
            ? "Tunnel attachment was replaced while activating."
            : "Tunnel attachment disconnected while activating.",
        );
      }
      let activatedAt: Date | null;
      try {
        activatedAt = await this.repository.activateDesktopTunnelAttachment(
          authorization.attachmentId,
          authorization.clientId,
          authorization.secretExpiresAt,
        );
      } catch (error) {
        this.#closeExact(active, "Could not activate attachment", 1011);
        throw error;
      }
      if (!activatedAt) {
        this.#closeExact(active, "Attachment is stale", 1008);
        throw new Error("Tunnel attachment is stale or expired.");
      }
      active.activatedAt = activatedAt;
      const current = this.#active.get(authorization.attachmentId);
      if (current !== active || active.socket.readyState !== 1) {
        this.#closeExact(
          active,
          "Attachment disconnected while activating",
          1012,
        );
        if (!current || current === active) await this.#markOffline(active);
        throw new Error(
          current && current !== active
            ? "Tunnel attachment was replaced while activating."
            : "Tunnel attachment disconnected while activating.",
        );
      }
      if (!source.activate()) {
        this.#closeExact(
          active,
          "Attachment disconnected while activating",
          1012,
        );
        await this.#markOffline(active);
        throw new Error("Tunnel attachment disconnected while activating.");
      }
      active.activated = true;
    } finally {
      release();
    }
  }

  async #expire(active: ActiveAttachment): Promise<void> {
    const authorization = active.authorization;
    // If expiry fires while activation is in flight, wait for that exact DB
    // incarnation to settle before constructing the automatic-stop fence.
    const release = await this.#acquireActivation(authorization.attachmentId);
    try {
      const stopped = await this.repository.stopDesktopTunnelAttachment(
        authorization.ownerId,
        authorization.attachmentId,
        "attachment-expired",
        false,
        {
          activatedAt: active.activatedAt,
          expiresAt: authorization.expiresAt,
          secretExpiresAt: authorization.secretExpiresAt,
        },
      );
      if (stopped) this.changed(this.#change(authorization));
    } finally {
      release();
    }
  }

  async #acquireActivation(attachmentId: string): Promise<() => void> {
    const previous = this.#activationTails.get(attachmentId);
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => current);
    this.#activationTails.set(attachmentId, tail);
    if (previous) await previous.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.#activationTails.get(attachmentId) === tail) {
        this.#activationTails.delete(attachmentId);
      }
    };
  }

  #heartbeatSweep(): void {
    for (const active of this.#active.values()) {
      if (!active.activated || active.heartbeatToken) continue;
      if (active.socket.readyState !== 1) {
        this.#retireOffline(active, "Attachment disconnected", 1012);
        continue;
      }
      const token = randomBytes(16);
      active.heartbeatToken = token;
      try {
        active.socket.ping(token);
      } catch {
        active.heartbeatToken = null;
        this.#retireOffline(active, "Attachment heartbeat failed", 1012);
        continue;
      }
      if (active.heartbeatToken !== token) continue;
      const timeout = setTimeout(() => {
        if (
          this.#active.get(active.authorization.attachmentId) !== active ||
          active.heartbeatToken !== token ||
          active.heartbeatTimeout !== timeout
        ) {
          return;
        }
        active.heartbeatTimeout = null;
        active.heartbeatToken = null;
        this.#retireOffline(active, "Attachment heartbeat timed out", 1012);
      }, this.#heartbeatTimeoutMs);
      timeout.unref();
      active.heartbeatTimeout = timeout;
    }
  }

  #pong(active: ActiveAttachment, data: unknown): void {
    const token = active.heartbeatToken;
    if (
      this.#active.get(active.authorization.attachmentId) !== active ||
      !token ||
      !equalBytes(token, data)
    ) {
      return;
    }
    this.#clearHeartbeat(active);
    if (
      !this.#broker.recordRouteActivity(
        active.authorization.tunnelId,
        active.authorization.attachmentId,
        active.authorization.origin === "code",
      )
    ) {
      this.#retireOffline(active, "Attachment authority expired", 1008);
    }
  }

  #clearHeartbeat(active: ActiveAttachment): void {
    if (active.heartbeatTimeout) clearTimeout(active.heartbeatTimeout);
    active.heartbeatTimeout = null;
    active.heartbeatToken = null;
  }

  #retireOffline(active: ActiveAttachment, reason: string, code: number): void {
    if (!this.#closeExact(active, reason, code)) return;
    void this.#markOffline(active).catch(() => undefined);
  }

  async #markOffline(active: ActiveAttachment): Promise<void> {
    if (!active.activatedAt) return;
    const authorization = active.authorization;
    const updated = await this.repository.markDesktopTunnelAttachmentOffline(
      authorization.attachmentId,
      authorization.secretExpiresAt,
      active.activatedAt,
    );
    if (updated) this.changed(this.#change(authorization));
  }
}

export function tunnelBandwidthChannel(
  authorization: TunnelAttachmentAuthorization,
): AccountBandwidthChannel {
  if (
    authorization.destination.kind === "worker-adapter" &&
    authorization.destination.adapter === "code"
  ) {
    return "code-relay";
  }
  if (
    authorization.destination.kind === "worker-adapter" &&
    authorization.destination.adapter === "project-share"
  ) {
    return "project-share-relay";
  }
  return "tunnel-relay";
}

function tunnelCloseReasonCode(reason: string): string {
  if (reason.includes("heartbeat timed out")) return "heartbeat_timeout";
  if (reason.includes("heartbeat failed")) return "heartbeat_failed";
  if (reason.includes("authority expired")) return "authority_expired";
  if (reason.includes("expired")) return "expired";
  if (reason.includes("replaced")) return "replaced";
  if (reason.includes("disconnected")) return "worker_disconnected";
  if (reason.includes("revoked")) return "revoked";
  if (reason.includes("shutting down")) return "server_shutdown";
  if (reason.includes("stale")) return "stale";
  if (reason.includes("activate")) return "activation_failed";
  return "closed";
}

function equalBytes(left: Uint8Array, right: unknown): boolean {
  if (!(right instanceof Uint8Array)) return false;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
