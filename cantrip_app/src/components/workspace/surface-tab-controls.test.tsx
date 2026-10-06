import type { ProjectSurface } from "@/lib/project-surface";
import { describe, expect, it, vi } from "vitest";

import { surfaceMoveTargets } from "./surface-tab-controls";

const surface = {
  definition: { supportedPlacements: ["center", "bottom"] },
} as ProjectSurface;

describe("surface menu move targets", () => {
  it("offers only supported destinations other than the current region", () => {
    const onMove = vi.fn();
    const targets = surfaceMoveTargets(surface, "center", onMove);
    expect(targets.map((target) => target.label)).toEqual(["Move to Bottom"]);
    targets[0]!.onSelect();
    expect(onMove).toHaveBeenCalledExactlyOnceWith("bottom");
  });

  it("does not offer moves without a handler", () => {
    expect(surfaceMoveTargets(surface, "center")).toEqual([]);
  });

  it("does not offer moves when no other region is supported", () => {
    const centerOnly = {
      definition: { supportedPlacements: ["center"] },
    } as ProjectSurface;
    expect(surfaceMoveTargets(centerOnly, "center", vi.fn())).toEqual([]);
  });
});
