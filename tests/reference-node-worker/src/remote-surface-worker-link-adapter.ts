import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  encodeWorkerLinkRemoteSurfaceChunk,
  WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES,
  WorkerLinkRemoteSurfaceFrameAssembler,
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
  readonly inboundInteractive: WorkerLinkRemoteSurfaceFrameAssembler;
  readonly lanes: Map<WorkerLinkQosLane, ActiveLane>;
  readonly nextFrameIds: Map<WorkerLinkQosLane, number>;
  pendingInteractiveBytes: number;
  readonly pendingInteractive: PendingInteractiveFrame[];
  readonly pendingRealtime: PendingInteractiveFrame[];
  releaseEmitter(): void;
  readonly surfaceId: string;
}

interface PendingInteractiveFrame {
  readonly bytes: Uint8Array;
  readonly frameId: number;
  offset: number;
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
        inboundInteractive: new WorkerLinkRemoteSurfaceFrameAssembler(),
        lanes: new Map(),
        nextFrameIds: new Map(),
        pendingInteractiveBytes: 0,
        pendingInteractive: [],
        pendingRealtime: [],
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
    if (lane === "realtime") this.#drainRealtime(active);

    return {
      close: () => this.#closeLane(active!, lane, identity),
      credit: () => {
        if (lane === "interactive") this.#drainInteractive(active!);
        if (lane === "realtime") this.#drainRealtime(active!);
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
      // Finish one partially-sent frame across credit returns and retain only
      // the newest successor, so large screenshots still make progress.
      const pending = {
        bytes: encoded,
        frameId: this.#nextFrameId(active, "realtime"),
        offset: 0,
      };
      const current = active.pendingRealtime[0];
      if (!current || current.offset === 0) {
        active.pendingRealtime.splice(
          0,
          active.pendingRealtime.length,
          pending,
        );
      } else if (active.pendingRealtime.length === 1) {
        active.pendingRealtime.push(pending);
      } else {
        active.pendingRealtime[1] = pending;
      }
      this.#drainRealtime(active);
      return true;
    }
    if (header.channel !== "control" && header.channel !== "clipboard") {
      return false;
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
    active.pendingInteractive.push({
      bytes: copy,
      frameId: this.#nextFrameId(active, "interactive"),
      offset: 0,
    });
    active.pendingInteractiveBytes += copy.byteLength;
    this.#drainInteractive(active);
    return true;
  }

  #drainInteractive(active: ActiveAttachment): void {
    if (active.failed) return;
    const lane = active.lanes.get("interactive");
    if (!lane) return;
    while (active.pendingInteractive.length > 0) {
      const frame = active.pendingInteractive[0]!;
      const end = Math.min(
        frame.bytes.byteLength,
        frame.offset + WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES,
      );
      if (
        !lane.emitter.data(
          encodeWorkerLinkRemoteSurfaceChunk({
            frameId: frame.frameId,
            frameLength: frame.bytes.byteLength,
            offset: frame.offset,
            payload: frame.bytes.subarray(frame.offset, end),
          }),
        )
      ) {
        return;
      }
      frame.offset = end;
      if (frame.offset < frame.bytes.byteLength) continue;
      active.pendingInteractive.shift();
      active.pendingInteractiveBytes -= frame.bytes.byteLength;
    }
  }

  #drainRealtime(active: ActiveAttachment): void {
    if (active.failed) return;
    const lane = active.lanes.get("realtime");
    if (!lane) return;
    while (active.pendingRealtime.length > 0) {
      const frame = active.pendingRealtime[0]!;
      const end = Math.min(
        frame.bytes.byteLength,
        frame.offset + WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES,
      );
      if (
        !lane.emitter.data(
          encodeWorkerLinkRemoteSurfaceChunk({
            frameId: frame.frameId,
            frameLength: frame.bytes.byteLength,
            offset: frame.offset,
            payload: frame.bytes.subarray(frame.offset, end),
          }),
        )
      ) {
        return;
      }
      frame.offset = end;
      if (frame.offset < frame.bytes.byteLength) continue;
      active.pendingRealtime.shift();
    }
  }

  async #write(active: ActiveAttachment, payload: Uint8Array): Promise<void> {
    if (active.failed) {
      throw new Error("Remote Surface WorkerLink attachment has failed.");
    }
    const assembled = active.inboundInteractive.push(payload);
    if (!assembled) return;
    const frame = decodeRemoteSurfaceFrame(assembled);
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
      if (lane === "interactive") {
        active.inboundInteractive.reset();
        const pending = active.pendingInteractive[0];
        if (pending) pending.offset = 0;
      } else if (lane === "realtime") {
        const pending = active.pendingRealtime[0];
        if (pending) pending.offset = 0;
      }
    }
  }

  #nextFrameId(
    active: ActiveAttachment,
    lane: Extract<WorkerLinkQosLane, "interactive" | "realtime">,
  ): number {
    const frameId = active.nextFrameIds.get(lane) ?? 0;
    active.nextFrameIds.set(lane, (frameId + 1) >>> 0);
    return frameId;
  }

  #fail(active: ActiveAttachment): void {
    if (active.failed) return;
    active.failed = true;
    active.pendingInteractive.length = 0;
    active.pendingInteractiveBytes = 0;
    active.pendingRealtime.length = 0;
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
      active.pendingRealtime.length = 0;
    }
    await this.surfaces.detach(resource.resourceId, attachmentId);
  }
}

function attachmentKey(surfaceId: string, attachmentId: string): string {
  return JSON.stringify([surfaceId, attachmentId]);
}
