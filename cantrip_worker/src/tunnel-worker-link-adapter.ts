import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";

import type { TunnelDestinationRouter } from "./tunnel-destination-router.js";
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
  resourceId: string;
  workerId: string;
  waiters: Set<(available: boolean) => void>;
  writable: boolean;
}

export class TunnelWorkerLinkAdapter implements WorkerLinkResourceAdapter {
  readonly kind = "tunnel" as const;
  readonly #attachments = new Map<string, ActiveTunnelChannel>();

  constructor(private readonly destinations: TunnelDestinationRouter) {}

  open: WorkerLinkResourceAdapter["open"] = ({
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
      resourceId: resource.resourceId,
      waiters: new Set(),
      workerId: session.identity.workerId,
      writable: true,
    };
    this.#attachments.set(attachmentId, active);
    return {
      close: () => this.#close(active),
      credit: () => this.#markWritable(active),
      write: (payload) => this.#write(active, payload),
    };
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
    // A rejected emission means the shared outer channel has no capacity at
    // this instant. Keep it non-writable until the gateway reports fresh
    // credit so competing nested TCP streams can retain and retry their frame.
    active.writable = false;
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

  #close(active: ActiveTunnelChannel): void {
    if (active.closed) return;
    active.closed = true;
    if (this.#attachments.get(active.attachmentId) === active) {
      this.#attachments.delete(active.attachmentId);
    }
    this.destinations.revokeAttachment(active.attachmentId);
    for (const resolve of active.waiters) resolve(false);
    active.waiters.clear();
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
