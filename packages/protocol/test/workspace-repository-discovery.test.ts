import { describe, expect, it } from "vitest";

import {
  workspaceRepositoryMutationConflictCodeSchema,
  workspaceRepositoryMutationConflictSchema,
} from "../src/workspace-repository-discovery.js";

describe("workspace repository discovery protocol", () => {
  it("bounds machine-readable mutation conflicts", () => {
    expect(workspaceRepositoryMutationConflictCodeSchema.options).toEqual([
      "repository-discovery-stale",
      "repository-candidates-stale",
    ]);
    expect(
      workspaceRepositoryMutationConflictSchema.parse({
        code: "repository-candidates-stale",
        error: "Repository discovery changed before import.",
      }),
    ).toEqual({
      code: "repository-candidates-stale",
      error: "Repository discovery changed before import.",
    });
    expect(
      workspaceRepositoryMutationConflictSchema.safeParse({
        code: "repository-path-/private/example",
        error: "Unsafe code",
      }).success,
    ).toBe(false);
  });
});
