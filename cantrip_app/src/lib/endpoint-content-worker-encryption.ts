import type {
  WorkerEncryptionRefreshResult,
  WorkerEncryptionStatus,
  WorkerSummary,
} from "@cantrip/protocol";
import {
  endpointContentDomainSchema,
  type EndpointContentDomain,
} from "@cantrip/protocol/endpoint-content";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type {
  ClientEncryptionService,
  ClientEncryptionSnapshot,
} from "./client-encryption";
import { clientEncryption } from "./client-encryption";
import { refreshWorkerEncryption } from "./api";
import {
  authorizeWorkerEncryption,
  type WorkerGrantApi,
} from "./worker-encryption-grants";

export type EndpointContentWorkerReadiness =
  | "ready"
  | "offline"
  | "locked"
  | "pending-approval"
  | "missing-grant"
  | "revoked"
  | "wrong-revision"
  | "unavailable";

export type EndpointContentWorkerDescriptor = Pick<
  WorkerSummary,
  "encryption" | "online" | "workerId"
>;

export class EndpointContentWorkerEncryptionError extends Error {
  constructor(
    readonly state: Exclude<EndpointContentWorkerReadiness, "ready">,
    message: string,
  ) {
    super(message);
    this.name = "EndpointContentWorkerEncryptionError";
  }
}

function domains(input: readonly EndpointContentDomain[]) {
  return [
    ...new Set(
      input.map((domain) => endpointContentDomainSchema.parse(domain)),
    ),
  ];
}

export function endpointContentWorkerReadiness(input: {
  domains: readonly EndpointContentDomain[];
  snapshot?: ClientEncryptionSnapshot;
  worker: EndpointContentWorkerDescriptor | null | undefined;
}): EndpointContentWorkerReadiness {
  const snapshot = input.snapshot ?? clientEncryption.getSnapshot();
  if (!input.worker?.online) return "offline";
  if (snapshot.status === "locked") return "locked";
  if (snapshot.status === "revoked") return "revoked";
  if (snapshot.status !== "ready" || !snapshot.masterKeyRevision) {
    return "unavailable";
  }
  if (!input.worker.encryption.supported) return "unavailable";
  if (input.worker.encryption.error?.toLowerCase().includes("revok")) {
    return "revoked";
  }
  if (input.worker.encryption.state === "pending-approval") {
    return "pending-approval";
  }
  if (input.worker.encryption.state === "error") return "unavailable";
  for (const domain of domains(input.domains)) {
    const grants = input.worker.encryption.grants.filter(
      ({ component }) => component === domain,
    );
    if (grants.length === 0) return "missing-grant";
    if (
      !grants.some(
        ({ keyRevision }) => keyRevision === snapshot.masterKeyRevision,
      )
    ) {
      return "wrong-revision";
    }
  }
  return input.worker.encryption.state === "ready" ? "ready" : "missing-grant";
}

export async function ensureEndpointContentWorkerEncryption(input: {
  api?: WorkerGrantApi;
  domains: readonly EndpointContentDomain[];
  refresh?: (
    workerId: string,
    input: { component: EndpointContentDomain; keyRevision: number },
  ) => Promise<WorkerEncryptionRefreshResult>;
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
  worker: EndpointContentWorkerDescriptor | null | undefined;
}): Promise<WorkerEncryptionStatus> {
  const service = input.service ?? clientEncryption;
  const snapshot = service.getSnapshot();
  const requiredDomains = domains(input.domains);
  if (requiredDomains.length === 0) {
    throw new EndpointContentWorkerEncryptionError(
      "unavailable",
      "At least one protected content domain is required.",
    );
  }
  const readiness = endpointContentWorkerReadiness({
    domains: requiredDomains,
    snapshot,
    worker: input.worker,
  });
  if (
    !input.worker ||
    !["ready", "pending-approval", "missing-grant", "wrong-revision"].includes(
      readiness,
    )
  ) {
    throw new EndpointContentWorkerEncryptionError(
      readiness === "ready" ? "unavailable" : readiness,
      "The worker's protected content connection is unavailable.",
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
    throw new EndpointContentWorkerEncryptionError(
      "locked",
      "Encryption must be unlocked before authorizing a worker.",
    );
  }
  if (readiness !== "ready") {
    await authorizeWorkerEncryption({
      api: input.api,
      components: requiredDomains,
      identity,
      keyRevision: snapshot.masterKeyRevision,
      service,
      workerId: input.worker.workerId,
    });
  }
  const refreshDomain = requiredDomains[0]!;
  const refreshed = await (input.refresh ?? refreshWorkerEncryption)(
    input.worker.workerId,
    {
      component: refreshDomain,
      keyRevision: snapshot.masterKeyRevision,
    },
  );
  if (
    refreshed.component !== refreshDomain ||
    refreshed.keyRevision !== snapshot.masterKeyRevision
  ) {
    throw new EndpointContentWorkerEncryptionError(
      "wrong-revision",
      "The worker returned readiness for another protected content key.",
    );
  }
  const refreshedReadiness = endpointContentWorkerReadiness({
    domains: requiredDomains,
    snapshot,
    worker: { ...input.worker, encryption: refreshed.status },
  });
  if (refreshedReadiness !== "ready") {
    throw new EndpointContentWorkerEncryptionError(
      refreshedReadiness,
      "The worker did not activate all required protected content grants.",
    );
  }
  return refreshed.status;
}
