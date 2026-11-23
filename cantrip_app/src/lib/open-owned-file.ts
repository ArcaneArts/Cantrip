import { resolveFileOpeningMode } from "@/components/files/file-viewers";
import type { QueryClient } from "@tanstack/react-query";
import {
  createFileDocument,
  getFileDocuments,
  type FileDocument,
} from "./api/file-documents";
import { getProjectWorktrees } from "./api/worktrees";
import { getClientSessionIdentitySnapshot } from "./client-session";
import type { WorkspaceCommandClient } from "./workspace-command-client";
import { surfaceTitleEncryption } from "./surface-title-encryption";

const pending = new WeakMap<
  WorkspaceCommandClient,
  Map<string, { resource: Promise<FileDocument>; consumers: number }>
>();

/** Immutable documents and workspace-owned views; never rebind an Explorer. */
export async function openOwnedFile({
  controller,
  queryClient,
  projectId,
  worktreeId,
  cantripOsBindingId,
  cantripOsRuntimeGeneration,
  workerId,
  path,
  focusWindow,
  preview = false,
  viewer,
  reservePreview,
}: {
  controller: WorkspaceCommandClient;
  queryClient: QueryClient;
  projectId: string;
  worktreeId: string;
  cantripOsBindingId?: string;
  cantripOsRuntimeGeneration?: string;
  workerId?: string;
  path: string;
  focusWindow: (id: string) => Promise<void>;
  preview?: boolean;
  viewer?: string | null;
  reservePreview?: (resourceId: string) => (() => void) | null;
}) {
  const session = JSON.stringify(getClientSessionIdentitySnapshot());
  const assertCurrent = () => {
    const state = controller.getSnapshot();
    if (
      session !== JSON.stringify(getClientSessionIdentitySnapshot()) ||
      state.disposed ||
      state.authoritative.projectId !== projectId
    )
      throw new Error("File opening context changed.");
  };
  assertCurrent();
  let requests = pending.get(controller);
  if (!requests) {
    requests = new Map();
    pending.set(controller, requests);
  }
  const key = JSON.stringify([
    session,
    projectId,
    worktreeId,
    path,
    cantripOsBindingId,
    cantripOsRuntimeGeneration,
  ]);
  let request = requests.get(key);
  if (!request) {
    const resource = (async () => {
      // Fetch the actual resource catalog, not a possibly still-loading query snapshot.
      const resources = await getFileDocuments(projectId);
      assertCurrent();
      const existing = resources.find(
        (candidate) =>
          candidate.projectId === projectId &&
          candidate.worktreeId === worktreeId &&
          candidate.cantripOsBindingId === cantripOsBindingId &&
          candidate.cantripOsRuntimeGeneration === cantripOsRuntimeGeneration &&
          candidate.path === path,
      );
      if (existing) return existing;
      const worktrees = cantripOsBindingId
        ? []
        : await getProjectWorktrees(projectId);
      assertCurrent();
      const worktree = worktrees.find(
        (candidate) =>
          candidate.id === worktreeId && candidate.projectId === projectId,
      );
      if (!cantripOsBindingId && !worktree)
        throw new Error("The selected worktree was not found.");
      const owningWorkerId = cantripOsBindingId ? workerId : worktree?.workerId;
      if (!owningWorkerId)
        throw new Error(
          "File document worker was not supplied for this source.",
        );
      return createFileDocument({
        id: surfaceTitleEncryption.fileDocumentId({
          projectId,
          workerId: owningWorkerId,
          worktreeId,
          cantripOsBindingId,
          cantripOsRuntimeGeneration,
          path,
        }),
        projectId,
        workerId: owningWorkerId,
        worktreeId,
        cantripOsBindingId,
        cantripOsRuntimeGeneration,
        path,
      });
    })();
    request = { resource, consumers: 0 };
    requests.set(key, request);
  }
  // Retain the shared backing until every placement/focus operation settles.
  // In particular an uncertain command must not allow another click to create
  // a second resource while the original operation is still pending.
  request.consumers++;
  try {
    const resource = await request.resource;
    assertCurrent();
    queryClient.setQueryData<FileDocument[]>(
      ["file-documents", projectId],
      (current = []) => [
        ...current.filter((candidate) => candidate.id !== resource.id),
        resource,
      ],
    );
    const receipt = await controller.openResource(
      {
        kind: "entity",
        definitionId: "project.file",
        resourceId: resource.id,
      },
      {
        preview,
        reservePreview,
        ...(viewer !== undefined
          ? {
              fileViewer: viewer,
              fileMode: resolveFileOpeningMode(path, viewer),
            }
          : {}),
      },
    );
    assertCurrent();
    if (receipt.focusWindowId) await focusWindow(receipt.focusWindowId);
    assertCurrent();
    // Callers that continue into a window transfer must use this actual open
    // result, not infer a tab from the currently selected Explorer or query data.
    return { resource, receipt };
  } finally {
    request.consumers--;
    if (request.consumers === 0 && requests.get(key) === request)
      requests.delete(key);
  }
}
