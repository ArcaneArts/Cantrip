import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  clearSensitiveBytes,
  decryptCantripOsSystemFrame,
} from "@cantrip/crypto";
import {
  cantripOsSystemCaptureOutcomeSchema,
  cantripOsSystemManifestSchema,
  cantripOsSystemArchiveReceiptSchema,
  type CantripOsSystemCaptureAdmission,
} from "@cantrip/protocol/cantrip-os-system";
import {
  cantripOsSystemOperationCommandSchema,
  cantripOsSystemRootReceiptSchema,
  cantripOsSystemProtectedOperationResultSchema,
  type CantripOsSystemOperationCommand,
  type CantripOsSystemScope,
  type CantripOsSystemReference,
} from "@cantrip/protocol";
import type { BackupKeyAccess } from "./private-backup-file.js";
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const admission = (command: CantripOsSystemOperationCommand) => ({
  ...command,
  mode: "execute" as const,
});
export const systemOperationContext = (
  command: CantripOsSystemOperationCommand,
) => ({
  ...command.scope,
  targetGeneration: command.target.generation,
  operationId: command.operationId,
  containerId: command.target.containerId,
});
export function captureAdmission(
  command: Extract<CantripOsSystemOperationCommand, { action: "capture" }>,
): CantripOsSystemCaptureAdmission {
  return {
    context: {
      ...systemOperationContext(command),
      checkpointId: command.checkpointId,
    },
    container: command.target.containerName,
    resumeOriginal: command.resumeOriginal,
  };
}
export const stageSchema = z
  .object({
    manifest: cantripOsSystemManifestSchema,
    receipt: cantripOsSystemArchiveReceiptSchema,
  })
  .strict();
export const systemJobSchema = z
  .object({
    version: z.literal(1),
    command: cantripOsSystemOperationCommandSchema,
    state: z.enum(["running", "ready", "failed", "unknown"]),
    phase: z.string().min(1).max(200),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    validated: z.boolean(),
    captureRequested: z.boolean(),
    hostRequested: z.boolean(),
    capture: cantripOsSystemCaptureOutcomeSchema.nullable(),
    stage: stageSchema.nullable(),
    host: z.unknown().nullable(),
    root: cantripOsSystemRootReceiptSchema.nullable(),
    protectedResult: cantripOsSystemProtectedOperationResultSchema.nullable(),
    diagnostic: z.string().nullable(),
  })
  .strict();
export type SystemJob = z.infer<typeof systemJobSchema>;
export function systemJobPaths(
  directory: string,
  scope: CantripOsSystemScope,
  operationId: string,
) {
  if (!z.uuid().safeParse(operationId).success)
    throw new Error("Invalid system operation identity");
  const key = hash([
    scope.serverId,
    scope.ownerId,
    scope.workerId,
    scope.instanceId,
    scope.guestInstanceId,
  ]);
  const file = join(
    directory,
    "cantrip-os-system-jobs",
    key,
    `${operationId}.json`,
  );
  return { file, host: `${file}.docker`, stage: `${file}.tar` };
}
export async function readSystemJob(
  directory: string,
  ref: CantripOsSystemReference,
) {
  try {
    const record = systemJobSchema.parse(
      JSON.parse(
        await readFile(
          systemJobPaths(directory, ref.scope, ref.operationId).file,
          "utf8",
        ),
      ),
    );
    if (
      record.command.operationId !== ref.operationId ||
      record.command.target.generation !== ref.targetGeneration ||
      !isDeepStrictEqual(record.command.scope, ref.scope)
    )
      throw new Error(
        "The system journal belongs to another original admission",
      );
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function captureDetails(
  command: Extract<CantripOsSystemOperationCommand, { action: "capture" }>,
  outcome: NonNullable<SystemJob["capture"]>,
  keys: BackupKeyAccess,
) {
  if (!outcome.protectedResult) return null;
  const proof = outcome.protectedResult,
    material = keys.componentKey("repository-content", proof.keyRevision);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptCantripOsSystemFrame({
      context: captureAdmission(command).context,
      ...proof,
      componentKey: material.key,
    });
    return z
      .object({
        manifest: cantripOsSystemManifestSchema.nullable(),
        archive: cantripOsSystemArchiveReceiptSchema.nullable(),
      })
      .parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
      );
  } finally {
    clearSensitiveBytes(material.key);
    if (plaintext) clearSensitiveBytes(plaintext);
  }
}
