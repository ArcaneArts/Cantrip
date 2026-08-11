import { describe, expect, it } from "vitest";

import { errorMessage } from "./error-message";

describe("errorMessage", () => {
  it("returns an Error message", () => {
    expect(errorMessage(new Error("Connection lost"))).toBe("Connection lost");
  });

  it("uses the default fallback for non-Error values", () => {
    expect(errorMessage("Connection lost")).toBe("Something went wrong.");
  });

  it("uses a caller-provided fallback for non-Error values", () => {
    expect(errorMessage({ reason: "offline" }, "Worker unavailable.")).toBe(
      "Worker unavailable.",
    );
  });

  it("preserves an explicitly empty Error message", () => {
    expect(errorMessage(new Error(""), "Fallback")).toBe("");
  });
});
