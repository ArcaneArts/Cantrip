import { describe, expect, it } from "vitest";

import {
  styledMenuContentClassName,
  styledMenuItemClassName,
} from "./styled-menu";

describe("styled menu classes", () => {
  it("applies shared popover chrome and consumer sizing", () => {
    const className = styledMenuContentClassName("min-w-52");

    expect(className).toContain("bg-popover");
    expect(className).toContain("shadow-lg");
    expect(className).toContain("min-w-52");
  });

  it("applies shared interaction states and consumer intent", () => {
    const defaultClassName = styledMenuItemClassName();
    const destructiveClassName = styledMenuItemClassName(
      "text-destructive focus:bg-destructive/10",
    );

    expect(defaultClassName).toContain("focus:bg-accent");
    expect(defaultClassName).toContain("data-[disabled]:opacity-50");
    expect(destructiveClassName).toContain("text-destructive");
    expect(destructiveClassName).toContain("focus:bg-destructive/10");
  });
});
