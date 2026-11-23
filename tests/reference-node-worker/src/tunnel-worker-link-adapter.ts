import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";

import type { TunnelDestinationRouter } from "./tunnel-destination-router.js";
import type { OsTunnelServices } from "./os-executor/tunnel-services.js";
import {
  WorkerLinkChannelRejectedError,
  type WorkerLinkAdapterEmitter,
  type WorkerLinkResourceAdapter,
} from "./worker-link-gateway.js";

interface ActiveTunnelChannel {
  attachmentId: string;
  closed: boolean;
  emitter: WorkerLinkAdapterEmitter;
  grantId: string;
  guest: boolean;
  listening: boolean;
  resourceId: string;
  workerId: string;
  waiters: Set<(available: boolean) => void>;
  writable: boolean;
}

export class TunnelWorkerLinkAdapter implements WorkerLinkResourceAdapter {
  readonly kind = "tunnel" as const;
  readonly #attachments = new Map<string, ActiveTunnelChannel>();

  constructor(
    private readonly destinations: TunnelDestinationRouter,
    private readonly osServices?: OsTunnelServices,
  ) {}

  open: WorkerLinkResourceAdapter["open"] = async ({
    grant,
    lane,
    emit,
    session,
  }) => {
    const resource = grant.binding.resource;
    const attachmentId = resource.attachmentId;
    if (
      lane !== "stream" ||
      !attachmentId ||
      this.#attachments.has(attachmentId) ||
      !grant.binding.operations.includes("stream:read") ||
      !grant.binding.operations.includes("stream:write")
    ) {
      throw new WorkerLinkChannelRejectedError(
        "resource-unavailable",
        "The tunnel attachment is not available for this channel.",
      );
    }
    const active: ActiveTunnelChannel = {
      attachmentId,
      closed: false,
      emitter: emit,
      grantId: grant.binding.grantId,
      guest:
        grant.binding.operations.includes("stream:guest-connect") ||
        grant.binding.operations.includes("stream:guest-listen"),
      listening: grant.binding.operations.includes("stream:guest-listen"),
      resourceId: resource.resourceId,
      waiters: new Set(),
      workerId: session.identity.workerId,
      writable: true,
    };
    this.#attachments.set(attachmentId, active);
    try {
      if (active.guest) {
        if (!this.osServices)
          throw new WorkerLinkChannelRejectedError(
            "resource-unavailable",
            "Guest tunnel preparation is unavailable.",
          );
        const listener = await this.osServices.activate(grant, session);
        if (active.closed || this.#attachments.get(attachmentId) !== active)
          throw new WorkerLinkChannelRejectedError(
            "resource-unavailable",
            "The guest tunnel channel was retired while opening.",
          );
        if (listener)
          void listener.closed
            .then(() =>
              active.closed
                ? undefined
                : active.emitter.close("endpoint-disconnected"),
            )
            .catch(() => {});
      }
    } catch (error) {
      await this.#close(active).catch(() => {});
      throw error;
    }
    return {
      carrierWritable: () => this.#markWritable(active),
      close: () => this.#close(active),
      credit: () => this.#markWritable(active),
      write: (payload) => this.#write(active, payload),
    };
  };

  revoke: WorkerLinkResourceAdapter["revoke"] = async ({ grant }) => {
    const attachmentId = grant.binding.resource.attachmentId;
    if (attachmentId)
      await this.osServices?.revoke(attachmentId, grant.binding.grantId);
  };

  routeFrame(
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): boolean | null {
    const active = this.#attachments.get(header.attachmentId);
    if (!active) return null;
    if (
      active.closed ||
      header.tunnelId !== active.resourceId ||
      !this.#identitiesMatch(active, header)
    ) {
      return false;
    }
    const sent = active.emitter.data(
      encodeTunnelDataPlaneFrame(header, payload),
      "tunnel-data-plane-v1",
    );
    // Accepted frames keep draining the shared outer byte window. Only a
    // rejected emission blocks nested streams; the gateway distinguishes
    // protocol credit from carrier capacity and wakes the adapter from the
    // matching source.
    if (!sent) active.writable = false;
    return sent;
  }

  waitForCapacity(attachmentId: string): Promise<boolean> | null {
    const active = this.#attachments.get(attachmentId);
    if (!active) return null;
    if (active.closed) return Promise.resolve(false);
    if (active.writable) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => active.waiters.add(resolve));
  }

  #write(active: ActiveTunnelChannel, payload: Uint8Array): void {
    if (active.closed) throw new Error("Tunnel WorkerLink channel is closed.");
    if (active.guest && !this.osServices?.isGuest(active.attachmentId))
      throw new Error("The captured guest tunnel was retired.");
    if (active.listening) {
      if (payload.byteLength !== 1 || payload[0] !== 0)
        throw new Error(
          "Guest listener channels accept only their control heartbeat.",
        );
      return;
    }
    const frame = decodeTunnelDataPlaneFrame(payload);
    if (
      frame.header.tunnelId !== active.resourceId ||
      frame.header.attachmentId !== active.attachmentId ||
      !this.#identitiesMatch(active, frame.header) ||
      !sourceFrameAllowed(frame.header, active.resourceId)
    ) {
      throw new Error("Tunnel WorkerLink frame escaped its grant binding.");
    }
    this.destinations.handleFrame(frame.header, frame.payload, {
      diagnosticTraceId:
        frame.header.kind === "connect"
          ? frame.header.diagnosticTraceId
          : undefined,
    });
  }

  #identitiesMatch(
    active: ActiveTunnelChannel,
    header: TunnelDataPlaneFrameHeader,
  ): boolean {
    return (
      header.sourceEndpointId === `worker-link-client:${active.grantId}` &&
      header.destinationEndpointId === `worker-link-worker:${active.workerId}`
    );
  }

  #markWritable(active: ActiveTunnelChannel): void {
    if (active.closed) return;
    active.writable = true;
    for (const resolve of active.waiters) resolve(true);
    active.waiters.clear();
  }

  async #close(active: ActiveTunnelChannel): Promise<void> {
    if (active.closed) return;
    active.closed = true;
    if (this.#attachments.get(active.attachmentId) === active) {
      this.#attachments.delete(active.attachmentId);
    }
    this.destinations.revokeAttachment(active.attachmentId);
    for (const resolve of active.waiters) resolve(false);
    active.waiters.clear();
    await this.osServices?.revoke(active.attachmentId, active.grantId);
  }
}

function sourceFrameAllowed(
  header: TunnelDataPlaneFrameHeader,
  resourceId: string,
): boolean {
  switch (header.kind) {
    case "connect":
      return (
        header.target.kind === "protected-tunnel" &&
        header.target.recordId === resourceId
      );
    case "data":
      return header.direction === "source-to-destination";
    case "credit":
      return header.direction === "destination-to-source";
    case "half-close":
      return header.direction === "source-to-destination";
    case "close":
    case "error":
      return true;
    case "open":
    case "accepted":
    case "rejected":
      return false;
  }
}
