import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import { getClientSession } from "@/lib/client-session";
import { confirmEditorAction } from "@/lib/editor-confirmation";

export const nativeCodeScope = () => {
  const session = getClientSession();
  return JSON.stringify([session?.serverId, session?.user.id]);
};
const owners = new Map<string, ExplorerLifecycleActions>();
const listeners = new Set<() => void>();
let revision = 0;
export const nativeCodeLifecycleRevision = () => revision;
export const subscribeNativeCodeLifecycle = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
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
  if (owners.get(key) === (actions ?? undefined)) return;
  const wasMounted = owners.has(key);
  if (actions) owners.set(key, actions);
  else owners.delete(key);
  // Migration waits for registration, not changing editor callbacks. Publishing
  // every callback replacement makes subscriber renders feed back into this
  // registry through the editor's lifecycle effect.
  if (wasMounted === owners.has(key)) return;
  revision++;
  for (const listener of listeners) listener();
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
