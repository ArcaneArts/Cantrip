import type {
  TunnelAttachmentInitialize,
  TunnelAttachmentReady,
} from "@cantrip/protocol";

import type {
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
import { WorkerTunnelEndpoint } from "./worker-endpoint.js";

interface ActiveAttachment {
  authorization: TunnelAttachmentAuthorization;
  endpoint: DesktopTunnelEndpoint;
  expires: ReturnType<typeof setTimeout>;
  route: TunnelRouteHandle;
  unsubscribeWorker: () => void;
}

export interface TunnelRuntimeChange {
  attachmentId: string;
  ownerId: string;
  projectId: string | null;
  tunnelId: string;
}

export class TunnelRuntimeManager {
  readonly #active = new Map<string, ActiveAttachment>();
  readonly #broker: TunnelStreamBroker;
  #closed = false;

  constructor(
    private readonly repository: ServerRepository,
    private readonly bridge: WorkerCommandBus,
    private readonly changed: (change: TunnelRuntimeChange) => void,
    broker = new TunnelStreamBroker(),
  ) {
    this.#broker = broker;
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
    });
    if (this.#closed) throw new Error("The tunnel runtime is shutting down.");
    if (initialize.clientId !== authorization.clientId) {
      throw new Error("Tunnel attachment client identity does not match.");
    }
    if (!this.bridge.isConnected(authorization.destination.workerId)) {
      throw new Error("The destination worker is offline.");
    }
    this.closeActive(authorization.attachmentId, "Attachment replaced");
    const source = new DesktopTunnelEndpoint(
      socket,
      authorization.clientId,
      authorization.attachmentId,
    );
    const destination = new WorkerTunnelEndpoint(
      this.bridge,
      authorization.destination.workerId,
    );
    const route = this.#broker.registerRoute({
      attachmentId: authorization.attachmentId,
      destination,
      destinationTarget: {
        kind: "tcp",
        host: authorization.destination.host,
        port: authorization.destination.port,
      },
      source,
      tunnelId: authorization.tunnelId,
      ownerId: authorization.ownerId,
      workerId: authorization.destination.workerId,
    });
    const expiresIn = Math.max(
      1,
      authorization.expiresAt.getTime() - Date.now(),
    );
    const expires = setTimeout(() => {
      this.closeActive(authorization.attachmentId, "Attachment expired", 1008);
      void this.repository
        .stopDesktopTunnelAttachment(
          authorization.ownerId,
          authorization.attachmentId,
          "Tunnel attachment expired.",
        )
        .then(() => this.changed(this.#change(authorization)))
        .catch(() => undefined);
    }, expiresIn);
    expires.unref();
    const unsubscribeWorker = this.bridge.subscribeWorkerDisconnect(
      authorization.destination.workerId,
      () => {
        if (!this.#active.has(authorization.attachmentId)) return;
        this.closeActive(
          authorization.attachmentId,
          "Destination worker disconnected",
          1012,
        );
        void this.repository
          .markDesktopTunnelAttachmentOffline(authorization.attachmentId)
          .then(() => this.changed(this.#change(authorization)))
          .catch(() => undefined);
      },
    );
    const active = {
      authorization,
      endpoint: source,
      expires,
      route,
      unsubscribeWorker,
    };
    this.#active.set(authorization.attachmentId, active);
    socket.on("close", () => {
      if (this.#active.get(authorization.attachmentId) !== active) return;
      this.#active.delete(authorization.attachmentId);
      clearTimeout(expires);
      unsubscribeWorker();
      route.close();
      void this.repository
        .markDesktopTunnelAttachmentOffline(authorization.attachmentId)
        .then(() => this.changed(this.#change(authorization)))
        .catch(() => undefined);
    });
    let activated: boolean;
    try {
      activated = await this.repository.activateDesktopTunnelAttachment(
        authorization.attachmentId,
        authorization.clientId,
        initialize.localPort,
      );
    } catch (error) {
      this.closeActive(
        authorization.attachmentId,
        "Could not activate attachment",
        1011,
      );
      throw error;
    }
    if (!activated) {
      this.closeActive(authorization.attachmentId, "Attachment is stale", 1008);
      throw new Error("Tunnel attachment is stale or expired.");
    }
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
    this.#active.delete(attachmentId);
    clearTimeout(active.expires);
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
    });
  }

  async revoke(ownerId: string, attachmentId: string): Promise<boolean> {
    const stopped = await this.repository.stopDesktopTunnelAttachment(
      ownerId,
      attachmentId,
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
}

function tunnelCloseReasonCode(reason: string): string {
  if (reason.includes("expired")) return "expired";
  if (reason.includes("replaced")) return "replaced";
  if (reason.includes("disconnected")) return "worker_disconnected";
  if (reason.includes("revoked")) return "revoked";
  if (reason.includes("shutting down")) return "server_shutdown";
  if (reason.includes("stale")) return "stale";
  if (reason.includes("activate")) return "activation_failed";
  return "closed";
}
