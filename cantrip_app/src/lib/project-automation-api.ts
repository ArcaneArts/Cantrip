import {
  projectAutomationCreateSchema,
  projectAutomationUpdateSchema,
  projectAutomationWireListSchema,
  projectAutomationWireSchema,
  type ProjectAutomationCreate,
  type ProjectAutomationUpdate,
} from "@cantrip/protocol/automations";

import { post, request } from "@/lib/api-client";
import {
  openProjectAutomationWire,
  protectProjectAutomationCreate,
  protectProjectAutomationUpdate,
} from "@/lib/project-automation-encryption";

export async function getProjectAutomations(projectId: string) {
  const wire = projectAutomationWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/automations`),
  );
  return Promise.all(
    wire.map((automation) => openProjectAutomationWire(automation)),
  );
}

export async function createProjectAutomation(
  projectId: string,
  input: ProjectAutomationCreate,
) {
  const trusted = projectAutomationCreateSchema.parse(input);
  return openProjectAutomationWire(
    projectAutomationWireSchema.parse(
      await post(
        `/api/projects/${encodeURIComponent(projectId)}/automations`,
        await protectProjectAutomationCreate(trusted),
      ),
    ),
  );
}

export async function updateProjectAutomation(
  automationId: string,
  input: ProjectAutomationUpdate,
) {
  const trusted = projectAutomationUpdateSchema.parse(input);
  return openProjectAutomationWire(
    projectAutomationWireSchema.parse(
      await request(`/api/automations/${encodeURIComponent(automationId)}`, {
        body: JSON.stringify(
          await protectProjectAutomationUpdate(automationId, trusted),
        ),
        method: "PATCH",
      }),
    ),
  );
}

export async function deleteProjectAutomation(automationId: string) {
  await request(`/api/automations/${encodeURIComponent(automationId)}`, {
    method: "DELETE",
  });
}
