// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = { invoke: vi.fn() };
import { confirmEditorAction } from "./editor-confirmation";

beforeEach(() => {
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal("__TAURI_INTERNALS__", native);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("editor confirmation", () => {
  it.each([
    ["Ok", true],
    ["Cancel", false],
  ])(
    "uses the registered native message command for %s",
    async (answer, expected) => {
      native.invoke.mockResolvedValue(answer);
      const legacy = vi.spyOn(window, "confirm");
      await expect(confirmEditorAction("Discard draft?")).resolves.toBe(
        expected,
      );
      expect(native.invoke).toHaveBeenCalledWith(
        "plugin:dialog|message",
        expect.objectContaining({
          message: "Discard draft?",
          buttons: "OkCancel",
        }),
        undefined,
      );
      expect(legacy).not.toHaveBeenCalled();
    },
  );
  it("propagates a native failure without approving or using the broken shim", async () => {
    native.invoke.mockRejectedValue(new Error("dialog unavailable"));
    const legacy = vi.spyOn(window, "confirm");
    await expect(confirmEditorAction("Discard?")).rejects.toThrow(
      "dialog unavailable",
    );
    expect(legacy).not.toHaveBeenCalled();
  });
  it("uses browser confirmation outside Tauri", async () => {
    vi.stubGlobal("isTauri", false);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await expect(confirmEditorAction("Discard?")).resolves.toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
