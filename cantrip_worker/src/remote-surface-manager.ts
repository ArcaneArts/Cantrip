import type {
  RemoteSurfaceChannel,
  RemoteSurfaceConfiguration,
  RemoteSurfaceFrameHeader,
  RemoteSurfaceTransport,
  RemoteSurfaceViewport,
  WorkerCommand,
} from "@cantrip/protocol";

type AttachCommand = Extract<WorkerCommand, { type: "surface.attach" }>;

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
}

export interface RemoteSurfaceAdapter {
  open(
    command: AttachCommand,
    emit: (
      attachmentId: string,
      channel: RemoteSurfaceChannel,
      payload: Uint8Array,
    ) => void,
  ): Promise<RemoteSurfaceSession>;
}

interface ManagedSession {
  attachments: Map<string, { lastInboundSequence: number }>;
  session: RemoteSurfaceSession;
}

export type RemoteSurfaceFrameEmitter = (
  header: RemoteSurfaceFrameHeader,
  payload: Uint8Array,
) => boolean;

export class RemoteSurfaceManager {
  readonly #adapters: Partial<
    Record<RemoteSurfaceConfiguration["kind"], RemoteSurfaceAdapter>
  >;
  readonly #outboundSequences = new Map<string, number>();
  readonly #sessions = new Map<string, ManagedSession>();
  #emitFrame: RemoteSurfaceFrameEmitter = () => false;

  constructor(
    adapters: Partial<
      Record<RemoteSurfaceConfiguration["kind"], RemoteSurfaceAdapter>
    > = {},
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
      const adapter = this.#adapters[command.configuration.kind];
      if (!adapter) {
        throw new Error(
          `Worker does not support ${command.configuration.kind} Remote Surfaces.`,
        );
      }
      const session = await adapter.open(
        command,
        (attachmentId, channel, payload) =>
          this.emit(command.surfaceId, attachmentId, channel, payload),
      );
      managed = { attachments: new Map(), session };
      this.#sessions.set(command.surfaceId, managed);
    } else if (
      managed.session.configuration.kind !== command.configuration.kind
    ) {
      throw new Error(
        "Remote Surface kind changed while its session was live.",
      );
    }

    const attachment = {
      id: command.attachmentId,
      viewport: command.viewport,
    };
    managed.attachments.set(command.attachmentId, {
      lastInboundSequence: -1,
    });
    try {
      await managed.session.attach(attachment);
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
    return { accepted: true, transport: managed.session.transport };
  }

  async detach(surfaceId: string, attachmentId: string): Promise<void> {
    const managed = this.#sessions.get(surfaceId);
    if (!managed?.attachments.delete(attachmentId)) return;
    this.#outboundSequences.delete(`${surfaceId}:${attachmentId}`);
    await managed.session.detach(attachmentId);
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
    await managed.session.close();
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.#sessions.keys()].map((surfaceId) => this.close(surfaceId)),
    );
  }

  async handleFrame(
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

  private emit(
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
