import {
  workspaceRepositoryDiscoverySnapshotSchema,
  workspaceRepositoryDiscoveryStartSchema,
  workspaceRepositoryImportStartSchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import type {
  WorkspaceRepositoryDiscoveryStart,
  WorkspaceRepositoryImportStart,
} from "@cantrip/protocol";

export async function getWorkspaceRepositoryDiscovery(workspaceId: string) {
  return workspaceRepositoryDiscoverySnapshotSchema.parse(
    await request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repository-discovery`,
    ),
  );
}

export async function startWorkspaceRepositoryDiscovery(
  workspaceId: string,
  input: Partial<WorkspaceRepositoryDiscoveryStart> = {},
) {
  return workspaceRepositoryDiscoverySnapshotSchema.parse(
    await post(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repository-discovery`,
      workspaceRepositoryDiscoveryStartSchema.parse(input),
    ),
  );
}

export async function startWorkspaceRepositoryImports(
  workspaceId: string,
  input: WorkspaceRepositoryImportStart,
) {
  return workspaceRepositoryDiscoverySnapshotSchema.parse(
    await post(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repository-imports`,
      workspaceRepositoryImportStartSchema.parse(input),
    ),
  );
}
