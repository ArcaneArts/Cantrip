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

export type SurfacePrivateStateWorkerReadiness =
  | "ready"
  | "offline"
  | "locked"
  | "pending-approval"
  | "missing-grant"
  | "revoked"
  | "stale"
  | "unavailable";

export type SurfacePrivateStateWorkerDescriptor = Pick<
  WorkerSummary,
  "encryption" | "online" | "workerId"
>;

export class SurfacePrivateStateWorkerReadinessError extends Error {
  constructor(
    readonly state: Exclude<SurfacePrivateStateWorkerReadiness, "ready">,
    message: string,
  ) {
    super(message);
    this.name = "SurfacePrivateStateWorkerReadinessError";
  }
}

export function surfacePrivateStateWorkerReadiness(
  worker: SurfacePrivateStateWorkerDescriptor | null | undefined,
  snapshot: ClientEncryptionSnapshot = clientEncryption.getSnapshot(),
): SurfacePrivateStateWorkerReadiness {
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
    ({ component }) => component === "surface-private-state",
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

export function surfacePrivateStateWorkerCanAttempt(
  readiness: SurfacePrivateStateWorkerReadiness,
): boolean {
  return ["ready", "pending-approval", "missing-grant", "stale"].includes(
    readiness,
  );
}

export async function ensureSurfacePrivateStateWorkerEncryption(input: {
  api?: WorkerGrantApi;
  refresh?: (
    workerId: string,
    input: { component: "surface-private-state"; keyRevision: number },
  ) => Promise<WorkerEncryptionRefreshResult>;
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
  worker: SurfacePrivateStateWorkerDescriptor | null | undefined;
}): Promise<WorkerEncryptionStatus> {
  const service = input.service ?? clientEncryption;
  const snapshot = service.getSnapshot();
  const worker = input.worker;
  const readiness = surfacePrivateStateWorkerReadiness(worker, snapshot);
  if (!worker || !surfacePrivateStateWorkerCanAttempt(readiness)) {
    throw new SurfacePrivateStateWorkerReadinessError(
      readiness === "ready" ? "unavailable" : readiness,
      "Surface private-state encryption is unavailable for this worker.",
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
    throw new SurfacePrivateStateWorkerReadinessError(
      "locked",
      "Encryption must be unlocked before authorizing a worker.",
    );
  }

  if (readiness !== "ready") {
    await authorizeWorkerEncryption({
      api: input.api,
      components: ["surface-private-state"],
      identity,
      keyRevision: snapshot.masterKeyRevision,
      service,
      workerId: worker.workerId,
    });
  }

  const refreshed = await (input.refresh ?? refreshWorkerEncryption)(
    worker.workerId,
    {
      component: "surface-private-state",
      keyRevision: snapshot.masterKeyRevision,
    },
  );
  if (
    refreshed.component !== "surface-private-state" ||
    refreshed.keyRevision !== snapshot.masterKeyRevision
  ) {
    throw new SurfacePrivateStateWorkerReadinessError(
      "stale",
      "The worker returned readiness for another surface-state key.",
    );
  }
  const refreshedReadiness = surfacePrivateStateWorkerReadiness(
    { ...worker, encryption: refreshed.status },
    snapshot,
  );
  if (refreshedReadiness !== "ready") {
    throw new SurfacePrivateStateWorkerReadinessError(
      refreshedReadiness,
      "The worker did not accept the surface private-state grant.",
    );
  }
  return refreshed.status;
}
