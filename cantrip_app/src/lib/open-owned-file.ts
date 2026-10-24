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
  path,
  focusWindow,
  preview = false,
  reservePreview,
}: {
  controller: WorkspaceCommandClient;
  queryClient: QueryClient;
  projectId: string;
  worktreeId: string;
  path: string;
  focusWindow: (id: string) => Promise<void>;
  preview?: boolean;
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
  const key = JSON.stringify([session, projectId, worktreeId, path]);
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
          candidate.path === path,
      );
      if (existing) return existing;
      const worktrees = await getProjectWorktrees(projectId);
      assertCurrent();
      const worktree = worktrees.find(
        (candidate) =>
          candidate.id === worktreeId && candidate.projectId === projectId,
      );
      if (!worktree) throw new Error("File document worktree was not found.");
      return createFileDocument({
        id: surfaceTitleEncryption.fileDocumentId({
          projectId,
          workerId: worktree.workerId,
          worktreeId,
          path,
        }),
        projectId,
        workerId: worktree.workerId,
        worktreeId,
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
      { preview, reservePreview },
    );
    assertCurrent();
    if (receipt.focusWindowId) await focusWindow(receipt.focusWindowId);
  } finally {
    request.consumers--;
    if (request.consumers === 0 && requests.get(key) === request)
      requests.delete(key);
  }
}
