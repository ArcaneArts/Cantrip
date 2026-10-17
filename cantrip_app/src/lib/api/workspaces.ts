import {
  projectWorkspaceWireListSchema,
  projectWorkspaceWireSummarySchema,
  encryptedProjectWorkspaceCreateSchema,
  encryptedAttachedProjectWorkspaceCreateResultSchema,
  encryptedProjectWorkspaceUpdateSchema,
} from "@cantrip/protocol";
import { request, post, CantripApiError } from "@/lib/api-client";
import type {
  EncryptedProjectWorkspaceCreate,
  EncryptedProjectWorkspaceName,
  EncryptedProjectWorkspaceUpdate,
} from "@cantrip/protocol";
import { ensureRepositoryWorkerEncryption } from "@/lib/repository-worker-encryption";
import {
  protectRepositoryOperationContent,
  openRepositoryOperationContent,
} from "@/lib/repository-operation-encryption";
import {
  repositoryOperationRequestContentSchema,
  repositoryOperationOutcomeContentSchema,
  workspaceRootAttachmentSchema,
} from "@cantrip/protocol/repository-operation";
import { getWorkers, refreshWorkerEncryption } from "./worker-wire";

export async function getProjectWorkspaceWireList() {
  return projectWorkspaceWireListSchema.parse(await request("/api/workspaces"));
}

export async function createEncryptedProjectWorkspace(
  input: EncryptedProjectWorkspaceCreate,
) {
  return projectWorkspaceWireSummarySchema.parse(
    await post(
      "/api/workspaces",
      encryptedProjectWorkspaceCreateSchema.parse(input),
    ),
  );
}

export async function createEncryptedAttachedProjectWorkspace(input: {
  id: string;
  nameProtection: EncryptedProjectWorkspaceName;
  rootPath: string;
  workerId: string;
}) {
  const worker = (await getWorkers()).find(
    ({ workerId }) => workerId === input.workerId,
  );
  await ensureRepositoryWorkerEncryption({
    refresh: refreshWorkerEncryption,
    worker,
  });
  const operationId = crypto.randomUUID();
  const context = {
    projectId: input.id,
    worktreeId: input.workerId,
    operationId,
  };
  const protectedRequest = await protectRepositoryOperationContent({
    context: { ...context, direction: "request" },
    content: {
      type: "workspace.root.attach" as const,
      arguments: { rootPath: input.rootPath },
    },
    schema: repositoryOperationRequestContentSchema,
  });
  const result = encryptedAttachedProjectWorkspaceCreateResultSchema.parse(
    await post("/api/workspaces/attached", {
      id: input.id,
      nameProtection: input.nameProtection,
      storage: { kind: "attached", workerId: input.workerId },
      operationId,
      protectedRequest,
    }),
  );
  const outcome = await openRepositoryOperationContent({
    context: { ...context, direction: "response" },
    opaque: result.operation.protectedResponse,
    schema: repositoryOperationOutcomeContentSchema,
  });
  if (!outcome.ok) {
    throw new CantripApiError(outcome.error, 422, outcome.code ?? null);
  }
  const attachment = workspaceRootAttachmentSchema.parse(outcome.result);
  if (
    !result.workspace ||
    result.workspace.storage.kind !== "attached" ||
    result.workspace.storage.rootPathHandle !== attachment.rootPathHandle ||
    result.workspace.storage.displayHandle !== attachment.displayHandle
  ) {
    throw new CantripApiError(
      "Attached workspace binding did not match the worker response.",
      502,
    );
  }
  return result.workspace;
}

export async function updateEncryptedProjectWorkspace(
  workspaceId: string,
  input: EncryptedProjectWorkspaceUpdate,
) {
  return projectWorkspaceWireSummarySchema.parse(
    await request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: "PATCH",
      body: JSON.stringify(encryptedProjectWorkspaceUpdateSchema.parse(input)),
    }),
  );
}

export async function deleteProjectWorkspace(workspaceId: string) {
  await request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "DELETE",
  });
}
