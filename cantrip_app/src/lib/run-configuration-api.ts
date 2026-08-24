import type {
  RunConfigurationDeleteResult,
  RunConfigurationReadResult,
  RunConfigurationRepositoryInventory,
  RunConfigurationWriteRequest,
  RunConfigurationWriteResult,
} from "@cantrip/protocol/run-configuration-definitions";
import {
  runConfigurationCapabilitiesResponseSchema,
  runConfigurationDeleteResponseSchema,
  runConfigurationGetResponseSchema,
  runConfigurationListResponseSchema,
  runConfigurationWriteResponseSchema,
} from "@cantrip/protocol/run-configuration-operations";

import { request, requestResponse } from "@/lib/api-client";

function configurationCollectionPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/run-configurations`;
}

function configurationPath(projectId: string, configurationId: string): string {
  return `${configurationCollectionPath(projectId)}/${encodeURIComponent(configurationId)}`;
}

function operationQuery(operationId: string): string {
  return `?operationId=${encodeURIComponent(operationId)}`;
}

function assertCorrelated(
  response: { operationId: string; projectId: string },
  projectId: string,
  operationId: string,
): void {
  if (
    response.projectId !== projectId ||
    response.operationId !== operationId
  ) {
    throw new Error("The Run configuration response was misrouted.");
  }
}

export async function listRunConfigurations(
  projectId: string,
  operationId = crypto.randomUUID(),
): Promise<RunConfigurationRepositoryInventory> {
  const response = runConfigurationListResponseSchema.parse(
    await request(
      `${configurationCollectionPath(projectId)}${operationQuery(operationId)}`,
    ),
  );
  assertCorrelated(response, projectId, operationId);
  return response.inventory;
}

export async function getRunConfiguration(
  projectId: string,
  configurationId: string,
  operationId = crypto.randomUUID(),
): Promise<RunConfigurationReadResult> {
  const response = runConfigurationGetResponseSchema.parse(
    await request(
      `${configurationPath(projectId, configurationId)}${operationQuery(operationId)}`,
    ),
  );
  assertCorrelated(response, projectId, operationId);
  return response.result;
}

export async function getRunConfigurationCapabilities(
  projectId: string,
  operationId = crypto.randomUUID(),
) {
  const response = runConfigurationCapabilitiesResponseSchema.parse(
    await request(
      `${configurationCollectionPath(projectId)}/capabilities${operationQuery(operationId)}`,
    ),
  );
  assertCorrelated(response, projectId, operationId);
  return response.capabilities;
}

export async function saveRunConfiguration(
  projectId: string,
  input: RunConfigurationWriteRequest,
  operationId = crypto.randomUUID(),
): Promise<RunConfigurationWriteResult> {
  const response = await requestResponse(
    configurationPath(projectId, input.document.id),
    {
      method: "PUT",
      body: JSON.stringify({ operationId, ...input }),
    },
    [409],
  );
  const wire = runConfigurationWriteResponseSchema.parse(await response.json());
  assertCorrelated(wire, projectId, operationId);
  return wire.result;
}

export async function deleteRunConfiguration(
  projectId: string,
  configurationId: string,
  expectedRevision: string,
  operationId = crypto.randomUUID(),
): Promise<RunConfigurationDeleteResult> {
  const response = await requestResponse(
    configurationPath(projectId, configurationId),
    {
      method: "DELETE",
      body: JSON.stringify({ operationId, expectedRevision }),
    },
    [404, 409],
  );
  const wire = runConfigurationDeleteResponseSchema.parse(
    await response.json(),
  );
  assertCorrelated(wire, projectId, operationId);
  return wire.result;
}
