import type { CodeGraphObservationTarget } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { CodeGraphObservationCoordinator } from "../src/codegraph/observations.js";

function target(index: number): CodeGraphObservationTarget {
  const id = index.toString(16).padStart(12, "0");
  return {
    projectId: `00000000-0000-4000-8000-${id}`,
    worktreeId: `worktree-${index}`,
    rootKind: "git-worktree",
    sourcePath: `/repositories/${index}`,
    worktreePath: `/repositories/${index}`,
  };
}

describe("CodeGraph observation coordination", () => {
  it("reauthorizes an exact agent target after an empty worker restart", async () => {
    const activations: CodeGraphObservationTarget[][] = [];
    const coordinator = new CodeGraphObservationCoordinator(async (targets) => {
      activations.push(targets);
    });

    await coordinator.refresh();
    await coordinator.ensure(target(1));

    expect(activations).toEqual([[], [target(1)]]);
  });

  it("serializes refreshes and prioritizes an exact target at the inventory cap", async () => {
    const activations: CodeGraphObservationTarget[][] = [];
    const releases: Array<() => void> = [];
    const coordinator = new CodeGraphObservationCoordinator(
      (targets) =>
        new Promise<void>((resolve) => {
          activations.push(targets);
          releases.push(resolve);
        }),
    );
    const configured = coordinator.configure(
      Array.from({ length: 128 }, (_, index) => target(index)),
    );
    await expect.poll(() => activations).toHaveLength(1);
    const exact = coordinator.ensure(target(200));
    expect(activations).toHaveLength(1);
    releases.shift()?.();
    await configured;
    await expect.poll(() => activations).toHaveLength(2);

    expect(activations[1]).toHaveLength(128);
    expect(activations[1]?.at(-1)).toEqual(target(200));
    expect(activations[1]).not.toContainEqual(target(0));
    releases.shift()?.();
    await exact;
  });
});
