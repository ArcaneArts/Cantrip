import type { ExplorerLifecycleActions } from "./explorer-view";

export type ExplorerPreparationResult =
  "cancelled" | "ready" | "save-failed" | "state-failed";

export function confirmExplorerDiscard(
  actions: ExplorerLifecycleActions | null | undefined,
  confirmDiscard: () => boolean,
): boolean {
  return !actions?.dirty || confirmDiscard();
}

export async function prepareExplorerRebind(
  actions: ExplorerLifecycleActions | null | undefined,
  confirmDiscard: () => boolean,
): Promise<ExplorerPreparationResult> {
  if (!confirmExplorerDiscard(actions, confirmDiscard)) return "cancelled";
  if (actions && !(await actions.flushViewState())) return "state-failed";
  return "ready";
}

export async function prepareExplorerPopout(
  actions: ExplorerLifecycleActions | null | undefined,
  confirmSave: () => boolean,
): Promise<ExplorerPreparationResult> {
  if (actions?.dirty) {
    if (!confirmSave()) return "cancelled";
    if (!(await actions.save())) return "save-failed";
  }
  if (actions && !(await actions.flushViewState())) return "state-failed";
  return "ready";
}
