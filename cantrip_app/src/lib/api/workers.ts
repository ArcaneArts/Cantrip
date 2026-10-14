import {
  codeGraphActionAcknowledgementSchema,
  managedWebRuntimeActionResultSchema,
  managedWebRuntimeActionRequestSchema,
  codeGraphProjectStatusSchema,
  serviceLogReadResultSchema,
  directAttachmentTicketSchema,
  workerManagementListSchema,
  workerSummarySchema,
  workerUpdateSchema,
  workerRestartResultSchema,
  workerEnrollmentCodeResultSchema,
  workerEnrollmentCodeCreateSchema,
  workerEnrollmentCodeStatusSchema,
  workerCredentialListSchema,
  workerCredentialRotateResultSchema,
  workerCredentialRotateSchema,
} from "@cantrip/protocol";
import { post, request, withQuery } from "@/lib/api-client";
import type {
  ServiceLogLevel,
  WorkerUpdate,
  WorkerEnrollmentCodeCreate,
  WorkerCredentialRotate,
} from "@cantrip/protocol";
import { resolveWorkerRepositoryMetadata } from "./repository-identity";

export async function checkCodeGraphUpdate(workerId: string) {
  return codeGraphActionAcknowledgementSchema.parse(
    await post(
      `/api/workers/${encodeURIComponent(workerId)}/codegraph/update-check`,
      {},
    ),
  );
}

export async function runManagedWebRuntimeAction(
  workerId: string,
  input: import("@cantrip/protocol").ManagedWebRuntimeActionRequest,
) {
  return managedWebRuntimeActionResultSchema.parse(
    await post(
      `/api/workers/${encodeURIComponent(workerId)}/web-runtimes/actions`,
      managedWebRuntimeActionRequestSchema.parse(input),
    ),
  );
}

function codeGraphWorktreePath(projectId: string, worktreeId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/codegraph`;
}

export async function getCodeGraphWorktreeStatus(
  projectId: string,
  worktreeId: string,
) {
  return codeGraphProjectStatusSchema.parse(
    await request(codeGraphWorktreePath(projectId, worktreeId)),
  );
}

export async function requestCodeGraphWorktreeAction(
  projectId: string,
  worktreeId: string,
  action: "sync" | "rebuild",
) {
  return codeGraphActionAcknowledgementSchema.parse(
    await post(`${codeGraphWorktreePath(projectId, worktreeId)}/${action}`, {}),
  );
}

export async function getWorkerServiceLogs(
  workerId: string,
  options: {
    afterCursor?: number;
    beforeCursor?: number;
    limit?: number;
    minimumLevel?: ServiceLogLevel;
  } = {},
) {
  return serviceLogReadResultSchema.parse(
    await request(
      withQuery(`/api/workers/${encodeURIComponent(workerId)}/logs`, options),
    ),
  );
}

export async function createDirectWorkerProbe(workerId: string) {
  return directAttachmentTicketSchema.parse(
    await post(`/api/workers/${encodeURIComponent(workerId)}/direct-probe`, {}),
  );
}

export async function getWorkerManagement() {
  const workers = workerManagementListSchema.parse(
    await request("/api/workers/management"),
  );
  return Promise.all(
    workers.map(async (worker) => ({
      ...worker,
      sources: await Promise.all(
        worker.sources.map(async (source) => {
          try {
            const resolved = await resolveWorkerRepositoryMetadata({
              workerId: worker.workerId,
              scopeId: source.projectId,
              values: {
                nameWithOwner: source.nameWithOwner,
                displayPath: source.displayPath,
              },
            });
            return {
              ...source,
              nameWithOwner:
                typeof resolved.values.nameWithOwner === "string"
                  ? resolved.values.nameWithOwner
                  : "Protected repository unavailable",
              displayPath:
                typeof resolved.values.displayPath === "string"
                  ? resolved.values.displayPath
                  : "Protected path unavailable",
            };
          } catch {
            return {
              ...source,
              nameWithOwner: "Protected repository unavailable",
              displayPath: "Protected path unavailable",
            };
          }
        }),
      ),
    })),
  );
}

export async function getWorkerLocality() {
  return workerManagementListSchema
    .parse(await request("/api/workers/management"))
    .map(({ internal, workerId }) => ({ internal, workerId }));
}

export async function updateWorker(workerId: string, input: WorkerUpdate) {
  return workerSummarySchema.parse(
    await request(`/api/workers/${encodeURIComponent(workerId)}`, {
      method: "PATCH",
      body: JSON.stringify(workerUpdateSchema.parse(input)),
    }),
  );
}

export async function restartWorker(workerId: string) {
  return workerRestartResultSchema.parse(
    await post(`/api/workers/${encodeURIComponent(workerId)}/restart`, {}),
  );
}

export async function unlinkWorker(workerId: string) {
  await request(`/api/workers/${encodeURIComponent(workerId)}`, {
    method: "DELETE",
  });
}

export async function createWorkerEnrollmentCode(
  input: WorkerEnrollmentCodeCreate,
) {
  return workerEnrollmentCodeResultSchema.parse(
    await post(
      "/api/workers/enrollment-codes",
      workerEnrollmentCodeCreateSchema.parse(input),
    ),
  );
}

export async function getWorkerEnrollmentCodeStatus(enrollmentCodeId: string) {
  return workerEnrollmentCodeStatusSchema.parse(
    await request(
      `/api/workers/enrollment-codes/${encodeURIComponent(enrollmentCodeId)}`,
    ),
  );
}

export async function getWorkerCredentials(workerId: string) {
  return workerCredentialListSchema.parse(
    await request(`/api/workers/${encodeURIComponent(workerId)}/credentials`),
  );
}

export async function rotateWorkerCredential(
  workerId: string,
  input: WorkerCredentialRotate,
) {
  return workerCredentialRotateResultSchema.parse(
    await post(
      `/api/workers/${encodeURIComponent(workerId)}/credentials/rotate`,
      workerCredentialRotateSchema.parse(input),
    ),
  );
}

export async function revokeWorkerCredential(
  workerId: string,
  credentialId: string,
) {
  await request(
    `/api/workers/${encodeURIComponent(workerId)}/credentials/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" },
  );
}
