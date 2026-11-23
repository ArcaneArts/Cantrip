import { describe, expect, it } from "vitest";
import type { RemoteDesktopSummary } from "@cantrip/protocol";
import type { ProjectSurface } from "./project-surface";
import { surfaceOsFilePlacement } from "./os-file-placement";
import { surfaceWorktreeId } from "./sidebar-file-tabs";

const surface = {
  kind: "remote-desktop",
  projectId: "project",
  entity: { id: "desktop", worktreeId: null },
} as ProjectSurface;
const desktop = {
  id: "desktop",
  projectId: "project",
  osSource: {
    bindingId: "binding",
    worktreeId: "linux",
    runtimeGeneration: "captured-runtime",
  },
} as RemoteDesktopSummary;

describe("desktop file destinations", () => {
  it.each([
    undefined,
    { ...desktop, id: "previous" },
    { ...desktop, projectId: "another" },
  ])(
    "does not infer Host from an absent or mismatched desktop query",
    (query) => {
      expect(surfaceOsFilePlacement(surface, query)).toBeNull();
      expect(surfaceWorktreeId(surface, query)).toBeNull();
    },
  );
  it("retains the captured source without consulting its current replacement", () => {
    expect(surfaceOsFilePlacement(surface, desktop)).toEqual({
      cantripOsBindingId: "binding",
      cantripOsRuntimeGeneration: "captured-runtime",
    });
    expect(surfaceWorktreeId(surface, desktop)).toBe("linux");
  });
  it("allows an explicitly resolved Host desktop", () => {
    expect(
      surfaceOsFilePlacement(surface, { ...desktop, osSource: undefined }),
    ).toEqual({});
    expect(surfaceOsFilePlacement(undefined)).toEqual({});
    expect(
      surfaceOsFilePlacement({
        kind: "unresolved",
        entity: null,
      } as ProjectSurface),
    ).toBeNull();
  });
});
