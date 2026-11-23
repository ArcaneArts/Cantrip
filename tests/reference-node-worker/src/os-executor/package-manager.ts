import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  cantripOsPackageWorkerCommandSchema,
  cantripOsPackageOperationCommandSchema,
  cantripOsPackageProbeSchema,
  cantripOsPackageCatalogResultSchema,
  cantripOsPackageOperationResultSchema,
  cantripOsGuestPackageRecordSchema,
  cantripOsPackageProtectedResultSchema,
  type CantripOsPackageWorkerCommand,
  type CantripOsPackageOperationCommand,
  type CantripOsGuestPackageRecord,
} from "@cantrip/protocol";
import {
  clearSensitiveBytes,
  encryptCantripOsPackageResult,
} from "@cantrip/crypto";
import {
  LocalDocker,
  packageControl,
  withInstanceLock,
} from "@cantrip/os-host";
import type { OsExecutorTransport } from "./connection.js";
import type { BackupKeyAccess } from "./private-backup-file.js";
import { OsOperationStore, type OsOperationRecord } from "./operations.js";
import { CantripOsPackageCatalog } from "./package-catalog.js";
import {
  packageAdmission,
  packageRequest,
  packageGuest,
  packageArguments,
  packageCryptoContext,
} from "./package-context.js";

type Scope = CantripOsPackageWorkerCommand["scope"];
type PackageOperationRecord = OsOperationRecord<Scope>;
export interface PackagePorts {
  control: (
    transport: OsExecutorTransport,
    args: string[],
    options?: Parameters<typeof packageControl>[2],
  ) => Promise<unknown>;
  docker: () => Promise<Pick<LocalDocker, "inspect">>;
}
const checkpointSchema = z
  .object({
    version: z.literal(1),
    command: cantripOsPackageOperationCommandSchema,
    phase: z.string().min(1).max(200),
    guest: cantripOsGuestPackageRecordSchema.nullable(),
  })
  .strict();
type Checkpoint = z.infer<typeof checkpointSchema>;
const protectedReceiptSchema = z
  .object({
    kind: z.literal("package-protected-result"),
    version: z.literal(1),
    admissionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    proofSha256: z.string().regex(/^[a-f0-9]{64}$/),
    protectedResult: cantripOsPackageProtectedResultSchema,
  })
  .strict();

/** External Worker administration only. Observation never uploads or starts.
 * Explicit continuation may finish immutable staging; the guest's durable claim
 * prevents a second installer even if an old carrier finishes late. */
export class CantripOsPackageManager {
  readonly operations: OsOperationStore<Scope>;
  readonly catalog: CantripOsPackageCatalog;
  constructor(
    directory: string,
    private readonly workerId: string,
    private readonly keys: BackupKeyAccess,
    catalogDirectory?: string,
    private readonly ports: PackagePorts = {
      control: packageControl,
      docker: () => LocalDocker.current(),
    },
  ) {
    this.operations = new OsOperationStore<Scope>(directory);
    this.catalog = new CantripOsPackageCatalog(directory, catalogDirectory);
  }
  private account(scope: Scope) {
    if (
      scope.workerId !== this.workerId ||
      this.keys.ownerId() !== scope.ownerId ||
      this.keys.serverIdentity() !== scope.serverId
    )
      throw new Error(
        "The package operation belongs to another Worker, account or Server",
      );
  }
  private target(command: CantripOsPackageWorkerCommand) {
    const value = command.target?.expected;
    if (
      value &&
      (value.guestInstanceId !== command.scope.guestInstanceId ||
        value.ownerId !== command.scope.ownerId ||
        value.workerId !== command.scope.workerId)
    )
      throw new Error("The package target does not match its owning admission");
  }
  private async transport(
    command: CantripOsPackageWorkerCommand,
  ): Promise<{ transport: OsExecutorTransport; containerId: string | null }> {
    if (command.transport.kind === "ssh") {
      if (command.target?.containerId)
        throw new Error("A Docker package target cannot use SSH");
      return { transport: command.transport, containerId: null };
    }
    const actual = await (
      await this.ports.docker()
    ).inspect<{ Id: string }>(command.transport.container);
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(actual.Id);
    if (command.target && command.target.containerId !== id)
      throw new Error(
        "The selected Docker instance was replaced; no replacement was used",
      );
    return { transport: { kind: "docker", container: id }, containerId: id };
  }
  private async status(
    command: Extract<
      CantripOsPackageWorkerCommand,
      { type: "cantrip-os.packages.status" }
    >,
  ) {
    const carrier = await this.transport(command);
    const probe = cantripOsPackageProbeSchema.parse(
      await this.ports.control(carrier.transport, [
        ...(command.target
          ? ["--expect", JSON.stringify(command.target.expected)]
          : []),
        "probe",
      ]),
    );
    if (
      probe.expected.guestInstanceId !== command.scope.guestInstanceId ||
      probe.expected.ownerId !== command.scope.ownerId ||
      probe.expected.workerId !== this.workerId
    )
      throw new Error(
        "The actual package target belongs to a different OS or attachment",
      );
    const same =
      command.target &&
      command.target.containerId === carrier.containerId &&
      command.target.bootId === probe.bootId &&
      command.target.initStart === probe.initStart &&
      command.target.architecture === probe.architecture &&
      isDeepStrictEqual(command.target.expected, probe.expected);
    const catalog = await this.catalog.list();
    return cantripOsPackageCatalogResultSchema.parse({
      target: {
        generation: same ? command.target!.generation : randomUUID(),
        expected: probe.expected,
        bootId: probe.bootId,
        initStart: probe.initStart,
        architecture: probe.architecture,
        containerId: carrier.containerId,
      },
      ...catalog,
      installed: probe.packages.map(
        ({ diagnostic: _diagnostic, ...item }) => item,
      ),
    });
  }
  private checkpoint(
    record: PackageOperationRecord,
    command: CantripOsPackageOperationCommand,
  ) {
    const value = checkpointSchema.parse(record.checkpoint);
    if (
      record.command !== command.type ||
      !isDeepStrictEqual(value.command, packageAdmission(command)) ||
      !isDeepStrictEqual(record.scope, command.scope)
    )
      throw new Error(
        "The saved package operation belongs to a different original admission",
      );
    return value;
  }
  private async observeOrDispatch(
    command: CantripOsPackageOperationCommand,
    checkpoint: Checkpoint,
    record: PackageOperationRecord,
    save: () => Promise<void>,
    fresh: boolean,
  ) {
    const terminal =
      checkpoint.guest && ["ready", "failed"].includes(checkpoint.guest.state);
    if (terminal) {
      this.apply(command, checkpoint, record, checkpoint.guest!);
      return;
    }
    const carrier = await this.transport(command);
    const control = (action: string, ...args: string[]) =>
      this.ports.control(
        carrier.transport,
        packageArguments(command, action, ...args),
      );
    let guest: CantripOsGuestPackageRecord;
    if (fresh && command.mode === "execute") {
      checkpoint.phase = "guest-admission-requested";
      record.checkpoint = checkpoint;
      await save();
      guest = packageGuest(
        command,
        await control("admit", JSON.stringify(packageRequest(command))),
      );
    } else
      guest = packageGuest(
        command,
        await control("inspect", command.operationId),
      );
    checkpoint.guest = guest;
    checkpoint.phase = guest.phase;
    record.checkpoint = checkpoint;
    await save();
    if (command.mode === "abandon" && guest.state === "staged")
      guest = packageGuest(
        command,
        await control("abandon", command.operationId),
      );
    if (
      ((fresh && command.mode === "execute") || command.mode === "continue") &&
      guest.state === "staged"
    ) {
      for (const artifact of command.packages) {
        if (guest.received.includes(artifact.sha256)) continue;
        const file = await this.catalog.file(artifact);
        checkpoint.phase = "artifact-transfer-requested";
        await save();
        guest = packageGuest(
          command,
          await this.ports.control(
            carrier.transport,
            packageArguments(
              command,
              "receive",
              command.operationId,
              artifact.sha256,
            ),
            { input: createReadStream(file) },
          ),
        );
        checkpoint.guest = guest;
        checkpoint.phase = guest.phase;
        await save();
      }
      checkpoint.phase = "start-requested";
      await save();
      guest = packageGuest(
        command,
        await control("start", command.operationId),
      );
    }
    this.apply(command, checkpoint, record, guest);
  }
  private apply(
    command: CantripOsPackageOperationCommand,
    checkpoint: Checkpoint,
    record: PackageOperationRecord,
    raw: CantripOsGuestPackageRecord,
  ) {
    const guest = packageGuest(command, raw);
    checkpoint.guest = guest;
    checkpoint.phase = guest.phase;
    record.checkpoint = checkpoint;
    record.state = guest.state === "staged" ? "unknown" : guest.state;
    record.error = guest.error;
  }
  private async result(
    command: CantripOsPackageOperationCommand,
    record: PackageOperationRecord,
  ) {
    const checkpoint = this.checkpoint(record, command);
    if (checkpoint.guest) packageGuest(command, checkpoint.guest);
    let protectedResult = null;
    this.account(command.scope);
    const proofSha256 = createHash("sha256")
      .update(JSON.stringify([record.state, checkpoint.guest, record.error]))
      .digest("hex");
    const cached =
      record.receipt === null
        ? null
        : protectedReceiptSchema.parse(record.receipt);
    if (cached) {
      if (
        cached.admissionFingerprint !== record.admissionFingerprint ||
        cached.proofSha256 !== proofSha256
      )
        throw new Error(
          "The protected package receipt does not match its original outcome",
        );
      protectedResult = cached.protectedResult;
    } else {
      const material = this.keys.componentKey("repository-content");
      try {
        protectedResult = await encryptCantripOsPackageResult({
          context: packageCryptoContext(command),
          keyRevision: material.keyRevision,
          componentKey: material.key,
          value: {
            version: 1,
            request: packageRequest(command),
            record: checkpoint.guest,
            diagnostic: record.error?.slice(0, 32768) ?? null,
          },
        });
        this.account(command.scope);
      } finally {
        clearSensitiveBytes(material.key);
      }
      if (["ready", "failed"].includes(record.state)) {
        const saved = await this.operations.recordTerminalReceipt(record, {
          kind: "package-protected-result",
          version: 1,
          admissionFingerprint: record.admissionFingerprint,
          proofSha256,
          protectedResult,
        });
        protectedResult = protectedReceiptSchema.parse(
          saved.receipt,
        ).protectedResult;
      }
    }
    return cantripOsPackageOperationResultSchema.parse({
      operationId: command.operationId,
      targetGeneration: command.target.generation,
      action: command.action,
      configuration: command.configuration,
      state: record.state,
      phase: checkpoint.phase,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      protectedResult,
      error: ["failed", "unknown"].includes(record.state)
        ? "Inspect the protected package outcome; uncertain installation was not repeated."
        : null,
    });
  }
  async handle(raw: CantripOsPackageWorkerCommand) {
    const command = cantripOsPackageWorkerCommandSchema.parse(raw);
    this.account(command.scope);
    this.target(command);
    const lock =
      command.transport.kind === "docker"
        ? command.transport.container
        : `ssh:${command.transport.host}:${command.transport.port}:${command.transport.user}`;
    return withInstanceLock(lock, async () => {
      if (command.type === "cantrip-os.packages.status")
        return this.status(command);
      const original = packageAdmission(command);
      packageRequest(command);
      const admitted = await this.operations.admit(
        command.scope,
        command.operationId,
        command.type,
        original,
        {
          version: 1,
          command: original,
          phase: "admitted",
          guest: null,
        } satisfies Checkpoint,
      );
      this.checkpoint(admitted.record, command);
      const record = ["ready", "failed"].includes(admitted.record.state)
        ? admitted.record
        : await this.operations.reconcile(
            command.scope,
            command.operationId,
            async (record, save) => {
              const checkpoint = this.checkpoint(record, command);
              record.checkpoint = checkpoint;
              await this.observeOrDispatch(
                command,
                checkpoint,
                record,
                save,
                admitted.fresh,
              );
            },
          );
      if (!record)
        throw new Error("The original package admission disappeared");
      return this.result(command, record);
    });
  }
}
