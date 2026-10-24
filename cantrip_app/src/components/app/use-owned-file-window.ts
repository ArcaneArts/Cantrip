import { useCallback, useEffect, useRef, useState } from "react";
import type { ExplorerEntry, ExplorerSummary } from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { openOwnedFile } from "@/lib/open-owned-file";
import { detachWorkspaceEditors } from "./detach-workspace-editors";

type Source = Parameters<typeof detachWorkspaceEditors>[0];
type Workspace = Pick<Source, "controller" | "windowId"> & {
  focusWindow(id: string): Promise<void>;
};
type Pending = {
  tabId: string;
  resourceId: string;
  title: string;
  workspace: Workspace;
  started: boolean;
  cancellation: AbortController;
  finish(error?: unknown): void;
};

/** Open through ownership first; a mounted source then uses the normal handoff.
 * Failure leaves the ordinary file tab intact, never an independent file window. */
export function useOwnedFileWindow({
  workspace,
  queryClient,
  surfaces,
  explorers,
  lifecycleRevision,
}: {
  workspace: Workspace | null;
  queryClient: QueryClient;
  surfaces: Source["surfaces"];
  explorers: Source["explorers"];
  lifecycleRevision: number;
}) {
  const current = useRef(workspace);
  current.current = workspace;
  const generation = useRef(0);
  const [pending, setPending] = useState<Pending[]>([]);
  const requests = useRef(new Set<Pending>());
  const openings = useRef(new Map<string, Promise<void>>());
  useEffect(
    () => () => {
      generation.current++;
      openings.current.clear();
      for (const request of requests.current) {
        request.cancellation.abort(new Error("File window context changed."));
        request.finish(new Error("File window context changed."));
      }
    },
    [workspace?.controller, workspace?.windowId],
  );

  const openOnce = useCallback(
    async (explorer: ExplorerSummary, entry: ExplorerEntry) => {
      const owner = current.current;
      if (!owner) throw new Error("Workspace connection is not ready.");
      const startedGeneration = generation.current;
      const { resource, receipt } = await openOwnedFile({
        ...owner,
        queryClient,
        projectId: explorer.projectId,
        worktreeId: explorer.worktreeId,
        path: entry.path,
      });
      if (
        generation.current !== startedGeneration ||
        current.current?.controller !== owner.controller
      )
        throw new Error("File window context changed.");
      // An already-open resource in another window has just been focused. Do not
      // steal it back or manufacture a duplicate native view.
      if (receipt.focusWindowId && receipt.focusWindowId !== owner.windowId)
        return;
      const tab = receipt.layout.windows
        .find((w) => w.id === owner.windowId)
        ?.panes.flatMap((p) => p.tabs)
        .find(
          (t) =>
            t.resource.kind === "entity" &&
            t.resource.definitionId === "project.file" &&
            t.resource.resourceId === resource.id,
        );
      if (!tab) throw new Error("The opened file tab is no longer available.");
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const request: Pending = {
          tabId: tab.id,
          resourceId: resource.id,
          title: entry.name,
          workspace: owner,
          started: false,
          cancellation: new AbortController(),
          finish(error) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            requests.current.delete(request);
            setPending((items) => items.filter((item) => item !== request));
            if (error !== undefined) reject(error);
            else resolve();
          },
        };
        // This bounds the actual renderer-registration wait, not an inferred
        // readiness check. Once handoff begins its own lifecycle owns cancellation.
        const timeout = setTimeout(() => {
          if (!request.started)
            request.finish(
              new Error("The file renderer did not attach for transfer."),
            );
        }, 30_000);
        requests.current.add(request);
        setPending((items) => [...items, request]);
      });
    },
    [queryClient],
  );

  useEffect(() => {
    for (const request of pending) {
      if (request.started) continue;
      const owner = current.current;
      if (
        !owner ||
        owner.controller !== request.workspace.controller ||
        owner.windowId !== request.workspace.windowId
      ) {
        request.finish(new Error("File window context changed."));
        continue;
      }
      const snapshot = owner.controller.getSnapshot();
      const pane = snapshot.authoritative.windows
        .find((w) => w.id === owner.windowId)
        ?.panes.find((p) => p.tabs.some((t) => t.id === request.tabId));
      const tab = pane?.tabs.find((t) => t.id === request.tabId);
      if (
        snapshot.disposed ||
        !tab ||
        tab.resource.kind !== "entity" ||
        tab.resource.resourceId !== request.resourceId
      ) {
        request.finish(
          new Error("The file tab changed before window transfer."),
        );
        continue;
      }
      const surface = surfaces.get(request.tabId);
      if (surface?.kind !== "file" || !explorers.has(request.tabId)) continue;
      request.started = true;
      void detachWorkspaceEditors({
        ...owner,
        paneId: pane!.id,
        tabId: request.tabId,
        title: request.title,
        signal: request.cancellation.signal,
        surfaces,
        explorers,
      }).then(
        () => request.finish(),
        (error: unknown) => request.finish(error),
      );
    }
  }, [
    pending,
    surfaces,
    explorers,
    lifecycleRevision,
    workspace?.controller,
    workspace?.windowId,
  ]);
  return useCallback(
    (explorer: ExplorerSummary, entry: ExplorerEntry) => {
      const key = JSON.stringify([
        explorer.projectId,
        explorer.worktreeId,
        entry.path,
      ]);
      const existing = openings.current.get(key);
      if (existing) return existing;
      const operation = openOnce(explorer, entry).finally(() => {
        if (openings.current.get(key) === operation)
          openings.current.delete(key);
      });
      openings.current.set(key, operation);
      return operation;
    },
    [openOnce],
  );
}
