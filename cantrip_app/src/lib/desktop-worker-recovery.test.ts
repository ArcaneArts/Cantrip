import { describe, expect, it, vi } from "vitest";

import {
  automaticDesktopWorkerRecoveryPlan,
  connectDesktopWorker,
  type DesktopWorkerConnectionDependencies,
} from "./desktop-worker-recovery";

const serverUrl = "https://winterhold.cantrip.art";
const currentWorkerId = "desktop-current";
const recoveryWorkerId = "desktop-retained";

function desktopWorker(workerId = currentWorkerId, running = true) {
  return { name: "This machine", running, serverUrl, workerId };
}

function serverWorker(
  workerId: string,
  online: boolean,
  sources: readonly unknown[] = [],
) {
  return { online, sources, workerId };
}

function dependencies(events: string[]): DesktopWorkerConnectionDependencies {
  return {
    createEnrollment: vi.fn(async (input) => {
      events.push(`enroll:${input.candidateWorkerIds.join(",")}`);
      return {
        code: `ctwl_${"a".repeat(32)}`,
        expiresAt: "2026-08-27T12:00:00.000Z",
        id: "019cfe85-2d24-7000-8000-000000000001",
        label: "This machine",
        workerId: recoveryWorkerId,
      };
    }),
    forgetDesktopWorker: vi.fn(async (workerId) => {
      events.push(`forget:${workerId}`);
    }),
    pairDesktopWorker: vi.fn(async (input) => {
      events.push(`pair:${input.workerId}`);
      return desktopWorker(input.workerId ?? "desktop-new");
    }),
    unlinkWorker: vi.fn(async (workerId) => {
      events.push(`unlink:${workerId}`);
    }),
  };
}

describe("desktop worker recovery", () => {
  it("automatically replaces a connected source-free worker with its retained source owner", () => {
    expect(
      automaticDesktopWorkerRecoveryPlan({
        candidates: [
          { repositoryCount: 4, workerId: recoveryWorkerId },
          { repositoryCount: 0, workerId: currentWorkerId },
        ],
        desktopWorkers: [desktopWorker()],
        serverUrl,
        workers: [serverWorker(currentWorkerId, true)],
      }),
    ).toEqual({ currentWorkerId, recoveryWorkerId });
  });

  it.each([
    {
      label: "the current worker is stopped",
      desktopWorkers: [desktopWorker(currentWorkerId, false)],
      workers: [serverWorker(currentWorkerId, true)],
    },
    {
      label: "the current worker is offline",
      desktopWorkers: [desktopWorker()],
      workers: [serverWorker(currentWorkerId, false)],
    },
    {
      label: "the current worker already owns a source",
      desktopWorkers: [desktopWorker()],
      workers: [serverWorker(currentWorkerId, true, [{}])],
    },
    {
      label: "the retained worker is online",
      desktopWorkers: [desktopWorker()],
      workers: [
        serverWorker(currentWorkerId, true),
        serverWorker(recoveryWorkerId, true, [{}]),
      ],
    },
  ])(
    "does not automatically recover when $label",
    ({ desktopWorkers, workers }) => {
      expect(
        automaticDesktopWorkerRecoveryPlan({
          candidates: [
            { repositoryCount: 4, workerId: recoveryWorkerId },
            { repositoryCount: 0, workerId: currentWorkerId },
          ],
          desktopWorkers,
          serverUrl,
          workers,
        }),
      ).toBeNull();
    },
  );

  it("retires the unreachable retained identity and preserves the current credential until pairing", async () => {
    const events: string[] = [];
    const result = await connectDesktopWorker(
      {
        candidates: [
          { repositoryCount: 4, workerId: recoveryWorkerId },
          { repositoryCount: 0, workerId: currentWorkerId },
        ],
        currentWorkerId,
        recoveryWorkerId,
        serverUrl,
        workers: [
          serverWorker(currentWorkerId, true),
          serverWorker(recoveryWorkerId, false, [{}]),
        ],
      },
      dependencies(events),
    );

    expect(events).toEqual([
      `unlink:${recoveryWorkerId}`,
      `enroll:${recoveryWorkerId}`,
      `pair:${recoveryWorkerId}`,
    ]);
    expect(result.desktopWorker.workerId).toBe(recoveryWorkerId);
    expect(events).not.toContain(`unlink:${currentWorkerId}`);
  });

  it("recovers an already-unlinked retained identity without touching the current worker", async () => {
    const events: string[] = [];
    await connectDesktopWorker(
      {
        candidates: [
          { repositoryCount: 4, workerId: recoveryWorkerId },
          { repositoryCount: 0, workerId: currentWorkerId },
        ],
        currentWorkerId,
        recoveryWorkerId,
        serverUrl,
        workers: [serverWorker(currentWorkerId, true)],
      },
      dependencies(events),
    );

    expect(events).toEqual([
      `enroll:${recoveryWorkerId}`,
      `pair:${recoveryWorkerId}`,
    ]);
  });

  it("leaves the connected worker running when the server rejects the retained identity", async () => {
    const events: string[] = [];
    const mocks = dependencies(events);
    vi.mocked(mocks.createEnrollment).mockResolvedValueOnce({
      code: `ctwl_${"b".repeat(32)}`,
      expiresAt: "2026-08-27T12:00:00.000Z",
      id: "019cfe85-2d24-7000-8000-000000000002",
      label: "This machine",
      workerId: null,
    });

    await expect(
      connectDesktopWorker(
        {
          candidates: [
            { repositoryCount: 4, workerId: recoveryWorkerId },
            { repositoryCount: 0, workerId: currentWorkerId },
          ],
          currentWorkerId,
          recoveryWorkerId,
          serverUrl,
          workers: [serverWorker(currentWorkerId, true)],
        },
        mocks,
      ),
    ).rejects.toThrow("did not authorize");
    expect(mocks.pairDesktopWorker).not.toHaveBeenCalled();
    expect(mocks.unlinkWorker).not.toHaveBeenCalledWith(currentWorkerId);
  });

  it("coalesces automatic and settings recovery of the same worker", async () => {
    const events: string[] = [];
    const mocks = dependencies(events);
    let releaseEnrollment!: () => void;
    const enrollmentGate = new Promise<void>((resolve) => {
      releaseEnrollment = resolve;
    });
    vi.mocked(mocks.createEnrollment).mockImplementationOnce(async (input) => {
      events.push(`enroll:${input.candidateWorkerIds.join(",")}`);
      await enrollmentGate;
      return {
        code: `ctwl_${"c".repeat(32)}`,
        expiresAt: "2026-08-27T12:00:00.000Z",
        id: "019cfe85-2d24-7000-8000-000000000003",
        label: "This machine",
        workerId: recoveryWorkerId,
      };
    });
    const input = {
      candidates: [
        { repositoryCount: 4, workerId: recoveryWorkerId },
        { repositoryCount: 0, workerId: currentWorkerId },
      ],
      currentWorkerId,
      recoveryWorkerId,
      serverUrl,
      workers: [serverWorker(currentWorkerId, true)],
    };

    const automatic = connectDesktopWorker(input, mocks);
    const settings = connectDesktopWorker(input, mocks);
    await Promise.resolve();
    expect(mocks.createEnrollment).toHaveBeenCalledTimes(1);
    releaseEnrollment();
    await Promise.all([automatic, settings]);
    expect(mocks.pairDesktopWorker).toHaveBeenCalledTimes(1);
  });
});
