import {
  clampRepositoryGraphScale,
  defaultRepositoryGraphCamera,
  type RepositoryGraphCamera,
} from "@/components/repository-graph";

import type {
  GitGraphColorDimension,
  GitGraphSizeDimension,
} from "./git-graph-model";

export type GitGraphPersistedState = {
  camera: RepositoryGraphCamera;
  colorDimension: GitGraphColorDimension;
  focusedNodeId: string | null;
  selectedNodeId: string | null;
  sizeDimension: GitGraphSizeDimension;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export const DEFAULT_GIT_GRAPH_STATE: GitGraphPersistedState = {
  camera: defaultRepositoryGraphCamera(),
  colorDimension: "language",
  focusedNodeId: null,
  selectedNodeId: null,
  sizeDimension: "lines",
};

const SIZE_DIMENSIONS = new Set<GitGraphSizeDimension>([
  "equal",
  "lines",
  "bytes",
  "commits",
  "churn",
]);
const COLOR_DIMENSIONS = new Set<GitGraphColorDimension>([
  "language",
  "commits",
  "churn",
  "last-change",
  "creation-age",
  "blame-owner",
  "blame-age",
]);

export function gitGraphStorageKey(projectId: string, worktreeId: string) {
  return `cantrip.git-graph.v1:${projectId}:${worktreeId}`;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseGitGraphState(value: unknown): GitGraphPersistedState {
  if (!value || typeof value !== "object") return DEFAULT_GIT_GRAPH_STATE;
  const input = value as Record<string, unknown>;
  const cameraInput =
    input.camera && typeof input.camera === "object"
      ? (input.camera as Record<string, unknown>)
      : {};
  const sizeDimension = SIZE_DIMENSIONS.has(
    input.sizeDimension as GitGraphSizeDimension,
  )
    ? (input.sizeDimension as GitGraphSizeDimension)
    : DEFAULT_GIT_GRAPH_STATE.sizeDimension;
  const colorDimension = COLOR_DIMENSIONS.has(
    input.colorDimension as GitGraphColorDimension,
  )
    ? (input.colorDimension as GitGraphColorDimension)
    : DEFAULT_GIT_GRAPH_STATE.colorDimension;
  return {
    camera: {
      centerX: finite(cameraInput.centerX, 0),
      centerY: finite(cameraInput.centerY, 0),
      rotation: finite(cameraInput.rotation, 0),
      scale: clampRepositoryGraphScale(finite(cameraInput.scale, 1)),
    },
    colorDimension,
    focusedNodeId:
      typeof input.focusedNodeId === "string" ? input.focusedNodeId : null,
    selectedNodeId:
      typeof input.selectedNodeId === "string" ? input.selectedNodeId : null,
    sizeDimension,
  };
}

export function readGitGraphState(
  projectId: string,
  worktreeId: string,
  storage: StorageLike | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): GitGraphPersistedState {
  if (!storage) return DEFAULT_GIT_GRAPH_STATE;
  try {
    const stored = storage.getItem(gitGraphStorageKey(projectId, worktreeId));
    return stored
      ? parseGitGraphState(JSON.parse(stored))
      : DEFAULT_GIT_GRAPH_STATE;
  } catch {
    return DEFAULT_GIT_GRAPH_STATE;
  }
}

export function hasStoredGitGraphState(
  projectId: string,
  worktreeId: string,
  storage: StorageLike | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(gitGraphStorageKey(projectId, worktreeId)) !== null;
  } catch {
    return false;
  }
}

export function writeGitGraphState(
  projectId: string,
  worktreeId: string,
  state: GitGraphPersistedState,
  storage: StorageLike | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      gitGraphStorageKey(projectId, worktreeId),
      JSON.stringify(parseGitGraphState(state)),
    );
  } catch {
    // Persistence is a convenience; a disabled or full storage area must not
    // make the graph unusable.
  }
}
