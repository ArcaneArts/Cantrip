import type { CodeTabSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  MAX_RETAINED_CODE_VIEWS,
  retainCodeSurfaceTabs,
} from "./persistent-code-views";

function codeTab(id: string): CodeTabSummary {
  return { id, title: id } as CodeTabSummary;
}

describe("retainCodeSurfaceTabs", () => {
  it("keeps an existing surface mounted and moves it to the MRU end", () => {
    expect(
      retainCodeSurfaceTabs(
        [codeTab("one"), codeTab("two")],
        codeTab("one"),
      ).map(({ id }) => id),
    ).toEqual(["two", "one"]);
  });

  it("bounds retained workbenches without evicting the active surface", () => {
    const retained = Array.from(
      { length: MAX_RETAINED_CODE_VIEWS },
      (_, index) => codeTab(String(index)),
    );
    const next = retainCodeSurfaceTabs(retained, codeTab("active"));

    expect(next).toHaveLength(MAX_RETAINED_CODE_VIEWS);
    expect(next.at(-1)?.id).toBe("active");
    expect(next.some(({ id }) => id === "0")).toBe(false);
  });
});
