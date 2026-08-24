import type {
  RunConfigurationDeleteResult,
  RunConfigurationDetectionCandidate,
  RunConfigurationDiagnostic,
  RunConfigurationProviderKind,
  RunConfigurationReadResult,
  RunConfigurationRepositoryInventory,
  RunConfigurationWriteRequest,
  RunConfigurationWriteResult,
} from "@cantrip/protocol/run-configuration-definitions";
import type {
  RunConfigurationRuntime,
  RunConfigurationRuntimeLifecycleRequest,
  RunConfigurationRuntimeOperationResult,
  RunConfigurationRuntimeOutputContent,
} from "@cantrip/protocol/run-configuration-runtime";
import {
  protectedRunConfigurationRuntimeOutputResultSchema,
  runConfigurationRuntimeOperationResultSchema,
  runConfigurationRuntimeOutputContentSchema,
  runConfigurationRuntimeStatusResultSchema,
} from "@cantrip/protocol/run-configuration-runtime";
import {
  runConfigurationCapabilitiesResponseSchema,
  runConfigurationDeleteResponseSchema,
  runConfigurationDetectResponseSchema,
  runConfigurationGetResponseSchema,
  runConfigurationListResponseSchema,
  runConfigurationWriteResponseSchema,
} from "@cantrip/protocol/run-configuration-operations";

import { request, requestResponse } from "@/lib/api-client";
import { ensureRunOperationWorker } from "@/lib/api";
import { openRunContent } from "@/lib/run-content-encryption";

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

export async function detectRunConfigurations(
  projectId: string,
  provider: RunConfigurationProviderKind | null = null,
  operationId = crypto.randomUUID(),
): Promise<{
  candidates: RunConfigurationDetectionCandidate[];
  diagnostics: RunConfigurationDiagnostic[];
}> {
  const providerQuery = provider
    ? `&provider=${encodeURIComponent(provider)}`
    : "";
  const response = runConfigurationDetectResponseSchema.parse(
    await request(
      `${configurationCollectionPath(projectId)}/detect${operationQuery(operationId)}${providerQuery}`,
    ),
  );
  assertCorrelated(response, projectId, operationId);
  return {
    candidates: response.candidates,
    diagnostics: response.diagnostics,
  };
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

export async function operateRunConfigurationRuntime(
  input: Omit<RunConfigurationRuntimeLifecycleRequest, "operationId">,
  operationId = crypto.randomUUID(),
): Promise<RunConfigurationRuntimeOperationResult> {
  const result = runConfigurationRuntimeOperationResultSchema.parse(
    await request("/api/run-configuration-runtimes/operations", {
      method: "POST",
      body: JSON.stringify({ ...input, operationId }),
    }),
  );
  if (
    result.operation.id !== operationId ||
    result.operation.projectId !== input.projectId ||
    result.operation.configurationId !== input.configurationId ||
    result.operation.operation !== input.operation ||
    (input.targetWorktreeId !== null &&
      result.operation.worktreeId !== input.targetWorktreeId)
  ) {
    throw new Error("The Run configuration runtime response was misrouted.");
  }
  return result;
}

export async function listRunConfigurationRuntimes(
  projectId: string,
  input: {
    configurationId?: string | null;
    targetWorktreeId?: string | null;
    limit?: number;
  } = {},
  operationId = crypto.randomUUID(),
): Promise<RunConfigurationRuntime[]> {
  const result = runConfigurationRuntimeStatusResultSchema.parse(
    await request("/api/run-configuration-runtimes/status", {
      method: "POST",
      body: JSON.stringify({
        operationId,
        projectId,
        configurationId: input.configurationId ?? null,
        targetWorktreeId: input.targetWorktreeId ?? null,
        limit: input.limit ?? 256,
      }),
    }),
  );
  if (result.operationId !== operationId || result.projectId !== projectId) {
    throw new Error("The Run configuration runtime status was misrouted.");
  }
  return result.runtimes;
}

export async function readRunConfigurationRuntimeOutput(
  input: {
    projectId: string;
    configurationId: string;
    worktreeId: string;
    tail?: number;
  },
  operationId = crypto.randomUUID(),
): Promise<RunConfigurationRuntimeOutputContent & { generation: number }> {
  await ensureRunOperationWorker({
    projectId: input.projectId,
    worktreeId: input.worktreeId,
  });
  const result = protectedRunConfigurationRuntimeOutputResultSchema.parse(
    await request("/api/run-configuration-runtimes/output", {
      method: "POST",
      body: JSON.stringify({
        operationId,
        projectId: input.projectId,
        configurationId: input.configurationId,
        worktreeId: input.worktreeId,
        tail: input.tail ?? 100_000,
      }),
    }),
  );
  if (
    result.operationId !== operationId ||
    result.projectId !== input.projectId ||
    result.configurationId !== input.configurationId ||
    result.worktreeId !== input.worktreeId
  ) {
    throw new Error("The Run configuration runtime output was misrouted.");
  }
  return {
    generation: result.generation,
    ...(await openRunContent({
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      operationId,
      operation: "run.configuration.output",
      opaque: result.protectedOutput,
      schema: runConfigurationRuntimeOutputContentSchema,
    })),
  };
}
