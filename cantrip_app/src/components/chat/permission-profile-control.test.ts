import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PermissionProfileControl,
  permissionProfileLabel,
} from "./permission-profile-control";

describe("permissionProfileLabel", () => {
  it("labels built-in profiles and preserves useful custom ids", () => {
    expect(permissionProfileLabel(":read-only")).toBe("Read only");
    expect(permissionProfileLabel(":danger-full-access")).toBe("Full access");
    expect(permissionProfileLabel(":yolo")).toBe("YOLO mode");
    expect(permissionProfileLabel(":team-safe")).toBe("team-safe");
  });

  it("renders a compact icon trigger instead of a native select", () => {
    const markup = renderToStaticMarkup(
      createElement(PermissionProfileControl, {
        pending: false,
        state: {
          available: true,
          profiles: [
            {
              id: ":workspace",
              description: "Workspace writes",
              allowed: true,
            },
            {
              id: ":yolo",
              description: "Unrestricted access without approval prompts",
              allowed: true,
            },
          ],
          selectedId: ":workspace",
          effectiveId: ":workspace",
          defaultId: ":workspace",
          usesDefault: false,
          forcedByWorktreePolicy: false,
          reason: null,
        },
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain("Agent permissions: Workspace");
    expect(markup).not.toContain("<select");
  });

  it("keeps the permission menu available while Codex starts", () => {
    const markup = renderToStaticMarkup(
      createElement(PermissionProfileControl, {
        pending: true,
        state: undefined,
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain("Agent permissions: Permissions");
    expect(markup).not.toContain(' disabled=""');
  });
});
