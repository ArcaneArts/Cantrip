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
import {
  openWorkerRemoteSurfaceStreamPayload,
  protectWorkerRemoteSurfaceStreamPayload,
} from "./remote-surface-stream-encryption.js";
import { workerLogError, workerLogger } from "./logger.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

type AttachCommand = Extract<WorkerCommand, { type: "surface.attach" }>;
type ConfigureCommand = Extract<WorkerCommand, { type: "surface.configure" }>;

export interface RemoteSurfacePrivateState {
  serverId: string;
  stateProtection: NonNullable<AttachCommand["stateProtection"]>;
  stateResource: NonNullable<AttachCommand["stateResource"]>;
  stateRevision: NonNullable<AttachCommand["stateRevision"]>;
}

function privateState(
  command: AttachCommand | ConfigureCommand,
): RemoteSurfacePrivateState | null {
  if (
    !command.stateProtection ||
    !command.stateResource ||
    !command.stateRevision
  ) {
    throw new Error("Remote Surface private state is unavailable.");
  }
  return {
    serverId: command.serverId,
    stateProtection: command.stateProtection,
    stateResource: command.stateResource,
    stateRevision: command.stateRevision,
  };
}

const MAX_ATTACHMENTS_PER_SURFACE = 4;
const REMOTE_SURFACE_CHANNELS = [
  "control",
  "frame",
  "cursor",
  "clipboard",
  "webrtc-signal",
] as const satisfies readonly RemoteSurfaceChannel[];

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
    privateState: RemoteSurfacePrivateState | null,
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

interface ManagedAttachment {
  inboundQueues: Map<RemoteSurfaceChannel, Promise<void>>;
  lastInboundSequences: Map<RemoteSurfaceChannel, number>;
  serverId: string;
  webrtc: WorkerWebRtcAttachment | null;
}

interface ManagedSession {
  attachments: Map<string, ManagedAttachment>;
  session: RemoteSurfaceSession;
  startedAtMs: number;
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
  #encryption: WorkerEncryptionService | null = null;
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

  setEncryptionService(service: WorkerEncryptionService): void {
    this.#encryption = service;
  }

  async attach(command: AttachCommand): Promise<{
    accepted: true;
    transport: RemoteSurfaceTransport;
  }> {
    const startedAtMs = Date.now();
    let managed = this.#sessions.get(command.surfaceId);
    if (!managed) {
      managed = await this.openSession(command);
    }
    if (managed.session.configuration.kind !== command.configuration.kind) {
      throw new Error(
        "Remote Surface kind changed while its session was live.",
      );
    } else if (managed.session.updateConfiguration) {
      await managed.session.updateConfiguration(
        command.configuration,
        privateState(command),
      );
    }

    if (
      !managed.attachments.has(command.attachmentId) &&
      managed.attachments.size >= MAX_ATTACHMENTS_PER_SURFACE
    ) {
      workerLogger.event("warn", "Remote surface attachment limit reached", {
        event: "surface.attachment.rejected",
        subsystem: "remote-surface",
        operation: "attach",
        reasonCode: "attachment-limit",
        status: "rejected",
        surfaceId: command.surfaceId,
        attachmentId: command.attachmentId,
        surfaceKind: command.configuration.kind,
        counts: {
          attachments: managed.attachments.size,
          limit: MAX_ATTACHMENTS_PER_SURFACE,
        },
      });
      throw new Error(
        `Remote Surface ${command.surfaceId} already has ${MAX_ATTACHMENTS_PER_SURFACE} active attachments.`,
      );
    }

    const attachment = {
      id: command.attachmentId,
      viewport: command.viewport,
    };
    managed.attachments.set(command.attachmentId, {
      inboundQueues: new Map(),
      lastInboundSequences: new Map(),
      serverId: command.serverId,
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
    } catch {
      managed.attachments.delete(command.attachmentId);
      if (managed.attachments.size === 0) {
        this.#sessions.delete(command.surfaceId);
        try {
          await managed.session.close();
        } catch {
          // Preserve the original attach failure.
        }
      }
      workerLogger.event("warn", "Remote surface attachment failed", {
        event: "surface.attachment.failed",
        subsystem: "remote-surface",
        operation: "attach",
        reasonCode: "adapter-attach-failed",
        status: "failed",
        surfaceId: command.surfaceId,
        attachmentId: command.attachmentId,
        surfaceKind: command.configuration.kind,
        durationMs: Date.now() - startedAtMs,
      });
      throw new Error("Remote Surface attachment failed.");
    }
    const transport = managed.attachments.get(command.attachmentId)?.webrtc
      ? "webrtc"
      : "websocket";
    workerLogger.event("info", "Remote surface attached", {
      event: "surface.attachment.attached",
      subsystem: "remote-surface",
      operation: "attach",
      status: "completed",
      surfaceId: command.surfaceId,
      attachmentId: command.attachmentId,
      surfaceKind: command.configuration.kind,
      transport,
      durationMs: Date.now() - startedAtMs,
      counts: { attachments: managed.attachments.size },
    });
    return {
      accepted: true,
      transport,
    };
  }

  async detach(surfaceId: string, attachmentId: string): Promise<void> {
    const managed = this.#sessions.get(surfaceId);
    const attachment = managed?.attachments.get(attachmentId);
    if (!managed || !attachment) return;
    managed.attachments.delete(attachmentId);
    await attachment.webrtc?.close(false);
    for (const channel of REMOTE_SURFACE_CHANNELS) {
      this.#outboundSequences.delete(
        this.streamKey(surfaceId, attachmentId, channel),
      );
    }
    await managed.session.detach(attachmentId);
    workerLogger.event("info", "Remote surface detached", {
      event: "surface.attachment.detached",
      subsystem: "remote-surface",
      operation: "detach",
      status: "completed",
      surfaceId,
      attachmentId,
      surfaceKind: managed.session.configuration.kind,
      counts: { attachments: managed.attachments.size },
    });
  }

  async configure(command: ConfigureCommand): Promise<void> {
    const managed = this.#sessions.get(command.surfaceId);
    if (!managed) return;
    if (managed.session.configuration.kind !== command.configuration.kind) {
      throw new Error("Remote Surface kind cannot change while it is live.");
    }
    try {
      await managed.session.updateConfiguration?.(
        command.configuration,
        privateState(command),
      );
    } catch {
      workerLogger.event("warn", "Remote surface configuration failed", {
        event: "surface.lifecycle.configure-failed",
        subsystem: "remote-surface",
        operation: "configure",
        reasonCode: "adapter-configure-failed",
        status: "failed",
        surfaceId: command.surfaceId,
        surfaceKind: command.configuration.kind,
      });
      throw new Error("Remote Surface configuration could not be applied.");
    }
  }

  async suspend(surfaceId: string): Promise<void> {
    const managed = this.requiredSession(surfaceId);
    await managed.session.suspend();
    workerLogger.event("debug", "Remote surface suspended", {
      event: "surface.lifecycle.suspended",
      subsystem: "remote-surface",
      operation: "suspend",
      status: "completed",
      surfaceId,
      surfaceKind: managed.session.configuration.kind,
    });
  }

  async resume(surfaceId: string): Promise<void> {
    const managed = this.requiredSession(surfaceId);
    await managed.session.resume();
    workerLogger.event("debug", "Remote surface resumed", {
      event: "surface.lifecycle.resumed",
      subsystem: "remote-surface",
      operation: "resume",
      status: "completed",
      surfaceId,
      surfaceKind: managed.session.configuration.kind,
    });
  }

  async close(surfaceId: string): Promise<void> {
    const managed = this.#sessions.get(surfaceId);
    if (!managed) return;
    this.#sessions.delete(surfaceId);
    for (const attachmentId of managed.attachments.keys()) {
      for (const channel of REMOTE_SURFACE_CHANNELS) {
        this.#outboundSequences.delete(
          this.streamKey(surfaceId, attachmentId, channel),
        );
      }
    }
    await Promise.allSettled(
      [...managed.attachments.values()].map((attachment) =>
        attachment.webrtc?.close(false),
      ),
    );
    await managed.session.close();
    workerLogger.event("info", "Remote surface closed", {
      event: "surface.lifecycle.closed",
      subsystem: "remote-surface",
      operation: "close",
      status: "completed",
      surfaceId,
      surfaceKind: managed.session.configuration.kind,
      durationMs: Date.now() - managed.startedAtMs,
      counts: { attachments: managed.attachments.size },
    });
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
      workerLogger.event("warn", "Remote surface session limit reached", {
        event: "surface.lifecycle.rejected",
        subsystem: "remote-surface",
        operation: "open",
        reasonCode: "session-limit",
        status: "rejected",
        surfaceId: command.surfaceId,
        surfaceKind: command.configuration.kind,
        counts: {
          sessions: this.#sessions.size,
          openings: this.#openingSessions.size,
          limit: this.maxSessions,
        },
      });
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
    const startedAtMs = Date.now();
    workerLogger.event("info", "Remote surface opening", {
      event: "surface.lifecycle.opening",
      subsystem: "remote-surface",
      operation: "open",
      status: "started",
      surfaceId: command.surfaceId,
      surfaceKind: command.configuration.kind,
      preferredTransport: command.preferredTransport,
    });
    const next = adapter
      .open(command, (attachmentId, channel, payload) =>
        this.emit(command.surfaceId, attachmentId, channel, payload),
      )
      .then((session) => {
        const managed = { attachments: new Map(), session, startedAtMs };
        this.#sessions.set(command.surfaceId, managed);
        workerLogger.event("info", "Remote surface opened", {
          event: "surface.lifecycle.opened",
          subsystem: "remote-surface",
          operation: "open",
          status: "ready",
          surfaceId: command.surfaceId,
          surfaceKind: command.configuration.kind,
          transport: session.transport,
          durationMs: Date.now() - startedAtMs,
          counts: { sessions: this.#sessions.size },
        });
        return managed;
      })
      .catch(() => {
        workerLogger.event("error", "Remote surface failed to open", {
          event: "surface.lifecycle.open-failed",
          subsystem: "remote-surface",
          operation: "open",
          reasonCode: "adapter-open-failed",
          status: "failed",
          surfaceId: command.surfaceId,
          surfaceKind: command.configuration.kind,
          durationMs: Date.now() - startedAtMs,
        });
        throw new Error("Remote Surface could not be opened.");
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
    const key = this.streamKey(surfaceId, attachmentId, channel);
    const sequence = (this.#outboundSequences.get(key) ?? -1) + 1;
    const header: RemoteSurfaceFrameHeader = {
      protocolVersion: 1,
      surfaceId,
      attachmentId,
      sequence,
      channel,
    };
    const attachment = managed.attachments.get(attachmentId)!;
    const protectedPayload = this.protectPayload(
      managed,
      attachmentId,
      attachment,
      header,
      payload,
    );
    if (!protectedPayload) return false;
    const rtcResult = attachment.webrtc?.send(
      channel,
      encodeRemoteSurfaceFrame(header, protectedPayload),
    );
    if (rtcResult === "sent" || rtcResult === "dropped") {
      this.#outboundSequences.set(key, sequence);
      return rtcResult === "sent";
    }
    if (this.#emitFrame(header, protectedPayload)) {
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
    const lastSequence =
      attachment.lastInboundSequences.get(header.channel) ?? -1;
    if (header.sequence <= lastSequence) return;
    attachment.lastInboundSequences.set(header.channel, header.sequence);
    const previous =
      attachment.inboundQueues.get(header.channel) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        const encryption = this.#encryption;
        if (!encryption) {
          throw new Error("Remote Surface stream encryption is unavailable.");
        }
        const plaintext = openWorkerRemoteSurfaceStreamPayload({
          context: {
            serverId: attachment.serverId,
            surfaceKind: managed.session.configuration.kind,
            surfaceId: header.surfaceId,
            attachmentId: header.attachmentId,
            direction: "client-to-worker",
            channel: header.channel,
            sequence: header.sequence,
          },
          protectedPayload: payload,
          service: encryption,
        });
        if (managed.attachments.get(header.attachmentId) !== attachment) return;
        if (header.channel === "webrtc-signal" && attachment.webrtc) {
          try {
            await attachment.webrtc.handleSignal(plaintext);
          } catch {
            await attachment.webrtc.close();
          }
          return;
        }
        await managed.session.handleFrame(
          header.attachmentId,
          header.channel,
          plaintext,
        );
      });
    attachment.inboundQueues.set(header.channel, queued);
    try {
      await queued;
    } finally {
      if (attachment.inboundQueues.get(header.channel) === queued) {
        attachment.inboundQueues.delete(header.channel);
      }
    }
  }

  private async acceptWebRtcFrame(
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): Promise<void> {
    try {
      await this.acceptFrame(header, payload);
    } catch (error) {
      workerLogger.rateLimited(
        `surface-webrtc-frame-rejected:${header.surfaceId}:${header.attachmentId}`,
        "warn",
        "Rejected Remote Surface WebRTC frame",
        {
          event: "surface.transport.frame-rejected",
          subsystem: "remote-surface",
          operation: "receive-webrtc-frame",
          reasonCode: "invalid-frame",
          status: "rejected",
          surfaceId: header.surfaceId,
          attachmentId: header.attachmentId,
          channel: header.channel,
          error: workerLogError(error),
        },
      );
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
    const key = this.streamKey(surfaceId, attachmentId, channel);
    const sequence = (this.#outboundSequences.get(key) ?? -1) + 1;
    const header: RemoteSurfaceFrameHeader = {
      protocolVersion: 1,
      surfaceId,
      attachmentId,
      sequence,
      channel,
    };
    const attachment = managed.attachments.get(attachmentId)!;
    const protectedPayload = this.protectPayload(
      managed,
      attachmentId,
      attachment,
      header,
      payload,
    );
    if (protectedPayload && this.#emitFrame(header, protectedPayload)) {
      this.#outboundSequences.set(key, sequence);
    }
  }

  private protectPayload(
    managed: ManagedSession,
    attachmentId: string,
    attachment: ManagedAttachment,
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): Uint8Array | null {
    const encryption = this.#encryption;
    if (!encryption) return null;
    try {
      return protectWorkerRemoteSurfaceStreamPayload({
        context: {
          serverId: attachment.serverId,
          surfaceKind: managed.session.configuration.kind,
          surfaceId: header.surfaceId,
          attachmentId,
          direction: "worker-to-client",
          channel: header.channel,
          sequence: header.sequence,
        },
        payload,
        service: encryption,
      });
    } catch {
      return null;
    }
  }

  private streamKey(
    surfaceId: string,
    attachmentId: string,
    channel: RemoteSurfaceChannel,
  ): string {
    return JSON.stringify([surfaceId, attachmentId, channel]);
  }

  private requiredSession(surfaceId: string): ManagedSession {
    const managed = this.#sessions.get(surfaceId);
    if (!managed) throw new Error("Remote Surface session is not running.");
    return managed;
  }
}
