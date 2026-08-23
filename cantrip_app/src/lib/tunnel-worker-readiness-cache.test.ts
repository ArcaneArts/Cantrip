import type { WorkerEncryptionStatus } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { TunnelWorkerReadinessCacheScope } from "./tunnel-worker-readiness-cache";
import { TunnelWorkerReadinessRequestCache } from "./tunnel-worker-readiness-cache";

const encryption: WorkerEncryptionStatus = {
  supported: true,
  state: "ready",
  principalId: "11111111-1111-4111-8111-111111111111",
  grants: [{ component: "tunnel-content", keyRevision: 3 }],
  lastSyncedAt: "2026-08-23T12:00:00.000Z",
  error: null,
};

function scope(serverId: string): TunnelWorkerReadinessCacheScope {
  return {
    activeServerUrl: "https://cantrip.test",
    session: { serverId, user: { id: "owner-a" } },
    snapshot: {
      clientId: "22222222-2222-4222-8222-222222222222",
      identity: { ownerId: "owner-a", serverId },
      masterKeyRevision: 3,
      status: "ready",
    },
    workerEncryption: encryption,
    workerId: "worker-a",
  };
}

describe("tunnel worker readiness request cache", () => {
  it("refreshes readiness when only the logical session server changes", async () => {
    const cache = new TunnelWorkerReadinessRequestCache(5_000);
    const refresh = vi.fn(async (serverId: string) => encryption);

    await cache.get(scope("server-a"), () => refresh("server-a"));
    await cache.get(scope("server-a"), () => refresh("server-a"));
    expect(refresh).toHaveBeenCalledTimes(1);

    await cache.get(scope("server-b"), () => refresh("server-b"));

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls.map(([serverId]) => serverId)).toEqual([
      "server-a",
      "server-b",
    ]);
  });
});
