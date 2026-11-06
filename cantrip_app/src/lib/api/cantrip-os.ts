import { z } from "zod";
import {
  cantripOsRunDefinitionApiSchema,
  cantripOsRecoveryRequestSchema,
  cantripOsRecoveryResultSchema,
  type CantripOsInstanceSummary,
  cantripOsRunSourceSchema,
  cantripOsRunDefinitionResponseSchema,
  type CantripOsRunDefinitionRequest,
  cantripOsAttachSchema,
  cantripOsBindingCreateSchema,
  cantripOsInspectSchema,
  cantripOsInstanceSummarySchema,
  cantripOsObservedInstanceSchema,
  cantripOsOperationResultSchema,
  cantripOsSourceBindingSummarySchema,
  cantripOsWorkspaceSummarySchema,
  cantripOsWorkspaceCreateSchema,
  cantripOsProvisionRequestContentSchema,
  cantripOsProvisionSchema,
  type CantripOsSourceBindingSummary,
  type CantripOsProvisionIntent,
} from "@cantrip/protocol";
import { request, CantripApiError } from "@/lib/api-client";
import {
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import { ensureRepositoryWorkerEncryption } from "@/lib/repository-worker-encryption";
import { protectRepositoryOperationContent } from "@/lib/repository-operation-encryption";
import { getWorkers, refreshWorkerEncryption } from "./worker-wire";

const route = (value: string) => encodeURIComponent(value);
const project = (id: string) =>
  `/api/projects/${route(id)}/cantrip-os/bindings`;
const refreshed = z.object({
  instance: cantripOsInstanceSummarySchema,
  workspaces: z.array(cantripOsWorkspaceSummarySchema),
});

/** Select this source's Primary explicitly; the Server resolves the binding.
 * Retain request.operationId when observing an uncertain mutation. */
export async function executeCantripOsRunDefinition(
  binding: CantripOsSourceBindingSummary,
  request: CantripOsRunDefinitionRequest,
) {
  const input = cantripOsRunDefinitionApiSchema.parse({
    bindingGeneration: binding.bindingGeneration,
    attachmentGeneration: binding.provisionedAttachmentGeneration ?? undefined,
    runtimeGeneration: binding.provisionedRuntimeGeneration,
    request,
  });
  const result = await mutate(
    `${project(binding.projectId)}/${route(binding.id)}/run-definitions`,
    input,
    cantripOsRunDefinitionResponseSchema,
  );
  if (
    request.projectId !== binding.projectId ||
    result.result.projectId !== binding.projectId ||
    result.result.operationId !== request.operationId ||
    `project.run-configuration-definitions.${result.result.operation}` !==
      request.type ||
    result.source.projectSourceId !== binding.projectSourceId ||
    result.source.runtimeGeneration !== input.runtimeGeneration
  )
    throw new Error("The Linux Run definition response was misrouted.");
  return result;
}

/** Mutations are bound to one authenticated lifetime and never replayed for
 * connection or CSRF recovery. Provision admissions are recovered by identity. */
async function mutate<T>(
  path: string,
  body: unknown,
  schema: { parse(value: unknown): T },
) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new CantripApiError("An authenticated session is required.", 401);
  return schema.parse(
    await request(
      path,
      { method: "POST", body: JSON.stringify(body) },
      { expectedIdentity: identity, allowCsrfRecovery: false },
    ),
  );
}
export async function getCantripOsInstances() {
  return z
    .array(cantripOsInstanceSummarySchema)
    .parse(await request("/api/cantrip-os"));
}
export async function inspectCantripOs(
  input: z.input<typeof cantripOsInspectSchema>,
) {
  return mutate(
    "/api/cantrip-os/inspect",
    cantripOsInspectSchema.parse(input),
    cantripOsObservedInstanceSchema,
  );
}
export async function attachCantripOs(
  input: z.input<typeof cantripOsAttachSchema>,
) {
  return mutate(
    "/api/cantrip-os/attach",
    cantripOsAttachSchema.parse(input),
    refreshed,
  );
}
export async function refreshCantripOs(instanceId: string) {
  return mutate(`/api/cantrip-os/${route(instanceId)}/refresh`, {}, refreshed);
}
export async function recoverCantripOsInstance(
  instance: CantripOsInstanceSummary,
) {
  return mutate(
    `/api/cantrip-os/${route(instance.id)}/recovery`,
    cantripOsRecoveryRequestSchema.parse({
      attachmentGeneration: instance.attachmentGeneration,
      runtimeGeneration: instance.runtimeGeneration,
    }),
    cantripOsRecoveryResultSchema,
  );
}
export async function getCantripOsWorkspaces(instanceId: string) {
  return z
    .array(cantripOsWorkspaceSummarySchema)
    .parse(await request(`/api/cantrip-os/${route(instanceId)}/workspaces`));
}
export async function createCantripOsWorkspace(
  instanceId: string,
  input: z.input<typeof cantripOsWorkspaceCreateSchema>,
) {
  return mutate(
    `/api/cantrip-os/${route(instanceId)}/workspaces`,
    cantripOsWorkspaceCreateSchema.parse(input),
    cantripOsOperationResultSchema,
  );
}
export async function getCantripOsBindings(projectId: string) {
  return z
    .array(cantripOsSourceBindingSummarySchema)
    .parse(await request(project(projectId)));
}
export async function createCantripOsBinding(
  projectId: string,
  input: z.input<typeof cantripOsBindingCreateSchema>,
) {
  return mutate(
    project(projectId),
    cantripOsBindingCreateSchema.parse(input),
    cantripOsSourceBindingSummarySchema,
  );
}
export async function recoverCantripOsBinding(
  projectId: string,
  bindingId: string,
) {
  return mutate(
    `${project(projectId)}/${route(bindingId)}/recover`,
    {},
    cantripOsOperationResultSchema,
  );
}
export async function verifyCantripOsBinding(
  projectId: string,
  bindingId: string,
) {
  return mutate(
    `${project(projectId)}/${route(bindingId)}/verify`,
    {},
    cantripOsSourceBindingSummarySchema,
  );
}

/** Prepare once and retain the exact opaque admission while its outcome is
 * uncertain. Recovery observes it without preparing a second mutation. */
export async function prepareCantripOsProvisionRequest(
  binding: CantripOsSourceBindingSummary,
  intent: CantripOsProvisionIntent,
  operationId: string = crypto.randomUUID(),
) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new CantripApiError("An authenticated session is required.", 401);
  const worker = (await getWorkers()).find(
    (worker) => worker.workerId === binding.workerId,
  );
  await ensureRepositoryWorkerEncryption({
    refresh: refreshWorkerEncryption,
    worker,
  });
  const protectedRequest = await protectRepositoryOperationContent({
    context: {
      projectId: binding.projectId,
      worktreeId: binding.worktreeId,
      operationId,
      direction: "request",
    },
    schema: cantripOsProvisionRequestContentSchema,
    content: {
      type: "cantrip-os.source.provision",
      instanceId: binding.instanceId,
      workspaceId: binding.workspaceId,
      bindingId: binding.id,
      bindingGeneration: binding.bindingGeneration,
      intent,
    },
  });
  if (!clientSessionIdentityMatches(identity))
    throw new CantripApiError(
      "The account or server changed while preparing this source.",
      409,
    );
  return cantripOsProvisionSchema.parse({
    operationId,
    bindingGeneration: binding.bindingGeneration,
    protectedRequest,
  });
}

/** An opaque request may be retained in a client draft before its first send. */
export async function submitCantripOsProvision(
  binding: CantripOsSourceBindingSummary,
  input: z.input<typeof cantripOsProvisionSchema>,
  identity: ClientSessionIdentitySnapshot | null = getClientSessionIdentitySnapshot(),
) {
  if (!identity)
    throw new CantripApiError("An authenticated session is required.", 401);
  const body = JSON.stringify(cantripOsProvisionSchema.parse(input));
  return cantripOsOperationResultSchema.parse(
    await request(
      `${project(binding.projectId)}/${route(binding.id)}/provision`,
      { method: "POST", body },
      { expectedIdentity: identity, allowCsrfRecovery: false },
    ),
  );
}

export async function prepareCantripOsProvision(
  binding: CantripOsSourceBindingSummary,
  intent: CantripOsProvisionIntent,
) {
  const identity = getClientSessionIdentitySnapshot();
  const prepared = await prepareCantripOsProvisionRequest(binding, intent);
  if (!identity || !clientSessionIdentityMatches(identity))
    throw new CantripApiError(
      "The account or server changed while preparing this source.",
      409,
    );
  return () => submitCantripOsProvision(binding, prepared, identity);
}

export async function getCantripOsRunSources(projectId: string) {
  return z
    .array(cantripOsRunSourceSchema)
    .parse(
      await request(`/api/projects/${route(projectId)}/cantrip-os/run-sources`),
    );
}
