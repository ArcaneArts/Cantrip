import type { ExplorerSummary } from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { createExplorer, getExplorers } from "./api/explorers";
import { getClientSessionIdentitySnapshot } from "./client-session";
import type { WorkspaceCommandClient } from "./workspace-command-client";
import { defaultExplorerFileMode } from "@/components/explorer/explorer-file-language";

const pending = new WeakMap<
  WorkspaceCommandClient,
  Map<string, { resource: Promise<ExplorerSummary>; consumers: number }>
>();

/** File-specific protected backing records; never rebind an existing tree/view. */
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
      const resources = await getExplorers(projectId);
      assertCurrent();
      const fileResourceIds = new Set(
        controller
          .getSnapshot()
          .authoritative.windows.flatMap((window) => window.panes)
          .flatMap((pane) => pane.tabs)
          .flatMap((tab) =>
            tab.resource.kind === "entity" &&
            tab.resource.definitionId === "project.file"
              ? [tab.resource.resourceId]
              : [],
          ),
      );
      const existing = resources.find(
        (candidate) =>
          fileResourceIds.has(candidate.id) &&
          candidate.projectId === projectId &&
          candidate.worktreeId === worktreeId &&
          candidate.selectedPath === path,
      );
      if (existing) return existing;
      return createExplorer(
        projectId,
        path.split("/").at(-1) || path,
        worktreeId,
        undefined,
        undefined,
        {
          attachToTabLayout: false,
          initialViewState: {
            selectedPath: path,
            fileMode: defaultExplorerFileMode(path),
          },
        },
      );
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
    queryClient.setQueryData<ExplorerSummary[]>(
      ["explorers", projectId],
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
