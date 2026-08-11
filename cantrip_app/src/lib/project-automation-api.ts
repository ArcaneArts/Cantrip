import {
  projectAutomationCreateSchema,
  projectAutomationListSchema,
  projectAutomationSchema,
  projectAutomationUpdateSchema,
  type ProjectAutomationCreate,
  type ProjectAutomationUpdate,
} from "@cantrip/protocol/automations";

import { post, request } from "@/lib/api-client";

export async function getProjectAutomations(projectId: string) {
  return projectAutomationListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/automations`),
  );
}

export async function createProjectAutomation(
  projectId: string,
  input: ProjectAutomationCreate,
) {
  return projectAutomationSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/automations`,
      projectAutomationCreateSchema.parse(input),
    ),
  );
}

export async function updateProjectAutomation(
  automationId: string,
  input: ProjectAutomationUpdate,
) {
  return projectAutomationSchema.parse(
    await request(`/api/automations/${encodeURIComponent(automationId)}`, {
      body: JSON.stringify(projectAutomationUpdateSchema.parse(input)),
      method: "PATCH",
    }),
  );
}

export async function deleteProjectAutomation(automationId: string) {
  await request(`/api/automations/${encodeURIComponent(automationId)}`, {
    method: "DELETE",
  });
}
