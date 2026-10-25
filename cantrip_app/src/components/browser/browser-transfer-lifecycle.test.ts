import { beforeEach, describe, expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({
  generation: 1,
  listeners: new Set<() => void>(),
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({ generation: session.generation }),
  clientSessionIdentityMatches: (identity: { generation: number }) =>
    identity.generation === session.generation,
  onClientSessionIdentityChanged: (listener: () => void) => {
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  },
}));
import {
  getBrowserTransferLifecycle,
  registerBrowserTransferLifecycle,
} from "./browser-transfer-lifecycle";
import type { BrowserTransferLifecycle } from "./browser-view-state";
import type { BrowserViewState } from "./browser-view-state";

const owner = {
  tabId: "tab",
  projectId: "project",
  browserId: "browser",
  workerId: "worker",
};
const lifecycle = () =>
  ({
    suspendTransfer: vi.fn(() => vi.fn()),
    captureTransfer: vi.fn(async () => ({ version: 1 })),
    retireTransfer: vi.fn(async () => {}),
  }) as unknown as BrowserTransferLifecycle;
describe("browser transfer lifecycle registration", () => {
  beforeEach(() => {
    session.generation++;
    for (const listener of session.listeners) listener();
  });
  it("registers the mounted view and unregisters without terminating its session", async () => {
    const actions = lifecycle();
    const unregister = registerBrowserTransferLifecycle(owner, actions);
    const registered = getBrowserTransferLifecycle(owner)!;
    await registered.captureTransfer();
    expect(actions.captureTransfer).toHaveBeenCalledOnce();
    expect(
      getBrowserTransferLifecycle({ ...owner, tabId: "other" }),
    ).toBeUndefined();
    expect(
      getBrowserTransferLifecycle({ ...owner, workerId: "other" }),
    ).toBeUndefined();
    unregister();
    expect(getBrowserTransferLifecycle(owner)).toBeUndefined();
    expect(actions.retireTransfer).not.toHaveBeenCalled();
    await expect(registered.captureTransfer()).rejects.toThrow(
      /no longer current/,
    );
  });
  it("old cleanup and cancellation cannot affect a replacement renderer", () => {
    const first = lifecycle();
    const unregisterFirst = registerBrowserTransferLifecycle(owner, first);
    const release = getBrowserTransferLifecycle(owner)!.suspendTransfer();
    const rawRelease = vi.mocked(first.suspendTransfer).mock.results[0]!.value;
    const unregisterNext = registerBrowserTransferLifecycle(owner, lifecycle());
    const next = getBrowserTransferLifecycle(owner);
    unregisterFirst();
    release();
    expect(rawRelease).not.toHaveBeenCalled();
    expect(getBrowserTransferLifecycle(owner)).toBe(next);
    unregisterNext();
  });
  it("revokes cached handles and pending captures on account/session rotation", async () => {
    let finish!: () => void;
    const actions = lifecycle();
    actions.captureTransfer = vi.fn(
      () =>
        new Promise<BrowserViewState>((resolve) => {
          finish = () => resolve({ version: 1 } as never);
        }),
    );
    const unregister = registerBrowserTransferLifecycle(owner, actions);
    const cached = getBrowserTransferLifecycle(owner)!;
    const capture = cached.captureTransfer();
    session.generation++;
    for (const listener of session.listeners) listener();
    expect(getBrowserTransferLifecycle(owner)).toBeUndefined();
    finish();
    await expect(capture).rejects.toThrow(/no longer current/);
    expect(() => cached.suspendTransfer()).toThrow(/no longer current/);
    unregister();
  });
});
