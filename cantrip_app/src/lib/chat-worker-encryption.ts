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

export type ChatWorkerEncryptionReadiness =
  | "ready"
  | "offline"
  | "locked"
  | "pending-approval"
  | "missing-grant"
  | "revoked"
  | "wrong-revision"
  | "unavailable";

export type ChatWorkerEncryptionDescriptor = Pick<
  WorkerSummary,
  "encryption" | "online" | "workerId"
>;

export class ChatWorkerEncryptionError extends Error {
  constructor(
    readonly state: Exclude<ChatWorkerEncryptionReadiness, "ready">,
    message: string,
  ) {
    super(message);
    this.name = "ChatWorkerEncryptionError";
  }
}

export function chatWorkerEncryptionReadiness(
  worker: ChatWorkerEncryptionDescriptor | null | undefined,
  snapshot: ClientEncryptionSnapshot = clientEncryption.getSnapshot(),
): ChatWorkerEncryptionReadiness {
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
  const requiredComponents = [
    "attachment-content",
    "chat-content",
    "interaction-content",
    "mcp-secret",
    "policy-content",
    "provider-credential",
    "workflow-content",
  ] as const;
  if (
    !requiredComponents.every((component) =>
      worker.encryption.grants.some(
        (grant) =>
          grant.component === component &&
          grant.keyRevision === snapshot.masterKeyRevision,
      ),
    )
  ) {
    const hasEveryComponent = requiredComponents.every((component) =>
      worker.encryption.grants.some((grant) => grant.component === component),
    );
    if (!hasEveryComponent) return "missing-grant";
    return "wrong-revision";
  }
  return worker.encryption.state === "ready" ? "ready" : "missing-grant";
}

export async function ensureChatWorkerEncryption(input: {
  api?: WorkerGrantApi;
  refresh?: (
    workerId: string,
    input: { component: "chat-content"; keyRevision: number },
  ) => Promise<WorkerEncryptionRefreshResult>;
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
  worker: ChatWorkerEncryptionDescriptor | null | undefined;
}): Promise<WorkerEncryptionStatus> {
  const service = input.service ?? clientEncryption;
  const snapshot = service.getSnapshot();
  const worker = input.worker;
  const readiness = chatWorkerEncryptionReadiness(worker, snapshot);
  if (
    !worker ||
    ["offline", "locked", "revoked", "unavailable"].includes(readiness)
  ) {
    throw new ChatWorkerEncryptionError(
      readiness === "ready" ? "unavailable" : readiness,
      readiness === "offline"
        ? "The selected worker is offline."
        : readiness === "locked"
          ? "Encryption must be unlocked for this account."
          : "The selected worker cannot use chat encryption yet.",
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
    throw new ChatWorkerEncryptionError(
      "locked",
      "Encryption must be unlocked before authorizing the worker.",
    );
  }
  if (readiness !== "ready") {
    await authorizeWorkerEncryption({
      api: input.api,
      components: [
        "attachment-content",
        "chat-content",
        "interaction-content",
        "mcp-secret",
        "policy-content",
        "provider-credential",
        "workflow-content",
      ],
      identity,
      keyRevision: snapshot.masterKeyRevision,
      service,
      workerId: worker.workerId,
    });
  }
  const refreshed = await (input.refresh ?? refreshWorkerEncryption)(
    worker.workerId,
    {
      component: "chat-content",
      keyRevision: snapshot.masterKeyRevision,
    },
  );
  if (
    refreshed.component !== "chat-content" ||
    refreshed.keyRevision !== snapshot.masterKeyRevision ||
    chatWorkerEncryptionReadiness(
      { ...worker, encryption: refreshed.status },
      snapshot,
    ) !== "ready"
  ) {
    throw new ChatWorkerEncryptionError(
      "wrong-revision",
      "The worker did not accept the current chat encryption key.",
    );
  }
  return refreshed.status;
}
