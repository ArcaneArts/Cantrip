import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NativeFolderRevealIcon,
  useShiftKeyHeld,
} from "./native-folder-reveal-icon";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
});

function modifierEvent(type: string, shiftKey: boolean): Event {
  const event = new Event(type);
  Object.defineProperty(event, "shiftKey", { value: shiftKey });
  return event;
}

function ShiftState() {
  return createElement("span", null, useShiftKeyHeld() ? "local" : "network");
}

describe("native folder reveal modifier", () => {
  it("uses a folder root icon only for direct local-folder reveals", () => {
    const network = renderToStaticMarkup(
      <NativeFolderRevealIcon localFolder={false} />,
    );
    const local = renderToStaticMarkup(<NativeFolderRevealIcon localFolder />);

    expect(network).toContain('data-native-folder-reveal="network"');
    expect(network).toContain("lucide-folder-open");
    expect(local).toContain('data-native-folder-reveal="local"');
    expect(local).toContain("lucide-folder-root");
  });

  it("tracks Shift presses and releases while reveal controls are mounted", async () => {
    const windowTarget = new EventTarget();
    vi.stubGlobal("window", windowTarget);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShiftState));
    });

    expect(renderer.root.findByType("span").children).toEqual(["network"]);
    await act(async () => {
      windowTarget.dispatchEvent(modifierEvent("keydown", true));
    });
    expect(renderer.root.findByType("span").children).toEqual(["local"]);
    await act(async () => {
      windowTarget.dispatchEvent(modifierEvent("keyup", false));
    });
    expect(renderer.root.findByType("span").children).toEqual(["network"]);

    await act(async () => renderer.unmount());
  });
});
