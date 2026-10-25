import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";
import type { TerminalTransferLifecycle } from "./terminal-view";

export interface TerminalTransferOwner {
  tabId: string;
  projectId: string;
  terminalId: string;
  workerId: string;
}

const owners = new Map<string, TerminalTransferLifecycle>();
const keyFor = (owner: TerminalTransferOwner) =>
  JSON.stringify([
    owner.tabId,
    owner.projectId,
    owner.terminalId,
    owner.workerId,
  ]);

/** Registry is local to one renderer process. Resource IDs alone are not view IDs. */
export function registerTerminalTransferLifecycle(
  owner: TerminalTransferOwner,
  lifecycle: TerminalTransferLifecycle,
): () => void {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity) return () => {};
  const key = keyFor(owner);
  let live = true;
  const assertCurrent = () => {
    if (
      !live ||
      owners.get(key) !== guarded ||
      !clientSessionIdentityMatches(identity)
    )
      throw new Error("The terminal transfer renderer is no longer current.");
  };
  const guarded: TerminalTransferLifecycle = {
    suspendTransfer() {
      assertCurrent();
      const release = lifecycle.suspendTransfer();
      return () => {
        // A stale cancellation must never re-enable a replaced/account-old renderer.
        if (
          live &&
          owners.get(key) === guarded &&
          clientSessionIdentityMatches(identity)
        )
          release();
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

export function getTerminalTransferLifecycle(
  owner: TerminalTransferOwner,
): TerminalTransferLifecycle | undefined {
  return owners.get(keyFor(owner));
}
