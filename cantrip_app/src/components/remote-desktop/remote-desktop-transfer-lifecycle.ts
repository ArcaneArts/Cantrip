import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";
import type {
  RemoteDesktopTransferLifecycle,
  RemoteDesktopTransferOwner,
} from "./remote-desktop-view-state";

const owners = new Map<string, RemoteDesktopTransferLifecycle>();
const keyFor = (owner: RemoteDesktopTransferOwner) =>
  JSON.stringify([
    owner.tabId,
    owner.desktopId,
    owner.projectId,
    owner.workerId,
  ]);

/** Registration lifetime is a renderer lifetime, not a worker session lifetime. */
export function registerRemoteDesktopTransferLifecycle(
  owner: RemoteDesktopTransferOwner,
  lifecycle: RemoteDesktopTransferLifecycle,
) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity) return () => {};
  const key = keyFor(owner);
  let live = true;
  const current = () =>
    live &&
    owners.get(key) === guarded &&
    clientSessionIdentityMatches(identity);
  const assertCurrent = () => {
    if (!current())
      throw new Error(
        "The remote desktop transfer renderer is no longer current.",
      );
  };
  const guarded: RemoteDesktopTransferLifecycle = {
    suspendTransfer() {
      assertCurrent();
      const release = lifecycle.suspendTransfer();
      return () => {
        if (current()) release();
      };
    },
    async captureTransfer() {
      assertCurrent();
      const state = await lifecycle.captureTransfer();
      assertCurrent();
      return state;
    },
    async retireTransfer() {
      assertCurrent();
      await lifecycle.retireTransfer();
      assertCurrent();
    },
  };
  owners.set(key, guarded);
  const remove = () => {
    live = false;
    if (owners.get(key) === guarded) owners.delete(key);
  };
  const unsubscribe = onClientSessionIdentityChanged(() => {
    if (!clientSessionIdentityMatches(identity)) remove();
  });
  return () => {
    remove();
    unsubscribe();
  };
}

export function getRemoteDesktopTransferLifecycle(
  owner: RemoteDesktopTransferOwner,
) {
  return owners.get(keyFor(owner));
}
