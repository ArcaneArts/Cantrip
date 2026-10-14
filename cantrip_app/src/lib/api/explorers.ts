import {
  explorerWireListSchema,
  explorerViewStateUpdateSchema,
  explorerWireSummarySchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import { surfaceTitleEncryption } from "@/lib/surface-title-encryption";
import type {
  ExecutionTarget,
  ExplorerViewStateUpdate,
} from "@cantrip/protocol";

export async function getExplorers(projectId: string) {
  const explorers = explorerWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/explorers`),
  );
  return Promise.all(
    explorers.map((explorer) => surfaceTitleEncryption.openExplorer(explorer)),
  );
}

export async function createExplorer(
  projectId: string,
  title: string,
  worktreeId?: string,
  paneId?: string,
  target?: ExecutionTarget,
  options: {
    attachToTabLayout?: boolean;
    id?: string;
    initialViewState?: ExplorerViewStateUpdate;
  } = {},
) {
  const id = options.id ?? crypto.randomUUID();
  const initialViewState = options.initialViewState
    ? explorerViewStateUpdateSchema.parse(options.initialViewState)
    : null;
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    title,
    "explorer",
  );
  const stateProtection = await surfaceTitleEncryption.protectExplorerState(
    id,
    initialViewState?.selectedPath ?? null,
  );
  return surfaceTitleEncryption.openExplorer(
    explorerWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/explorers`, {
        id,
        titleProtection,
        stateProtection,
        ...(worktreeId ? { worktreeId } : {}),
        ...(paneId ? { paneId } : {}),
        ...(target ? { target } : {}),
        ...(initialViewState ? { fileMode: initialViewState.fileMode } : {}),
        attachToTabLayout: options.attachToTabLayout ?? true,
      }),
    ),
  );
}

export async function pinExplorer(
  explorerId: string,
  title: string,
  viewState: ExplorerViewStateUpdate,
  paneId?: string,
) {
  const state = explorerViewStateUpdateSchema.parse(viewState);
  const titleProtection = await surfaceTitleEncryption.protect(
    explorerId,
    title,
    "explorer",
  );
  const stateProtection = await surfaceTitleEncryption.protectExplorerState(
    explorerId,
    state.selectedPath,
  );
  return surfaceTitleEncryption.openExplorer(
    explorerWireSummarySchema.parse(
      await post(`/api/explorers/${encodeURIComponent(explorerId)}/pin`, {
        titleProtection,
        stateProtection,
        fileMode: state.fileMode,
        ...(paneId ? { paneId } : {}),
      }),
    ),
  );
}

export async function updateExplorerWorktree(
  explorerId: string,
  worktreeId: string,
) {
  const stateProtection = await surfaceTitleEncryption.protectExplorerState(
    explorerId,
    null,
  );
  return surfaceTitleEncryption.openExplorer(
    explorerWireSummarySchema.parse(
      await request(
        `/api/explorers/${encodeURIComponent(explorerId)}/worktree`,
        {
          method: "PATCH",
          body: JSON.stringify({ worktreeId, stateProtection }),
        },
      ),
    ),
  );
}

export async function renameExplorer(explorerId: string, title: string) {
  const titleProtection = await surfaceTitleEncryption.protect(
    explorerId,
    title,
    "explorer",
  );
  return surfaceTitleEncryption.openExplorer(
    explorerWireSummarySchema.parse(
      await request(`/api/explorers/${encodeURIComponent(explorerId)}`, {
        method: "PATCH",
        body: JSON.stringify({ titleProtection }),
      }),
    ),
  );
}

export async function updateExplorerViewState(
  explorerId: string,
  input: ExplorerViewStateUpdate,
) {
  const parsed = explorerViewStateUpdateSchema.parse(input);
  const stateProtection = await surfaceTitleEncryption.protectExplorerState(
    explorerId,
    parsed.selectedPath,
  );
  return surfaceTitleEncryption.openExplorer(
    explorerWireSummarySchema.parse(
      await request(
        `/api/explorers/${encodeURIComponent(explorerId)}/view-state`,
        {
          method: "PATCH",
          body: JSON.stringify({
            fileMode: parsed.fileMode,
            stateProtection,
          }),
        },
      ),
    ),
  );
}

export async function deleteExplorer(explorerId: string) {
  await request(`/api/explorers/${encodeURIComponent(explorerId)}`, {
    method: "DELETE",
  });
}
