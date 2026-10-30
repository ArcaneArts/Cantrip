import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";
import type {
  ChatTransferLifecycle,
  ChatTransferOwner,
} from "./chat-view-state";

const owners = new Map<string, ChatTransferLifecycle>();
const keyFor = (owner: ChatTransferOwner) =>
  JSON.stringify([owner.tabId, owner.chatId, owner.projectId]);

/** Fence stale component callbacks and account changes without stopping execution. */
export function registerChatTransferLifecycle(
  owner: ChatTransferOwner,
  lifecycle: ChatTransferLifecycle,
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
      throw new Error("The chat transfer renderer is no longer current.");
  };
  const guarded: ChatTransferLifecycle = {
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

export function getChatTransferLifecycle(owner: ChatTransferOwner) {
  return owners.get(keyFor(owner));
}

/** Checkpoint protected drafts before a view is replaced/closed, without stopping execution. */
export async function checkpointChatView(owner: ChatTransferOwner) {
  const lifecycle = getChatTransferLifecycle(owner);
  // An unmounted view has no live composer to checkpoint.
  if (!lifecycle) return () => {};
  const release = lifecycle.suspendTransfer();
  try {
    await lifecycle.captureTransfer();
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
