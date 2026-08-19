import {
  panRepositoryGraphCamera,
  rotateRepositoryGraphCameraAt,
  zoomRepositoryGraphCameraAt,
  type RepositoryGraphCamera,
  type RepositoryGraphViewport,
} from "./repository-graph-camera";
import type { RepositoryGraphPoint } from "./repository-graph-model";

export type RepositoryGraphGesturePointer = RepositoryGraphPoint & {
  id: number;
};

export type RepositoryGraphGestureCallbacks = {
  getCamera(): RepositoryGraphCamera;
  getViewport(): RepositoryGraphViewport;
  setCamera(camera: RepositoryGraphCamera): void;
};

type PairGesture = {
  angle: number;
  distance: number;
  midpoint: RepositoryGraphPoint;
};

function pairGesture(
  first: RepositoryGraphPoint,
  second: RepositoryGraphPoint,
): PairGesture {
  return {
    angle: Math.atan2(second.y - first.y, second.x - first.x),
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    midpoint: {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    },
  };
}

function shortestAngleDelta(next: number, previous: number): number {
  let delta = next - previous;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export class RepositoryGraphGestureController {
  readonly #callbacks: RepositoryGraphGestureCallbacks;
  readonly #pointers = new Map<number, RepositoryGraphPoint>();
  #pair: PairGesture | null = null;

  constructor(callbacks: RepositoryGraphGestureCallbacks) {
    this.#callbacks = callbacks;
  }

  pointerDown(pointer: RepositoryGraphGesturePointer): void {
    this.#pointers.set(pointer.id, { x: pointer.x, y: pointer.y });
    this.#pair = this.currentPair();
  }

  pointerMove(pointer: RepositoryGraphGesturePointer): boolean {
    const previous = this.#pointers.get(pointer.id);
    if (!previous) return false;
    this.#pointers.set(pointer.id, { x: pointer.x, y: pointer.y });
    if (this.#pointers.size === 1) {
      this.#callbacks.setCamera(
        panRepositoryGraphCamera(this.#callbacks.getCamera(), {
          x: pointer.x - previous.x,
          y: pointer.y - previous.y,
        }),
      );
      return true;
    }

    const nextPair = this.currentPair();
    const previousPair = this.#pair;
    this.#pair = nextPair;
    if (!nextPair || !previousPair) return false;

    let camera = panRepositoryGraphCamera(this.#callbacks.getCamera(), {
      x: nextPair.midpoint.x - previousPair.midpoint.x,
      y: nextPair.midpoint.y - previousPair.midpoint.y,
    });
    camera = zoomRepositoryGraphCameraAt(
      camera,
      nextPair.distance / previousPair.distance,
      nextPair.midpoint,
      this.#callbacks.getViewport(),
    );
    camera = rotateRepositoryGraphCameraAt(
      camera,
      shortestAngleDelta(nextPair.angle, previousPair.angle),
      nextPair.midpoint,
      this.#callbacks.getViewport(),
    );
    this.#callbacks.setCamera(camera);
    return true;
  }

  pointerUp(pointerId: number): void {
    this.#pointers.delete(pointerId);
    this.#pair = this.currentPair();
  }

  cancel(): void {
    this.#pointers.clear();
    this.#pair = null;
  }

  get activePointerCount(): number {
    return this.#pointers.size;
  }

  private currentPair(): PairGesture | null {
    if (this.#pointers.size < 2) return null;
    const [first, second] = [...this.#pointers.values()];
    return first && second ? pairGesture(first, second) : null;
  }
}
