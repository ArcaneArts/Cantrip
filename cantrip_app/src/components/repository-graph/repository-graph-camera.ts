import type {
  RepositoryGraphBounds,
  RepositoryGraphPoint,
} from "./repository-graph-model";

export type RepositoryGraphViewport = {
  height: number;
  width: number;
};

export type RepositoryGraphCamera = {
  centerX: number;
  centerY: number;
  rotation: number;
  scale: number;
};

export const REPOSITORY_GRAPH_MIN_SCALE = 0.08;
export const REPOSITORY_GRAPH_MAX_SCALE = 8;

export function defaultRepositoryGraphCamera(): RepositoryGraphCamera {
  return { centerX: 0, centerY: 0, rotation: 0, scale: 1 };
}

export function clampRepositoryGraphScale(scale: number): number {
  return Math.min(
    REPOSITORY_GRAPH_MAX_SCALE,
    Math.max(REPOSITORY_GRAPH_MIN_SCALE, scale),
  );
}

export function repositoryGraphWorldToScreen(
  point: RepositoryGraphPoint,
  camera: RepositoryGraphCamera,
  viewport: RepositoryGraphViewport,
): RepositoryGraphPoint {
  const x = (point.x - camera.centerX) * camera.scale;
  const y = (point.y - camera.centerY) * camera.scale;
  const cosine = Math.cos(camera.rotation);
  const sine = Math.sin(camera.rotation);
  return {
    x: viewport.width / 2 + x * cosine - y * sine,
    y: viewport.height / 2 + x * sine + y * cosine,
  };
}

export function repositoryGraphScreenToWorld(
  point: RepositoryGraphPoint,
  camera: RepositoryGraphCamera,
  viewport: RepositoryGraphViewport,
): RepositoryGraphPoint {
  const x = point.x - viewport.width / 2;
  const y = point.y - viewport.height / 2;
  const cosine = Math.cos(-camera.rotation);
  const sine = Math.sin(-camera.rotation);
  return {
    x: camera.centerX + (x * cosine - y * sine) / camera.scale,
    y: camera.centerY + (x * sine + y * cosine) / camera.scale,
  };
}

export function panRepositoryGraphCamera(
  camera: RepositoryGraphCamera,
  delta: RepositoryGraphPoint,
): RepositoryGraphCamera {
  const cosine = Math.cos(-camera.rotation);
  const sine = Math.sin(-camera.rotation);
  return {
    ...camera,
    centerX:
      camera.centerX - (delta.x * cosine - delta.y * sine) / camera.scale,
    centerY:
      camera.centerY - (delta.x * sine + delta.y * cosine) / camera.scale,
  };
}

export function zoomRepositoryGraphCameraAt(
  camera: RepositoryGraphCamera,
  factor: number,
  screenPoint: RepositoryGraphPoint,
  viewport: RepositoryGraphViewport,
): RepositoryGraphCamera {
  const worldBefore = repositoryGraphScreenToWorld(
    screenPoint,
    camera,
    viewport,
  );
  const next = {
    ...camera,
    scale: clampRepositoryGraphScale(camera.scale * factor),
  };
  const worldAfter = repositoryGraphScreenToWorld(screenPoint, next, viewport);
  return {
    ...next,
    centerX: next.centerX + worldBefore.x - worldAfter.x,
    centerY: next.centerY + worldBefore.y - worldAfter.y,
  };
}

export function rotateRepositoryGraphCameraAt(
  camera: RepositoryGraphCamera,
  deltaRadians: number,
  screenPoint: RepositoryGraphPoint,
  viewport: RepositoryGraphViewport,
): RepositoryGraphCamera {
  const worldBefore = repositoryGraphScreenToWorld(
    screenPoint,
    camera,
    viewport,
  );
  const next = { ...camera, rotation: camera.rotation + deltaRadians };
  const worldAfter = repositoryGraphScreenToWorld(screenPoint, next, viewport);
  return {
    ...next,
    centerX: next.centerX + worldBefore.x - worldAfter.x,
    centerY: next.centerY + worldBefore.y - worldAfter.y,
  };
}

export function fitRepositoryGraphCamera(
  bounds: RepositoryGraphBounds,
  viewport: RepositoryGraphViewport,
  options: { padding?: number; rotation?: number } = {},
): RepositoryGraphCamera {
  const padding = Math.max(0, options.padding ?? 40);
  const rotation = options.rotation ?? 0;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const cosine = Math.abs(Math.cos(rotation));
  const sine = Math.abs(Math.sin(rotation));
  const rotatedWidth = width * cosine + height * sine;
  const rotatedHeight = width * sine + height * cosine;
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    rotation,
    scale: clampRepositoryGraphScale(
      Math.min(availableWidth / rotatedWidth, availableHeight / rotatedHeight),
    ),
  };
}

export function repositoryGraphViewportWorldBounds(
  camera: RepositoryGraphCamera,
  viewport: RepositoryGraphViewport,
): RepositoryGraphBounds {
  const corners = [
    { x: 0, y: 0 },
    { x: viewport.width, y: 0 },
    { x: viewport.width, y: viewport.height },
    { x: 0, y: viewport.height },
  ].map((point) => repositoryGraphScreenToWorld(point, camera, viewport));
  return {
    maxX: Math.max(...corners.map((point) => point.x)),
    maxY: Math.max(...corners.map((point) => point.y)),
    minX: Math.min(...corners.map((point) => point.x)),
    minY: Math.min(...corners.map((point) => point.y)),
  };
}

export function resetRepositoryGraphRotation(
  camera: RepositoryGraphCamera,
): RepositoryGraphCamera {
  return { ...camera, rotation: 0 };
}
