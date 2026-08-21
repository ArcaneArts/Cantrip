import { describe, expect, it } from "vitest";

import { confirmDialogAllowsOpenChange } from "./confirm-dialog";

describe("ConfirmDialog", () => {
  it("allows opening and idle closing", () => {
    expect(confirmDialogAllowsOpenChange(true, false)).toBe(true);
    expect(confirmDialogAllowsOpenChange(false, false)).toBe(true);
  });

  it("blocks every close request while the action is pending", () => {
    expect(confirmDialogAllowsOpenChange(false, true)).toBe(false);
  });
});
