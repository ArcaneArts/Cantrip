import {
  workerEncryptionMaterialFingerprint,
  type WorkerEncryptionComponentScope,
  type WorkerEncryptionStatus,
} from "@cantrip/protocol/encryption";

export function workerEncryptionRefreshChangesSurfaceMaterial(input: {
  after: WorkerEncryptionStatus;
  before: WorkerEncryptionStatus;
  component: WorkerEncryptionComponentScope;
}): boolean {
  return (
    input.component === "surface-private-state" &&
    workerEncryptionMaterialFingerprint(input.before) !==
      workerEncryptionMaterialFingerprint(input.after)
  );
}
