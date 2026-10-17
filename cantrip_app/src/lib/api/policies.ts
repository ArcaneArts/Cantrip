import {
  listPackagedPolicyTemplates,
  getPackagedPolicyTemplate,
} from "@/lib/policy-templates";
import {
  policyWireListSchema,
  POLICY_BOOTSTRAP_VERSION,
  encryptedPolicyBootstrapSchema,
  policyWireDetailSchema,
  policyCreateSchema,
  policyFromTemplateCreateSchema,
  policyUpdateSchema,
  policyDeleteSchema,
  policyOrderUpdateSchema,
  policyTemplateResetSchema,
  policyAssignmentUpdateSchema,
  effectivePolicyWireListSchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import {
  protectPolicyCreate,
  openPolicyWireList,
  openPolicyWireDetail,
  protectPolicyUpdate,
  openPolicyAssignmentWireList,
  openEffectivePolicyWireList,
} from "@/lib/policy-encryption";
import type {
  PolicyCreate,
  PolicyFromTemplateCreate,
  PolicyUpdate,
  PolicyOrderUpdate,
  PolicyTemplateReset,
  PolicyAssignmentUpdate,
} from "@cantrip/protocol";

export async function getPolicyTemplates() {
  return listPackagedPolicyTemplates();
}

export async function getPolicyTemplate(templateKey: string) {
  const template = getPackagedPolicyTemplate(templateKey);
  if (!template) {
    throw new Error(`Packaged policy template ${templateKey} is unavailable.`);
  }
  return template;
}

export async function getPolicies() {
  let wire = policyWireListSchema.parse(await request("/api/policies"));
  if (wire.bootstrapVersion < POLICY_BOOTSTRAP_VERSION) {
    const templates = await Promise.all(
      (await getPolicyTemplates())
        .filter(({ suggestedDefault }) => suggestedDefault)
        .map(({ templateKey }) => getPolicyTemplate(templateKey)),
    );
    const policies = await Promise.all(
      templates.map((template) =>
        protectPolicyCreate(
          {
            key: template.suggestedPolicyKey,
            name: template.name,
            summary: template.summary,
            bodyMarkdown: template.bodyMarkdown,
            enabled: template.suggestedEnabled,
            mandatory: template.suggestedMandatory,
            audience: "ide",
          },
          template.templateKey,
        ),
      ),
    );
    wire = policyWireListSchema.parse(
      await post(
        "/api/policies/bootstrap",
        encryptedPolicyBootstrapSchema.parse({
          expectedBootstrapVersion: wire.bootstrapVersion,
          policies,
        }),
      ),
    );
  }
  return openPolicyWireList(wire);
}

export async function getPolicy(policyId: string) {
  return openPolicyWireDetail(
    await request(`/api/policies/${encodeURIComponent(policyId)}`),
  );
}

export async function createPolicy(input: PolicyCreate) {
  return openPolicyWireDetail(
    policyWireDetailSchema.parse(
      await post(
        "/api/policies",
        await protectPolicyCreate(policyCreateSchema.parse(input)),
      ),
    ),
  );
}

export async function createPolicyFromTemplate(
  templateKey: string,
  input: PolicyFromTemplateCreate = {},
) {
  const overrides = policyFromTemplateCreateSchema.parse(input);
  const template = await getPolicyTemplate(templateKey);
  return openPolicyWireDetail(
    policyWireDetailSchema.parse(
      await post(
        "/api/policies",
        await protectPolicyCreate(
          policyCreateSchema.parse({
            key: overrides.key ?? template.suggestedPolicyKey,
            name: overrides.name ?? template.name,
            summary: overrides.summary ?? template.summary,
            bodyMarkdown: overrides.bodyMarkdown ?? template.bodyMarkdown,
            enabled: overrides.enabled ?? template.suggestedEnabled,
            mandatory: overrides.mandatory ?? template.suggestedMandatory,
            audience: overrides.audience ?? "ide",
          }),
          templateKey,
        ),
      ),
    ),
  );
}

export async function updatePolicy(policyId: string, input: PolicyUpdate) {
  const parsed = policyUpdateSchema.parse(input);
  const current = await getPolicy(policyId);
  return openPolicyWireDetail(
    policyWireDetailSchema.parse(
      await request(`/api/policies/${encodeURIComponent(policyId)}`, {
        method: "PATCH",
        body: JSON.stringify(
          await protectPolicyUpdate(policyId, current, parsed),
        ),
      }),
    ),
  );
}

export async function deletePolicy(policyId: string, rowVersion: number) {
  await request(`/api/policies/${encodeURIComponent(policyId)}`, {
    method: "DELETE",
    body: JSON.stringify(policyDeleteSchema.parse({ rowVersion })),
  });
}

export async function reorderPolicies(input: PolicyOrderUpdate) {
  return openPolicyWireList(
    await request("/api/policies/order", {
      method: "PATCH",
      body: JSON.stringify(policyOrderUpdateSchema.parse(input)),
    }),
  );
}

export async function resetPolicyFromTemplate(
  policyId: string,
  input: PolicyTemplateReset,
) {
  const reset = policyTemplateResetSchema.parse(input);
  const current = await getPolicy(policyId);
  if (!current.templateKey) {
    throw new Error("This policy was not created from a packaged template.");
  }
  const template = await getPolicyTemplate(current.templateKey);
  return updatePolicy(policyId, {
    rowVersion: reset.rowVersion,
    name: template.name,
    summary: template.summary,
    bodyMarkdown: template.bodyMarkdown,
    ...(reset.restoreDefaults
      ? {
          enabled: template.suggestedEnabled,
          mandatory: template.suggestedMandatory,
        }
      : {}),
  });
}

export async function getWorkspacePolicyAssignments(workspaceId: string) {
  return openPolicyAssignmentWireList(
    await request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/policies`,
    ),
  );
}

export async function updateWorkspacePolicyAssignments(
  workspaceId: string,
  input: PolicyAssignmentUpdate,
) {
  return openPolicyAssignmentWireList(
    await request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/policies`,
      {
        method: "PATCH",
        body: JSON.stringify(policyAssignmentUpdateSchema.parse(input)),
      },
    ),
  );
}

export async function getProjectPolicyAssignments(projectId: string) {
  return openPolicyAssignmentWireList(
    await request(`/api/projects/${encodeURIComponent(projectId)}/policies`),
  );
}

export async function updateProjectPolicyAssignments(
  projectId: string,
  input: PolicyAssignmentUpdate,
) {
  return openPolicyAssignmentWireList(
    await request(`/api/projects/${encodeURIComponent(projectId)}/policies`, {
      method: "PATCH",
      body: JSON.stringify(policyAssignmentUpdateSchema.parse(input)),
    }),
  );
}

export async function getProjectEffectivePolicies(projectId: string) {
  return openEffectivePolicyWireList(
    effectivePolicyWireListSchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/effective-policies`,
      ),
    ),
  );
}
