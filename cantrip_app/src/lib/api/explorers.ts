import {
  explorerWireListSchema,
  explorerViewStateUpdateSchema,
  explorerWireSummarySchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import { surfaceTitleEncryption } from "@/lib/surface-title-encryption";
import {
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
} from "@/lib/client-session";
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

/** Keep the exact ciphertext alongside the decrypted location for a migration
 * compare-and-swap. Re-encrypting the same path is not the same snapshot. */
export async function getExplorerMigrationSource(
  projectId: string,
  explorerId: string,
) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity) throw new Error("Sign in before migrating an Explorer.");
  const explorers = explorerWireListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/explorers`,
      {},
      { expectedIdentity: identity },
    ),
  );
  if (!clientSessionIdentityMatches(identity))
    throw new Error("Explorer migration account changed.");
  const wire = explorers.find((candidate) => candidate.id === explorerId);
  if (!wire) throw new Error("Legacy Explorer is no longer available.");
  const explorer = await surfaceTitleEncryption.openExplorer(wire);
  if (!clientSessionIdentityMatches(identity))
    throw new Error("Explorer migration account changed.");
  return { wire, explorer };
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
