// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodeEditorSettings } from "@/components/settings/code-editor-settings";
import {
  readCodeEditorLineNumbers,
  saveCodeEditorLineNumbers,
  useCodeEditorLineNumbers,
} from "./code-editor-preferences";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const key = "cantrip:code-editor-line-numbers:v1";
beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("defaults on and preserves saved choices", () => {
  expect(readCodeEditorLineNumbers()).toBe(true);
  saveCodeEditorLineNumbers(false);
  expect(readCodeEditorLineNumbers()).toBe(false);
  expect(window.localStorage.getItem(key)).toBe("false");
  saveCodeEditorLineNumbers(true);
  expect(readCodeEditorLineNumbers()).toBe(true);
});

it("updates mounted settings and consumers for local changes and another window's storage event", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  function Consumer() {
    return <output>{String(useCodeEditorLineNumbers())}</output>;
  }
  try {
    await act(async () =>
      root.render(
        <>
          <CodeEditorSettings />
          <Consumer />
        </>,
      ),
    );
    const checkbox = node.querySelector("input")!;
    expect(checkbox.checked).toBe(true);
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(false);
    expect(node.querySelector("output")!.textContent).toBe("false");
    await act(async () => {
      window.localStorage.setItem(key, "true");
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: "true" }),
      );
    });
    expect(checkbox.checked).toBe(true);
    expect(node.querySelector("output")!.textContent).toBe("true");
    await act(async () => {
      window.localStorage.setItem(key, "false");
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: "false" }),
      );
    });
    expect(checkbox.checked).toBe(false);
    await act(async () => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(checkbox.checked).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps the default and shows an error if the preference cannot be saved", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  try {
    await act(async () => root.render(<CodeEditorSettings />));
    await act(async () => node.querySelector("input")!.click());
    expect(node.querySelector("input")!.checked).toBe(true);
    expect(node.querySelector('[role="alert"]')!.textContent).toContain(
      "Could not save",
    );
  } finally {
    await act(async () => root.unmount());
  }
});
