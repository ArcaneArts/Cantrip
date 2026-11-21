import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type {
  RemoteSurfaceConfiguration,
  WorkerCommand,
} from "@cantrip/protocol";
import type { CuaServiceLease } from "../computer-use/service.js";
import type { OsCuaServices } from "../os-executor/computer-use.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import type {
  RemoteSurfaceAdapter,
  RemoteSurfaceSession,
  RemoteSurfacePrivateState,
} from "../remote-surface-manager.js";
import { CuaDesktopFrameSource } from "./cua-frame-source.js";
import { ManagedDesktopRemoteSurfaceSession } from "./desktop-adapter.js";
import { openRemoteDesktopPersistentPrivateState } from "./desktop-private-state.js";
import type { DesktopAutomationClient } from "./automation-client.js";
import { OsDesktopInput } from "./os-desktop-input.js";

type Command = Extract<WorkerCommand, { type: "surface.attach" }>;

/** A cached surface acquires native resources only while viewers are attached.
 * Its immutable Server capture never follows a replacement guest generation. */
export class OsDesktopSession implements RemoteSurfaceSession {
  readonly transport = "websocket" as const;
  readonly configuration: Extract<
    RemoteSurfaceConfiguration,
    { kind: "desktop" }
  >;
  private inner: ManagedDesktopRemoteSurfaceSession | null = null;
  private lease: CuaServiceLease | null = null;
  private input: OsDesktopInput | null = null;
  private queue = Promise.resolve<unknown>(undefined);
  private readonly attachments = new Set<string>();
  private readonly lifetime = new AbortController();
  private closed = false;
  private suspended = false;
  constructor(
    private command: Command,
    private readonly emit: Parameters<RemoteSurfaceAdapter["open"]>[1],
    private readonly services: Pick<OsCuaServices, "acquireExecution">,
    private readonly encryption: WorkerEncryptionService,
    private readonly workerId: string,
  ) {
    if (
      command.configuration.kind !== "desktop" ||
      !command.configuration.osSource?.desktopGeneration ||
      !command.osExecution
    )
      throw new Error(
        "Linux desktop execution is unavailable; no Host fallback was attempted.",
      );
    const scope = command.osExecution.scope;
    if (
      scope.workerId !== workerId ||
      scope.ownerId !== encryption.ownerId() ||
      scope.projectId !== command.projectId
    )
      throw new Error(
        "Linux desktop execution belongs to another owner, project or Worker.",
      );
    this.configuration = structuredClone(command.configuration);
    this.command = structuredClone(command);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(work);
    this.queue = result;
    return result;
  }
  private async initialize() {
    if (this.closed) throw new Error("Linux desktop viewer is closed.");
    if (this.inner) return this.inner;
    const command = this.command;
    if (
      !command.stateProtection ||
      !command.stateResource ||
      !command.stateRevision
    )
      throw new Error("Linux desktop protected state is unavailable.");
    const initialTarget = await openRemoteDesktopPersistentPrivateState({
      ownerId: this.encryption.ownerId(),
      service: this.encryption,
      surfaceId: command.surfaceId,
      state: {
        serverId: command.serverId,
        stateProtection: command.stateProtection,
        stateResource: command.stateResource,
        stateRevision: command.stateRevision,
      },
    });
    if (initialTarget.kind !== "monitor")
      throw new Error("Linux workspace viewing requires its assigned display.");
    const lease = await this.services.acquireExecution(
      command.serverId,
      command.osExecution!,
      this.lifetime.signal,
      this.configuration.osSource!.desktopGeneration,
    );
    this.lease = lease;
    try {
      this.lifetime.signal.throwIfAborted();
      const source = new CuaDesktopFrameSource(lease.service.captures, {
        workerId: this.workerId,
        surfaceId: command.surfaceId,
        attachmentId: command.surfaceId,
        participantId: "remote-capture",
      });
      this.input = new OsDesktopInput({
        workerId: this.workerId,
        surfaceId: command.surfaceId,
        service: lease.service,
        emit: this.emit,
        target: async () => {
          const target = (await source.inventory()).monitors[0];
          if (!target)
            throw new Error("The assigned Linux desktop is unavailable.");
          return { kind: "monitor", id: target.id, name: target.name };
        },
      });
      // Any accidental compatibility path fails here, without touching Host.
      const client = new Proxy({} as DesktopAutomationClient, {
        get: () => async () => {
          throw new Error(
            "Host desktop operations are unavailable for a Linux workspace.",
          );
        },
      });
      this.inner = new ManagedDesktopRemoteSurfaceSession({
        client,
        viewOnly: true,
        configuration: this.configuration,
        sharedCapture: true,
        createFramePipeline: (target) => source.open(target),
        display: { width: 1, height: 1 },
        emit: (id, channel, payload) => {
          if (channel === "control") {
            const message = JSON.parse(new TextDecoder().decode(payload));
            if (message.type === "desktop-input") return true;
            if (message.type === "desktop-state")
              this.input?.size(message.width, message.height);
          }
          return this.emit(id, channel, payload);
        },
        framePipeline: null,
        launchApplication: async () => {
          throw new Error("Use the assigned workspace to launch applications.");
        },
        listTargets: () => source.inventory(),
        applicationIcons: null,
        initialTarget,
        ownerId: this.encryption.ownerId(),
        serverId: command.serverId,
        surfacePrivateState: this.encryption,
        stateRevision: command.stateRevision,
        streamSettings: command.desktopStream ?? {
          targetFps: 15,
          quality: "adaptive",
        },
        surfaceId: command.surfaceId,
      });
      if (this.suspended) {
        this.inner.suspend();
        await this.input.suspend();
      }
      return this.inner;
    } catch (error) {
      await this.release();
      throw error;
    }
  }
  attach: RemoteSurfaceSession["attach"] = (attachment) =>
    this.serial(async () => {
      const session = await this.initialize();
      try {
        await session.attach(attachment);
        this.attachments.add(attachment.id);
        this.input?.attach(attachment.id);
      } catch (error) {
        session.detach(attachment.id);
        if (!this.attachments.size) await this.release();
        throw error;
      }
    });
  detach: RemoteSurfaceSession["detach"] = (id) =>
    this.serial(async () => {
      try {
        await this.input?.detach(id);
      } finally {
        this.inner?.detach(id);
        this.attachments.delete(id);
        if (!this.attachments.size) await this.release();
      }
    });
  handleFrame: RemoteSurfaceSession["handleFrame"] = async (
    id,
    channel,
    payload,
  ) => {
    if (channel === "control" && (await this.input?.handle(id, payload)))
      return;
    await this.inner?.handleFrame(id, channel, payload);
  };
  updateConfiguration(
    configuration: RemoteSurfaceConfiguration,
    state: RemoteSurfacePrivateState | null,
  ) {
    return this.serial(async () => {
      if (
        configuration.kind !== "desktop" ||
        !isDeepStrictEqual(configuration.osSource, this.configuration.osSource)
      )
        throw new Error("A Linux desktop viewer cannot be retargeted.");
      if (!state)
        throw new Error("Linux desktop protected state is unavailable.");
      const target = await openRemoteDesktopPersistentPrivateState({
        ownerId: this.encryption.ownerId(),
        service: this.encryption,
        surfaceId: this.command.surfaceId,
        state,
      });
      if (target.kind !== "monitor")
        throw new Error(
          "Linux workspace viewing requires its assigned display.",
        );
      this.command = { ...this.command, ...state, configuration };
      await this.inner?.updateConfiguration(configuration, state);
    });
  }
  suspend() {
    this.suspended = true;
    void this.input?.suspend().catch(() => {});
    this.inner?.suspend();
  }
  resume() {
    this.suspended = false;
    this.input?.resume();
    this.inner?.resume();
  }
  private async release() {
    const input = this.input;
    this.input = null;
    try {
      await input?.close();
    } finally {
      this.inner?.close();
      this.inner = null;
      const lease = this.lease;
      this.lease = null;
      await lease?.release();
    }
  }
  close() {
    this.closed = true;
    this.lifetime.abort();
    const inputClosed = this.input?.close();
    return this.serial(async () => {
      this.attachments.clear();
      try {
        await inputClosed;
      } finally {
        await this.release();
      }
    });
  }
}

/** Opening a new view observes its actual X11 desktop before capturing identity. */
export async function prepareOsDesktop(
  command: Extract<WorkerCommand, { type: "surface.desktop.os-prepare" }>,
  services: Pick<OsCuaServices, "acquireExecution">,
  encryption: WorkerEncryptionService,
  workerId: string,
) {
  if (
    command.osExecution.scope.workerId !== workerId ||
    command.osExecution.scope.ownerId !== encryption.ownerId() ||
    command.osExecution.scope.projectId !== command.projectId
  )
    throw new Error(
      "Linux desktop execution belongs to another owner, project or Worker.",
    );
  const lease = await services.acquireExecution(
    command.serverId,
    command.osExecution,
    new AbortController().signal,
  );
  try {
    const targets = await lease.service.captures.inventory({
      workerId,
      surfaceId: "desktop-preparation",
      attachmentId: randomUUID(),
      participantId: "desktop-preparation",
    });
    if (!targets.some((target) => target.kind === "monitor"))
      throw new Error("The assigned Linux display is unavailable.");
    return { desktopGeneration: lease.desktopGeneration };
  } finally {
    await lease.release();
  }
}
