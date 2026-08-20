import type {
  WorkerEncryptionRefreshResult,
  WorkerEncryptionStatus,
  WorkerSummary,
} from "@cantrip/protocol";

import { refreshWorkerEncryption } from "./api";
import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type {
  ClientEncryptionService,
  ClientEncryptionSnapshot,
} from "./client-encryption";
import { clientEncryption } from "./client-encryption";
import {
  authorizeWorkerEncryption,
  type WorkerGrantApi,
} from "./worker-encryption-grants";

export type PrivateLabelWorkerEncryptionReadiness =
  | "ready"
  | "offline"
  | "locked"
  | "pending-approval"
  | "missing-grant"
  | "revoked"
  | "stale"
  | "unavailable";

export type PrivateLabelWorkerEncryptionDescriptor = Pick<
  WorkerSummary,
  "encryption" | "online" | "workerId"
>;

export class PrivateLabelWorkerEncryptionError extends Error {
  constructor(
    readonly state: Exclude<PrivateLabelWorkerEncryptionReadiness, "ready">,
    message: string,
  ) {
    super(message);
    this.name = "PrivateLabelWorkerEncryptionError";
  }
}

export function privateLabelWorkerEncryptionReadiness(
  worker: PrivateLabelWorkerEncryptionDescriptor | null | undefined,
  snapshot: ClientEncryptionSnapshot = clientEncryption.getSnapshot(),
): PrivateLabelWorkerEncryptionReadiness {
  if (!worker?.online) return "offline";
  if (snapshot.status === "locked") return "locked";
  if (snapshot.status === "revoked") return "revoked";
  if (snapshot.status !== "ready" || !snapshot.masterKeyRevision) {
    return "unavailable";
  }
  if (!worker.encryption.supported) return "unavailable";
  if (worker.encryption.error?.toLowerCase().includes("revok")) {
    return "revoked";
  }
  if (worker.encryption.state === "pending-approval") {
    return "pending-approval";
  }
  if (worker.encryption.state === "error") return "unavailable";
  const grants = worker.encryption.grants.filter(
    ({ component }) => component === "private-surface-metadata",
  );
  if (grants.length === 0) return "missing-grant";
  if (
    !grants.some(
      ({ keyRevision }) => keyRevision === snapshot.masterKeyRevision,
    )
  ) {
    return "stale";
  }
  return worker.encryption.state === "ready" ? "ready" : "missing-grant";
}

export function privateLabelWorkerEncryptionCanAttempt(
  readiness: PrivateLabelWorkerEncryptionReadiness,
): boolean {
  return ["ready", "pending-approval", "missing-grant", "stale"].includes(
    readiness,
  );
}

export function privateLabelWorkerEncryptionMessage(
  readiness: PrivateLabelWorkerEncryptionReadiness,
  workerName = "The selected worker",
): string | null {
  switch (readiness) {
    case "ready":
      return null;
    case "offline":
      return `${workerName} is offline. Private labels can be opened when it reconnects.`;
    case "locked":
      return "Unlock encryption for this account before authorizing private labels.";
    case "pending-approval":
      return "Cantrip will approve and authorize this worker for private labels.";
    case "missing-grant":
      return "Cantrip will authorize this worker for private labels.";
    case "stale":
      return "Cantrip will refresh this worker's private-label key.";
    case "revoked":
      return "This worker's private-label authorization was revoked.";
    case "unavailable":
      return `${workerName} cannot use private-label encryption yet.`;
  }
}

export async function ensurePrivateLabelWorkerEncryption(input: {
  api?: WorkerGrantApi;
  refresh?: (
    workerId: string,
    input: {
      component: "private-surface-metadata";
      keyRevision: number;
    },
  ) => Promise<WorkerEncryptionRefreshResult>;
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
  worker: PrivateLabelWorkerEncryptionDescriptor | null | undefined;
}): Promise<WorkerEncryptionStatus> {
  const service = input.service ?? clientEncryption;
  const snapshot = service.getSnapshot();
  const worker = input.worker;
  const readiness = privateLabelWorkerEncryptionReadiness(worker, snapshot);
  if (!worker || !privateLabelWorkerEncryptionCanAttempt(readiness)) {
    throw new PrivateLabelWorkerEncryptionError(
      readiness === "ready" ? "unavailable" : readiness,
      privateLabelWorkerEncryptionMessage(readiness) ??
        "Private-label encryption is unavailable.",
    );
  }
  const session = (input.session ?? getClientSession)();
  const identity = session
    ? { ownerId: session.user.id, serverId: session.serverId }
    : null;
  if (
    !identity ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== identity.ownerId ||
    snapshot.identity.serverId !== identity.serverId
  ) {
    throw new PrivateLabelWorkerEncryptionError(
      "locked",
      "Encryption must be unlocked before authorizing a worker.",
    );
  }

  if (readiness !== "ready") {
    await authorizeWorkerEncryption({
      api: input.api,
      components: ["private-surface-metadata"],
      identity,
      keyRevision: snapshot.masterKeyRevision,
      service,
      workerId: worker.workerId,
    });
  }

  let refreshed: WorkerEncryptionRefreshResult;
  try {
    refreshed = await (input.refresh ?? refreshWorkerEncryption)(
      worker.workerId,
      {
        component: "private-surface-metadata",
        keyRevision: snapshot.masterKeyRevision,
      },
    );
  } catch (error) {
    throw new PrivateLabelWorkerEncryptionError(
      "unavailable",
      error instanceof Error
        ? `The worker could not refresh private-label encryption: ${error.message}`
        : "The worker could not refresh private-label encryption.",
    );
  }
  if (
    refreshed.component !== "private-surface-metadata" ||
    refreshed.keyRevision !== snapshot.masterKeyRevision
  ) {
    throw new PrivateLabelWorkerEncryptionError(
      "stale",
      "The worker returned readiness for another private-label key.",
    );
  }
  const refreshedReadiness = privateLabelWorkerEncryptionReadiness(
    { ...worker, encryption: refreshed.status },
    snapshot,
  );
  if (refreshedReadiness !== "ready") {
    throw new PrivateLabelWorkerEncryptionError(
      refreshedReadiness,
      privateLabelWorkerEncryptionMessage(refreshedReadiness) ??
        "The worker did not accept the private-label grant.",
    );
  }
  return refreshed.status;
}
