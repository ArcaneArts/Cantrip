import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import { getClientSession } from "@/lib/client-session";

export const nativeCodeScope = () => {
  const session = getClientSession();
  return JSON.stringify([session?.serverId, session?.user.id]);
};
const owners = new Map<string, ExplorerLifecycleActions>();
export const nativeCodeOwnerKey = (id: string, scope = nativeCodeScope()) =>
  `${scope}:${id}`;
export function setNativeCodeLifecycle(
  key: string,
  actions: ExplorerLifecycleActions | null,
): void {
  if (actions) owners.set(key, actions);
  else owners.delete(key);
}
export function confirmNativeCodeDiscard(id: string): boolean {
  const lifecycle = owners.get(nativeCodeOwnerKey(id));
  if (!lifecycle?.dirty) return true;
  if (
    !window.confirm("Close this Code tab and discard its unsaved file changes?")
  )
    return false;
  lifecycle.discard?.();
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
    !window.confirm(
      "Save file changes before moving this Code tab to another checkout or window?",
    )
  )
    return false;
  return (await lifecycle.save()) && (await lifecycle.flushViewState());
}
