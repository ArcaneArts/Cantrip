import {
  terminalWireListSchema,
  protectedScriptCommandListSchema,
  scriptCommandListSchema,
  terminalWireSummarySchema,
  terminalServiceConfigurationSchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import { surfaceTitleEncryption } from "@/lib/surface-title-encryption";
import { openRepositoryOperationContent } from "@/lib/repository-operation-encryption";
import type {
  ExecutionTarget,
  ProjectPaneRegion,
  TerminalSummary,
  TerminalServiceConfiguration,
} from "@cantrip/protocol";
import { getWorkers } from "./worker-wire";
import {
  ensureRepositoryOperationWorker,
  resolveRepositoryOperationTarget,
} from "./repository-operations";

export async function getTerminals(projectId: string) {
  const terminals = terminalWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/terminals`),
  );
  return Promise.all(
    terminals.map((terminal) => surfaceTitleEncryption.openTerminal(terminal)),
  );
}

export async function getTerminalScriptCommands(
  terminalId: string,
  workerId: string,
) {
  const worker = (await getWorkers()).find(
    (candidate) => candidate.workerId === workerId,
  );
  await ensureRepositoryOperationWorker(worker);
  const operationId = crypto.randomUUID();
  const wire = protectedScriptCommandListSchema.parse(
    await request(
      `/api/terminals/${encodeURIComponent(terminalId)}/script-commands?operationId=${encodeURIComponent(operationId)}`,
    ),
  );
  return openRepositoryOperationContent({
    context: {
      projectId: wire.projectId,
      worktreeId: wire.worktreeId,
      operationId,
      direction: "response",
    },
    opaque: wire.protectedCommands,
    schema: scriptCommandListSchema,
  });
}

export async function getProjectScriptCommands(
  projectId: string,
  worktreeId?: string,
) {
  const target = await resolveRepositoryOperationTarget({
    projectId,
    worktreeId,
  });
  await ensureRepositoryOperationWorker(target.worker);
  const query = new URLSearchParams();
  const operationId = crypto.randomUUID();
  query.set("operationId", operationId);
  if (worktreeId) query.set("worktreeId", worktreeId);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const wire = protectedScriptCommandListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/script-commands${suffix}`,
    ),
  );
  return openRepositoryOperationContent({
    context: {
      projectId: wire.projectId,
      worktreeId: wire.worktreeId,
      operationId,
      direction: "response",
    },
    opaque: wire.protectedCommands,
    schema: scriptCommandListSchema,
  });
}

export function terminalCreatePlacement(
  worktreeId: string | undefined,
  target: ExecutionTarget | undefined,
) {
  return target ? { target } : worktreeId ? { worktreeId } : {};
}

export async function createTerminal(
  projectId: string,
  title: string,
  worktreeId?: string,
  paneId?: string,
  target?: ExecutionTarget,
  directoryPath?: string,
  targetRegion?: ProjectPaneRegion,
) {
  const id = crypto.randomUUID();
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    title,
    "terminal",
  );
  const stateProtection = await surfaceTitleEncryption.protectTerminalState(
    id,
    directoryPath,
    "",
  );
  // Execution targets supersede the legacy worktree placement. Keeping this
  // normalization at the API boundary prevents callers from emitting the
  // mutually exclusive pair rejected by encryptedTerminalCreateSchema.
  const placement = terminalCreatePlacement(worktreeId, target);
  return surfaceTitleEncryption.openTerminal(
    terminalWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/terminals`, {
        id,
        titleProtection,
        stateProtection,
        ...placement,
        ...(paneId ? { paneId } : {}),
        ...(!paneId && targetRegion ? { targetRegion } : {}),
      }),
    ),
  );
}

export async function updateTerminalWorktree(
  terminalId: string,
  worktreeId: string,
) {
  return surfaceTitleEncryption.openTerminal(
    terminalWireSummarySchema.parse(
      await request(
        `/api/terminals/${encodeURIComponent(terminalId)}/worktree`,
        {
          method: "PATCH",
          body: JSON.stringify({ worktreeId }),
        },
      ),
    ),
  );
}

export async function renameTerminal(terminalId: string, title: string) {
  const titleProtection = await surfaceTitleEncryption.protect(
    terminalId,
    title,
    "terminal",
  );
  return surfaceTitleEncryption.openTerminal(
    terminalWireSummarySchema.parse(
      await request(`/api/terminals/${encodeURIComponent(terminalId)}`, {
        method: "PATCH",
        body: JSON.stringify({ titleProtection }),
      }),
    ),
  );
}

export async function updateTerminalService(
  terminal: TerminalSummary,
  service: TerminalServiceConfiguration,
) {
  const configuration = terminalServiceConfigurationSchema.parse(service);
  const stateProtection = await surfaceTitleEncryption.protectTerminalState(
    terminal.id,
    terminal.directoryPath,
    configuration.command,
  );
  return surfaceTitleEncryption.openTerminal(
    terminalWireSummarySchema.parse(
      await request(
        `/api/terminals/${encodeURIComponent(terminal.id)}/service`,
        {
          method: "PUT",
          body: JSON.stringify({
            enabled: configuration.enabled,
            stateProtection,
          }),
        },
      ),
    ),
  );
}

export async function restartTerminalService(terminalId: string) {
  await post(
    `/api/terminals/${encodeURIComponent(terminalId)}/service/restart`,
    {},
  );
}

export async function deleteTerminal(terminalId: string) {
  await request(`/api/terminals/${encodeURIComponent(terminalId)}`, {
    method: "DELETE",
  });
}
