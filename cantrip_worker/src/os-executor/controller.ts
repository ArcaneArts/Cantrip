import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  cantripOsObservedInstanceSchema,
  cantripOsOperationResultSchema,
  cantripOsSourceReceiptSchema,
  cantripOsWorkspaceObservationSchema,
  type CantripOsDispatchScope,
  type CantripOsSourceDispatchScope,
  type CantripOsProvisionIntent,
  type WorkerCommand,
} from "@cantrip/protocol";
import { LocalDocker, sourceMounts } from "@cantrip/os-host";
import {
  executorControl,
  workspaceControl,
  OsExecutorConnection,
  type OsExecutorBinding,
  type OsExecutorTransport,
} from "./connection.js";
import {
  inspectLinuxSource,
  provisionLinuxSource,
  type LinuxSourceReceipt,
} from "./checkouts.js";
import { installLinkedSource } from "./linked.js";
import { OsOperationStore, type OsOperationRecord } from "./operations.js";
import { guestFileUri } from "./paths.js";

type WireCommand = Extract<WorkerCommand, { type: `cantrip-os.${string}` }>;
type Provision = Extract<WireCommand, { type: "cantrip-os.source.provision" }>;
type Command =
  | Exclude<WireCommand, Provision>
  | (Omit<Provision, "protectedRequest"> & {
      intent: CantripOsProvisionIntent;
    });
interface Status {
  service: string;
  instance_id: string;
  generation: string;
  attachment: { owner_id: string; worker_id: string } | null;
}
interface GuestWorkspace {
  id: string;
  uid: number;
  gid: number;
  home: string;
}
const workspace = (record: GuestWorkspace) =>
  cantripOsWorkspaceObservationSchema.parse({
    guestWorkspaceId: record.id,
    uid: record.uid,
    gid: record.gid,
    homeGuestPath: record.home,
  });
const sourceMetadata = (source: LinuxSourceReceipt) => ({
  head: source.head,
  branch: source.branch,
  detached: source.detached,
  repositoryFingerprint: source.repositoryFingerprint,
  gitCommonGuestPath: source.gitCommonGuestPath,
});

/** The authenticated owning Server admits these administrative commands.
 * The worker retains connection capabilities and native process provenance. */
export class CantripOsController {
  readonly operations: OsOperationStore;
  constructor(
    directory: string,
    private readonly workerId: string,
  ) {
    this.operations = new OsOperationStore(directory);
  }

  private async status(transport: OsExecutorTransport) {
    const status = await executorControl<Status>(transport, ["status"]);
    if (status.service !== "running")
      throw new Error(
        "The optional CantripOS executor is disabled or unavailable.",
      );
    return status;
  }

  private async assertScope(
    transport: OsExecutorTransport,
    scope: CantripOsDispatchScope,
    attached = true,
  ) {
    if (scope.workerId !== this.workerId)
      throw new Error("The OS command belongs to a different worker.");
    const status = await this.status(transport);
    if (
      status.instance_id !== scope.guestInstanceId ||
      status.generation !== scope.runtimeGeneration ||
      (attached &&
        (status.attachment?.owner_id !== scope.ownerId ||
          status.attachment?.worker_id !== scope.workerId))
    ) {
      throw new Error(
        "The OS attachment/runtime changed; refresh its intended placement.",
      );
    }
    return status;
  }

  private async observed(transport: OsExecutorTransport) {
    const status = await this.status(transport);
    const records = await workspaceControl<GuestWorkspace[]>(transport, [
      "list",
    ]);
    return cantripOsObservedInstanceSchema.parse({
      guestInstanceId: status.instance_id,
      runtimeGeneration: status.generation,
      attachment: status.attachment
        ? {
            ownerId: status.attachment.owner_id,
            workerId: status.attachment.worker_id,
          }
        : null,
      workspaces: records.map(workspace),
    });
  }

  private async open(
    transport: OsExecutorTransport,
    scope: CantripOsSourceDispatchScope,
  ) {
    const binding = await executorControl<OsExecutorBinding>(transport, [
      "open",
      scope.guestWorkspaceId,
    ]);
    if (
      binding.instance_id !== scope.guestInstanceId ||
      binding.generation !== scope.runtimeGeneration ||
      binding.owner_id !== scope.ownerId ||
      binding.worker_id !== scope.workerId ||
      binding.workspace_id !== scope.guestWorkspaceId ||
      binding.uid !== scope.uid ||
      binding.home !== scope.homeGuestPath
    ) {
      throw new Error("The selected OS workspace identity changed.");
    }
    return binding;
  }

  private async connection(
    transport: OsExecutorTransport,
    scope: CantripOsSourceDispatchScope,
  ) {
    const binding = await this.open(transport, scope);
    const connection = new OsExecutorConnection(transport, binding);
    try {
      const initialized = await connection.request<{ sessionId: string }>(
        "initialize",
        {
          clientName: "cantrip-source-dispatch",
          resumeSessionId: null,
        },
      );
      connection.notify("initialized");
      return { connection, binding, sessionId: initialized.sessionId };
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  private result(record: OsOperationRecord) {
    // Private scope/argv/transport/session records never leave the worker.
    return cantripOsOperationResultSchema.parse({
      operationId: record.operationId,
      state: record.state,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      error: record.error
        ? record.state === "unknown"
          ? "OS delivery is unknown; inspect this operation before retrying."
          : "The OS operation failed; inspect its worker diagnostics."
        : null,
      receipt: record.receipt,
    });
  }

  async handle(command: Command) {
    const workerId =
      "scope" in command ? command.scope.workerId : command.workerId;
    if (workerId !== this.workerId)
      throw new Error("The OS command belongs to a different worker.");
    switch (command.type) {
      case "cantrip-os.inspect":
        return this.observed(command.transport);
      case "cantrip-os.attach": {
        await this.assertScope(command.transport, command.scope, false);
        await executorControl(command.transport, [
          "attach",
          command.scope.ownerId,
          this.workerId,
        ]);
        await this.assertScope(command.transport, command.scope);
        return this.observed(command.transport);
      }
      case "cantrip-os.workspaces.list": {
        await this.assertScope(command.transport, command.scope);
        return (
          await workspaceControl<GuestWorkspace[]>(command.transport, ["list"])
        ).map(workspace);
      }
      case "cantrip-os.workspaces.create": {
        await this.assertScope(command.transport, command.scope);
        return this.result(
          await this.operations.execute(
            command.scope,
            command.operationId,
            command.type,
            { guestWorkspaceId: command.guestWorkspaceId },
            async () => ({
              kind: "workspace",
              workspace: workspace(
                await workspaceControl<GuestWorkspace>(command.transport, [
                  "create",
                  command.guestWorkspaceId,
                ]),
              ),
            }),
          ),
        );
      }
      case "cantrip-os.operation.inspect": {
        const record = await this.operations.inspect(
          command.scope,
          command.operationId,
        );
        return record ? this.result(record) : null;
      }
      case "cantrip-os.source.provision": {
        const { scope, transport, intent } = command;
        await this.assertScope(transport, scope);
        if (scope.mode !== intent.mode)
          throw new Error("Source mode changed after admission.");
        if (
          intent.mode === "linux-owned" &&
          intent.source.kind !== scope.sourceKind
        )
          throw new Error("Source kind changed after admission.");
        return this.result(
          await this.operations.execute(
            scope,
            command.operationId,
            command.type,
            intent,
            async (record, save, journalPath) => {
              if (intent.mode === "linked" && scope.mode === "linked") {
                if (
                  transport.kind !== "docker" ||
                  intent.workerPath !== scope.linkedWorkerPath ||
                  !isDeepStrictEqual(
                    intent.dependencyOverlays,
                    scope.dependencyOverlays,
                  )
                )
                  throw new Error(
                    "Linked mount admission does not match its canonical source.",
                  );
                const actual = await installLinkedSource({
                  container: transport.container,
                  expected: await this.open(transport, scope),
                  mount: {
                    id: scope.bindingId,
                    cacheKey: `${scope.projectSourceId}:${scope.worktreeId}:${scope.workspaceId}`,
                    workerPath: scope.linkedWorkerPath,
                    guestPath: scope.guestPath,
                    dependencyOverlays: intent.dependencyOverlays,
                  },
                  operationId: command.operationId,
                  journalPath,
                });
                return {
                  kind: "source",
                  source: cantripOsSourceReceiptSchema.parse({
                    bindingId: actual.bindingId,
                    guestPath: actual.guestPath,
                    runtimeGeneration: actual.runtimeGeneration,
                    uid: actual.uid,
                    homeGuestPath: actual.homeGuestPath,
                    recreated: actual.recreated,
                    dependencyOverlays: actual.dependencyOverlays,
                    cleanupWarnings: actual.cleanupWarnings,
                    workspaceId: scope.workspaceId,
                    guestWorkspaceId: scope.guestWorkspaceId,
                    mode: scope.mode,
                    interruptedGuestWorkspaces: actual.interruptedWorkspaces,
                    head: null,
                    branch: null,
                    detached: false,
                    repositoryFingerprint: null,
                    gitCommonGuestPath: null,
                  }),
                };
              }
              if (
                intent.mode !== "linux-owned" ||
                scope.mode !== "linux-owned" ||
                scope.dependencyOverlays.length
              )
                throw new Error(
                  "Linux-owned provisioning requires its selected Linux source.",
                );
              const { connection, binding, sessionId } = await this.connection(
                transport,
                scope,
              );
              record.native = { binding, sessionId };
              await save();
              try {
                const source = await provisionLinuxSource(
                  connection,
                  {
                    sourceId: scope.projectSourceId,
                    operationId: command.operationId,
                    guestPath: scope.guestPath,
                    sourceKind: intent.source.kind,
                    repositoryUrl:
                      intent.source.kind === "git"
                        ? intent.source.repositoryUrl
                        : null,
                    revision:
                      intent.source.kind === "git"
                        ? intent.source.revision
                        : null,
                  },
                  {
                    prepared: async (processId, argv) => {
                      record.processes.push({ processId, argv });
                      await save();
                    },
                  },
                );
                return {
                  kind: "source",
                  source: cantripOsSourceReceiptSchema.parse({
                    ...sourceMetadata(source),
                    guestPath: source.guestPath,
                    bindingId: scope.bindingId,
                    workspaceId: scope.workspaceId,
                    guestWorkspaceId: scope.guestWorkspaceId,
                    mode: scope.mode,
                    runtimeGeneration: binding.generation,
                    uid: binding.uid,
                    homeGuestPath: binding.home,
                    recreated: false,
                    interruptedGuestWorkspaces: [],
                    dependencyOverlays: [],
                    cleanupWarnings: [],
                  }),
                };
              } finally {
                await connection.close();
              }
            },
          ),
        );
      }
      case "cantrip-os.source.inspect": {
        const { scope, transport } = command;
        if (command.sourceKind !== scope.sourceKind)
          throw new Error("Source kind changed after admission.");
        await this.assertScope(transport, scope);
        if (scope.mode === "linked") {
          if (transport.kind !== "docker")
            throw new Error(
              "Linked sources require the owning local Docker instance.",
            );
          const engine = await LocalDocker.current();
          const mount = sourceMounts(
            await engine.inspect(transport.container),
            scope.guestInstanceId,
          ).find((entry) => entry.id === scope.bindingId);
          if (
            !mount ||
            mount.workerPath !== (await realpath(scope.linkedWorkerPath)) ||
            mount.guestPath !== scope.guestPath ||
            !isDeepStrictEqual(
              mount.dependencyOverlays,
              scope.dependencyOverlays,
            )
          )
            throw new Error("The intended Docker source mount is unavailable.");
        }
        const { connection, binding } = await this.connection(transport, scope);
        try {
          const source =
            scope.mode === "linux-owned"
              ? await inspectLinuxSource(connection, {
                  sourceId: scope.projectSourceId,
                  guestPath: scope.guestPath,
                  sourceKind: command.sourceKind,
                })
              : null;
          if (source && source.guestPath !== scope.guestPath)
            throw new Error("The source's canonical Linux location changed.");
          if (!source) {
            const metadata = await connection.request<{ isDirectory: boolean }>(
              "fs/getMetadata",
              { path: guestFileUri(scope.guestPath), sandbox: null },
            );
            if (!metadata.isDirectory)
              throw new Error("The linked source is not a directory.");
          }
          return cantripOsSourceReceiptSchema.parse({
            ...(source
              ? sourceMetadata(source)
              : {
                  head: null,
                  branch: null,
                  detached: false,
                  repositoryFingerprint: null,
                  gitCommonGuestPath: null,
                }),
            bindingId: scope.bindingId,
            workspaceId: scope.workspaceId,
            guestWorkspaceId: scope.guestWorkspaceId,
            mode: scope.mode,
            guestPath: scope.guestPath,
            runtimeGeneration: binding.generation,
            uid: binding.uid,
            homeGuestPath: binding.home,
            recreated: false,
            interruptedGuestWorkspaces: [],
            dependencyOverlays: scope.dependencyOverlays,
            cleanupWarnings: [],
          });
        } finally {
          await connection.close();
        }
      }
    }
  }
}
