import { describe, expect, it, vi } from "vitest";

import {
  WORKER_ONLINE_WINDOW_MS,
  workerIsOnlineForPlacement,
} from "../src/db/repository.js";

describe("worker placement presence", () => {
  it("trusts an authoritative live connection over a stale heartbeat", () => {
    const isWorkerConnected = vi.fn(() => true);

    expect(
      workerIsOnlineForPlacement(
        {
          id: "worker-alpha",
          lastSeenAt: new Date(Date.now() - WORKER_ONLINE_WINDOW_MS - 1),
        },
        isWorkerConnected,
      ),
    ).toBe(true);
    expect(isWorkerConnected).toHaveBeenCalledWith("worker-alpha");
  });

  it("rejects a disconnected worker even when its heartbeat is fresh", () => {
    expect(
      workerIsOnlineForPlacement(
        { id: "worker-alpha", lastSeenAt: new Date() },
        () => false,
      ),
    ).toBe(false);
  });

  it("falls back to heartbeat freshness without a connection provider", () => {
    expect(
      workerIsOnlineForPlacement({
        id: "worker-alpha",
        lastSeenAt: new Date(Date.now() - WORKER_ONLINE_WINDOW_MS + 1),
      }),
    ).toBe(true);
    expect(
      workerIsOnlineForPlacement({
        id: "worker-alpha",
        lastSeenAt: new Date(Date.now() - WORKER_ONLINE_WINDOW_MS - 1),
      }),
    ).toBe(false);
  });
});
