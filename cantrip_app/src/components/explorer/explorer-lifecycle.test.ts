import { describe, expect, it, vi } from "vitest";

import type { ExplorerLifecycleActions } from "./explorer-view";
import {
  confirmExplorerDiscard,
  nextExplorerEntryReplayKey,
  prepareExplorerPopout,
  prepareExplorerRebind,
} from "./explorer-lifecycle";

function lifecycle(
  overrides: Partial<ExplorerLifecycleActions> = {},
): ExplorerLifecycleActions {
  return {
    dirty: false,
    flushViewState: vi.fn().mockResolvedValue(true),
    reconcile: vi.fn(),
    save: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("Explorer lifecycle preparation", () => {
  it("never prompts for clean deletion and cancels dirty deletion", () => {
    const confirm = vi.fn().mockReturnValue(false);
    expect(confirmExplorerDiscard(lifecycle(), confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(confirmExplorerDiscard(lifecycle({ dirty: true }), confirm)).toBe(
      false,
    );
  });

  it("flushes view state only after a dirty rebind is confirmed", async () => {
    const actions = lifecycle({ dirty: true });
    expect(await prepareExplorerRebind(actions, () => false)).toBe("cancelled");
    expect(actions.flushViewState).not.toHaveBeenCalled();
    expect(await prepareExplorerRebind(actions, () => true)).toBe("ready");
    expect(actions.flushViewState).toHaveBeenCalledOnce();
  });

  it("saves a dirty editor before flushing and opening a popout", async () => {
    const actions = lifecycle({ dirty: true });
    expect(await prepareExplorerPopout(actions, () => true)).toBe("ready");
    expect(actions.save).toHaveBeenCalledOnce();
    expect(actions.flushViewState).toHaveBeenCalledOnce();
    expect(vi.mocked(actions.save).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(actions.flushViewState).mock.invocationCallOrder[0]!,
    );
  });

  it("reports failed saves and persistence without opening a popout", async () => {
    const saveFailed = lifecycle({
      dirty: true,
      save: vi.fn().mockResolvedValue(false),
    });
    expect(await prepareExplorerPopout(saveFailed, () => true)).toBe(
      "save-failed",
    );
    expect(saveFailed.flushViewState).not.toHaveBeenCalled();

    const stateFailed = lifecycle({
      flushViewState: vi.fn().mockResolvedValue(false),
    });
    expect(await prepareExplorerPopout(stateFailed, () => true)).toBe(
      "state-failed",
    );
  });
});

describe("Explorer entry reveal lifecycle", () => {
  it("advances only when entering an inactive Explorer", () => {
    expect(nextExplorerEntryReplayKey(0, true, true)).toBe(0);
    expect(nextExplorerEntryReplayKey(0, true, false)).toBe(0);
    expect(nextExplorerEntryReplayKey(0, false, false)).toBe(0);
    expect(nextExplorerEntryReplayKey(0, false, true)).toBe(1);
    expect(nextExplorerEntryReplayKey(1, false, true)).toBe(2);
  });
});
