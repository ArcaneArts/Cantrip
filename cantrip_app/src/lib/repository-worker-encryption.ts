import type {
  WorkerEncryptionRefreshResult,
  WorkerEncryptionStatus,
  WorkerSummary,
} from "@cantrip/protocol";

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

export type RepositoryWorkerReadiness =
  | "ready"
  | "offline"
  | "locked"
  | "pending-approval"
  | "missing-grant"
  | "revoked"
  | "stale"
  | "unavailable";

export type RepositoryWorkerDescriptor = Pick<
  WorkerSummary,
  "encryption" | "online" | "workerId"
>;

export class RepositoryWorkerReadinessError extends Error {
  constructor(
    readonly state: Exclude<RepositoryWorkerReadiness, "ready">,
    message: string,
  ) {
    super(message);
    this.name = "RepositoryWorkerReadinessError";
  }
}

export function repositoryWorkerReadiness(
  worker: RepositoryWorkerDescriptor | null | undefined,
  snapshot: ClientEncryptionSnapshot = clientEncryption.getSnapshot(),
): RepositoryWorkerReadiness {
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
    ({ component }) => component === "repository-content",
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

export async function ensureRepositoryWorkerEncryption(input: {
  api?: WorkerGrantApi;
  refresh: (
    workerId: string,
    input: { component: "repository-content"; keyRevision: number },
  ) => Promise<WorkerEncryptionRefreshResult>;
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
  worker: RepositoryWorkerDescriptor | null | undefined;
}): Promise<WorkerEncryptionStatus> {
  const service = input.service ?? clientEncryption;
  const snapshot = service.getSnapshot();
  const worker = input.worker;
  const readiness = repositoryWorkerReadiness(worker, snapshot);
  if (
    !worker ||
    !["ready", "pending-approval", "missing-grant", "stale"].includes(readiness)
  ) {
    throw new RepositoryWorkerReadinessError(
      readiness === "ready" ? "unavailable" : readiness,
      "Repository encryption is unavailable for this worker.",
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
    throw new RepositoryWorkerReadinessError(
      "locked",
      "Encryption must be unlocked before authorizing a worker.",
    );
  }
  if (readiness === "ready") return worker.encryption;
  await authorizeWorkerEncryption({
    api: input.api,
    components: ["repository-content"],
    identity,
    keyRevision: snapshot.masterKeyRevision,
    service,
    workerId: worker.workerId,
  });
  const refreshed = await input.refresh(worker.workerId, {
    component: "repository-content",
    keyRevision: snapshot.masterKeyRevision,
  });
  if (
    refreshed.component !== "repository-content" ||
    refreshed.keyRevision !== snapshot.masterKeyRevision
  ) {
    throw new RepositoryWorkerReadinessError(
      "stale",
      "The worker returned readiness for another repository key.",
    );
  }
  const refreshedReadiness = repositoryWorkerReadiness(
    { ...worker, encryption: refreshed.status },
    snapshot,
  );
  if (refreshedReadiness !== "ready") {
    throw new RepositoryWorkerReadinessError(
      refreshedReadiness,
      "The worker did not accept the repository-content grant.",
    );
  }
  return refreshed.status;
}
