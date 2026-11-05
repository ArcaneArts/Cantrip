import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { tunnelOsPrepareResultSchema } from "@cantrip/protocol";
import type {
  CantripOsExecution,
  WorkerCommand,
  InstalledWorkerLinkGrant,
  WorkerLinkSession,
} from "@cantrip/protocol";
import type {
  ProtectedTunnelContentRecord,
  TunnelContentRecord,
} from "@cantrip/protocol/tunnel-content";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import { openWorkerTunnelContentRecord } from "../tunnel-content-encryption.js";
import { remoteControl } from "./connection.js";
import { workerLogger, workerLogErrorIdentity } from "../logger.js";
import { OsServiceStream } from "./service-stream.js";
import { OsReverseForward } from "./reverse-forward.js";
import { tunnelContentOsSource } from "@cantrip/protocol/tunnel-content";
import { OsVncControls } from "./vnc-control.js";
import type { OsCuaServices } from "./computer-use.js";

type Prepare = Extract<WorkerCommand, { type: "surface.tunnel.os-prepare" }>;
const descriptorSchema = z.strictObject({
  instance_id: z.uuid(),
  generation: z.uuid(),
  owner_id: z.string(),
  worker_id: z.string(),
  workspace_id: z.string(),
  uid: z.number().int().positive(),
  gid: z.number().int().positive(),
  home: z.string().min(1),
  user: z.string().min(1),
  remote_generation: z.uuid(),
  service: z.union([
    z.strictObject({
      kind: z.literal("tcp"),
      port: z.number().int().min(1).max(65_535),
    }),
    z.strictObject({ kind: z.literal("ssh") }),
    z.strictObject({ kind: z.literal("vnc") }),
    z.strictObject({
      kind: z.literal("listen"),
      port: z.number().int().min(1).max(65_535),
    }),
  ]),
  display: z.number().int().min(0).max(65535).optional(),
  desktop_generation: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  ssh_host_key: tunnelOsPrepareResultSchema.shape.ssh
    .unwrap()
    .shape.hostKey.optional(),
});
type Request =
  | { kind: "tcp"; port: number }
  | { kind: "ssh"; publicKey: string }
  | { kind: "vnc" }
  | {
      kind: "listen";
      port: number;
      target: { host: "127.0.0.1" | "localhost" | "::1"; port: number };
    };
interface Entry {
  command: Prepare;
  descriptor: z.infer<typeof descriptorSchema>;
  identity: string;
  active: boolean;
  timer: ReturnType<typeof setTimeout>;
  streams: Set<OsServiceStream>;
  abort: AbortController;
  openings: Set<Promise<OsServiceStream>>;
  listener?: {
    stream: OsServiceStream;
    target: { host: "127.0.0.1" | "localhost" | "::1"; port: number };
    forward?: OsReverseForward;
    activation?: Promise<{ closed: Promise<void> }>;
  };
}

/** Server-admitted source captures. Browser frames cannot create these entries. */
export class OsTunnelServices {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<
    string,
    { grantId: string; abort: AbortController }
  >();
  private connected = true;
  private readonly vnc: OsVncControls;

  constructor(
    private readonly encryption: WorkerEncryptionService,
    private readonly workerId: string,
    cua?: () => Pick<OsCuaServices, "acquireExecution">,
  ) {
    this.vnc = new OsVncControls(cua, (identity) =>
      this.describe(identity.osExecution, { kind: "vnc" }),
    );
  }

  async prepare(command: Prepare) {
    const scope = command.osExecution.scope;
    if (
      !this.connected ||
      command.serverId !== this.encryption.serverIdentity() ||
      scope.ownerId !== this.encryption.ownerId() ||
      scope.workerId !== this.workerId ||
      command.projectId !== scope.projectId ||
      Date.parse(command.expiresAt) <= Date.now()
    )
      throw new Error(
        "The OS tunnel preparation does not match this Worker authority.",
      );
    const pending = { grantId: command.grantId, abort: new AbortController() };
    this.pending.get(command.attachmentId)?.abort.abort();
    this.pending.set(command.attachmentId, pending);
    const current = () =>
      this.connected &&
      this.pending.get(command.attachmentId) === pending &&
      !pending.abort.signal.aborted;
    try {
      const content = await openWorkerTunnelContentRecord({
        record: command.protectedRecord,
        serverId: command.serverId,
        service: this.encryption,
        tunnelId: command.tunnelId,
        workerId: this.workerId,
      });
      const request = this.request(command, content);
      const service: z.infer<typeof descriptorSchema>["service"] =
        request.kind === "listen"
          ? { kind: "listen", port: request.port }
          : request.kind === "tcp"
            ? { kind: "tcp", port: request.port }
            : request.kind === "ssh"
              ? { kind: "ssh" }
              : { kind: "vnc" };
      const descriptor = await this.describe(
        command.osExecution,
        service,
        pending.abort.signal,
      );
      const ssh =
        service.kind === "ssh"
          ? tunnelOsPrepareResultSchema.shape.ssh.unwrap().parse({
              user: descriptor.user,
              hostAlias: `cantrip-os-${descriptor.instance_id}`,
              hostKey: descriptor.ssh_host_key,
            })
          : undefined;
      if (service.kind === "vnc") {
        if (!descriptor.desktop_generation || descriptor.display === undefined)
          throw new Error("The VNC service has no captured running desktop.");
        await this.vnc.reconcile(command, descriptor);
      }
      const identity = createHash("sha256")
        .update(JSON.stringify(descriptor))
        .digest("hex");
      if (
        command.expectedIdentity !== null &&
        command.expectedIdentity !== identity
      )
        throw new Error(
          "The captured guest service is retired. Stop and explicitly start a new forward.",
        );
      if (!current()) throw new Error("The OS tunnel preparation was retired.");
      const previous = this.entries.get(command.attachmentId);
      if (previous) await this.closeEntry(previous);
      if (!current()) throw new Error("The OS tunnel preparation was retired.");
      const entry: Entry = {
        command,
        descriptor,
        identity,
        active: false,
        streams: new Set(),
        abort: new AbortController(),
        openings: new Set(),
        timer: setTimeout(
          () => void this.closeBackground(entry),
          Math.max(1, Date.parse(command.expiresAt) - Date.now()),
        ),
      };
      entry.timer.unref();
      this.entries.set(command.attachmentId, entry);
      if (request.kind === "listen") {
        try {
          await this.prepareListener(entry, request.target);
          if (!current() || this.entries.get(command.attachmentId) !== entry)
            throw new Error("The guest listener preparation was retired.");
        } catch (error) {
          await this.closeEntry(entry);
          throw error;
        }
      }
      return { identity, ...(ssh ? { ssh } : {}) };
    } finally {
      if (this.pending.get(command.attachmentId) === pending)
        this.pending.delete(command.attachmentId);
    }
  }

  private async describe(
    execution: CantripOsExecution,
    service: z.infer<typeof descriptorSchema>["service"],
    signal?: AbortSignal,
  ) {
    const { scope, transport } = execution;
    const placement = {
      instance_id: scope.guestInstanceId,
      generation: scope.runtimeGeneration,
      owner_id: scope.ownerId,
      worker_id: scope.workerId,
      workspace_id: scope.guestWorkspaceId,
      uid: scope.uid,
      gid: scope.gid,
      home: scope.homeGuestPath,
    };
    const descriptor = descriptorSchema.parse(
      await remoteControl(
        transport,
        [
          "service-info",
          scope.guestWorkspaceId,
          "--service",
          JSON.stringify(service),
          "--expect-placement",
          JSON.stringify(placement),
        ],
        signal,
      ),
    );
    if (
      !Object.entries(placement).every(
        ([key, value]) => descriptor[key as keyof typeof descriptor] === value,
      )
    )
      throw new Error(
        "The guest service descriptor differs from its captured placement.",
      );
    if (!isDeepStrictEqual(descriptor.service, service))
      throw new Error(
        "The guest returned a different service than the captured destination.",
      );
    return descriptor;
  }

  private request(command: Prepare, content: TunnelContentRecord): Request {
    const scope = command.osExecution.scope;
    const capture = tunnelContentOsSource(content);
    if (
      content.destination.workerId !== this.workerId ||
      !isDeepStrictEqual(capture, {
        bindingId: scope.bindingId,
        worktreeId: scope.worktreeId,
        bindingGeneration: scope.bindingGeneration,
        attachmentGeneration: scope.attachmentGeneration,
        runtimeGeneration: scope.runtimeGeneration,
      })
    )
      throw new Error(
        "The encrypted tunnel differs from its canonical OS capture.",
      );
    if (content.source.kind === "worker-os-listener") {
      if (
        command.mode !== "listen" ||
        content.source.workerId !== this.workerId ||
        content.destination.kind !== "worker-tcp"
      )
        throw new Error(
          "The guest listener does not match its canonical direction.",
        );
      return {
        kind: "listen",
        port: content.source.port,
        target: {
          host: content.destination.host,
          port: content.destination.port,
        },
      };
    }
    if (command.mode === "listen" || content.source.kind !== "desktop-loopback")
      throw new Error(
        "The incoming guest service does not match its canonical direction.",
      );
    switch (content.destination.kind) {
      case "worker-os-tcp":
        return { kind: "tcp", port: content.destination.port };
      case "worker-os-ssh":
        return { kind: "ssh", publicKey: content.destination.publicKey };
      case "worker-os-vnc":
        return { kind: "vnc" };
      default:
        throw new Error("The guest tunnel has no captured OS destination.");
    }
  }
  private async prepareListener(
    entry: Entry,
    target: NonNullable<Entry["listener"]>["target"],
  ) {
    const stream = new OsServiceStream(
      entry.command.osExecution.transport,
      entry.command.osExecution.scope.guestWorkspaceId,
      entry.descriptor,
    );
    entry.listener = { stream, target };
    entry.streams.add(stream);
    entry.abort.signal.addEventListener("abort", () => stream.destroy(), {
      once: true,
    });
    stream.once("close", () => entry.streams.delete(stream));
    const ready = stream.ready();
    entry.openings.add(ready);
    try {
      await ready;
    } finally {
      entry.openings.delete(ready);
    }
    entry.abort.signal.throwIfAborted();
  }

  activate(grant: InstalledWorkerLinkGrant, session: WorkerLinkSession) {
    const attachmentId = grant.binding.resource.attachmentId;
    const entry = attachmentId ? this.entries.get(attachmentId) : undefined;
    if (
      !entry ||
      entry.command.grantId !== grant.binding.grantId ||
      entry.command.tunnelId !== grant.binding.resource.resourceId ||
      entry.command.serverId !== session.identity.serverId ||
      entry.command.osExecution.scope.ownerId !== session.identity.ownerId ||
      entry.command.osExecution.scope.workerId !== session.identity.workerId ||
      Date.parse(entry.command.expiresAt) <= Date.now()
    )
      throw new Error(
        "The guest tunnel grant has no matching Server preparation.",
      );
    const listening = grant.binding.operations.includes("stream:guest-listen");
    if (
      Boolean(entry.listener) !== listening ||
      listening === grant.binding.operations.includes("stream:guest-connect")
    )
      throw new Error(
        "The guest grant direction does not match its prepared service.",
      );
    if (entry.listener) {
      if (entry.listener.activation)
        throw new Error("The guest listener already has a control channel.");
      entry.listener.activation = this.activateListener(entry);
      return entry.listener.activation;
    }
    entry.active = true;
  }
  private async activateListener(entry: Entry) {
    try {
      const current = await this.describe(
        entry.command.osExecution,
        entry.descriptor.service,
        entry.abort.signal,
      );
      entry.abort.signal.throwIfAborted();
      if (
        !isDeepStrictEqual(current, entry.descriptor) ||
        this.entries.get(entry.command.attachmentId) !== entry ||
        entry.listener!.stream.destroyed ||
        Date.parse(entry.command.expiresAt) <= Date.now()
      )
        throw new Error("The prepared guest listener is retired.");
      const forward = new OsReverseForward(
        entry.listener!.stream,
        entry.listener!.target,
      );
      entry.listener!.forward = forward;
      entry.active = true;
      return { closed: forward.closed };
    } catch (error) {
      await this.closeEntry(entry);
      throw error;
    }
  }

  isGuest(attachmentId: string) {
    return this.entries.get(attachmentId)?.active === true;
  }

  async open(
    attachmentId: string,
    tunnelId: string,
    record: ProtectedTunnelContentRecord,
    content: TunnelContentRecord,
  ) {
    const entry = this.entries.get(attachmentId);
    if (
      !entry?.active ||
      entry.command.tunnelId !== tunnelId ||
      !isDeepStrictEqual(entry.command.protectedRecord, record) ||
      Date.parse(entry.command.expiresAt) <= Date.now()
    )
      throw new Error(
        "The OS tunnel connection has no current canonical grant.",
      );
    if (entry.listener)
      throw new Error("Guest listeners do not accept incoming tunnel frames.");
    const work = this.connect(entry, content);
    entry.openings.add(work);
    void work.finally(() => entry.openings.delete(work)).catch(() => {});
    return work;
  }
  private async connect(entry: Entry, content: TunnelContentRecord) {
    const request = this.request(entry.command, content);
    if (request.kind === "listen")
      throw new Error("Use the guest listener control channel.");
    const hold =
      request.kind === "vnc"
        ? await this.vnc.acquire(
            entry.command,
            entry.descriptor,
            entry.abort.signal,
          )
        : undefined;
    let stream: OsServiceStream;
    try {
      entry.abort.signal.throwIfAborted();
      stream = new OsServiceStream(
        entry.command.osExecution.transport,
        entry.command.osExecution.scope.guestWorkspaceId,
        entry.descriptor,
        request.kind === "ssh" ? request.publicKey : undefined,
      );
    } catch (error) {
      if (hold) await this.vnc.abandon(hold);
      throw error;
    }
    if (hold) this.vnc.bind(entry.command, entry.descriptor, hold, stream);
    entry.streams.add(stream);
    stream.once("close", () => entry.streams.delete(stream));
    await stream.ready();
    if (
      this.entries.get(entry.command.attachmentId) !== entry ||
      !entry.active
    ) {
      stream.destroy();
      throw new Error("The OS tunnel was retired while connecting.");
    }
    return stream;
  }

  async revoke(attachmentId: string, grantId?: string) {
    const pending = this.pending.get(attachmentId);
    if (pending && (!grantId || pending.grantId === grantId)) {
      this.pending.delete(attachmentId);
      pending.abort.abort();
    }
    const entry = this.entries.get(attachmentId);
    if (entry && (!grantId || entry.command.grantId === grantId))
      await this.closeEntry(entry);
  }
  private async closeEntry(entry: Entry) {
    entry.active = false;
    entry.listener?.forward?.close();
    entry.abort.abort();
    clearTimeout(entry.timer);
    if (this.entries.get(entry.command.attachmentId) === entry)
      this.entries.delete(entry.command.attachmentId);
    await Promise.all(
      [...entry.streams].map(
        (stream) =>
          new Promise<void>((resolve) => {
            if (stream.closed) {
              resolve();
              return;
            }
            stream.once("close", resolve);
            stream.destroy();
          }),
      ),
    );
    await Promise.allSettled([...entry.openings]);
    await this.vnc.retireAttachment(entry.command);
    if (entry.listener) {
      try {
        await entry.listener.stream.confirmRetired();
      } catch (error) {
        const current = await this.describe(
          entry.command.osExecution,
          entry.descriptor.service,
        ).catch(() => undefined);
        if (
          !current ||
          (current.remote_generation === entry.descriptor.remote_generation &&
            current.generation === entry.descriptor.generation)
        )
          throw error;
      }
    }
  }
  private closeBackground(entry: Entry) {
    return this.closeEntry(entry).catch((error: unknown) => {
      workerLogger.event("warn", "Guest tunnel cleanup remains unconfirmed", {
        event: "tunnel.guest-cleanup.unconfirmed",
        subsystem: "tunnel",
        operation: "close",
        status: "failed",
        workerId: this.workerId,
        tunnelId: entry.command.tunnelId,
        attachmentId: entry.command.attachmentId,
        ...workerLogErrorIdentity(error),
      });
    });
  }
  disconnect() {
    this.connected = false;
    for (const pending of this.pending.values()) pending.abort.abort();
    this.pending.clear();
    return Promise.all(
      [...this.entries.values()].map((entry) => this.closeBackground(entry)),
    ).then(() => {});
  }
  reconnect() {
    this.connected = true;
  }
}
