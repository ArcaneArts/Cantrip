import { describe, expect, it } from "vitest";

import {
  fitRepositoryGraphCamera,
  panRepositoryGraphCamera,
  repositoryGraphScreenToWorld,
  repositoryGraphWorldToScreen,
  resetRepositoryGraphRotation,
  rotateRepositoryGraphCameraAt,
  zoomRepositoryGraphCameraAt,
  type RepositoryGraphCamera,
} from "./repository-graph-camera";

const viewport = { height: 600, width: 800 };

describe("repository graph camera", () => {
  it("round trips points through translated, scaled, and rotated cameras", () => {
    const camera: RepositoryGraphCamera = {
      centerX: 45,
      centerY: -12,
      rotation: 1.17,
      scale: 2.4,
    };
    const world = { x: 123, y: 456 };
    const screen = repositoryGraphWorldToScreen(world, camera, viewport);
    const restored = repositoryGraphScreenToWorld(screen, camera, viewport);
    expect(restored.x).toBeCloseTo(world.x, 8);
    expect(restored.y).toBeCloseTo(world.y, 8);
  });

  it("keeps the focal world point fixed while zooming and rotating", () => {
    const camera: RepositoryGraphCamera = {
      centerX: 10,
      centerY: 20,
      rotation: 0.3,
      scale: 1.2,
    };
    const focus = { x: 117, y: 222 };
    const before = repositoryGraphScreenToWorld(focus, camera, viewport);
    const zoomed = zoomRepositoryGraphCameraAt(camera, 2, focus, viewport);
    const rotated = rotateRepositoryGraphCameraAt(zoomed, 0.8, focus, viewport);
    const after = repositoryGraphScreenToWorld(focus, rotated, viewport);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
    expect(rotated.rotation).toBeCloseTo(1.1);
  });

  it("fits bounds, pans in screen space, and resets only orientation", () => {
    const fitted = fitRepositoryGraphCamera(
      { maxX: 100, maxY: 50, minX: -100, minY: -50 },
      viewport,
      { padding: 50, rotation: Math.PI / 2 },
    );
    expect(fitted.centerX).toBe(0);
    expect(fitted.centerY).toBe(0);
    expect(fitted.scale).toBeGreaterThan(0);
    const panned = panRepositoryGraphCamera(fitted, { x: 40, y: -20 });
    expect(panned.centerX).not.toBe(fitted.centerX);
    expect(panned.centerY).not.toBe(fitted.centerY);
    expect(resetRepositoryGraphRotation(panned)).toEqual({
      ...panned,
      rotation: 0,
    });
  });

  it("fits broad repository layouts below the old overview zoom floor", () => {
    const fitted = fitRepositoryGraphCamera(
      { maxX: 5_000, maxY: 5_000, minX: -5_000, minY: -5_000 },
      viewport,
      { padding: 50 },
    );
    expect(fitted.scale).toBeCloseTo(0.05);
    expect(fitted.scale).toBeLessThan(0.08);
  });
});
