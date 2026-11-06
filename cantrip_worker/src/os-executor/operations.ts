import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CantripOsDispatchScope } from "@cantrip/protocol";
import {
  OsExecutorDeliveryError,
  type OsExecutorBinding,
} from "./connection.js";
import { writeOsOperationRecord } from "./operation-files.js";

type OsOperationScope = Pick<
  CantripOsDispatchScope,
  "ownerId" | "workerId" | "serverId" | "instanceId" | "guestInstanceId"
>;
export interface OsOperationRecord<
  Scope extends OsOperationScope = CantripOsDispatchScope,
> {
  version: 1;
  operationId: string;
  command: string;
  admissionFingerprint: string;
  scope: Scope;
  state: "running" | "ready" | "failed" | "unknown";
  startedAt: string;
  updatedAt: string;
  receipt: unknown;
  error: string | null;
  native: { binding: OsExecutorBinding; sessionId: string } | null;
  processes: Array<{ processId: string; argv: string[] }>;
  /** Private resumable administrative progress; never projected by result(). */
  checkpoint?: unknown;
}

/** Private worker records survive lost command receipts and worker restarts.
 * Existing operations are observed, never re-executed by this store. */
export class OsOperationStore<
  Scope extends OsOperationScope = CantripOsDispatchScope,
> {
  private readonly active = new Set<string>();
  constructor(private readonly directory: string) {}

  private file(scope: Scope, operationId: string) {
    if (!/^[a-f0-9-]{36}$/i.test(operationId))
      throw new Error("Invalid OS operation ID.");
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          scope.serverId,
          scope.ownerId,
          scope.workerId,
          scope.instanceId,
          scope.guestInstanceId,
        ]),
      )
      .digest("hex");
    return path.join(
      this.directory,
      "cantrip-os-operations",
      key,
      `${operationId}.json`,
    );
  }

  async inspect(
    scope: Scope,
    operationId: string,
  ): Promise<OsOperationRecord<Scope> | null> {
    const file = this.file(scope, operationId);
    try {
      const record = JSON.parse(
        await readFile(file, "utf8"),
      ) as OsOperationRecord<Scope>;
      if (
        record.version !== 1 ||
        record.operationId !== operationId ||
        this.file(record.scope, operationId) !== file
      )
        throw new Error("Stored OS operation has the wrong identity.");
      return record.state === "running" && !this.active.has(file)
        ? {
            ...record,
            state: "unknown",
            error:
              "The controlling worker session ended; inspect the recorded native sessions before retrying.",
          }
        : record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async admit(
    scope: Scope,
    operationId: string,
    command: string,
    admission: unknown,
    initialCheckpoint?: unknown,
  ): Promise<{ record: OsOperationRecord<Scope>; fresh: boolean }> {
    const file = this.file(scope, operationId);
    const admissionFingerprint = createHash("sha256")
      .update(JSON.stringify([command, admission]))
      .digest("hex");
    const record: OsOperationRecord<Scope> = {
      version: 1,
      operationId,
      command,
      admissionFingerprint,
      scope,
      state: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      receipt: null,
      error: null,
      native: null,
      processes: [],
      checkpoint: initialCheckpoint,
    };
    try {
      await writeOsOperationRecord(file, record, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.inspect(scope, operationId);
      if (
        !existing ||
        existing.command !== command ||
        existing.admissionFingerprint !== admissionFingerprint ||
        !isDeepStrictEqual(existing.scope, scope)
      )
        throw new Error(
          "The OS operation ID already belongs to a different admission.",
        );
      return { record: existing, fresh: false };
    }
    return { record, fresh: true };
  }

  async execute(
    scope: Scope,
    operationId: string,
    command: string,
    admission: unknown,
    run: (
      record: OsOperationRecord<Scope>,
      save: () => Promise<void>,
      journalPath: string,
    ) => Promise<unknown>,
    initialCheckpoint?: unknown,
  ): Promise<OsOperationRecord<Scope>> {
    const { record, fresh } = await this.admit(
      scope,
      operationId,
      command,
      admission,
      initialCheckpoint,
    );
    if (!fresh) return record;
    const file = this.file(scope, operationId);
    const save = async () => {
      record.updatedAt = new Date().toISOString();
      await writeOsOperationRecord(file, record);
    };
    this.active.add(file);
    try {
      try {
        record.receipt = await run(record, save, `${file}.docker`);
        record.state = "ready";
      } catch (error) {
        record.state =
          error &&
          typeof error === "object" &&
          Reflect.get(error, "delivery") === "unknown"
            ? "unknown"
            : "failed";
        record.error =
          error instanceof Error ? error.message : "OS operation failed.";
      }
      try {
        await save();
      } catch (error) {
        const unknown = new OsExecutorDeliveryError(
          "The OS operation outcome could not be recorded; inspect the existing operation before retrying.",
        );
        unknown.cause = error;
        throw unknown;
      }
    } finally {
      this.active.delete(file);
    }
    return record;
  }

  /** Attach an immutable protected receipt to an already committed terminal
   * fact. Never changes its state, timestamps, checkpoint or admission. */
  async recordTerminalReceipt(
    record: OsOperationRecord<Scope>,
    receipt: unknown,
  ) {
    const file = this.file(record.scope, record.operationId);
    const current = await this.inspect(record.scope, record.operationId);
    if (
      this.active.has(file) ||
      !current ||
      current.command !== record.command ||
      current.admissionFingerprint !== record.admissionFingerprint ||
      !isDeepStrictEqual(current.scope, record.scope) ||
      current.state !== record.state ||
      !["ready", "failed"].includes(current.state) ||
      !isDeepStrictEqual(current.checkpoint, record.checkpoint)
    )
      throw new Error(
        "The completed OS admission changed before its protected receipt was recorded",
      );
    if (current.receipt !== null) return current;
    const saved = { ...current, receipt };
    await writeOsOperationRecord(file, saved);
    return saved;
  }

  /** Save a conclusively observed completion of an existing admission. This
   * never admits or dispatches a replacement process. */
  async recordObservedCompletion(
    record: OsOperationRecord<Scope>,
    receipt: unknown,
  ) {
    const file = this.file(record.scope, record.operationId);
    if (this.active.has(file))
      throw new Error("The OS operation is still active.");
    const current = await this.inspect(record.scope, record.operationId);
    if (
      !current ||
      current.command !== record.command ||
      current.admissionFingerprint !== record.admissionFingerprint ||
      !isDeepStrictEqual(current.scope, record.scope)
    )
      throw new Error("The observed OS operation identity changed.");
    if (current.state === "ready") return current;
    if (current.state !== "unknown")
      throw new Error("Only an unknown admission can be recovered.");
    const recovered: OsOperationRecord<Scope> = {
      ...current,
      receipt,
      state: "ready",
      error: null,
      updatedAt: new Date().toISOString(),
    };
    await writeOsOperationRecord(file, recovered);
    return recovered;
  }

  /** Continue observation of an existing admission only. The caller must not
   * dispatch an uncertain mutation. No record is created when it is missing. */
  async reconcile(
    scope: Scope,
    operationId: string,
    observe: (
      record: OsOperationRecord<Scope>,
      save: () => Promise<void>,
    ) => Promise<void>,
  ): Promise<OsOperationRecord<Scope> | null> {
    const file = this.file(scope, operationId);
    const record = await this.inspect(scope, operationId);
    if (!record) return null;
    if (!isDeepStrictEqual(record.scope, scope))
      throw new Error("The saved OS admission scope changed.");
    if (this.active.has(file) || record.state === "ready") return record;
    this.active.add(file);
    const save = async () => {
      record.updatedAt = new Date().toISOString();
      await writeOsOperationRecord(file, record);
    };
    try {
      record.state = "unknown";
      try {
        await observe(record, save);
      } catch (error) {
        record.state = "unknown";
        record.error =
          error instanceof Error
            ? error.message
            : "OS recovery observation failed.";
      }
      await save();
      return record;
    } finally {
      this.active.delete(file);
    }
  }
}
