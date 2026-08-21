import {
  workflowAutomationTriggerCreateSchema,
  workflowAutomationTriggerListSchema,
  workflowAutomationTriggerSchema,
  workflowAutomationTriggerUpdateSchema,
  workflowDefinitionCreateSchema,
  workflowDefinitionDetailSchema,
  workflowDefinitionWireDetailSchema,
  workflowDefinitionGenerationCreateSchema,
  workflowDefinitionGenerationResultSchema,
  workflowDefinitionWireListSchema,
  workflowDefinitionWireSummarySchema,
  workflowDefinitionUpdateSchema,
  workflowGateDecisionSchema,
  workflowGitEventDeliveryCreateSchema,
  workflowNodeRetrySchema,
  workflowRepositoryExportSchema,
  workflowRepositoryImportSchema,
  workflowRepositoryInventorySchema,
  workflowRepositoryWriteResultSchema,
  workflowRevisionCreateSchema,
  workflowRevisionWireSchema,
  workflowRunCancelSchema,
  workflowRunCreateSchema,
  workflowRunDetailSchema,
  workflowRunListSchema,
  workflowRunPauseSchema,
  workflowRunResumeSchema,
  workflowRunSaveRevisionSchema,
  workflowTriggerDeliveryCreateSchema,
  workflowTriggerDeliveryResultSchema,
  workflowWorktreeOutcomeRequestSchema,
  type WorkflowAutomationTriggerCreate,
  type WorkflowAutomationTriggerQuery,
  type WorkflowAutomationTriggerUpdate,
  type WorkflowDefinitionCreate,
  type WorkflowDefinitionGenerationCreate,
  type WorkflowDefinitionQuery,
  type WorkflowDefinitionUpdate,
  type WorkflowGateDecision,
  type WorkflowGitEventDeliveryCreate,
  type WorkflowNodeRetry,
  type WorkflowRepositoryExport,
  type WorkflowRepositoryImport,
  type WorkflowRevisionCreate,
  type WorkflowRunCancel,
  type WorkflowRunCreate,
  type WorkflowRunPause,
  type WorkflowRunQuery,
  type WorkflowRunResume,
  type WorkflowRunSaveRevision,
  type WorkflowTriggerDeliveryCreate,
  type WorkflowWorktreeOutcomeRequest,
} from "@cantrip/protocol/workflows";

import { post, request, withQuery } from "@/lib/api-client";
import {
  openWorkflowDefinitionWireDetail,
  openWorkflowDefinitionWireSummary,
  openWorkflowRevisionWire,
  protectWorkflowDefinitionCreate,
  protectWorkflowDefinitionUpdate,
  protectWorkflowRevisionCreate,
} from "@/lib/workflow-encryption";

export async function getWorkflows(
  input: Partial<WorkflowDefinitionQuery> = {},
) {
  const wire = workflowDefinitionWireListSchema.parse(
    await request(
      withQuery("/api/workflows", {
        scope: input.scope,
        projectId: input.projectId,
        includeArchived: input.includeArchived,
        limit: input.limit,
      }),
    ),
  );
  return Promise.all(
    wire.map((workflow) => openWorkflowDefinitionWireSummary(workflow)),
  );
}

export async function getWorkflow(workflowId: string) {
  return openWorkflowDefinitionWireDetail(
    workflowDefinitionWireDetailSchema.parse(
      await request(`/api/workflows/${encodeURIComponent(workflowId)}`),
    ),
  );
}

export async function createWorkflow(input: WorkflowDefinitionCreate) {
  const trusted = workflowDefinitionCreateSchema.parse(input);
  return openWorkflowDefinitionWireDetail(
    workflowDefinitionWireDetailSchema.parse(
      await post(
        "/api/workflows",
        await protectWorkflowDefinitionCreate(trusted),
      ),
    ),
  );
}

export async function generateWorkflowDefinition(
  chatId: string,
  input: WorkflowDefinitionGenerationCreate,
) {
  return workflowDefinitionGenerationResultSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/workflow-generation`,
      workflowDefinitionGenerationCreateSchema.parse(input),
    ),
  );
}

export async function updateWorkflow(
  workflowId: string,
  input: WorkflowDefinitionUpdate,
) {
  const trusted = workflowDefinitionUpdateSchema.parse(input);
  return openWorkflowDefinitionWireSummary(
    workflowDefinitionWireSummarySchema.parse(
      await request(`/api/workflows/${encodeURIComponent(workflowId)}`, {
        method: "PATCH",
        body: JSON.stringify(
          await protectWorkflowDefinitionUpdate(workflowId, trusted),
        ),
      }),
    ),
  );
}

export async function appendWorkflowRevision(
  workflowId: string,
  input: WorkflowRevisionCreate,
) {
  const trusted = workflowRevisionCreateSchema.parse(input);
  return openWorkflowRevisionWire(
    workflowRevisionWireSchema.parse(
      await post(
        `/api/workflows/${encodeURIComponent(workflowId)}/revisions`,
        await protectWorkflowRevisionCreate(trusted),
      ),
    ),
  );
}

export async function getWorkflowRepository(projectId: string) {
  return workflowRepositoryInventorySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/workflow-repository`,
    ),
  );
}

export async function importWorkflowRepositoryItem(
  projectId: string,
  input: WorkflowRepositoryImport,
) {
  return workflowDefinitionDetailSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/workflow-repository/import`,
      workflowRepositoryImportSchema.parse(input),
    ),
  );
}

export async function exportWorkflowToRepository(
  workflowId: string,
  input: WorkflowRepositoryExport,
) {
  return workflowRepositoryWriteResultSchema.parse(
    await post(
      `/api/workflows/${encodeURIComponent(workflowId)}/repository-export`,
      workflowRepositoryExportSchema.parse(input),
    ),
  );
}

export async function getWorkflowAutomationTriggers(
  input: Partial<WorkflowAutomationTriggerQuery> = {},
) {
  return workflowAutomationTriggerListSchema.parse(
    await request(
      withQuery("/api/workflow-triggers", {
        projectId: input.projectId,
        type: input.type,
        enabled: input.enabled,
        limit: input.limit,
      }),
    ),
  );
}

export async function createWorkflowAutomationTrigger(
  input: WorkflowAutomationTriggerCreate,
) {
  return workflowAutomationTriggerSchema.parse(
    await post(
      "/api/workflow-triggers",
      workflowAutomationTriggerCreateSchema.parse(input),
    ),
  );
}

export async function updateWorkflowAutomationTrigger(
  triggerId: string,
  input: WorkflowAutomationTriggerUpdate,
) {
  return workflowAutomationTriggerSchema.parse(
    await request(`/api/workflow-triggers/${encodeURIComponent(triggerId)}`, {
      method: "PATCH",
      body: JSON.stringify(workflowAutomationTriggerUpdateSchema.parse(input)),
    }),
  );
}

export async function invokeSavedWorkflowCommand(
  triggerId: string,
  input: WorkflowTriggerDeliveryCreate,
) {
  return workflowTriggerDeliveryResultSchema.parse(
    await post(
      `/api/workflow-triggers/${encodeURIComponent(triggerId)}/invoke`,
      workflowTriggerDeliveryCreateSchema.parse(input),
    ),
  );
}

export async function deliverWorkflowGitEvent(
  triggerId: string,
  input: WorkflowGitEventDeliveryCreate,
) {
  return workflowTriggerDeliveryResultSchema.parse(
    await post(
      `/api/workflow-triggers/${encodeURIComponent(triggerId)}/git-event`,
      workflowGitEventDeliveryCreateSchema.parse(input),
    ),
  );
}

export async function getWorkflowRuns(input: Partial<WorkflowRunQuery> = {}) {
  return workflowRunListSchema.parse(
    await request(
      withQuery("/api/workflow-runs", {
        workflowId: input.workflowId,
        projectId: input.projectId,
        status: input.status,
        recoveryState: input.recoveryState,
        limit: input.limit,
      }),
    ),
  );
}

export async function getWorkflowRun(runId: string) {
  return workflowRunDetailSchema.parse(
    await request(`/api/workflow-runs/${encodeURIComponent(runId)}`),
  );
}

export async function saveWorkflowRunRevision(
  runId: string,
  input: WorkflowRunSaveRevision,
) {
  return workflowDefinitionDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/save-revision`,
      workflowRunSaveRevisionSchema.parse(input),
    ),
  );
}

export async function createWorkflowRun(input: WorkflowRunCreate) {
  return workflowRunDetailSchema.parse(
    await post("/api/workflow-runs", workflowRunCreateSchema.parse(input)),
  );
}

export async function pauseWorkflowRun(runId: string, input: WorkflowRunPause) {
  return workflowRunDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/pause`,
      workflowRunPauseSchema.parse(input),
    ),
  );
}

export async function resumeWorkflowRun(
  runId: string,
  input: WorkflowRunResume,
) {
  return workflowRunDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/resume`,
      workflowRunResumeSchema.parse(input),
    ),
  );
}

export async function cancelWorkflowRun(
  runId: string,
  input: WorkflowRunCancel,
) {
  return workflowRunDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/cancel`,
      workflowRunCancelSchema.parse(input),
    ),
  );
}

export async function decideWorkflowGate(
  runId: string,
  gateId: string,
  input: WorkflowGateDecision,
) {
  return workflowRunDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gateId)}/decision`,
      workflowGateDecisionSchema.parse(input),
    ),
  );
}

export async function retryWorkflowNode(
  runId: string,
  runNodeId: string,
  input: WorkflowNodeRetry,
) {
  return workflowRunDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(runNodeId)}/retry`,
      workflowNodeRetrySchema.parse(input),
    ),
  );
}

export async function resolveWorkflowWorktree(
  runId: string,
  leaseId: string,
  input: WorkflowWorktreeOutcomeRequest,
) {
  return workflowRunDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/worktree-leases/${encodeURIComponent(leaseId)}/outcome`,
      workflowWorktreeOutcomeRequestSchema.parse(input),
    ),
  );
}
