import {
  projectWireListSchema,
  projectWorktreeListSchema,
  projectWireSummarySchema,
  projectPreferredWorkerUpdateSchema,
} from "@cantrip/protocol";
import { request } from "@/lib/api-client";
import type { ProjectPreferredWorkerUpdate } from "@cantrip/protocol";

export async function getProjectWireList() {
  return projectWireListSchema.parse(await request("/api/projects"));
}

export async function getProjectWorktreeWireList(projectId: string) {
  return projectWorktreeListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/worktrees`),
  );
}

export async function removeProject(
  projectId: string,
  deleteLocalFiles: boolean,
) {
  await request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    body: JSON.stringify({ deleteLocalFiles }),
  });
}

export async function updateProjectPreferredWorkerWire(
  projectId: string,
  input: ProjectPreferredWorkerUpdate,
) {
  return projectWireSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/preferred-worker`,
      {
        method: "PATCH",
        body: JSON.stringify(projectPreferredWorkerUpdateSchema.parse(input)),
      },
    ),
  );
}
