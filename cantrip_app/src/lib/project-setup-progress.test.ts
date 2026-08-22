import type { ProjectReplicaJobSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  isWindowsLongPathSetupFailure,
  latestProjectProvisionJob,
  projectListRefreshInterval,
  projectOwningWorkerId,
  projectSetupFailureKey,
  projectSetupJobRefreshInterval,
  projectSetupPercent,
} from "./project-setup-progress";

function job(
  id: string,
  createdAt: string,
  kind: ProjectReplicaJobSummary["kind"],
  percent: number,
): ProjectReplicaJobSummary {
  return {
    id,
    kind,
    createdAt,
    progress: { percent },
  } as ProjectReplicaJobSummary;
}

describe("project setup progress", () => {
  it("keeps bounded project polling active while durable setup is pending", () => {
    expect(projectListRefreshInterval(true, [{ setupStatus: "cloning" }])).toBe(
      3_000,
    );
    expect(
      projectListRefreshInterval(true, [{ setupStatus: "preparing" }]),
    ).toBe(3_000);
    expect(projectListRefreshInterval(true, [{ setupStatus: "ready" }])).toBe(
      false,
    );
    expect(projectListRefreshInterval(false, [{ setupStatus: "ready" }])).toBe(
      15_000,
    );
  });

  it("polls active setup jobs even while live updates are healthy", () => {
    expect(projectSetupJobRefreshInterval("cloning")).toBe(2_000);
    expect(projectSetupJobRefreshInterval("preparing")).toBe(2_000);
    expect(projectSetupJobRefreshInterval("failed")).toBe(false);
    expect(projectSetupJobRefreshInterval("ready")).toBe(false);
  });

  it("selects the newest provision job and provides a startup fallback", () => {
    const latest = latestProjectProvisionJob([
      job("old", "2026-08-16T01:00:00.000Z", "provision", 30),
      job("sync", "2026-08-16T03:00:00.000Z", "synchronize", 90),
      job("new", "2026-08-16T02:00:00.000Z", "provision", 64),
    ]);

    expect(latest?.id).toBe("new");
    expect(projectSetupPercent(latest)).toBe(64);
    expect(projectSetupPercent(null)).toBe(5);
  });

  it("uses setup placement before the project source exists", () => {
    expect(
      projectOwningWorkerId(
        { preferredWorkerId: "worker-preferred", source: null },
        { workerId: "worker-job" },
      ),
    ).toBe("worker-preferred");
    expect(
      projectOwningWorkerId(
        { preferredWorkerId: null, source: null },
        { workerId: "worker-job" },
      ),
    ).toBe("worker-job");
    expect(
      projectOwningWorkerId(
        {
          preferredWorkerId: "worker-preferred",
          source: {
            id: "source-one",
            sourceKind: "git",
            workerId: "worker-source",
            path: "/repo",
            displayPath: "repo",
          },
        },
        { workerId: "worker-job" },
      ),
    ).toBe("worker-source");
  });

  it("recognizes typed and legacy Windows long-path failures", () => {
    expect(
      isWindowsLongPathSetupFailure({
        error: {
          code: "windows-long-paths-disabled",
          message: "Git long paths are disabled.",
          retryable: true,
        },
      }),
    ).toBe(true);
    expect(
      isWindowsLongPathSetupFailure({
        error: {
          code: "remote-unavailable",
          message: "fatal: cannot write keep file: Filename too long",
          retryable: true,
        },
      }),
    ).toBe(true);
    expect(
      isWindowsLongPathSetupFailure({
        error: {
          code: "remote-unavailable",
          message: "fatal: the remote disconnected",
          retryable: true,
        },
      }),
    ).toBe(false);
  });

  it("keys a failure by job revision so a repeated failure can reopen", () => {
    expect(projectSetupFailureKey({ id: "job-one", stateRevision: 4 })).toBe(
      "job-one:4",
    );
  });
});
