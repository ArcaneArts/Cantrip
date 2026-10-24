import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  label: "popout",
  close: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => native,
}));
import { closeRetiredWorkspaceWindow } from "./desktop-popout";
beforeEach(() => {
  native.label = "popout";
  native.close.mockClear();
});

it("closes the actual retired native popout", async () => {
  await closeRetiredWorkspaceWindow("popout");
  expect(native.close).toHaveBeenCalledOnce();
});
it("cannot close a different native window by label", async () => {
  await expect(closeRetiredWorkspaceWindow("another")).rejects.toThrow(
    "not this native window",
  );
  expect(native.close).not.toHaveBeenCalled();
});
it("never closes the main host", async () => {
  native.label = "main";
  await expect(closeRetiredWorkspaceWindow("main")).rejects.toThrow(
    "not this native window",
  );
  expect(native.close).not.toHaveBeenCalled();
});
