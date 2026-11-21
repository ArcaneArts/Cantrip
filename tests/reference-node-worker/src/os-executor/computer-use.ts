import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  cantripOsDesktopPlacement,
  type CantripOsExecution,
} from "@cantrip/protocol";
import type { CuaPreviewAuthority } from "@cantrip/protocol/computer-use-preview";
import {
  CantripCuaService,
  CuaServiceError,
  type CuaServiceLease,
} from "../computer-use/service.js";
import { CuaAuthorizationError } from "../computer-use/handler.js";
import {
  remoteCommand,
  remoteControl,
  type OsExecutorTransport,
} from "./connection.js";
import type { OsAgentPlacements } from "./agent-placements.js";

const desktopSchema = z.strictObject({
  instance_id: z.uuid(),
  generation: z.uuid(),
  owner_id: z.string(),
  worker_id: z.string(),
  workspace_id: z.string(),
  desktop_generation: z.string().regex(/^[a-f0-9]{64}$/),
  remote_generation: z.uuid(),
  uid: z.number().int().positive(),
  gid: z.number().int().positive(),
  home: z.string(),
  user: z.string(),
  display: z.number().int().min(0).max(65535),
});
type Desktop = z.infer<typeof desktopSchema>;
interface Entry {
  context: Desktop;
  connectionId: string;
  service: CantripCuaService;
  transport: OsExecutorTransport;
  owners: Set<symbol>;
}
interface Options {
  workerId: string;
  host: CantripCuaService;
  placements: Pick<OsAgentPlacements, "resolve">;
  control?: typeof remoteControl;
  create?: (command: ReturnType<typeof remoteCommand>) => CantripCuaService;
}

/** Share one native connection per explicitly assigned desktop. Command/preview
 * leases pin that connection; replacement never redirects an existing lease. */
export class OsCuaServices {
  private entries = new Map<string, Entry>();
  private queues = new Map<string, Promise<unknown>>();
  private connected = true;
  private closed = false;
  private lifetime = new AbortController();
  constructor(private readonly options: Options) {}

  private serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(action);
    this.queues.set(key, pending);
    void pending
      .finally(() => {
        if (this.queues.get(key) === pending) this.queues.delete(key);
      })
      .catch(() => {});
    return pending;
  }
  private active(signal?: AbortSignal) {
    if (this.closed) throw new CuaServiceError("closed");
    if (!this.connected) throw new CuaServiceError("disconnected");
    signal?.throwIfAborted();
  }
  private placement(
    authority: CuaPreviewAuthority,
  ): CantripOsExecution | undefined {
    if (authority.workerId !== this.options.workerId)
      throw new CuaAuthorizationError("ownership-mismatch");
    const captured = this.options.placements.resolve(authority);
    if (
      !isDeepStrictEqual(
        captured && cantripOsDesktopPlacement(captured),
        authority.osPlacement,
      ) ||
      (captured &&
        (authority.contextKind !== "project" ||
          captured.scope.ownerId !== authority.ownerId ||
          captured.scope.workerId !== authority.workerId ||
          captured.scope.projectId !== authority.projectId ||
          captured.scope.worktreeId !== authority.placementId))
    ) {
      throw new CuaAuthorizationError("ownership-mismatch");
    }
    return captured;
  }
  async acquire(
    authority: CuaPreviewAuthority,
    signal: AbortSignal,
  ): Promise<CuaServiceLease> {
    this.active(signal);
    const execution = this.placement(authority);
    if (!execution)
      return { service: this.options.host, release: async () => {} };
    return this.acquireExecution(authority.serverId, execution, signal);
  }
  /** Called only with Server-admitted surface execution, never browser paths. */
  async acquireExecution(
    serverId: string,
    execution: CantripOsExecution,
    signal: AbortSignal,
    expectedDesktopGeneration?: string,
  ): Promise<CuaServiceLease & { desktopGeneration: string }> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    this.active(signal);
    const { scope, transport } = execution;
    if (scope.workerId !== this.options.workerId)
      throw new CuaAuthorizationError("ownership-mismatch");
    const key = JSON.stringify([
      serverId,
      scope.ownerId,
      scope.workerId,
      scope.instanceId,
      scope.workspaceId,
    ]);
    return this.serial(key, async () => {
      this.active(signal);
      const control = this.options.control ?? remoteControl;
      const context = desktopSchema.parse(
        await control<unknown>(
          transport,
          [
            "open",
            scope.guestWorkspaceId,
            "--expect-placement",
            JSON.stringify({
              instance_id: scope.guestInstanceId,
              generation: scope.runtimeGeneration,
              owner_id: scope.ownerId,
              worker_id: scope.workerId,
              workspace_id: scope.guestWorkspaceId,
              uid: scope.uid,
              gid: scope.gid,
              home: scope.homeGuestPath,
              ...(expectedDesktopGeneration
                ? { desktop_generation: expectedDesktopGeneration }
                : {}),
            }),
          ],
          signal,
        ),
      );
      this.active(signal);
      if (
        context.instance_id !== scope.guestInstanceId ||
        context.generation !== scope.runtimeGeneration ||
        context.owner_id !== scope.ownerId ||
        context.worker_id !== scope.workerId ||
        context.workspace_id !== scope.guestWorkspaceId ||
        context.uid !== scope.uid ||
        context.gid !== scope.gid ||
        context.home !== scope.homeGuestPath ||
        (expectedDesktopGeneration !== undefined &&
          context.desktop_generation !== expectedDesktopGeneration)
      ) {
        throw new CuaAuthorizationError("ownership-mismatch");
      }
      let entry = this.entries.get(key);
      if (
        entry &&
        (!isDeepStrictEqual(entry.context, context) ||
          entry.service.status().state === "closed")
      ) {
        await entry.service.close();
        // A replacement root manager fences its predecessor using the guardian's
        // live workspace lock. Never send old cleanup into that new generation.
        if (entry.context.remote_generation === context.remote_generation)
          await this.retire(entry);
        this.entries.delete(key);
        entry = undefined;
      }
      this.active(signal);
      if (!entry) {
        const connectionId = randomUUID();
        const command = remoteCommand(transport, [
          "connect",
          context.workspace_id,
          "--expect",
          JSON.stringify(context),
          "--connection-id",
          connectionId,
        ]);
        const service =
          this.options.create?.(command) ??
          new CantripCuaService({
            workerId: this.options.workerId,
            binary: command.command,
            args: command.args,
            allowMonitorInput: true,
          });
        entry = {
          service,
          context,
          transport,
          connectionId,
          owners: new Set(),
        };
        this.entries.set(key, entry);
      }
      const owned = entry;
      const owner = Symbol("CUA desktop lease");
      owned.owners.add(owner);
      return {
        desktopGeneration: owned.context.desktop_generation,
        service: owned.service,
        release: () =>
          this.serial(key, async () => {
            if (!owned.owners.delete(owner) || owned.owners.size) return;
            if (this.entries.get(key) !== owned) return;
            await this.retire(owned);
            this.entries.delete(key);
          }),
      };
    });
  }
  private async retire(entry: Entry) {
    await entry.service.close();
    if (!this.connected || this.closed) return;
    await (this.options.control ?? remoteControl)(
      entry.transport,
      [
        "close",
        entry.context.workspace_id,
        "--expect",
        JSON.stringify(entry.context),
        "--connection-id",
        entry.connectionId,
      ],
      this.lifetime.signal,
    );
  }
  cancelChat(chatId: string, threadId?: string | null) {
    this.options.host.cancelChat(chatId, threadId);
    for (const entry of this.entries.values())
      entry.service.cancelChat(chatId, threadId);
  }
  cancelThread(threadId: string) {
    this.options.host.cancelThread(threadId);
    for (const entry of this.entries.values())
      entry.service.cancelThread(threadId);
  }
  disconnect() {
    this.connected = false;
    this.lifetime.abort();
    this.options.host.disconnect();
    for (const entry of this.entries.values()) entry.service.disconnect();
  }
  reconnect() {
    if (this.closed) return;
    if (!this.connected) this.lifetime = new AbortController();
    this.connected = true;
    this.options.host.reconnect();
    for (const entry of this.entries.values()) entry.service.reconnect();
  }
  async close() {
    this.closed = true;
    this.disconnect();
    await Promise.allSettled([...this.queues.values()]);
    await Promise.allSettled([
      this.options.host.close(),
      ...[...this.entries.values()].map((entry) => this.retire(entry)),
    ]);
    this.entries.clear();
  }
}
