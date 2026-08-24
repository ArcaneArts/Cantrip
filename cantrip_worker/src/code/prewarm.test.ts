import { createHash } from "node:crypto";

import type { WorkerEncryptionStatus } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ownerScopedCodeProfileId,
  prewarmDefaultCodeProfileAfterEncryptionRefresh,
} from "./prewarm.js";

const status = (
  state: WorkerEncryptionStatus["state"],
): WorkerEncryptionStatus =>
  ({
    supported: true,
    state,
    principalId: "principal-one",
    grants: [],
    lastSyncedAt: null,
    error: null,
  }) as WorkerEncryptionStatus;

describe("verified Cantrip Code prewarm", () => {
  it("does not prewarm before encryption becomes ready", async () => {
    const prewarmProfile = vi.fn<() => Promise<void>>();

    await prewarmDefaultCodeProfileAfterEncryptionRefresh({
      identity: { ownerId: "owner-one", serverId: "server-one" },
      prewarmProfile,
      status: status("pending-approval"),
    });

    expect(prewarmProfile).not.toHaveBeenCalled();
  });

  it("prewarms the server-compatible owner-scoped default profile", async () => {
    const prewarmProfile = vi.fn(async () => undefined);

    await prewarmDefaultCodeProfileAfterEncryptionRefresh({
      identity: { ownerId: "owner-one", serverId: "server-one" },
      prewarmProfile,
      status: status("ready"),
    });

    expect(prewarmProfile).toHaveBeenCalledOnce();
    expect(prewarmProfile).toHaveBeenCalledWith(
      createHash("sha256").update("owner-one\0default").digest("hex"),
    );
    expect(ownerScopedCodeProfileId("owner-one", "default")).not.toBe(
      ownerScopedCodeProfileId("owner-two", "default"),
    );
  });

  it("absorbs a background prewarm failure so a later refresh can retry", async () => {
    const prewarmProfile = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValueOnce(undefined);
    const input = {
      identity: { ownerId: "owner-one", serverId: "server-one" },
      prewarmProfile,
      status: status("ready"),
    };

    await expect(
      prewarmDefaultCodeProfileAfterEncryptionRefresh(input),
    ).resolves.toBeUndefined();
    await expect(
      prewarmDefaultCodeProfileAfterEncryptionRefresh(input),
    ).resolves.toBeUndefined();
    expect(prewarmProfile).toHaveBeenCalledTimes(2);
  });
});
