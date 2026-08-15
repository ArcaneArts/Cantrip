import { describe, expect, it, vi } from "vitest";

import {
  closeTabOnMiddleClick,
  preventMiddleMouseDefault,
} from "./tab-middle-click";

describe("tab middle-click handling", () => {
  it("closes and consumes a middle-button auxiliary click", () => {
    const event = {
      button: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const close = vi.fn();

    expect(closeTabOnMiddleClick(event, close)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("leaves other mouse buttons alone", () => {
    const event = {
      button: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const close = vi.fn();

    expect(closeTabOnMiddleClick(event, close)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("suppresses the middle-button mouse-down default", () => {
    const middle = { button: 1, preventDefault: vi.fn() };
    const primary = { button: 0, preventDefault: vi.fn() };

    expect(preventMiddleMouseDefault(middle)).toBe(true);
    expect(middle.preventDefault).toHaveBeenCalledOnce();
    expect(preventMiddleMouseDefault(primary)).toBe(false);
    expect(primary.preventDefault).not.toHaveBeenCalled();
  });
});
