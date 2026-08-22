import { workerSummarySchema } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { repositoryPlacementAvailability } from "./repository-import-options-dialog";

const now = "2026-08-22T12:00:00.000Z";

function worker(
  capabilities: Partial<
    ReturnType<typeof workerSummarySchema.parse>["projectReplicas"]
  >,
) {
  return workerSummarySchema.parse({
    workerId: "worker-one",
    name: "Build Worker",
    platform: "linux",
    architecture: "x64",
    codexVersion: null,
    projectReplicas: {
      provision: true,
      synchronize: true,
      remove: true,
      exactRevision: true,
      ...capabilities,
    },
    startedAt: now,
    online: true,
    lastSeenAt: now,
  });
}

describe("repository import placement options", () => {
  it("keeps managed available while gating custom modes by complete capability", () => {
    expect(repositoryPlacementAvailability(worker({}))).toEqual({
      managed: true,
      managedLink: false,
      direct: false,
    });
    expect(
      repositoryPlacementAvailability(
        worker({
          managedLinkPlacement: true,
          directPlacement: true,
          attachExisting: true,
          recursiveParentCreation: true,
        }),
      ),
    ).toEqual({ managed: true, managedLink: true, direct: true });
  });
});
