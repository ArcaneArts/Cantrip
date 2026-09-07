import { describe, expect, it, vi } from "vitest";
import { listenForMouseBack } from "./use-mouse-back";

function mouse(target: EventTarget, type: string, button = 3) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "button", { value: button });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("fullscreen mouse Back", () => {
  it("returns once and suppresses the rest of the gesture after the screen closes", () => {
    const target = new EventTarget();
    let active = true;
    const back = vi.fn(() => {
      active = false;
    });
    const cleanup = listenForMouseBack(target, () => (active ? back : null));
    for (const type of ["mousedown", "mouseup", "auxclick"]) {
      expect(mouse(target, type)).toBe(true);
    }
    expect(back).toHaveBeenCalledTimes(1);
    expect(mouse(target, "mousedown")).toBe(false);
    cleanup();
  });
  it.each([0, 1, 2, 4])("leaves mouse button %i alone", (button) => {
    const target = new EventTarget();
    const back = vi.fn();
    const cleanup = listenForMouseBack(target, () => back);
    for (const type of ["mousedown", "mouseup", "auxclick"])
      expect(mouse(target, type, button)).toBe(false);
    expect(back).not.toHaveBeenCalled();
    cleanup();
  });
  it("reads the current return action and removes listeners on cleanup", () => {
    const target = new EventTarget();
    const first = vi.fn();
    const second = vi.fn();
    let back: (() => void) | null = null;
    const cleanup = listenForMouseBack(target, () => back);
    expect(mouse(target, "mousedown")).toBe(false);
    back = first;
    mouse(target, "mousedown");
    back = second;
    mouse(target, "mouseup");
    mouse(target, "auxclick");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    cleanup();
    expect(mouse(target, "mousedown")).toBe(false);
  });
});
