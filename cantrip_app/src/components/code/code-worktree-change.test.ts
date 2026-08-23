import { describe, expect, it, vi } from "vitest";

import type { CodeHeaderState } from "./code-view";
import { runCodeWorktreeChange } from "./code-worktree-change";

function header(prepare = true): CodeHeaderState {
  return {
    attachmentExpiresAt: null,
    error: null,
    isBusy: false,
    runtime: null,
    status: "running",
    reload: vi.fn(),
    prepareWorktreeChange: vi.fn().mockResolvedValue(prepare),
    restart: vi.fn(),
    resumeAfterWorktreeChange: vi.fn(),
    saveAll: vi.fn(),
    stop: vi.fn(),
  };
}

describe("Cantrip Code worktree changes", () => {
  it("rebinds an inactive editor without pausing it", async () => {
    const current = header();
    const rebind = vi.fn().mockResolvedValue(true);

    await expect(
      runCodeWorktreeChange({ active: false, header: current, rebind }),
    ).resolves.toBe(true);
    expect(current.prepareWorktreeChange).not.toHaveBeenCalled();
    expect(current.resumeAfterWorktreeChange).not.toHaveBeenCalled();
  });

  it("pauses and always resumes an active editor around the rebind", async () => {
    const current = header();
    const rebind = vi.fn().mockRejectedValue(new Error("rebind failed"));

    await expect(
      runCodeWorktreeChange({ active: true, header: current, rebind }),
    ).rejects.toThrow("rebind failed");
    expect(current.prepareWorktreeChange).toHaveBeenCalledOnce();
    expect(current.resumeAfterWorktreeChange).toHaveBeenCalledOnce();
  });

  it("does not rebind when the editor cannot be saved and paused", async () => {
    const current = header(false);
    const rebind = vi.fn().mockResolvedValue(true);

    await expect(
      runCodeWorktreeChange({ active: true, header: current, rebind }),
    ).resolves.toBe(false);
    expect(rebind).not.toHaveBeenCalled();
    expect(current.resumeAfterWorktreeChange).not.toHaveBeenCalled();
  });
});
