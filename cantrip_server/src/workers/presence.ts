import {
  workerEncryptionMaterialFingerprint,
  type WorkerSummary,
} from "@cantrip/protocol";

export function workerPresenceFingerprint(worker: WorkerSummary): string {
  return JSON.stringify([
    worker.workerId,
    worker.name,
    worker.platform,
    worker.architecture,
    worker.codexVersion,
    worker.codexRuntime,
    worker.remoteSurfaces,
    worker.directBroker,
    worker.code,
    worker.projectReplicas,
    worker.managedFolders,
    worker.standaloneChat,
    worker.chatRelocation,
    worker.externalCodexHistory,
    worker.codegraph,
    worker.webRuntimes,
    workerEncryptionMaterialFingerprint(worker.encryption),
    worker.startedAt,
    worker.online,
  ]);
}
