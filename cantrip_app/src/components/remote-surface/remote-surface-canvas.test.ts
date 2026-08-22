import { describe, expect, it, vi } from "vitest";

import {
  RemoteSurfaceFrameRenderer,
  REMOTE_SURFACE_MOBILE_INPUT_SENTINEL,
  RemoteSurfaceTouchPointerTracker,
  RemoteSurfaceTouchTapTracker,
  remoteSurfaceMobileInputAction,
  type RemoteSurfaceTouchPointerEvent,
} from "./remote-surface-canvas";

describe("remoteSurfaceMobileInputAction", () => {
  it("extracts inserted text without leaking the input sentinel", () => {
    expect(
      remoteSurfaceMobileInputAction(
        "insertText",
        `${REMOTE_SURFACE_MOBILE_INPUT_SENTINEL}hello`,
      ),
    ).toEqual({ type: "text", text: "hello" });
    expect(
      remoteSurfaceMobileInputAction(
        "insertText",
        REMOTE_SURFACE_MOBILE_INPUT_SENTINEL,
      ),
    ).toBeNull();
  });

  it("maps mobile editing operations to remote control keys", () => {
    expect(remoteSurfaceMobileInputAction("deleteContentBackward", "")).toEqual(
      { type: "key", key: "Backspace", code: "Backspace" },
    );
    expect(remoteSurfaceMobileInputAction("deleteContentForward", "")).toEqual({
      type: "key",
      key: "Delete",
      code: "Delete",
    });
    expect(remoteSurfaceMobileInputAction("insertLineBreak", "\n")).toEqual({
      type: "key",
      key: "Enter",
      code: "Enter",
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function bitmap(value: number) {
  return {
    close: vi.fn(),
    height: value + 10,
    width: value,
  };
}

function canvas() {
  return { height: 0, width: 0 } as HTMLCanvasElement;
}

function touchPointer(
  pointerId: number,
  clientX: number,
  clientY: number,
): RemoteSurfaceTouchPointerEvent {
  return {
    altKey: false,
    clientX,
    clientY,
    ctrlKey: false,
    height: 8,
    metaKey: false,
    pointerId,
    pressure: 0.5,
    shiftKey: false,
    width: 6,
  };
}

describe("RemoteSurfaceFrameRenderer", () => {
  it("renders ordered browser frames without dropping them", async () => {
    const target = canvas();
    const drawn: number[] = [];
    const onRendered = vi.fn();
    let now = 1_000;
    const renderer = new RemoteSurfaceFrameRenderer({
      policy: "ordered",
      getCanvas: () => target,
      decodeFrame: async (bytes) => {
        now += 2;
        return bitmap(bytes[0]!);
      },
      drawFrame: (_canvas, frame) => drawn.push(frame.width),
      now: () => now,
      onError: vi.fn(),
      onRendered,
    });
    renderer.push(new Uint8Array([1]));
    renderer.push(new Uint8Array([2]));
    renderer.push(new Uint8Array([3]));
    await vi.waitFor(() => expect(onRendered).toHaveBeenCalledTimes(3));
    expect(drawn).toEqual([1, 2, 3]);
    now = 2_000;
    expect(renderer.takeFeedback()).toEqual({
      intervalMs: 1_000,
      receivedFrames: 3,
      renderedFrames: 3,
      droppedFrames: 0,
      averageDecodeMs: 2,
    });
  });

  it("keeps only the latest pending desktop frame", async () => {
    const first = deferred<ReturnType<typeof bitmap>>();
    const target = canvas();
    const drawn: number[] = [];
    const onRendered = vi.fn();
    const renderer = new RemoteSurfaceFrameRenderer({
      policy: "latest",
      getCanvas: () => target,
      decodeFrame: (bytes) =>
        bytes[0] === 1 ? first.promise : Promise.resolve(bitmap(bytes[0]!)),
      drawFrame: (_canvas, frame) => drawn.push(frame.width),
      onError: vi.fn(),
      onRendered,
    });
    renderer.push(new Uint8Array([1]));
    renderer.push(new Uint8Array([2]));
    renderer.push(new Uint8Array([3]));
    first.resolve(bitmap(1));
    await vi.waitFor(() => expect(onRendered).toHaveBeenCalledTimes(2));
    expect(drawn).toEqual([1, 3]);
    expect(renderer.takeFeedback()).toMatchObject({
      receivedFrames: 3,
      renderedFrames: 2,
      droppedFrames: 1,
    });
  });

  it("discards a decoded frame after reset", async () => {
    const pending = deferred<ReturnType<typeof bitmap>>();
    const stale = bitmap(9);
    const drawFrame = vi.fn();
    const onRendered = vi.fn();
    const renderer = new RemoteSurfaceFrameRenderer({
      policy: "ordered",
      getCanvas: canvas,
      decodeFrame: () => pending.promise,
      drawFrame,
      onError: vi.fn(),
      onRendered,
    });
    renderer.push(new Uint8Array([9]));
    renderer.reset();
    pending.resolve(stale);
    await vi.waitFor(() => expect(stale.close).toHaveBeenCalledOnce());
    expect(drawFrame).not.toHaveBeenCalled();
    expect(onRendered).not.toHaveBeenCalled();
  });

  it("reports decode failures and recovers for the next frame", async () => {
    const onError = vi.fn();
    const onRendered = vi.fn();
    const renderer = new RemoteSurfaceFrameRenderer({
      policy: "ordered",
      getCanvas: canvas,
      decodeFrame: async (bytes) => {
        if (bytes[0] === 1) throw new Error("bad jpeg");
        return bitmap(bytes[0]!);
      },
      drawFrame: vi.fn(),
      onError,
      onRendered,
    });
    renderer.push(new Uint8Array([1]));
    renderer.push(new Uint8Array([2]));
    await vi.waitFor(() => expect(onRendered).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("RemoteSurfaceTouchTapTracker", () => {
  it("accepts a stationary single-pointer tap", () => {
    const tracker = new RemoteSurfaceTouchTapTracker();
    expect(tracker.input(touchPointer(7, 60, 170), "down")).toBe(false);
    expect(tracker.input(touchPointer(7, 66, 176), "move")).toBe(false);
    expect(tracker.input(touchPointer(7, 66, 176), "up")).toBe(true);
  });

  it("rejects drag, cancellation, and multi-pointer gestures", () => {
    const tracker = new RemoteSurfaceTouchTapTracker();
    tracker.input(touchPointer(1, 10, 10), "down");
    tracker.input(touchPointer(1, 30, 10), "move");
    expect(tracker.input(touchPointer(1, 30, 10), "up")).toBe(false);

    tracker.input(touchPointer(2, 10, 10), "down");
    expect(tracker.input(touchPointer(2, 10, 10), "cancel")).toBe(false);

    tracker.input(touchPointer(3, 10, 10), "down");
    tracker.input(touchPointer(4, 20, 20), "down");
    expect(tracker.input(touchPointer(3, 10, 10), "up")).toBe(false);
    expect(tracker.input(touchPointer(4, 20, 20), "up")).toBe(false);
  });
});

describe("RemoteSurfaceTouchPointerTracker", () => {
  const bounds = { height: 200, left: 10, top: 20, width: 100 };
  const target = { height: 1_000, width: 500 };

  it("encodes a captured touch pointer drag as one remote touch gesture", () => {
    const tracker = new RemoteSurfaceTouchPointerTracker();
    expect(
      tracker.input(touchPointer(7, 60, 170), "down", bounds, target),
    ).toMatchObject({
      event: "start",
      points: [{ force: 0.5, id: 7, radiusX: 3, radiusY: 4, x: 250, y: 750 }],
    });
    expect(
      tracker.input(touchPointer(7, 60, 70), "move", bounds, target),
    ).toMatchObject({
      event: "move",
      points: [{ id: 7, x: 250, y: 250 }],
    });
    expect(
      tracker.input(touchPointer(7, 60, 70), "up", bounds, target),
    ).toMatchObject({ event: "end", points: [] });
    expect(
      tracker.input(touchPointer(7, 60, 60), "move", bounds, target),
    ).toBeNull();
  });

  it("clears an interrupted pointer gesture", () => {
    const tracker = new RemoteSurfaceTouchPointerTracker();
    tracker.input(touchPointer(4, 30, 40), "down", bounds, target);
    expect(
      tracker.input(touchPointer(4, 30, 40), "cancel", bounds, target),
    ).toMatchObject({ event: "cancel", points: [] });
    expect(
      tracker.input(touchPointer(4, 30, 30), "move", bounds, target),
    ).toBeNull();
  });
});
