import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  LocalDocker,
  replaceSystem,
  observeSystemReplacement,
  continueSystemReplacement,
  withInstanceLock,
  type SystemReplacementInput,
  type SystemReplacementResult,
} from "@cantrip/os-host";
import {
  cantripOsSystemWorkerCommandSchema,
  cantripOsSystemStatusResultSchema,
  cantripOsSystemOperationResultSchema,
  type CantripOsSystemWorkerCommand,
  type CantripOsSystemOperationCommand,
  type CantripOsSystemScope,
  type CantripOsSystemPrivateOperationResult,
  type CantripOsSystemOperationResult,
} from "@cantrip/protocol";
import {
  clearSensitiveBytes,
  encryptCantripOsSystemOperationResult,
} from "@cantrip/crypto";
import type { BackupKeyAccess } from "./private-backup-file.js";
import { CantripOsSystemCheckpointManager } from "./system-checkpoints.js";
import { writeOsOperationRecord } from "./operation-files.js";
import {
  systemTarget,
  systemTargetAuthority,
  readSystemIdentity,
} from "./system-target.js";
import {
  admission,
  hash,
  captureAdmission,
  captureDetails,
  systemJobPaths,
  readSystemJob,
  systemOperationContext,
  type SystemJob,
} from "./system-job.js";

const privateImageLabels = (labels: Record<string, string> = {}) =>
  Object.keys(labels).some(
    (key) =>
      key === "io.cantrip.os.source-mounts" ||
      key.startsWith("io.cantrip.os.system.") ||
      key.startsWith("io.cantrip.os.replacement."),
  );

export class CantripOsSystemManager {
  readonly captures: CantripOsSystemCheckpointManager;
  constructor(
    private readonly directory: string,
    private readonly workerId: string,
    private readonly keys: BackupKeyAccess,
    private readonly docker: () => Promise<LocalDocker> = () =>
      LocalDocker.current(),
  ) {
    this.captures = new CantripOsSystemCheckpointManager(
      directory,
      workerId,
      keys,
      {
        docker,
        seal: async (input) =>
          (await import("./private-system-file.js")).sealPrivateSystem(input),
      },
    );
  }
  private account(scope: CantripOsSystemScope) {
    if (
      scope.workerId !== this.workerId ||
      this.keys.ownerId() !== scope.ownerId ||
      this.keys.serverIdentity() !== scope.serverId
    )
      throw new Error(
        "The system operation belongs to another Worker, account or Server",
      );
  }
  private sameOwner(
    scope: CantripOsSystemScope,
    other: Pick<
      CantripOsSystemScope,
      "ownerId" | "serverId" | "workerId" | "instanceId"
    >,
  ) {
    if (
      ["ownerId", "serverId", "workerId", "instanceId"].some(
        (key) =>
          scope[key as keyof typeof other] !== other[key as keyof typeof other],
      )
    )
      throw new Error("The system source belongs to another owning instance");
  }
  private paths(command: CantripOsSystemOperationCommand) {
    return systemJobPaths(this.directory, command.scope, command.operationId);
  }
  private async save(record: SystemJob, exclusive = false) {
    record.updatedAt = new Date().toISOString();
    await writeOsOperationRecord(
      this.paths(record.command).file,
      record,
      exclusive,
    );
  }
  private async status(
    command: Extract<
      CantripOsSystemWorkerCommand,
      { type: "cantrip-os.system.status" }
    >,
  ) {
    if (command.transport.kind !== "docker")
      return cantripOsSystemStatusResultSchema.parse({
        supported: false,
        target: null,
        bases: [],
        running: null,
        error:
          "System image management requires an authorized Docker management path. SSH alone does not supply it.",
      });
    const engine = await this.docker();
    let allowChangedGuest = false;
    if (command.recovery) {
      this.sameOwner(command.scope, command.recovery.scope);
      const job = await readSystemJob(this.directory, command.recovery);
      const actual = await engine.inspect<{
        Id: string;
        State: { Running: boolean };
      }>(command.transport.container);
      if (
        !job ||
        job.state !== "ready" ||
        job.command.action === "capture" ||
        job.root?.targetContainerId !== actual.Id
      )
        throw new Error(
          "No completed original system operation authorizes replacement discovery",
        );
      const identity = await readSystemIdentity(
        engine,
        actual.Id,
        job.command.target.expected.identityPath,
      ).catch(() => null);
      if (identity?.identity.attachment === null)
        return cantripOsSystemStatusResultSchema.parse({
          supported: true,
          target: null,
          bases: [],
          running: actual.State.Running,
          enrollment: {
            containerId: actual.Id,
            guestInstanceId: identity.identity.instance_id,
          },
          error:
            "The resulting system is unattached. Explicit recovery can assign it to the owning Worker.",
        });
      allowChangedGuest = true;
    }
    const current = await systemTarget(
      engine,
      command.transport.container,
      command.scope,
      command.target,
      undefined,
      allowChangedGuest,
    );
    const bases = [];
    let error: string | null = null;
    try {
      const images = await engine.request<
        Array<{
          Id: string;
          RepoTags?: string[];
          Labels?: Record<string, string>;
        }>
      >(
        "GET",
        `/images/json?filters=${encodeURIComponent(JSON.stringify({ label: ["io.cantrip.os=foundation"] }))}`,
      );
      for (const item of images.slice(0, 256)) {
        if (privateImageLabels(item.Labels)) continue;
        try {
          const actual = await engine.request<{
            Id: string;
            Architecture: string;
            Os: string;
            Config: { Labels?: Record<string, string> };
          }>("GET", `/images/${encodeURIComponent(item.Id)}/json`);
          if (
            actual.Os !== "linux" ||
            actual.Config.Labels?.["io.cantrip.os"] !== "foundation" ||
            privateImageLabels(actual.Config.Labels)
          )
            continue;
          bases.push({
            imageId: actual.Id,
            architecture: actual.Architecture,
            tags: (item.RepoTags ?? []).slice(0, 100),
          });
        } catch {
          error =
            "Some base image metadata is unavailable; the current management target was still verified.";
        }
      }
    } catch {
      error =
        "Base images could not be listed; the current management target was still verified.";
    }
    return cantripOsSystemStatusResultSchema.parse({
      supported: true,
      ...current,
      bases,
      error,
    });
  }
  private async validate(command: CantripOsSystemOperationCommand) {
    const expected = command.target.expected;
    if (
      expected.ownerId !== command.scope.ownerId ||
      expected.workerId !== command.scope.workerId
    )
      throw new Error("The system target ownership changed");
    if (command.action === "rollback") {
      this.sameOwner(command.scope, command.replacement.scope);
      const source = await readSystemJob(this.directory, command.replacement);
      if (
        !source ||
        source.command.action !== "replace" ||
        !isDeepStrictEqual(command.target, source.command.target)
      )
        throw new Error(
          "Rollback requires the original replacement's exact management target",
        );
      return;
    }
    if (expected.guestInstanceId !== command.scope.guestInstanceId)
      throw new Error("The system target guest identity changed");
    const observed = await systemTarget(
      await this.docker(),
      command.transport.container,
      command.scope,
      command.target,
    );
    if (
      !isDeepStrictEqual(
        systemTargetAuthority(observed.target),
        systemTargetAuthority(command.target),
      )
    )
      throw new Error(
        "The selected Docker target changed; no replacement was substituted",
      );
  }
  private async stage(
    command: Extract<CantripOsSystemOperationCommand, { action: "replace" }>,
    record: SystemJob,
    mutate: boolean,
  ) {
    if (command.source.kind === "base") return true;
    const source = command.source.capture;
    this.sameOwner(command.scope, source.context);
    const path = this.paths(command).stage;
    if (!record.stage) {
      let exists = false;
      try {
        await stat(path);
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!exists && !mutate) return false;
      if (!exists) record.stage = await this.captures.open(source, path);
      else {
        const verified = await this.captures.verify(source),
          digest = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(path)) {
          bytes += chunk.length;
          digest.update(chunk);
        }
        if (
          bytes !== verified.receipt.archiveBytes ||
          digest.digest("hex") !== verified.receipt.archiveSha256
        )
          throw new Error(
            "The retained plaintext staging file does not match its authenticated checkpoint",
          );
        record.stage = verified;
      }
      record.phase = "archive-authenticated";
      await this.save(record);
    }
    return true;
  }
  private async hostInput(
    command: CantripOsSystemOperationCommand,
    record: SystemJob,
  ): Promise<SystemReplacementInput> {
    const common = {
      operationId: command.operationId,
      container: command.target.containerName,
      instanceId: command.scope.instanceId,
      scopeKey: hash(admission(command)),
      startTarget: command.action !== "capture" && command.startTarget,
    };
    if (command.action === "replace") {
      const source =
        command.source.kind === "base"
          ? command.source
          : {
              kind: "checkpoint" as const,
              imageId: record.stage!.manifest.snapshot.imageId,
              operationId: command.source.capture.context.operationId,
              requestSha256: record.stage!.manifest.snapshot.requestSha256,
              containerId: command.source.capture.context.containerId,
            };
      return {
        journalPath: this.paths(command).host,
        request: {
          ...common,
          action: "replace",
          expectedContainerId: command.target.containerId,
          source,
          archive: record.stage
            ? {
                path: this.paths(command).stage,
                bytes: record.stage.receipt.archiveBytes,
                sha256: record.stage.receipt.archiveSha256,
              }
            : null,
        },
      };
    }
    if (command.action !== "rollback")
      throw new Error("Capture does not have a replacement input");
    const source = await readSystemJob(this.directory, command.replacement);
    if (!source || source.command.action !== "replace")
      throw new Error("The original replacement is unavailable");
    const originalInput = await this.hostInput(source.command, source);
    return {
      journalPath: this.paths(command).host,
      replacementJournalPath: originalInput.journalPath,
      request: {
        ...common,
        action: "rollback",
        replacementOperationId: source.command.operationId,
        replacementRequestSha256: hash(originalInput.request),
        expectedOriginalId: source.command.target.containerId,
      },
    };
  }
  private async rootProof(
    engine: LocalDocker,
    command: CantripOsSystemOperationCommand,
    host: SystemReplacementResult,
  ) {
    const op = host.operation;
    let guestInstanceId: string | null = null,
      guestAttachment: "owned" | "unattached" | "unavailable" = "unavailable";
    if (op.targetContainerId)
      try {
        const actual = await readSystemIdentity(
          engine,
          op.targetContainerId,
          command.target.expected.identityPath,
        );
        if (actual.identity.attachment === null) {
          guestInstanceId = actual.identity.instance_id;
          guestAttachment = "unattached";
        } else if (
          actual.identity.attachment.owner_id === command.scope.ownerId &&
          actual.identity.attachment.worker_id === command.scope.workerId
        ) {
          guestInstanceId = actual.identity.instance_id;
          guestAttachment = "owned";
        }
      } catch {
        /* Root completion is separate from fresh guest authority. */
      }
    return {
      requestSha256: op.requestSha256,
      originalContainerId: op.originalContainerId,
      targetContainerId: op.targetContainerId,
      retainedContainerId: op.retainedContainerId,
      runtimeHandlesRestored: false as const,
      guestInstanceId,
      guestAttachment,
    };
  }
  private async advance(
    command: CantripOsSystemOperationCommand,
    record: SystemJob,
    fresh: boolean,
  ) {
    const mutate = fresh || command.mode === "continue";
    if (!record.validated) {
      try {
        await this.validate(command);
      } catch (error) {
        record.state = "failed";
        record.phase = "validation-failed";
        record.diagnostic =
          error instanceof Error ? error.message : String(error);
        return;
      }
      record.validated = true;
      await this.save(record);
    }
    this.account(command.scope);
    if (command.action === "capture") {
      const input = captureAdmission(command);
      let value = await this.captures.run(input, "observe");
      this.account(command.scope);
      if (mutate && !record.captureRequested) {
        await this.captures.run(input, "prepare");
        record.captureRequested = true;
        await this.save(record);
        value = await this.captures.run(input, "continue");
      } else if (command.mode === "continue" && value)
        value = await this.captures.run(input, "continue");
      if (!value) {
        record.state = "unknown";
        record.diagnostic =
          "No original private capture receipt was found; capture was not repeated";
        return;
      }
      record.capture = value;
      record.state = value.state;
      record.phase = value.phase;
      await this.save(record);
      return;
    }
    if (
      command.action === "replace" &&
      !(await this.stage(command, record, mutate))
    ) {
      record.state = "unknown";
      record.phase = "awaiting-archive-authentication";
      return;
    }
    const input = await this.hostInput(command, record),
      engine = await this.docker();
    let observed = await observeSystemReplacement(engine, input);
    this.account(command.scope);
    if (!observed && mutate && !record.hostRequested) {
      record.hostRequested = true;
      await this.save(record);
      observed = await replaceSystem(engine, input);
    } else if (observed && command.mode === "continue")
      observed = await continueSystemReplacement(engine, input);
    if (!observed) {
      record.state = "unknown";
      record.diagnostic =
        "The original root transition has no observable host admission";
      return;
    }
    record.host = observed;
    record.state = observed.operation.state;
    record.phase = observed.operation.phase;
    record.root = await this.rootProof(engine, command, observed);
    record.diagnostic = observed.operation.error;
    await this.save(record);
  }
  private output(record: SystemJob): CantripOsSystemOperationResult {
    const c = record.command;
    return cantripOsSystemOperationResultSchema.parse({
      operationId: c.operationId,
      targetGeneration: c.target.generation,
      action: c.action,
      state: record.state,
      phase: record.phase,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      protectedResult: record.protectedResult,
      root: record.root,
      error:
        record.state === "unknown"
          ? "System delivery is unknown. Observe the original operation; no claimed effect was repeated."
          : record.state === "failed"
            ? "The system operation failed. Inspect its private outcome and retained recovery state."
            : null,
    });
  }
  private async protect(record: SystemJob) {
    const command = record.command;
    this.account(command.scope);
    const material = this.keys.componentKey("repository-content");
    try {
      const value: CantripOsSystemPrivateOperationResult = {
        version: 1,
        command,
        capture:
          command.action === "capture" && record.capture
            ? await captureDetails(command, record.capture, this.keys)
            : null,
        replacement: record.host,
        diagnostic: record.diagnostic?.slice(0, 32768) ?? null,
      };
      record.protectedResult = await encryptCantripOsSystemOperationResult({
        context: systemOperationContext(command),
        componentKey: material.key,
        keyRevision: material.keyRevision,
        value,
      });
      this.account(command.scope);
    } finally {
      clearSensitiveBytes(material.key);
    }
  }
  async handle(raw: CantripOsSystemWorkerCommand): Promise<unknown> {
    const command = cantripOsSystemWorkerCommandSchema.parse(raw);
    this.account(command.scope);
    if (command.type === "cantrip-os.system.status")
      return this.status(command);
    const paths = this.paths(command),
      ref = {
        scope: command.scope,
        operationId: command.operationId,
        targetGeneration: command.target.generation,
      };
    return withInstanceLock(`system-job:${hash(ref)}`, async () => {
      this.account(command.scope);
      let record = await readSystemJob(this.directory, ref),
        fresh = !record;
      if (record && !isDeepStrictEqual(record.command, admission(command)))
        throw new Error(
          "The system operation ID belongs to a different immutable admission",
        );
      if (!record) {
        if (command.mode === "observe") return null;
        if (command.mode === "continue")
          throw new Error("No original system admission exists to continue");
        const at = new Date().toISOString();
        record = {
          version: 1,
          command: admission(command),
          state: "running",
          phase: "reserved",
          startedAt: at,
          updatedAt: at,
          validated: false,
          captureRequested: false,
          hostRequested: false,
          capture: null,
          stage: null,
          host: null,
          root: null,
          protectedResult: null,
          diagnostic: null,
        };
        await this.save(record, true);
      }
      if (
        (record.state === "ready" || record.state === "failed") &&
        record.protectedResult
      )
        return this.output(record);
      try {
        if (
          command.mode === "prepare" ||
          (command.mode === "observe" &&
            record.phase === "prepared" &&
            !record.captureRequested &&
            !record.hostRequested)
        ) {
          if (record.captureRequested || record.hostRequested)
            return this.output(record);
          if (record.phase === "prepared" && record.protectedResult)
            return this.output(record);
          record.state = "running";
          record.phase = "prepared";
          await this.protect(record);
          await this.save(record);
          return this.output(record);
        }
        if (fresh || command.mode === "continue") {
          const material = this.keys.componentKey("repository-content");
          clearSensitiveBytes(material.key);
        }
        await this.advance(command, record, fresh);
        record.updatedAt = new Date().toISOString();
        await this.protect(record);
        await this.save(record);
        return this.output(record);
      } catch (error) {
        this.account(command.scope);
        const durable = await readSystemJob(this.directory, ref);
        if (
          durable &&
          (durable.state === "ready" || durable.state === "failed") &&
          durable.protectedResult
        )
          return this.output(durable);
        record.state = "unknown";
        record.protectedResult = null;
        record.diagnostic =
          error instanceof Error ? error.message : String(error);
        await this.save(record);
        await this.protect(record);
        await this.save(record);
        return this.output(record);
      }
    });
  }
}
