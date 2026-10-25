import { afterEach, expect, it, vi } from "vitest";
import type { RemoteDesktopViewState } from "./remote-desktop-view-state";

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
  getRemoteDesktopTransferLifecycle,
  registerRemoteDesktopTransferLifecycle,
} from "./remote-desktop-transfer-lifecycle";

const owner = {
  tabId: "tab",
  desktopId: "desktop",
  projectId: "project",
  workerId: "worker",
};
const state: RemoteDesktopViewState = {
  version: 1,
  ...owner,
  viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
  fleetOpen: false,
  targetSearch: "",
};
const cleanups: Array<() => void> = [];
function register(capture = async () => state) {
  const release = vi.fn();
  const actions = {
    suspendTransfer: vi.fn(() => release),
    captureTransfer: vi.fn(capture),
    retireTransfer: vi.fn(async () => {}),
  };
  cleanups.push(registerRemoteDesktopTransferLifecycle(owner, actions));
  return {
    actions,
    release,
    handle: getRemoteDesktopTransferLifecycle(owner)!,
  };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  session.authenticated = true;
  session.generation++;
  expect(session.listeners.size).toBe(0);
});

it("matches all owner boundaries and unregisters without retiring the worker session", async () => {
  const { handle, actions } = register();
  expect(await handle.captureTransfer()).toEqual(state);
  for (const key of ["tabId", "desktopId", "projectId", "workerId"] as const)
    expect(
      getRemoteDesktopTransferLifecycle({ ...owner, [key]: "other" }),
    ).toBeUndefined();
  cleanups.pop()!();
  expect(actions.retireTransfer).not.toHaveBeenCalled();
  await expect(handle.captureTransfer()).rejects.toThrow("no longer current");
});

it("fences stale cancellation and cleanup after a renderer is replaced", () => {
  const first = register();
  const release = first.handle.suspendTransfer();
  const next = register();
  cleanups.shift()!();
  release();
  expect(first.release).not.toHaveBeenCalled();
  expect(getRemoteDesktopTransferLifecycle(owner)).toBe(next.handle);
  expect(() => first.handle.suspendTransfer()).toThrow("no longer current");
});

it("rejects a pending capture after account rotation", async () => {
  let finish!: (value: RemoteDesktopViewState) => void;
  const { handle } = register(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = handle.captureTransfer();
  session.generation++;
  for (const listener of session.listeners) listener();
  expect(getRemoteDesktopTransferLifecycle(owner)).toBeUndefined();
  finish(state);
  await expect(pending).rejects.toThrow("no longer current");
  await expect(handle.retireTransfer()).rejects.toThrow("no longer current");
});

it("does not register an unauthenticated renderer", () => {
  session.authenticated = false;
  expect(register().handle).toBeUndefined();
  expect(session.listeners.size).toBe(0);
});
