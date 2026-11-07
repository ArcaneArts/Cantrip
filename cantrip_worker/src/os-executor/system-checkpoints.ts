import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  LocalDocker,
  captureSystemCheckpoint,
  observeSystemCheckpoint,
  continueSystemCheckpoint,
  openSystemCheckpointImage,
  withInstanceLock,
  type SystemCheckpointInput,
} from "@cantrip/os-host";
import {
  cantripOsSystemCaptureAdmissionSchema,
  cantripOsSystemCaptureOutcomeSchema,
  cantripOsSystemManifestSchema,
  cantripOsSystemArchiveReceiptSchema,
  cantripOsSystemProtectedResultSchema,
  type CantripOsSystemCaptureAdmission,
  type CantripOsSystemCaptureOutcome,
} from "@cantrip/protocol/cantrip-os-system";
import {
  clearSensitiveBytes,
  encryptCantripOsSystemFrame,
} from "@cantrip/crypto";
import { writeOsOperationRecord } from "./operation-files.js";
import type { BackupKeyAccess } from "./private-backup-file.js";
import {
  sealPrivateSystem,
  verifyPrivateSystem,
  openPrivateSystem,
} from "./private-system-file.js";

const journalSchema = z
  .object({
    version: z.literal(1),
    admission: cantripOsSystemCaptureAdmissionSchema,
    state: z.enum(["running", "ready", "failed", "unknown"]),
    phase: z.string().min(1).max(200),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    manifest: cantripOsSystemManifestSchema.nullable(),
    archive: cantripOsSystemArchiveReceiptSchema.nullable(),
    protectedResult: cantripOsSystemProtectedResultSchema.nullable(),
    lastError: z.string().nullable(),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
type Mode = "execute" | "observe" | "continue";
export interface SystemCheckpointPorts {
  docker: () => Promise<LocalDocker>;
  seal: typeof sealPrivateSystem;
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Worker-private durable transfer foundation. Product admission/routing is
 * deliberately separate: this class accepts an already authorized exact target.
 * Existing execute calls only observe, and observation never exports again. */
export class CantripOsSystemCheckpointManager {
  constructor(
    private readonly directory: string,
    private readonly workerId: string,
    private readonly keys: BackupKeyAccess,
    private readonly ports: SystemCheckpointPorts = {
      docker: () => LocalDocker.current(),
      seal: sealPrivateSystem,
    },
  ) {}
  private account(
    admission: CantripOsSystemCaptureAdmission,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const c = admission.context;
    if (
      c.workerId !== this.workerId ||
      this.keys.ownerId() !== c.ownerId ||
      this.keys.serverIdentity() !== c.serverId
    )
      throw new Error(
        "The system checkpoint belongs to another Worker, owner or Server.",
      );
  }
  private paths(admission: CantripOsSystemCaptureAdmission) {
    const c = admission.context;
    const scope = digest([
      c.serverId,
      c.ownerId,
      c.workerId,
      c.instanceId,
      c.guestInstanceId,
    ]);
    const journal = join(
      this.directory,
      "cantrip-os-system-checkpoints",
      scope,
      `${c.operationId}.json`,
    );
    return {
      journal,
      host: `${journal}.docker`,
      archive: `${journal}.ctos-system`,
    };
  }
  private lock(admission: CantripOsSystemCaptureAdmission) {
    const c = admission.context;
    return `system-transfer:${digest([c.serverId, c.ownerId, c.workerId, c.instanceId, c.guestInstanceId, c.operationId])}`;
  }
  private async load(admission: CantripOsSystemCaptureAdmission) {
    try {
      const record = journalSchema.parse(
        JSON.parse(await readFile(this.paths(admission).journal, "utf8")),
      );
      if (!isDeepStrictEqual(record.admission, admission))
        throw new Error(
          "The system checkpoint operation already has a different immutable admission.",
        );
      if (
        (record.archive && !record.manifest) ||
        (record.state === "ready" &&
          (!record.archive ||
            !record.manifest ||
            !record.protectedResult ||
            record.phase !== "complete"))
      )
        throw new Error(
          "The system checkpoint journal has no completed private proof.",
        );
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async save(record: Journal, exclusive = false) {
    record.updatedAt = new Date().toISOString();
    await writeOsOperationRecord(
      this.paths(record.admission).journal,
      record,
      exclusive,
    );
  }
  private result(record: Journal): CantripOsSystemCaptureOutcome {
    return cantripOsSystemCaptureOutcomeSchema.parse({
      operationId: record.admission.context.operationId,
      checkpointId: record.admission.context.checkpointId,
      state: record.state,
      phase: record.phase,
      protectedResult: record.protectedResult,
    });
  }
  private async protect(record: Journal) {
    this.account(record.admission);
    const material = this.keys.componentKey("repository-content");
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        state: record.state,
        phase: record.phase,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        manifest: record.manifest,
        archive: record.archive,
        error: record.lastError,
      }),
    );
    try {
      const streamId = randomUUID();
      record.protectedResult = {
        streamId,
        keyRevision: material.keyRevision,
        frame: await encryptCantripOsSystemFrame({
          context: record.admission.context,
          streamId,
          keyRevision: material.keyRevision,
          componentKey: material.key,
          kind: "result",
          sequence: 0,
          plaintext,
        }),
      };
      this.account(record.admission);
    } finally {
      clearSensitiveBytes(material.key);
      clearSensitiveBytes(plaintext);
    }
  }
  private async finish(record: Journal) {
    record.updatedAt = new Date().toISOString();
    await this.protect(record);
    await this.save(record);
    return this.result(record);
  }
  async run(
    raw: CantripOsSystemCaptureAdmission,
    mode: Mode,
    signal?: AbortSignal,
  ): Promise<CantripOsSystemCaptureOutcome | null> {
    const admission = cantripOsSystemCaptureAdmissionSchema.parse(raw);
    if (!["execute", "observe", "continue"].includes(mode))
      throw new Error("Unknown system checkpoint operation mode.");
    this.account(admission, signal);
    const paths = this.paths(admission);
    return withInstanceLock(
      this.lock(admission),
      async () => {
        this.account(admission, signal);
        let record = await this.load(admission);
        const fresh = !record;
        if (!record) {
          if (mode === "observe") return null;
          if (mode === "continue")
            throw new Error(
              "There is no original system checkpoint admission to continue.",
            );
          record = {
            version: 1,
            admission,
            state: "running",
            phase: "reserved",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            manifest: null,
            archive: null,
            protectedResult: null,
            lastError: null,
          };
          // Acquire the actual grant before admitting any guest effects.
          await this.protect(record);
          await this.save(record, true);
        }
        if (record.state === "ready" || record.state === "failed")
          return this.result(record);
        const action = fresh
          ? "execute"
          : mode === "execute"
            ? "observe"
            : mode;
        try {
          if (!record.manifest) {
            record.phase = "capture-requested";
            await this.save(record);
            const c = admission.context;
            const input: SystemCheckpointInput = {
              journalPath: paths.host,
              signal,
              request: {
                operationId: c.operationId,
                container: admission.container,
                expectedContainerId: c.containerId,
                instanceId: c.instanceId,
                scopeKey: digest(c),
                resumeOriginal: admission.resumeOriginal,
              },
            };
            const engine = await this.ports.docker();
            let captured =
              action === "execute"
                ? await captureSystemCheckpoint(engine, input)
                : await observeSystemCheckpoint(engine, input);
            if (action === "continue")
              captured = captured
                ? await continueSystemCheckpoint(engine, input)
                : await captureSystemCheckpoint(engine, input);
            this.account(admission, signal);
            if (!captured || captured.operation.state !== "ready") {
              record.state = captured?.operation.state ?? "unknown";
              record.phase = `capture-${captured?.operation.phase ?? "unobserved"}`;
              record.lastError =
                captured?.operation.error ??
                captured?.observationError ??
                "The original system capture is not verified.";
              return this.finish(record);
            }
            record.manifest = cantripOsSystemManifestSchema.parse({
              version: 1,
              snapshot: captured.operation.snapshot,
            });
            record.phase = "captured";
            await this.save(record);
          }
          // Recover publication before contacting Docker. A published archive is
          // authoritative even if its source Engine/image is now unavailable.
          try {
            const existing = await verifyPrivateSystem({
              context: admission.context,
              keys: this.keys,
              source: paths.archive,
              signal,
            });
            if (!isDeepStrictEqual(existing.manifest, record.manifest))
              throw new Error("The published system manifest changed.");
            record.archive = existing.receipt;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (record.archive)
              throw new Error(
                "The completed system archive is unavailable; it was not regenerated.",
              );
            if (action === "observe") {
              record.state = "unknown";
              record.lastError =
                "No published archive is present. Explicit continuation can authorize a new read of the captured image.";
              return this.finish(record);
            }
            record.phase = "export-requested";
            await this.save(record);
            const c = admission.context;
            const stream = await openSystemCheckpointImage(
              await this.ports.docker(),
              {
                journalPath: paths.host,
                signal,
                request: {
                  operationId: c.operationId,
                  container: admission.container,
                  expectedContainerId: c.containerId,
                  instanceId: c.instanceId,
                  scopeKey: digest(c),
                  resumeOriginal: admission.resumeOriginal,
                },
              },
            );
            try {
              record.archive = await this.ports.seal({
                context: c,
                keys: this.keys,
                destination: paths.archive,
                manifest: record.manifest,
                archive: stream,
                signal,
              });
            } finally {
              stream.destroy();
            }
          }
          this.account(admission, signal);
          record.state = "ready";
          record.phase = "complete";
          record.lastError = null;
          return await this.finish(record);
        } catch (error) {
          this.account(admission);
          record.state = "unknown";
          record.lastError =
            error instanceof Error ? error.message : String(error);
          return this.finish(record);
        }
      },
      { signal },
    );
  }
  async open(
    raw: CantripOsSystemCaptureAdmission,
    destination: string,
    signal?: AbortSignal,
  ) {
    const admission = cantripOsSystemCaptureAdmissionSchema.parse(raw);
    this.account(admission, signal);
    return withInstanceLock(
      this.lock(admission),
      async () => {
        const record = await this.load(admission);
        if (
          !record ||
          record.state !== "ready" ||
          !record.manifest ||
          !record.archive
        )
          throw new Error("The original system checkpoint is not complete.");
        return openPrivateSystem({
          context: admission.context,
          keys: this.keys,
          source: this.paths(admission).archive,
          destination,
          signal,
          expected: { manifest: record.manifest, receipt: record.archive },
        });
      },
      { signal },
    );
  }
  async verify(raw: CantripOsSystemCaptureAdmission, signal?: AbortSignal) {
    const admission = cantripOsSystemCaptureAdmissionSchema.parse(raw);
    this.account(admission, signal);
    return withInstanceLock(
      this.lock(admission),
      async () => {
        const record = await this.load(admission);
        if (
          !record ||
          record.state !== "ready" ||
          !record.manifest ||
          !record.archive
        )
          throw new Error("The original system checkpoint is not complete.");
        const verified = await verifyPrivateSystem({
          context: admission.context,
          keys: this.keys,
          source: this.paths(admission).archive,
          signal,
        });
        if (
          !isDeepStrictEqual(verified.manifest, record.manifest) ||
          !isDeepStrictEqual(verified.receipt, record.archive)
        )
          throw new Error("The original system archive proof changed.");
        return verified;
      },
      { signal },
    );
  }
}
