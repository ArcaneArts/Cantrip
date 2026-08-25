import { createHash } from "node:crypto";

import type { WorkerEncryptionStatus } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  createCoalescingCodePrewarmScheduler,
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
  it("serializes refreshes and preserves one trailing run with the latest identity", async () => {
    let finishFirst: (() => void) | undefined;
    const run = vi.fn((trigger: string) => {
      if (trigger !== "startup") return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    });
    const schedule = createCoalescingCodePrewarmScheduler({
      onError: vi.fn(),
      run,
    });

    schedule("startup");
    schedule("heartbeat");
    schedule("command-refresh");
    expect(run).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls).toEqual([["startup"], ["command-refresh"]]);
  });

  it("continues with a queued refresh after a failed run", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const onError = vi.fn();
    const run = vi.fn((trigger: string) => {
      if (trigger !== "startup") return Promise.resolve();
      return new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      });
    });
    const schedule = createCoalescingCodePrewarmScheduler({ onError, run });

    schedule("startup");
    schedule("command-refresh");
    rejectFirst?.(new Error("refresh failed"));

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenCalledOnce();
    expect(run.mock.calls[1]).toEqual(["command-refresh"]);
  });

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
