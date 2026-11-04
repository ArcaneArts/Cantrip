import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CantripOsDispatchScope } from "@cantrip/protocol";
import {
  OsExecutorDeliveryError,
  type OsExecutorBinding,
} from "./connection.js";

export interface OsOperationRecord {
  version: 1;
  operationId: string;
  command: string;
  admissionFingerprint: string;
  scope: CantripOsDispatchScope;
  state: "running" | "ready" | "failed" | "unknown";
  startedAt: string;
  updatedAt: string;
  receipt: unknown;
  error: string | null;
  native: { binding: OsExecutorBinding; sessionId: string } | null;
  processes: Array<{ processId: string; argv: string[] }>;
}

/** Private worker records survive lost command receipts and worker restarts.
 * Existing operations are observed, never re-executed by this store. */
export class OsOperationStore {
  private readonly active = new Set<string>();
  constructor(private readonly directory: string) {}

  private file(scope: CantripOsDispatchScope, operationId: string) {
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
    scope: CantripOsDispatchScope,
    operationId: string,
  ): Promise<OsOperationRecord | null> {
    const file = this.file(scope, operationId);
    try {
      const record = JSON.parse(
        await readFile(file, "utf8"),
      ) as OsOperationRecord;
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

  async execute(
    scope: CantripOsDispatchScope,
    operationId: string,
    command: string,
    admission: unknown,
    run: (
      record: OsOperationRecord,
      save: () => Promise<void>,
      journalPath: string,
    ) => Promise<unknown>,
  ): Promise<OsOperationRecord> {
    const file = this.file(scope, operationId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const admissionFingerprint = createHash("sha256")
      .update(JSON.stringify([command, admission]))
      .digest("hex");
    const record: OsOperationRecord = {
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
    };
    try {
      await writeFile(file, JSON.stringify(record) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
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
      return existing;
    }
    const save = async () => {
      record.updatedAt = new Date().toISOString();
      const temporary = `${file}.${randomUUID()}`;
      await writeFile(temporary, JSON.stringify(record) + "\n", {
        mode: 0o600,
      });
      await rename(temporary, file);
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
}
