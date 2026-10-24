import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";
import type { BrowserTransferLifecycle } from "./browser-view-state";

export interface BrowserTransferOwner {
  tabId: string;
  browserId: string;
  projectId: string;
  workerId: string;
}
const owners = new Map<string, BrowserTransferLifecycle>();
const keyFor = (owner: BrowserTransferOwner) =>
  JSON.stringify([
    owner.tabId,
    owner.browserId,
    owner.projectId,
    owner.workerId,
  ]);

export function registerBrowserTransferLifecycle(
  owner: BrowserTransferOwner,
  lifecycle: BrowserTransferLifecycle,
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
      throw new Error("The browser transfer renderer is no longer current.");
  };
  const guarded: BrowserTransferLifecycle = {
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
export function getBrowserTransferLifecycle(owner: BrowserTransferOwner) {
  return owners.get(keyFor(owner));
}
