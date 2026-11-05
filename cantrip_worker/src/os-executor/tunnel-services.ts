import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
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
import { OsServiceStream } from "./service-stream.js";

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
  service: z.strictObject({
    kind: z.literal("tcp"),
    port: z.number().int().min(1).max(65_535),
  }),
});
interface Entry {
  command: Prepare;
  descriptor: z.infer<typeof descriptorSchema>;
  identity: string;
  active: boolean;
  timer: ReturnType<typeof setTimeout>;
  streams: Set<OsServiceStream>;
}

/** Server-admitted source captures. Browser frames cannot create these entries. */
export class OsTunnelServices {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<
    string,
    { grantId: string; abort: AbortController }
  >();
  private connected = true;

  constructor(
    private readonly encryption: WorkerEncryptionService,
    private readonly workerId: string,
  ) {}

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
      this.validateDestination(command, content);
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
          command.osExecution.transport,
          [
            "service-info",
            scope.guestWorkspaceId,
            "--service",
            JSON.stringify({ kind: "tcp", port: content.destination.port }),
            "--expect-placement",
            JSON.stringify(placement),
          ],
          pending.abort.signal,
        ),
      );
      if (
        !Object.entries(placement).every(
          ([key, value]) =>
            descriptor[key as keyof typeof descriptor] === value,
        )
      )
        throw new Error(
          "The guest service descriptor differs from its captured placement.",
        );
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
        timer: setTimeout(
          () => void this.closeEntry(entry),
          Math.max(1, Date.parse(command.expiresAt) - Date.now()),
        ),
      };
      entry.timer.unref();
      this.entries.set(command.attachmentId, entry);
      return { identity };
    } finally {
      if (this.pending.get(command.attachmentId) === pending)
        this.pending.delete(command.attachmentId);
    }
  }

  private validateDestination(
    command: Prepare,
    content: TunnelContentRecord,
  ): asserts content is TunnelContentRecord & {
    destination: Extract<
      TunnelContentRecord["destination"],
      { kind: "worker-os-tcp" }
    >;
  } {
    const scope = command.osExecution.scope;
    if (
      content.destination.kind !== "worker-os-tcp" ||
      content.destination.workerId !== this.workerId ||
      !isDeepStrictEqual(content.destination.source, {
        bindingId: scope.bindingId,
        worktreeId: scope.worktreeId,
        bindingGeneration: scope.bindingGeneration,
        attachmentGeneration: scope.attachmentGeneration,
        runtimeGeneration: scope.runtimeGeneration,
      })
    )
      throw new Error(
        "The encrypted tunnel destination differs from its canonical OS capture.",
      );
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
    entry.active = true;
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
    this.validateDestination(entry.command, content);
    const stream = new OsServiceStream(
      entry.command.osExecution.transport,
      entry.command.osExecution.scope.guestWorkspaceId,
      entry.descriptor,
    );
    entry.streams.add(stream);
    stream.once("close", () => entry.streams.delete(stream));
    await stream.ready();
    if (this.entries.get(attachmentId) !== entry || !entry.active) {
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
  }
  disconnect() {
    this.connected = false;
    for (const pending of this.pending.values()) pending.abort.abort();
    this.pending.clear();
    return Promise.all(
      [...this.entries.values()].map((entry) => this.closeEntry(entry)),
    ).then(() => {});
  }
  reconnect() {
    this.connected = true;
  }
}
