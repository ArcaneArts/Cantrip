import { describe, expect, it } from "vitest";

import { parseDesktopTabDragPreview } from "./desktop-window-coordinator";

describe("desktop tab drag previews", () => {
  it("parses a bounded native preview route", () => {
    expect(
      parseDesktopTabDragPreview(
        "?cantrip-tab-drag-preview=1&kind=terminal&theme=dark&title=Shell",
      ),
    ).toEqual({ kind: "terminal", theme: "dark", title: "Shell" });
  });

  it("does not claim ordinary application routes", () => {
    expect(parseDesktopTabDragPreview("?project=one")).toBeNull();
    expect(
      parseDesktopTabDragPreview("?cantrip-tab-drag-preview=1&kind=chat"),
    ).toBeNull();
  });
});
