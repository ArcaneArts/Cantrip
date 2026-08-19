import { describe, expect, it } from "vitest";

import {
  DEFAULT_GIT_GRAPH_STATE,
  gitGraphStorageKey,
  hasStoredGitGraphState,
  parseGitGraphState,
  readGitGraphState,
  writeGitGraphState,
} from "./git-graph-state";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("Git graph persisted state", () => {
  it("round trips camera, dimensions, focus, and selection per worktree", () => {
    const storage = memoryStorage();
    const state = {
      camera: { centerX: 12, centerY: -4, rotation: 8.2, scale: 2.5 },
      colorDimension: "churn" as const,
      focusedNodeId: "directory:src",
      selectedNodeId: "file:src/app.ts",
      sizeDimension: "commits" as const,
    };
    writeGitGraphState("project", "worktree", state, storage);
    expect(hasStoredGitGraphState("project", "worktree", storage)).toBe(true);
    expect(readGitGraphState("project", "worktree", storage)).toEqual(state);
    expect(gitGraphStorageKey("project", "other")).not.toBe(
      gitGraphStorageKey("project", "worktree"),
    );
  });

  it("sanitizes corrupt values and clamps unsafe zoom", () => {
    expect(
      parseGitGraphState({
        camera: {
          centerX: Number.NaN,
          centerY: "bad",
          rotation: Number.POSITIVE_INFINITY,
          scale: 100_000,
        },
        colorDimension: "nope",
        focusedNodeId: 1,
        selectedNodeId: false,
        sizeDimension: "wrong",
      }),
    ).toEqual({
      ...DEFAULT_GIT_GRAPH_STATE,
      camera: { centerX: 0, centerY: 0, rotation: 0, scale: 8 },
    });
  });

  it("falls back when storage is disabled or contains malformed JSON", () => {
    const storage = memoryStorage();
    storage.setItem(gitGraphStorageKey("p", "w"), "{");
    expect(readGitGraphState("p", "w", storage)).toEqual(
      DEFAULT_GIT_GRAPH_STATE,
    );
  });
});
