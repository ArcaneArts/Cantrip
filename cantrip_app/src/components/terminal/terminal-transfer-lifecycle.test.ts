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
  getTerminalTransferLifecycle,
  registerTerminalTransferLifecycle,
} from "./terminal-transfer-lifecycle";
import type { TerminalTransferLifecycle } from "./terminal-view";
import type { TerminalViewState } from "./terminal-view-state";

const owner = {
  tabId: "tab",
  projectId: "project",
  terminalId: "terminal",
  workerId: "worker",
};
const lifecycle = () =>
  ({
    suspendTransfer: vi.fn(() => vi.fn()),
    captureTransfer: vi.fn(async () => ({ version: 1 })),
    retireTransfer: vi.fn(async () => {}),
  }) as unknown as TerminalTransferLifecycle;
describe("terminal transfer lifecycle registration", () => {
  beforeEach(() => {
    session.generation++;
    for (const listener of session.listeners) listener();
  });
  it("registers the mounted view and unregisters without terminating its session", async () => {
    const actions = lifecycle();
    const unregister = registerTerminalTransferLifecycle(owner, actions);
    const registered = getTerminalTransferLifecycle(owner)!;
    await registered.captureTransfer();
    expect(actions.captureTransfer).toHaveBeenCalledOnce();
    expect(
      getTerminalTransferLifecycle({ ...owner, tabId: "other" }),
    ).toBeUndefined();
    expect(
      getTerminalTransferLifecycle({ ...owner, workerId: "other" }),
    ).toBeUndefined();
    unregister();
    expect(getTerminalTransferLifecycle(owner)).toBeUndefined();
    expect(actions.retireTransfer).not.toHaveBeenCalled();
    await expect(registered.captureTransfer()).rejects.toThrow(
      /no longer current/,
    );
  });
  it("old cleanup and cancellation cannot affect a replacement renderer", () => {
    const first = lifecycle();
    const unregisterFirst = registerTerminalTransferLifecycle(owner, first);
    const release = getTerminalTransferLifecycle(owner)!.suspendTransfer();
    const rawRelease = vi.mocked(first.suspendTransfer).mock.results[0]!.value;
    const unregisterNext = registerTerminalTransferLifecycle(
      owner,
      lifecycle(),
    );
    const next = getTerminalTransferLifecycle(owner);
    unregisterFirst();
    release();
    expect(rawRelease).not.toHaveBeenCalled();
    expect(getTerminalTransferLifecycle(owner)).toBe(next);
    unregisterNext();
  });
  it("revokes cached handles and pending captures on account/session rotation", async () => {
    let finish!: () => void;
    const actions = lifecycle();
    actions.captureTransfer = vi.fn(
      () =>
        new Promise<TerminalViewState>((resolve) => {
          finish = () => resolve({ version: 1 } as never);
        }),
    );
    const unregister = registerTerminalTransferLifecycle(owner, actions);
    const cached = getTerminalTransferLifecycle(owner)!;
    const capture = cached.captureTransfer();
    session.generation++;
    for (const listener of session.listeners) listener();
    expect(getTerminalTransferLifecycle(owner)).toBeUndefined();
    finish();
    await expect(capture).rejects.toThrow(/no longer current/);
    expect(() => cached.suspendTransfer()).toThrow(/no longer current/);
    unregister();
  });
});
