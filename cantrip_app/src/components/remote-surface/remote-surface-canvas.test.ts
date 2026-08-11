import { describe, expect, it, vi } from "vitest";

import { RemoteSurfaceFrameRenderer } from "./remote-surface-canvas";

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
