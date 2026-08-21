import { describe, expect, it } from "vitest";

import {
  DIALOG_CONTENT_CLASS_NAME,
  DIALOG_OVERLAY_CLASS_NAME,
  DIALOG_POSITIONER_CLASS_NAME,
} from "./dialog";

describe("dialog rendering", () => {
  it("centers content without compositing text through transforms", () => {
    expect(DIALOG_POSITIONER_CLASS_NAME).toContain("place-items-center");
    expect(DIALOG_CONTENT_CLASS_NAME).not.toMatch(
      /animate|translate|zoom|transform/u,
    );
  });

  it("keeps the layout click-through outside interactive content", () => {
    expect(DIALOG_POSITIONER_CLASS_NAME).toContain("pointer-events-none");
    expect(DIALOG_CONTENT_CLASS_NAME).toContain("pointer-events-auto");
  });

  it("unmounts the pointer-active overlay immediately when closed", () => {
    expect(DIALOG_OVERLAY_CLASS_NAME).toContain(
      "data-[state=open]:animate-in",
    );
    expect(DIALOG_OVERLAY_CLASS_NAME).not.toContain("data-[state=closed]");
  });
});
