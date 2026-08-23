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
import { refreshWorkerEncryption } from "./api";
import {
  authorizeWorkerEncryption,
  type WorkerGrantApi,
} from "./worker-encryption-grants";

export type TaskWorkerEncryptionReadiness =
  | "ready"
  | "offline"
  | "locked"
  | "pending-approval"
  | "missing-grant"
  | "revoked"
  | "wrong-revision"
  | "unavailable";

export type TaskWorkerEncryptionDescriptor = Pick<
  WorkerSummary,
  "encryption" | "online" | "workerId"
>;

export class TaskWorkerEncryptionError extends Error {
  constructor(
    readonly state: Exclude<TaskWorkerEncryptionReadiness, "ready">,
    message: string,
  ) {
    super(message);
    this.name = "TaskWorkerEncryptionError";
  }
}

export function taskWorkerEncryptionReadiness(
  worker: TaskWorkerEncryptionDescriptor | null | undefined,
  snapshot: ClientEncryptionSnapshot = clientEncryption.getSnapshot(),
): TaskWorkerEncryptionReadiness {
  if (!worker?.online) return "offline";
  if (snapshot.status === "locked") return "locked";
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
  for (const component of [
    "attachment-content",
    "task-content",
    "client-control-content",
    "customization-content",
    "mcp-secret",
    "policy-content",
    "provider-credential",
    "repository-content",
    "run-content",
  ] as const) {
    const grants = worker.encryption.grants.filter(
      (grant) => grant.component === component,
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
  return worker.encryption.state === "ready" ? "ready" : "missing-grant";
}

export function taskWorkerEncryptionCanAttempt(
  readiness: TaskWorkerEncryptionReadiness,
): boolean {
  return [
    "ready",
    "pending-approval",
    "missing-grant",
    "wrong-revision",
  ].includes(readiness);
}

export function taskWorkerEncryptionMessage(
  readiness: TaskWorkerEncryptionReadiness,
  workerName = "The selected worker",
): string | null {
  switch (readiness) {
    case "ready":
      return null;
    case "offline":
      return `${workerName} is offline. The Task can continue when it reconnects.`;
    case "locked":
      return "Unlock encryption for this account before starting a Task operation.";
    case "pending-approval":
      return "Cantrip will approve and authorize this worker for Task content when the operation starts.";
    case "missing-grant":
      return "Cantrip will authorize this worker for Task content when the operation starts.";
    case "wrong-revision":
      return "Cantrip will refresh this worker's Task key before the operation starts.";
    case "revoked":
      return "This worker's Task encryption authorization was revoked.";
    case "unavailable":
      return `${workerName} cannot use Task encryption yet.`;
  }
}

export async function ensureTaskWorkerEncryption(input: {
  api?: WorkerGrantApi;
  refresh?: (
    workerId: string,
    input: { component: "task-content"; keyRevision: number },
  ) => Promise<WorkerEncryptionRefreshResult>;
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
  worker: TaskWorkerEncryptionDescriptor | null | undefined;
}): Promise<WorkerEncryptionStatus> {
  const service = input.service ?? clientEncryption;
  const snapshot = service.getSnapshot();
  const worker = input.worker;
  const readiness = taskWorkerEncryptionReadiness(worker, snapshot);
  if (!worker || !taskWorkerEncryptionCanAttempt(readiness)) {
    throw new TaskWorkerEncryptionError(
      readiness === "ready" ? "unavailable" : readiness,
      taskWorkerEncryptionMessage(readiness, "The selected worker") ??
        "Task encryption is unavailable.",
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
    throw new TaskWorkerEncryptionError(
      "locked",
      "Encryption must be unlocked for this account before authorizing a worker.",
    );
  }

  if (readiness !== "ready") {
    await authorizeWorkerEncryption({
      api: input.api,
      components: [
        "attachment-content",
        "task-content",
        "client-control-content",
        "customization-content",
        "mcp-secret",
        "policy-content",
        "provider-credential",
        "repository-content",
        "run-content",
      ],
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
        component: "task-content",
        keyRevision: snapshot.masterKeyRevision,
      },
    );
  } catch (error) {
    if (error instanceof TaskWorkerEncryptionError) throw error;
    throw new TaskWorkerEncryptionError(
      "unavailable",
      error instanceof Error
        ? `The worker could not refresh Task encryption: ${error.message}`
        : "The worker could not refresh Task encryption.",
    );
  }
  if (
    refreshed.component !== "task-content" ||
    refreshed.keyRevision !== snapshot.masterKeyRevision
  ) {
    throw new TaskWorkerEncryptionError(
      "wrong-revision",
      "The worker returned readiness for a different Task encryption key.",
    );
  }
  const refreshedReadiness = taskWorkerEncryptionReadiness(
    { ...worker, encryption: refreshed.status },
    snapshot,
  );
  if (refreshedReadiness !== "ready") {
    throw new TaskWorkerEncryptionError(
      refreshedReadiness,
      taskWorkerEncryptionMessage(refreshedReadiness) ??
        "The worker did not accept the Task encryption grant.",
    );
  }
  return refreshed.status;
}
