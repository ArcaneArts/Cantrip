import {
  cantripOsBackupAdmissionSchema,
  cantripOsResetPathsSchema,
  cantripOsBackupListQuerySchema,
  cantripOsBackupPageSchema,
  cantripOsBackupRecoverySchema,
  cantripOsBackupSummarySchema,
  cantripOsBackupPrivateRequestSchema,
  type CantripOsInstanceSummary,
  type CantripOsBackupAdmission,
} from "@cantrip/protocol";
import type { z } from "zod";
import { request, CantripApiError } from "@/lib/api-client";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import { clientEncryption } from "@/lib/client-encryption";
import { authorizeWorkerEncryption } from "@/lib/worker-encryption-grants";
import {
  protectCantripOsBackupRequest,
  openCantripOsBackupRequest,
  openCantripOsBackupResult,
} from "@/lib/cantrip-os-backup-encryption";
import { refreshWorkerEncryption } from "./worker-wire";

export type CantripOsBackupSummary = z.infer<
  typeof cantripOsBackupSummarySchema
>;
export type CantripOsBackupIntent = z.infer<
  typeof cantripOsBackupPrivateRequestSchema
>;
export type CantripOsBackupDetails = Awaited<
  ReturnType<typeof openCantripOsBackupDetails>
>;
const route = (id: string) => encodeURIComponent(id);
const operation = (id: string) =>
  `/api/cantrip-os/backup-operations/${route(id)}`;

function authenticated() {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new CantripApiError("An authenticated session is required.", 401);
  return identity;
}

/** Refresh performs the real Worker bootstrap, loading every still-active key
 * revision. The response envelope revision is NOT the archive file revision.
 * Revoked historical grants are not silently recreated. */
async function authorizeBackupWorker(workerId: string) {
  const identity = authenticated();
  const snapshot = clientEncryption.getSnapshot();
  if (
    snapshot.status !== "ready" ||
    !snapshot.identity ||
    !snapshot.masterKeyRevision ||
    snapshot.identity.ownerId !== identity.userId ||
    snapshot.identity.serverId !== identity.serverId
  )
    throw new Error(
      "Unlock encryption for this account to use private backups.",
    );
  const assertCurrent = () => {
    if (
      !clientSessionIdentityMatches(identity) ||
      clientEncryption.getSnapshot() !== snapshot
    )
      throw new CantripApiError(
        "The account or server changed during backup authorization.",
        409,
      );
  };
  await authorizeWorkerEncryption({
    workerId,
    components: ["repository-content"],
    identity: snapshot.identity,
    keyRevision: snapshot.masterKeyRevision,
    assertCurrent,
  });
  assertCurrent();
  await refreshWorkerEncryption(workerId, {
    component: "repository-content",
    keyRevision: snapshot.masterKeyRevision,
  });
  assertCurrent();
  return identity;
}

export async function prepareCantripOsBackup(
  instance: CantripOsInstanceSummary,
  intent: CantripOsBackupIntent,
  operationId: string = crypto.randomUUID(),
) {
  const identity = await authorizeBackupWorker(instance.workerId);
  const content = cantripOsBackupPrivateRequestSchema.parse(intent);
  const protectedRequest = await protectCantripOsBackupRequest(
    operationId,
    content,
  );
  if (!clientSessionIdentityMatches(identity))
    throw new CantripApiError(
      "The account or server changed while preparing this backup operation.",
      409,
    );
  return cantripOsBackupAdmissionSchema.parse({
    operationId,
    workspaceId: content.workspaceId,
    attachmentGeneration: instance.attachmentGeneration,
    runtimeGeneration: instance.runtimeGeneration,
    protectedRequest,
    action: content.action,
    ...(content.action === "restore"
      ? { backupId: content.backupId, replace: content.replace }
      : {}),
    ...(content.action === "rollback"
      ? { restoreOperationId: content.restoreOperationId }
      : {}),
  });
}

function assertSummary(
  summary: CantripOsBackupSummary,
  admission: CantripOsBackupAdmission,
  instanceId: string,
) {
  if (
    summary.operationId !== admission.operationId ||
    summary.action !== admission.action ||
    summary.instanceId !== instanceId ||
    summary.workspaceId !== admission.workspaceId ||
    JSON.stringify(summary.protectedRequest) !==
      JSON.stringify(admission.protectedRequest) ||
    (admission.action === "restore" &&
      summary.backupId !== admission.backupId) ||
    (admission.action === "rollback" &&
      summary.restoreOperationId !== admission.restoreOperationId)
  )
    throw new Error("The backup operation response was misrouted.");
  return summary;
}

/** Persist this opaque admission before calling. An identical repeat observes
 * the original Server admission; it never encrypts another intent or operation. */
export async function submitCantripOsBackup(
  instanceId: string,
  input: CantripOsBackupAdmission,
) {
  const identity = authenticated();
  const admission = cantripOsBackupAdmissionSchema.parse(input);
  const summary = cantripOsBackupSummarySchema.parse(
    await request(
      `/api/cantrip-os/${route(instanceId)}/backup-operations`,
      { method: "POST", body: JSON.stringify(admission) },
      { expectedIdentity: identity, allowCsrfRecovery: false },
    ),
  );
  return assertSummary(summary, admission, instanceId);
}

export async function getCantripOsBackupOperation(id: string) {
  const summary = cantripOsBackupSummarySchema.parse(
    await request(operation(id), {}, { expectedIdentity: authenticated() }),
  );
  if (summary.operationId !== id)
    throw new Error("The backup observation was misrouted.");
  return summary;
}
export async function getCantripOsBackupOperations(cursor?: string) {
  const query = cantripOsBackupListQuerySchema.parse({
    limit: 20,
    ...(cursor ? { cursor } : {}),
  });
  const search = new URLSearchParams({
    limit: String(query.limit),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  return cantripOsBackupPageSchema.parse(
    await request(
      `/api/cantrip-os/backup-operations?${search}`,
      {},
      { expectedIdentity: authenticated() },
    ),
  );
}
export async function recoverCantripOsBackup(
  summary: CantripOsBackupSummary,
  input: z.input<typeof cantripOsBackupRecoverySchema>,
) {
  const identity = await authorizeBackupWorker(summary.workerId);
  const body = cantripOsBackupRecoverySchema.parse(input);
  const result = cantripOsBackupSummarySchema.parse(
    await request(
      `${operation(summary.operationId)}/recovery`,
      { method: "POST", body: JSON.stringify(body) },
      { expectedIdentity: identity, allowCsrfRecovery: false },
    ),
  );
  if (
    result.operationId !== summary.operationId ||
    result.instanceId !== summary.instanceId ||
    result.workspaceId !== summary.workspaceId ||
    result.action !== summary.action ||
    result.backupId !== summary.backupId ||
    result.restoreOperationId !== summary.restoreOperationId ||
    JSON.stringify(result.protectedRequest) !==
      JSON.stringify(summary.protectedRequest)
  )
    throw new Error("The backup recovery response was misrouted.");
  return result;
}

export async function openCantripOsBackupDetails(
  summary: CantripOsBackupSummary,
) {
  const intent = await openCantripOsBackupRequest(
    summary.operationId,
    summary.protectedRequest,
  );
  if (
    intent.action !== summary.action ||
    intent.workspaceId !== summary.workspaceId ||
    (intent.action === "restore" &&
      (intent.backupId !== summary.backupId ||
        summary.restoreOperationId !== null)) ||
    (intent.action === "rollback" &&
      intent.restoreOperationId !== summary.restoreOperationId)
  )
    throw new Error("Private backup intent differs from its Server admission.");
  const result = summary.result?.protectedResult
    ? await openCantripOsBackupResult(
        summary.operationId,
        summary.result.protectedResult,
      )
    : null;
  if (
    summary.result &&
    (summary.result.operationId !== summary.operationId ||
      summary.result.action !== summary.action)
  )
    throw new Error("The backup outcome was misrouted.");
  if (
    result &&
    ((result.action === "error" ? result.operationAction : result.action) !==
      summary.action ||
      (result.action === "restore" && result.backupId !== summary.backupId) ||
      (result.action === "rollback" &&
        result.restoreOperationId !== summary.restoreOperationId))
  )
    throw new Error(
      "Private backup outcome differs from its Server admission.",
    );
  if (result?.action === "reset") {
    if (
      intent.action !== "reset" ||
      JSON.stringify(
        cantripOsResetPathsSchema.parse(result.receipt.reset_paths),
      ) !== JSON.stringify(intent.paths) ||
      result.receipt.shared_system_state_changed !== false ||
      result.receipt.runtime_handles_restored !== false ||
      typeof result.receipt.retained_original_home !== "string" ||
      !result.receipt.retained_original_home.startsWith("/")
    )
      throw new Error(
        "The private reset receipt differs from its saved selection.",
      );
  }
  if (
    summary.result?.state === "ready" &&
    (!result || result.action === "error")
  )
    throw new Error("The backup has no authenticated successful outcome.");
  return { intent, result };
}
