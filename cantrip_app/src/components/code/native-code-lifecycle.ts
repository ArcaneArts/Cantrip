import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import { getClientSession } from "@/lib/client-session";
import { confirmEditorAction } from "@/lib/editor-confirmation";

export const nativeCodeScope = () => {
  const session = getClientSession();
  return JSON.stringify([session?.serverId, session?.user.id]);
};
const owners = new Map<string, ExplorerLifecycleActions>();
export const nativeCodeOwnerKey = (id: string, scope = nativeCodeScope()) =>
  `${scope}:${id}`;
export function getNativeCodeLifecycle(
  id: string,
): ExplorerLifecycleActions | undefined {
  return owners.get(nativeCodeOwnerKey(id));
}
export function setNativeCodeLifecycle(
  key: string,
  actions: ExplorerLifecycleActions | null,
): void {
  if (actions) owners.set(key, actions);
  else owners.delete(key);
}
export async function confirmNativeCodeDiscard(id: string): Promise<boolean> {
  const lifecycle = owners.get(nativeCodeOwnerKey(id));
  if (!lifecycle?.dirty) return true;
  if (
    !(await confirmEditorAction(
      "Close this Code tab and discard its unsaved file changes?",
    ))
  )
    return false;
  // Approval is not a committed close/delete. Retain the draft until the
  // authoritative mutation succeeds so failures leave the editor recoverable.
  return true;
}

export function nativeCodeDirty(id: string): boolean {
  return owners.get(nativeCodeOwnerKey(id))?.dirty ?? false;
}
export async function prepareNativeCodeTransfer(id: string): Promise<boolean> {
  const lifecycle = owners.get(nativeCodeOwnerKey(id));
  if (!lifecycle) return true;
  if (
    lifecycle.dirty &&
    !(await confirmEditorAction(
      "Save file changes before moving this Code tab to another checkout or window?",
    ))
  )
    return false;
  return (await lifecycle.save()) && (await lifecycle.flushViewState());
}
