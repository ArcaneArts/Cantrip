import { workerSummarySchema } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  buildExecutionTargetCatalog,
  executionTargetAvailability,
} from "../src/execution-targets/catalog.js";

function worker(workerId: string) {
  return workerSummarySchema.parse({
    workerId,
    name: workerId,
    platform: "linux",
    architecture: "x64",
    codexVersion: "0.146.1",
    online: true,
    lastSeenAt: "2026-08-12T12:00:00.000Z",
    startedAt: "2026-08-12T12:00:00.000Z",
  });
}

describe("execution target catalog", () => {
  it("bounds the returned catalog and reports truncation", () => {
    const catalog = buildExecutionTargetCatalog({
      browsers: [],
      chats: [],
      codeTabs: [],
      desktops: [],
      explorers: [],
      projectId: "project-one",
      remoteSurfaces: [],
      replicas: [],
      terminals: [],
      workers: Array.from({ length: 2_001 }, (_, index) =>
        worker(`worker-${index.toString().padStart(4, "0")}`),
      ),
      worktrees: [],
    });
    expect(catalog.targets).toHaveLength(2_000);
    expect(catalog.truncated).toBe(true);
    expect(catalog.targets[0]).toMatchObject({
      resourceKind: "worker",
      availability: "available",
    });
  });

  it("combines heartbeat, connection, and capability availability", () => {
    const target = worker("worker-one");
    expect(
      executionTargetAvailability(target, null, () => false),
    ).toMatchObject({
      availability: "worker-offline",
      online: false,
    });
    expect(
      executionTargetAvailability(target, "browser", () => true),
    ).toMatchObject({
      availability: "capability-unavailable",
      online: true,
    });
  });
});
