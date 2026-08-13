import type { ExplorerSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  MAX_RETAINED_EXPLORER_VIEWS,
  retainExplorerSurfaceTabs,
} from "./persistent-explorer-views";

function explorer(id: string): ExplorerSummary {
  return { id, title: id } as ExplorerSummary;
}

describe("retainExplorerSurfaceTabs", () => {
  it("keeps an existing Explorer mounted and moves it to the MRU end", () => {
    expect(
      retainExplorerSurfaceTabs(
        [explorer("one"), explorer("two")],
        explorer("one"),
      ).map(({ id }) => id),
    ).toEqual(["two", "one"]);
  });

  it("bounds clean retained views without evicting the active Explorer", () => {
    const retained = Array.from(
      { length: MAX_RETAINED_EXPLORER_VIEWS },
      (_, index) => explorer(String(index)),
    );
    const next = retainExplorerSurfaceTabs(retained, explorer("active"));

    expect(next).toHaveLength(MAX_RETAINED_EXPLORER_VIEWS);
    expect(next.at(-1)?.id).toBe("active");
    expect(next.some(({ id }) => id === "0")).toBe(false);
  });

  it("retains dirty inactive editors beyond the normal memory bound", () => {
    const retained = Array.from(
      { length: MAX_RETAINED_EXPLORER_VIEWS },
      (_, index) => explorer(String(index)),
    );
    const dirtyIds = new Set(retained.map(({ id }) => id));
    const next = retainExplorerSurfaceTabs(
      retained,
      explorer("active"),
      dirtyIds,
    );

    expect(next).toHaveLength(MAX_RETAINED_EXPLORER_VIEWS + 1);
    expect(next.map(({ id }) => id)).toContain("0");
    expect(next.at(-1)?.id).toBe("active");
  });
});
