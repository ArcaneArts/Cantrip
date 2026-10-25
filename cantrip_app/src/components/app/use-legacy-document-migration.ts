import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ExplorerSummary } from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";
import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import { migrateOwnedLegacyFile } from "@/lib/migrate-owned-legacy-file";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import {
  getNativeCodeLifecycle,
  nativeCodeLifecycleRevision,
  subscribeNativeCodeLifecycle,
} from "@/components/code/native-code-lifecycle";

const noSubscription = () => () => {};
const noSnapshot = () => null;

/** Automatic, owner-window-local conversion. Real failures retain the source
 * and offer explicit retry; catalog refreshes must not spin a failing migration. */
export function useLegacyDocumentMigration({
  workspace,
  explorers,
  lifecycles,
  lifecycleRevision,
  queryClient,
}: {
  workspace: { controller: WorkspaceCommandClient; windowId: string } | null;
  explorers: readonly ExplorerSummary[] | undefined;
  lifecycles: ReadonlyMap<string, ExplorerLifecycleActions>;
  lifecycleRevision: number;
  queryClient: QueryClient;
}) {
  const controller = workspace?.controller;
  const codeRevision = useSyncExternalStore(
    subscribeNativeCodeLifecycle,
    nativeCodeLifecycleRevision,
  );
  const windowId = workspace?.windowId;
  const state = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? noSnapshot,
  );
  const context = useMemo(
    () => ({
      attempted: new Set<string>(),
      failures: new Map<string, unknown>(),
      running: false,
    }),
    [controller, windowId],
  );
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!controller || !windowId || !state || state.disposed || context.running)
      return;
    const owner = state.authoritative.windows.find(
      (window) => window.id === windowId,
    );
    for (const tab of owner?.panes.flatMap((pane) => pane.tabs) ?? []) {
      if (
        tab.resource.kind !== "entity" ||
        !["project.explorer", "project.code"].includes(
          tab.resource.definitionId,
        ) ||
        context.attempted.has(tab.id)
      )
        continue;
      const code = tab.resource.definitionId === "project.code";
      if (
        code &&
        state.authoritative.legacyCodeImports?.some(
          (entry) => entry.tabId === tab.id,
        )
      )
        continue;
      if (
        state.authoritative.pendingTransfers?.some((transfer) =>
          transfer.tabIds.includes(tab.id),
        )
      )
        continue;
      const explorerId = tab.resource.resourceId;
      const explorer = explorers?.find(
        (explorer) => explorer.id === explorerId,
      );
      const lifecycle = code
        ? getNativeCodeLifecycle(explorerId)
        : lifecycles.get(explorerId);
      if ((!code && !explorer?.selectedPath) || !lifecycle) continue;
      context.attempted.add(tab.id);
      context.running = true;
      // Run outside the effect commit so suspension can flush the inert state.
      void Promise.resolve()
        .then(() =>
          migrateOwnedLegacyFile({
            controller,
            windowId,
            tabId: tab.id,
            explorerId,
            lifecycle,
            queryClient,
            sourceKind: code ? "code" : "explorer",
          }),
        )
        .catch((error: unknown) => {
          context.failures.set(tab.id, error);
        })
        .finally(() => {
          context.running = false;
          setRevision((value) => value + 1);
        });
      break;
    }
  }, [
    controller,
    windowId,
    state,
    context,
    explorers,
    lifecycles,
    lifecycleRevision,
    codeRevision,
    queryClient,
    revision,
  ]);
  const retry = useCallback(() => {
    for (const tabId of context.failures.keys())
      context.attempted.delete(tabId);
    context.failures.clear();
    setRevision((value) => value + 1);
  }, [context]);
  return { error: context.failures.values().next().value ?? null, retry };
}
