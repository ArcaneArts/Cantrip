import { describe, expect, it } from "vitest";
import {
  projectSourceLocationSchema,
  cantripOsGuestPathSchema,
  cantripOsDependencyOverlaySchema,
} from "./cantrip-os.js";

describe("CantripOS source addressing", () => {
  it("keeps Linux locations separate from worker-local path contracts", () => {
    expect(
      projectSourceLocationSchema.parse({
        kind: "cantrip-os",
        instanceId: "instance",
        workspaceId: "workspace",
        guestPath: "/projects/source",
      }).kind,
    ).toBe("cantrip-os");
    expect(
      projectSourceLocationSchema.safeParse({
        kind: "worker-local",
        guestPath: "/projects/source",
      }).success,
    ).toBe(false);
    expect(
      projectSourceLocationSchema.safeParse({
        kind: "cantrip-os",
        workerPath: "/projects/source",
        instanceId: "instance",
        workspaceId: "workspace",
      }).success,
    ).toBe(false);
  });

  it("accepts literal Linux filenames without accepting relative guest roots", () => {
    expect(cantripOsGuestPathSchema.parse("/projects/a #b%/file")).toBe(
      "/projects/a #b%/file",
    );
    expect(cantripOsGuestPathSchema.safeParse("projects/source").success).toBe(
      false,
    );
    expect(cantripOsGuestPathSchema.safeParse("C:\\source").success).toBe(
      false,
    );
    expect(cantripOsGuestPathSchema.safeParse("/projects/a\0b").success).toBe(
      false,
    );
  });

  it("accepts explicitly selected dependency paths, including ignored directories", () => {
    for (const path of [
      "node_modules",
      ".venv",
      "packages/app/node_modules",
      ".cache/build",
    ])
      expect(cantripOsDependencyOverlaySchema.parse({ path }).path).toBe(path);
    for (const path of [
      "",
      "/node_modules",
      "../node_modules",
      "a/../b",
      ".git/objects",
    ])
      expect(cantripOsDependencyOverlaySchema.safeParse({ path }).success).toBe(
        false,
      );
  });
});
