import { describe, expect, it, vi } from "vitest";

import { CantripApiError } from "@/lib/api-client";
import {
  PROJECT_SHARE_STATE_STALE_CODE,
  recoverStaleProjectShareState,
} from "@/lib/project-share-recovery";

describe("project share stale-state recovery", () => {
  it("revokes the orphan and retries exactly once", async () => {
    let orphanPresent = true;
    const open = vi
      .fn<() => Promise<{ revision: number; tunnelId: string }>>()
      .mockImplementation(async () => {
        if (orphanPresent) {
          throw new CantripApiError(
            "Project share state is stale.",
            409,
            PROJECT_SHARE_STATE_STALE_CODE,
          );
        }
        return {
          revision: 1,
          tunnelId: "22222222-2222-4222-8222-222222222222",
        };
      });
    const revokeOrphan = vi.fn().mockImplementation(async () => {
      orphanPresent = false;
    });

    await expect(
      recoverStaleProjectShareState({ open, revokeOrphan }),
    ).resolves.toEqual({
      revision: 1,
      tunnelId: "22222222-2222-4222-8222-222222222222",
    });
    expect(open).toHaveBeenCalledTimes(2);
    expect(revokeOrphan).toHaveBeenCalledOnce();
  });

  it("does not retry unrelated errors or a second stale response", async () => {
    const unrelated = new CantripApiError("Worker offline.", 503);
    const openUnrelated = vi.fn().mockRejectedValue(unrelated);
    const revokeUnrelated = vi.fn();
    await expect(
      recoverStaleProjectShareState({
        open: openUnrelated,
        revokeOrphan: revokeUnrelated,
      }),
    ).rejects.toBe(unrelated);
    expect(openUnrelated).toHaveBeenCalledOnce();
    expect(revokeUnrelated).not.toHaveBeenCalled();

    const stale = new CantripApiError(
      "Project share state is stale.",
      409,
      PROJECT_SHARE_STATE_STALE_CODE,
    );
    const openStale = vi.fn().mockRejectedValue(stale);
    const revokeStale = vi.fn().mockResolvedValue(undefined);
    await expect(
      recoverStaleProjectShareState({
        open: openStale,
        revokeOrphan: revokeStale,
      }),
    ).rejects.toBe(stale);
    expect(openStale).toHaveBeenCalledTimes(2);
    expect(revokeStale).toHaveBeenCalledOnce();
  });
});
