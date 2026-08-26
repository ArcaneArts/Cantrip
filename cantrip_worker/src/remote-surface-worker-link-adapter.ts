import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  type InstalledWorkerLinkGrant,
  type RemoteSurfaceFrameHeader,
  type RemoteSurfaceKind,
  type WorkerLinkQosLane,
  type WorkerLinkResourceKind,
} from "@cantrip/protocol";

import type { RemoteSurfaceManager } from "./remote-surface-manager.js";
import {
  WorkerLinkChannelRejectedError,
  type WorkerLinkAdapterEmitter,
  type WorkerLinkResourceAdapter,
} from "./worker-link-gateway.js";

const MAX_PENDING_INTERACTIVE_FRAMES = 128;
const MAX_PENDING_INTERACTIVE_BYTES = 4 * 1_024 * 1_024;

interface ActiveLane {
  readonly emitter: WorkerLinkAdapterEmitter;
  readonly identity: string;
}

interface ActiveAttachment {
  readonly attachmentId: string;
  failed: boolean;
  readonly grantId: string;
  readonly lanes: Map<WorkerLinkQosLane, ActiveLane>;
  pendingInteractiveBytes: number;
  readonly pendingInteractive: Uint8Array[];
  releaseEmitter(): void;
  readonly surfaceId: string;
}

export interface RemoteSurfaceWorkerLinkAdapterOptions {
  readonly resourceKind: Extract<
    WorkerLinkResourceKind,
    "browser" | "remote-desktop"
  >;
  readonly surfaceKind: RemoteSurfaceKind;
}

export class RemoteSurfaceWorkerLinkAdapter implements WorkerLinkResourceAdapter {
  readonly kind: Extract<WorkerLinkResourceKind, "browser" | "remote-desktop">;
  readonly #attachments = new Map<string, ActiveAttachment>();

  constructor(
    private readonly surfaces: Pick<
      RemoteSurfaceManager,
      "bindAttachmentFrameEmitter" | "detach" | "handleFrame"
    >,
    private readonly options: RemoteSurfaceWorkerLinkAdapterOptions,
  ) {
    this.kind = options.resourceKind;
  }

  open: WorkerLinkResourceAdapter["open"] = ({
    channel,
    emit,
    grant,
    lane,
  }) => {
    const resource = grant.binding.resource;
    const attachmentId = resource.attachmentId;
    if (
      resource.kind !== this.kind ||
      !attachmentId ||
      (lane !== "interactive" && lane !== "realtime") ||
      !grant.binding.operations.includes("stream:read") ||
      !grant.binding.operations.includes("stream:open")
    ) {
      throw new WorkerLinkChannelRejectedError(
        "resource-unavailable",
        "The Remote Surface attachment is unavailable for this lane.",
      );
    }
    if (
      lane === "interactive" &&
      !grant.binding.operations.includes("stream:write")
    ) {
      throw new WorkerLinkChannelRejectedError(
        "unauthorized",
        "The Remote Surface interactive lane is not writable.",
      );
    }

    const key = attachmentKey(resource.resourceId, attachmentId);
    let active = this.#attachments.get(key);
    if (active && active.grantId !== grant.binding.grantId) {
      throw new WorkerLinkChannelRejectedError(
        "resource-unavailable",
        "The Remote Surface attachment belongs to another grant.",
      );
    }
    if (!active) {
      const created: ActiveAttachment = {
        attachmentId,
        failed: false,
        grantId: grant.binding.grantId,
        lanes: new Map(),
        pendingInteractiveBytes: 0,
        pendingInteractive: [],
        releaseEmitter: () => undefined,
        surfaceId: resource.resourceId,
      };
      try {
        created.releaseEmitter = this.surfaces.bindAttachmentFrameEmitter(
          created.surfaceId,
          created.attachmentId,
          this.options.surfaceKind,
          (header, payload) => this.#emit(created, header, payload),
        );
      } catch {
        throw new WorkerLinkChannelRejectedError(
          "resource-unavailable",
          "The Remote Surface attachment is not running.",
        );
      }
      this.#attachments.set(key, created);
      active = created;
    }
    if (active.failed || active.lanes.has(lane)) {
      throw new WorkerLinkChannelRejectedError(
        "resource-unavailable",
        "The Remote Surface lane is already active or failed.",
      );
    }
    const identity = `${channel.channelId}\0${channel.connectionId}`;
    active.lanes.set(lane, { emitter: emit, identity });
    if (lane === "interactive") this.#drainInteractive(active);

    return {
      close: () => this.#closeLane(active!, lane, identity),
      credit: () => {
        if (lane === "interactive") this.#drainInteractive(active!);
      },
      ...(lane === "interactive"
        ? { write: (payload: Uint8Array) => this.#write(active!, payload) }
        : {}),
    };
  };

  revoke: NonNullable<WorkerLinkResourceAdapter["revoke"]> = async ({
    grant,
  }) => {
    await this.#revoke(grant);
  };

  #emit(
    active: ActiveAttachment,
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): boolean {
    if (
      active.failed ||
      header.surfaceId !== active.surfaceId ||
      header.attachmentId !== active.attachmentId
    ) {
      return false;
    }
    const encoded = encodeRemoteSurfaceFrame(header, payload);
    if (header.channel === "frame" || header.channel === "cursor") {
      // Realtime output is explicitly disposable. A missing or pressured lane
      // consumes the frame instead of spilling it into the legacy relay path.
      active.lanes.get("realtime")?.emitter.data(encoded);
      return true;
    }
    if (header.channel !== "control" && header.channel !== "clipboard") {
      return false;
    }
    if (active.pendingInteractive.length === 0) {
      const lane = active.lanes.get("interactive");
      if (lane?.emitter.data(encoded)) return true;
    }
    return this.#queueInteractive(active, encoded);
  }

  #queueInteractive(active: ActiveAttachment, payload: Uint8Array): boolean {
    if (
      active.pendingInteractive.length >= MAX_PENDING_INTERACTIVE_FRAMES ||
      active.pendingInteractiveBytes + payload.byteLength >
        MAX_PENDING_INTERACTIVE_BYTES
    ) {
      this.#fail(active);
      return false;
    }
    const copy = payload.slice();
    active.pendingInteractive.push(copy);
    active.pendingInteractiveBytes += copy.byteLength;
    return true;
  }

  #drainInteractive(active: ActiveAttachment): void {
    if (active.failed) return;
    const lane = active.lanes.get("interactive");
    if (!lane) return;
    while (active.pendingInteractive.length > 0) {
      const payload = active.pendingInteractive[0]!;
      if (!lane.emitter.data(payload)) return;
      active.pendingInteractive.shift();
      active.pendingInteractiveBytes -= payload.byteLength;
    }
  }

  async #write(active: ActiveAttachment, payload: Uint8Array): Promise<void> {
    if (active.failed) {
      throw new Error("Remote Surface WorkerLink attachment has failed.");
    }
    const frame = decodeRemoteSurfaceFrame(payload);
    if (
      frame.header.surfaceId !== active.surfaceId ||
      frame.header.attachmentId !== active.attachmentId ||
      frame.header.channel !== "control"
    ) {
      throw new Error("Remote Surface frame escaped its grant binding.");
    }
    await this.surfaces.handleFrame(frame.header, frame.payload);
  }

  #closeLane(
    active: ActiveAttachment,
    lane: WorkerLinkQosLane,
    identity: string,
  ): void {
    if (active.lanes.get(lane)?.identity === identity) {
      active.lanes.delete(lane);
    }
  }

  #fail(active: ActiveAttachment): void {
    if (active.failed) return;
    active.failed = true;
    active.pendingInteractive.length = 0;
    active.pendingInteractiveBytes = 0;
    const lane = active.lanes.get("interactive");
    lane?.emitter.error("credit-exceeded");
    void lane?.emitter.close("congested");
  }

  async #revoke(grant: InstalledWorkerLinkGrant): Promise<void> {
    const resource = grant.binding.resource;
    const attachmentId = resource.attachmentId;
    if (resource.kind !== this.kind || !attachmentId) return;
    const key = attachmentKey(resource.resourceId, attachmentId);
    const active = this.#attachments.get(key);
    if (active && active.grantId !== grant.binding.grantId) return;
    if (active) {
      this.#attachments.delete(key);
      active.releaseEmitter();
      active.lanes.clear();
      active.pendingInteractive.length = 0;
      active.pendingInteractiveBytes = 0;
    }
    await this.surfaces.detach(resource.resourceId, attachmentId);
  }
}

function attachmentKey(surfaceId: string, attachmentId: string): string {
  return JSON.stringify([surfaceId, attachmentId]);
}
