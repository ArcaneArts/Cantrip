import type {
  RemoteSurfaceChannel,
  RemoteSurfaceConfiguration,
  RemoteSurfaceFrameHeader,
  RemoteSurfaceTransport,
  RemoteSurfaceViewport,
  WorkerCommand,
} from "@cantrip/protocol";
import { encodeRemoteSurfaceFrame } from "@cantrip/protocol";

import {
  WorkerWebRtcAttachment,
  type WorkerWebRtcAttachmentOptions,
} from "./remote-surfaces/webrtc.js";
import { workerLogger } from "./logger.js";

type AttachCommand = Extract<WorkerCommand, { type: "surface.attach" }>;

const MAX_ATTACHMENTS_PER_SURFACE = 4;

export interface RemoteSurfaceAttachment {
  id: string;
  viewport: RemoteSurfaceViewport;
}

export interface RemoteSurfaceSession {
  readonly configuration: RemoteSurfaceConfiguration;
  readonly transport: RemoteSurfaceTransport;
  attach(attachment: RemoteSurfaceAttachment): Promise<void> | void;
  close(): Promise<void> | void;
  detach(attachmentId: string): Promise<void> | void;
  handleFrame(
    attachmentId: string,
    channel: RemoteSurfaceChannel,
    payload: Uint8Array,
  ): Promise<void> | void;
  resume(): Promise<void> | void;
  suspend(): Promise<void> | void;
  updateConfiguration?(
    configuration: RemoteSurfaceConfiguration,
  ): Promise<void> | void;
}

export interface RemoteSurfaceAdapter {
  open(
    command: AttachCommand,
    emit: (
      attachmentId: string,
      channel: RemoteSurfaceChannel,
      payload: Uint8Array,
    ) => boolean,
  ): Promise<RemoteSurfaceSession>;
}

interface ManagedSession {
  attachments: Map<
    string,
    {
      lastInboundSequence: number;
      webrtc: WorkerWebRtcAttachment | null;
    }
  >;
  session: RemoteSurfaceSession;
}

export type WorkerWebRtcAttachmentFactory = (
  options: WorkerWebRtcAttachmentOptions,
) => WorkerWebRtcAttachment;

export type RemoteSurfaceFrameEmitter = (
  header: RemoteSurfaceFrameHeader,
  payload: Uint8Array,
) => boolean;

export class RemoteSurfaceManager {
  readonly #adapters: Partial<
    Record<RemoteSurfaceConfiguration["kind"], RemoteSurfaceAdapter>
  >;
  readonly #outboundSequences = new Map<string, number>();
  readonly #openingSessions = new Map<string, Promise<ManagedSession>>();
  readonly #sessions = new Map<string, ManagedSession>();
  #emitFrame: RemoteSurfaceFrameEmitter = () => false;

  constructor(
    adapters: Partial<
      Record<RemoteSurfaceConfiguration["kind"], RemoteSurfaceAdapter>
    > = {},
    private readonly maxSessions = 4,
    private readonly createWebRtcAttachment: WorkerWebRtcAttachmentFactory = (
      options,
    ) => new WorkerWebRtcAttachment(options),
  ) {
    this.#adapters = adapters;
  }

  setFrameEmitter(emitFrame: RemoteSurfaceFrameEmitter): void {
    this.#emitFrame = emitFrame;
  }

  async attach(command: AttachCommand): Promise<{
    accepted: true;
    transport: RemoteSurfaceTransport;
  }> {
    let managed = this.#sessions.get(command.surfaceId);
    if (!managed) {
      managed = await this.openSession(command);
    }
    if (managed.session.configuration.kind !== command.configuration.kind) {
      throw new Error(
        "Remote Surface kind changed while its session was live.",
      );
    } else if (managed.session.updateConfiguration) {
      await managed.session.updateConfiguration(command.configuration);
    }

    if (
      !managed.attachments.has(command.attachmentId) &&
      managed.attachments.size >= MAX_ATTACHMENTS_PER_SURFACE
    ) {
      throw new Error(
        `Remote Surface ${command.surfaceId} already has ${MAX_ATTACHMENTS_PER_SURFACE} active attachments.`,
      );
    }

    const attachment = {
      id: command.attachmentId,
      viewport: command.viewport,
    };
    managed.attachments.set(command.attachmentId, {
      lastInboundSequence: -1,
      webrtc: null,
    });
    try {
      await managed.session.attach(attachment);
      if (command.preferredTransport === "webrtc" && command.webrtc) {
        const managedAttachment = managed.attachments.get(command.attachmentId);
        if (managedAttachment) {
          managedAttachment.webrtc = this.createWebRtcAttachment({
            attachmentId: command.attachmentId,
            configuration: command.webrtc,
            emitSignal: (signal) =>
              this.emitWebSocket(
                command.surfaceId,
                command.attachmentId,
                "webrtc-signal",
                new TextEncoder().encode(JSON.stringify(signal)),
              ),
            onFrame: (header, payload) =>
              void this.acceptWebRtcFrame(header, payload),
            surfaceId: command.surfaceId,
          });
        }
      }
    } catch (error) {
      managed.attachments.delete(command.attachmentId);
      if (managed.attachments.size === 0) {
        this.#sessions.delete(command.surfaceId);
        try {
          await managed.session.close();
        } catch {
          // Preserve the original attach failure.
        }
      }
      throw error;
    }
    return {
      accepted: true,
      transport: managed.attachments.get(command.attachmentId)?.webrtc
        ? "webrtc"
        : "websocket",
    };
  }

  async detach(surfaceId: string, attachmentId: string): Promise<void> {
    const managed = this.#sessions.get(surfaceId);
    const attachment = managed?.attachments.get(attachmentId);
    if (!managed || !attachment) return;
    managed.attachments.delete(attachmentId);
    await attachment.webrtc?.close(false);
    this.#outboundSequences.delete(`${surfaceId}:${attachmentId}`);
    await managed.session.detach(attachmentId);
  }

  async configure(
    surfaceId: string,
    configuration: RemoteSurfaceConfiguration,
  ): Promise<void> {
    const managed = this.#sessions.get(surfaceId);
    if (!managed) return;
    if (managed.session.configuration.kind !== configuration.kind) {
      throw new Error("Remote Surface kind cannot change while it is live.");
    }
    await managed.session.updateConfiguration?.(configuration);
  }

  async suspend(surfaceId: string): Promise<void> {
    await this.requiredSession(surfaceId).session.suspend();
  }

  async resume(surfaceId: string): Promise<void> {
    await this.requiredSession(surfaceId).session.resume();
  }

  async close(surfaceId: string): Promise<void> {
    const managed = this.#sessions.get(surfaceId);
    if (!managed) return;
    this.#sessions.delete(surfaceId);
    for (const attachmentId of managed.attachments.keys()) {
      this.#outboundSequences.delete(`${surfaceId}:${attachmentId}`);
    }
    await Promise.allSettled(
      [...managed.attachments.values()].map((attachment) =>
        attachment.webrtc?.close(false),
      ),
    );
    await managed.session.close();
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.#sessions.keys()].map((surfaceId) => this.close(surfaceId)),
    );
  }

  private async openSession(command: AttachCommand): Promise<ManagedSession> {
    const opening = this.#openingSessions.get(command.surfaceId);
    if (opening) return opening;
    if (this.#sessions.size + this.#openingSessions.size >= this.maxSessions) {
      throw new Error(
        `Worker Remote Surface limit of ${this.maxSessions} sessions reached.`,
      );
    }
    const adapter = this.#adapters[command.configuration.kind];
    if (!adapter) {
      throw new Error(
        `Worker does not support ${command.configuration.kind} Remote Surfaces.`,
      );
    }
    const next = adapter
      .open(command, (attachmentId, channel, payload) =>
        this.emit(command.surfaceId, attachmentId, channel, payload),
      )
      .then((session) => {
        const managed = { attachments: new Map(), session };
        this.#sessions.set(command.surfaceId, managed);
        return managed;
      });
    this.#openingSessions.set(command.surfaceId, next);
    try {
      return await next;
    } finally {
      if (this.#openingSessions.get(command.surfaceId) === next) {
        this.#openingSessions.delete(command.surfaceId);
      }
    }
  }

  async handleFrame(
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): Promise<void> {
    const attachment = this.#sessions
      .get(header.surfaceId)
      ?.attachments.get(header.attachmentId);
    if (header.channel === "webrtc-signal" && attachment?.webrtc) {
      if (header.sequence <= attachment.lastInboundSequence) return;
      attachment.lastInboundSequence = header.sequence;
      try {
        await attachment.webrtc.handleSignal(payload);
      } catch {
        await attachment.webrtc.close();
      }
      return;
    }
    await this.acceptFrame(header, payload);
  }

  private emit(
    surfaceId: string,
    attachmentId: string,
    channel: RemoteSurfaceChannel,
    payload: Uint8Array,
  ): boolean {
    const managed = this.#sessions.get(surfaceId);
    if (!managed?.attachments.has(attachmentId)) return false;
    const key = `${surfaceId}:${attachmentId}`;
    const sequence = (this.#outboundSequences.get(key) ?? -1) + 1;
    const header: RemoteSurfaceFrameHeader = {
      protocolVersion: 1,
      surfaceId,
      attachmentId,
      sequence,
      channel,
    };
    const attachment = managed.attachments.get(attachmentId)!;
    const rtcResult = attachment.webrtc?.send(
      channel,
      encodeRemoteSurfaceFrame(header, payload),
    );
    if (rtcResult === "sent" || rtcResult === "dropped") {
      this.#outboundSequences.set(key, sequence);
      return rtcResult === "sent";
    }
    if (this.#emitFrame(header, payload)) {
      this.#outboundSequences.set(key, sequence);
      return true;
    }
    return false;
  }

  private async acceptFrame(
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): Promise<void> {
    const managed = this.#sessions.get(header.surfaceId);
    const attachment = managed?.attachments.get(header.attachmentId);
    if (!managed || !attachment) return;
    if (header.sequence <= attachment.lastInboundSequence) return;
    attachment.lastInboundSequence = header.sequence;
    await managed.session.handleFrame(
      header.attachmentId,
      header.channel,
      payload,
    );
  }

  private async acceptWebRtcFrame(
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): Promise<void> {
    try {
      await this.acceptFrame(header, payload);
    } catch (error) {
      workerLogger.warn("Rejected Remote Surface WebRTC frame", error);
    }
  }

  private emitWebSocket(
    surfaceId: string,
    attachmentId: string,
    channel: RemoteSurfaceChannel,
    payload: Uint8Array,
  ): void {
    const managed = this.#sessions.get(surfaceId);
    if (!managed?.attachments.has(attachmentId)) return;
    const key = `${surfaceId}:${attachmentId}`;
    const sequence = (this.#outboundSequences.get(key) ?? -1) + 1;
    if (
      this.#emitFrame(
        {
          protocolVersion: 1,
          surfaceId,
          attachmentId,
          sequence,
          channel,
        },
        payload,
      )
    ) {
      this.#outboundSequences.set(key, sequence);
    }
  }

  private requiredSession(surfaceId: string): ManagedSession {
    const managed = this.#sessions.get(surfaceId);
    if (!managed) throw new Error("Remote Surface session is not running.");
    return managed;
  }
}
