import { describe, expect, it } from "vitest";

import { permissionProfileLabel } from "./permission-profile-control";

describe("permissionProfileLabel", () => {
  it("labels built-in profiles and preserves useful custom ids", () => {
    expect(permissionProfileLabel(":read-only")).toBe("Read only");
    expect(permissionProfileLabel(":danger-full-access")).toBe("Full access");
    expect(permissionProfileLabel(":team-safe")).toBe("team-safe");
  });
});
