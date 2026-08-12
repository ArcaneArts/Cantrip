import type {
  TunnelAttachmentInitialize,
  TunnelAttachmentReady,
} from "@cantrip/protocol";

import type {
  ServerRepository,
  TunnelAttachmentAuthorization,
} from "../db/repository.js";
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
      route.close();
      void this.repository
        .markDesktopTunnelAttachmentOffline(authorization.attachmentId)
        .then(() => this.changed(this.#change(authorization)))
        .catch(() => undefined);
    });
    const activated = await this.repository.activateDesktopTunnelAttachment(
      authorization.attachmentId,
      authorization.clientId,
      initialize.localPort,
    );
    if (!activated) {
      this.closeActive(authorization.attachmentId, "Attachment is stale", 1008);
      throw new Error("Tunnel attachment is stale or expired.");
    }
    this.changed(this.#change(authorization));
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
  }

  async revoke(ownerId: string, attachmentId: string): Promise<boolean> {
    this.closeActive(attachmentId, "Attachment revoked", 1008);
    this.#broker.revokeAttachment(attachmentId);
    const stopped = await this.repository.stopDesktopTunnelAttachment(
      ownerId,
      attachmentId,
    );
    if (!stopped) return false;
    this.changed({ attachmentId, ownerId, ...stopped });
    return true;
  }

  stats() {
    return this.#broker.stats();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const attachmentId of [...this.#active.keys()]) {
      this.closeActive(attachmentId, "Server is shutting down", 1012);
    }
    this.#broker.close();
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
