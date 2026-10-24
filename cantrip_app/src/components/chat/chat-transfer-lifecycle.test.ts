import { afterEach, expect, it, vi } from "vitest";
import type { ChatTransferLifecycle, ChatViewState } from "./chat-view-state";

const session = vi.hoisted(() => ({
  generation: 1,
  authenticated: true,
  listeners: new Set<() => void>(),
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () =>
    session.authenticated ? { generation: session.generation } : null,
  clientSessionIdentityMatches: (identity: { generation: number }) =>
    session.authenticated && identity.generation === session.generation,
  onClientSessionIdentityChanged: (listener: () => void) => {
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  },
}));
import {
  getChatTransferLifecycle,
  registerChatTransferLifecycle,
} from "./chat-transfer-lifecycle";

const owner = { tabId: "tab", chatId: "chat", projectId: "project" };
const cleanups: Array<() => void> = [];
const lifecycle = (): ChatTransferLifecycle => ({
  suspendTransfer: vi.fn(() => vi.fn()),
  captureTransfer: vi.fn(async () => ({ version: 1 }) as ChatViewState),
  retireTransfer: vi.fn(async () => {}),
});
function register(actions = lifecycle()) {
  cleanups.push(registerChatTransferLifecycle(owner, actions));
  return getChatTransferLifecycle(owner)!;
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  session.authenticated = true;
  session.generation++;
  expect(session.listeners.size).toBe(0);
});

it("scopes views by tab, chat and project without retiring chat execution on cleanup", async () => {
  const actions = lifecycle();
  const handle = register(actions);
  await handle.captureTransfer();
  expect(actions.captureTransfer).toHaveBeenCalledOnce();
  for (const key of ["tabId", "chatId", "projectId"] as const)
    expect(
      getChatTransferLifecycle({ ...owner, [key]: "other" }),
    ).toBeUndefined();
  cleanups.pop()!();
  expect(getChatTransferLifecycle(owner)).toBeUndefined();
  expect(actions.retireTransfer).not.toHaveBeenCalled();
  await expect(handle.captureTransfer()).rejects.toThrow("no longer current");
});

it("does not let stale cleanup or cancellation affect a replacement renderer", () => {
  const release = vi.fn();
  const first = register({ ...lifecycle(), suspendTransfer: () => release });
  const cancel = first.suspendTransfer();
  const replacement = register();
  cleanups.shift()!();
  cancel();
  expect(release).not.toHaveBeenCalled();
  expect(getChatTransferLifecycle(owner)).toBe(replacement);
  expect(() => first.suspendTransfer()).toThrow("no longer current");
});

it("rejects a pending private capture after account rotation", async () => {
  let finish!: (value: ChatViewState) => void;
  const handle = register({
    ...lifecycle(),
    captureTransfer: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const capture = handle.captureTransfer();
  session.generation++;
  for (const listener of session.listeners) listener();
  expect(getChatTransferLifecycle(owner)).toBeUndefined();
  finish({ version: 1 } as ChatViewState);
  await expect(capture).rejects.toThrow("no longer current");
  await expect(handle.retireTransfer()).rejects.toThrow("no longer current");
});

it("does not register a renderer without an authenticated session", () => {
  session.authenticated = false;
  expect(register()).toBeUndefined();
  expect(session.listeners.size).toBe(0);
});
