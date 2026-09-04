import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";

import { DockResizeControl } from "./dock-resize-control";

it("exposes pointer, keyboard, and double-click dock restoration controls", async () => {
  const onDoubleClick = vi.fn();
  const onKeyChange = vi.fn();
  const onPointerBegin = vi.fn();
  const onPointerMove = vi.fn();
  const onPointerEnd = vi.fn();
  const onPointerCancel = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(DockResizeControl, {
        direction: "vertical",
        fraction: 0.95,
        label: "Right dock size",
        mode: "full",
        onDoubleClick,
        onKeyChange,
        onPointerBegin,
        onPointerCancel,
        onPointerEnd,
        onPointerMove,
        style: {},
      }),
    );
  });
  const separator = renderer.root.findByProps({ role: "separator" });
  const pointerEvent = { pointerId: 7 };
  const preventDefault = vi.fn();

  separator.props.onDoubleClick();
  separator.props.onKeyDown({ key: "Enter", preventDefault });
  separator.props.onPointerDown(pointerEvent);
  separator.props.onPointerMove(pointerEvent);
  separator.props.onPointerUp(pointerEvent);
  separator.props.onPointerCancel(pointerEvent);

  expect(onDoubleClick).toHaveBeenCalledOnce();
  expect(onKeyChange).toHaveBeenCalledWith("Enter");
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(onPointerBegin).toHaveBeenCalledWith(pointerEvent);
  expect(onPointerMove).toHaveBeenCalledWith(pointerEvent);
  expect(onPointerEnd).toHaveBeenCalledWith(pointerEvent);
  expect(onPointerCancel).toHaveBeenCalledWith(pointerEvent);
  expect(separator.props["aria-valuetext"]).toBe("Right dock size full view");

  await act(async () => renderer.unmount());
});
