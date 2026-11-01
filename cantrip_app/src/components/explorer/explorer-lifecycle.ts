import type { ExplorerLifecycleActions } from "./explorer-view";

export type ExplorerPreparationResult =
  "cancelled" | "ready" | "save-failed" | "state-failed";

export function nextExplorerEntryReplayKey(
  current: number,
  wasActive: boolean,
  active: boolean,
): number {
  return active && !wasActive ? current + 1 : current;
}

export async function confirmExplorerDiscard(
  actions: ExplorerLifecycleActions | null | undefined,
  confirmDiscard: () => boolean,
): Promise<boolean> {
  if (!actions?.dirty) return true;
  if (!confirmDiscard()) return false;
  await actions.discard?.();
  return true;
}

export async function prepareExplorerRebind(
  actions: ExplorerLifecycleActions | null | undefined,
  confirmDiscard: () => boolean,
): Promise<ExplorerPreparationResult> {
  if (!(await confirmExplorerDiscard(actions, confirmDiscard)))
    return "cancelled";
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

export async function deleteExplorerAfterPreparation<TResult>(
  actions: ExplorerLifecycleActions | null | undefined,
  deleteExplorer: () => Promise<TResult>,
): Promise<TResult> {
  await actions?.prepareClose();
  try {
    return await deleteExplorer();
  } catch (error) {
    actions?.cancelClose();
    throw error;
  }
}
