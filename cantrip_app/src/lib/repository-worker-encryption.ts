import type {
  WorkerEncryptionRefreshResult,
  WorkerEncryptionStatus,
  WorkerSummary,
} from "@cantrip/protocol";

import type { ClientSessionContext } from "./client-session";
import {
  clientSessionIdentityMatches,
  getClientSession,
  getClientSessionIdentitySnapshot,
} from "./client-session";
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
  let readiness = repositoryWorkerReadiness(worker, snapshot);
  if (!worker || ["offline", "locked", "revoked"].includes(readiness)) {
    throw new RepositoryWorkerReadinessError(
      readiness === "ready" ? "unavailable" : readiness,
      "The worker's protected server connection is unavailable.",
    );
  }
  const getSession = input.session ?? getClientSession;
  const session = getSession();
  const sessionIdentity = input.session
    ? null
    : getClientSessionIdentitySnapshot();
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
  const keyRevision = snapshot.masterKeyRevision;
  const assertCurrent = () => {
    const current = getSession();
    if (
      service.getSnapshot() !== snapshot ||
      current?.user.id !== identity.ownerId ||
      current.serverId !== identity.serverId ||
      (sessionIdentity && !clientSessionIdentityMatches(sessionIdentity))
    ) {
      throw new RepositoryWorkerReadinessError(
        "locked",
        "Encryption identity changed while authorizing the worker. Try again after unlocking.",
      );
    }
  };
  if (readiness === "ready") return worker.encryption;
  const refresh = async () => {
    assertCurrent();
    const result = await input.refresh(worker.workerId, {
      component: "repository-content",
      keyRevision,
    });
    assertCurrent();
    if (
      result.component !== "repository-content" ||
      result.keyRevision !== keyRevision
    ) {
      throw new RepositoryWorkerReadinessError(
        "stale",
        "The worker returned readiness for another repository key.",
      );
    }
    return {
      status: result.status,
      readiness: repositoryWorkerReadiness(
        { ...worker, encryption: result.status },
        snapshot,
      ),
    };
  };
  // The first heartbeat can retain a bootstrap error from before onboarding
  // initialized the account. Refresh actual authority before granting its key.
  if (readiness === "unavailable") {
    const refreshed = await refresh();
    const { status } = refreshed;
    readiness = refreshed.readiness;
    if (readiness === "ready") return status;
    if (!["pending-approval", "missing-grant", "stale"].includes(readiness)) {
      throw new RepositoryWorkerReadinessError(
        readiness,
        "The worker's protected server connection is unavailable.",
      );
    }
  }
  const grants = await authorizeWorkerEncryption({
    api: input.api,
    assertCurrent,
    components: ["repository-content"],
    identity,
    keyRevision,
    service,
    workerId: worker.workerId,
  });
  let refreshed = await refresh();
  const principalId = grants[0]?.principalId;
  // A heartbeat refresh started before createGrant can be joined by the first
  // command. Once it completes, one fresh command can observe the committed
  // grant. Never retry a rejected refresh, revocation, or a replaced identity.
  for (let attempt = 0; ; attempt += 1) {
    const { status, readiness } = refreshed;
    if (status.principalId !== principalId) {
      throw new RepositoryWorkerReadinessError(
        "stale",
        "The worker encryption identity changed while authorizing its repository key.",
      );
    }
    if (readiness === "ready") return status;
    if (
      attempt === 0 &&
      ["pending-approval", "missing-grant", "stale"].includes(readiness)
    ) {
      refreshed = await refresh();
      continue;
    }
    throw new RepositoryWorkerReadinessError(
      readiness,
      "The worker did not activate its protected server connection.",
    );
  }
}
