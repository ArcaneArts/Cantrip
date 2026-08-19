import { describe, expect, it } from "vitest";

import {
  defaultRepositoryGraphCamera,
  type RepositoryGraphCamera,
} from "./repository-graph-camera";
import { RepositoryGraphGestureController } from "./repository-graph-gestures";

function controller() {
  let camera = defaultRepositoryGraphCamera();
  const gestures = new RepositoryGraphGestureController({
    getCamera: () => camera,
    getViewport: () => ({ height: 600, width: 800 }),
    setCamera: (next) => {
      camera = next;
    },
  });
  return {
    camera: () => camera,
    gestures,
    setCamera: (next: RepositoryGraphCamera) => {
      camera = next;
    },
  };
}

describe("repository graph gestures", () => {
  it("pans with one pointer", () => {
    const state = controller();
    state.gestures.pointerDown({ id: 1, x: 100, y: 100 });
    expect(state.gestures.pointerMove({ id: 1, x: 130, y: 90 })).toBe(true);
    expect(state.camera().centerX).toBeCloseTo(-30);
    expect(state.camera().centerY).toBeCloseTo(10);
    state.gestures.pointerUp(1);
    expect(state.gestures.activePointerCount).toBe(0);
  });

  it("combines two-pointer pan, pinch zoom, and unrestricted twist", () => {
    const state = controller();
    state.gestures.pointerDown({ id: 1, x: 100, y: 100 });
    state.gestures.pointerDown({ id: 2, x: 200, y: 100 });
    state.gestures.pointerMove({ id: 1, x: 80, y: 80 });
    state.gestures.pointerMove({ id: 2, x: 240, y: 160 });

    expect(state.camera().scale).toBeGreaterThan(1);
    expect(Math.abs(state.camera().rotation)).toBeGreaterThan(0.1);
    expect(Math.abs(state.camera().centerX)).toBeGreaterThan(0);
    expect(Math.abs(state.camera().centerY)).toBeGreaterThan(0);

    const rotation = state.camera().rotation;
    state.gestures.pointerMove({ id: 1, x: 220, y: 220 });
    state.gestures.pointerMove({ id: 2, x: 100, y: 20 });
    expect(state.camera().rotation).not.toBe(rotation);
  });

  it("cancels every active pointer without changing the camera", () => {
    const state = controller();
    state.gestures.pointerDown({ id: 1, x: 10, y: 10 });
    const before = state.camera();
    state.gestures.cancel();
    expect(state.gestures.activePointerCount).toBe(0);
    expect(state.camera()).toEqual(before);
  });
});
