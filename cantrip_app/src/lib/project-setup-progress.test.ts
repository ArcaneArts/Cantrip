import type { ProjectReplicaJobSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  latestProjectProvisionJob,
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
});
