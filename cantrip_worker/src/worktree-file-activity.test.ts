import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityPath,
  boundedFileChanges,
  commitFileChanges,
  WorktreeFileActivity,
} from "./worktree-file-activity.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("worktree file activity", () => {
  it("does not mistake parent-directory notifications for another file edit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-file-activity-"));
    roots.push(root);
    await mkdir(path.join(root, "src"));
    const activity = new WorktreeFileActivity(
      root,
      async () => "src/existing.ts\0",
    );
    await activity.initialize();
    await writeFile(path.join(root, "src/new.ts"), "new");
    activity.record("src");
    activity.record("src/new.ts");
    expect(await activity.flush()).toEqual([
      { path: "src/new.ts", kind: "added" },
    ]);
  });
  it("ignores Git metadata and paths outside the worktree", () => {
    for (const file of [
      ".git/HEAD",
      "../private",
      "/absolute",
      "C:\\private",
      "nested/.git/index",
    ])
      expect(activityPath(file)).toBeNull();
    expect(activityPath("src\\hello world.ts")).toBe("src/hello world.ts");
  });
  it("classifies adds, repeated edits, atomic saves, and deletions without temporary-file noise", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-file-activity-"));
    roots.push(root);
    await writeFile(path.join(root, "existing.ts"), "before");
    const activity = new WorktreeFileActivity(
      root,
      async () => "existing.ts\0",
    );
    await activity.initialize();
    expect(await activity.flush()).toEqual([]);
    await writeFile(path.join(root, "new.ts"), "new");
    activity.record("new.ts");
    activity.record("new.ts");
    activity.record("existing.ts");
    expect(await activity.flush()).toEqual([
      { path: "new.ts", kind: "added" },
      { path: "existing.ts", kind: "modified" },
    ]);
    await writeFile(path.join(root, "new.ts"), "changed");
    activity.record("new.ts");
    expect(await activity.flush()).toEqual([
      { path: "new.ts", kind: "modified" },
    ]);
    await rm(path.join(root, "existing.ts"));
    await writeFile(path.join(root, "existing.ts"), "atomic replacement");
    activity.record("existing.ts");
    expect(await activity.flush()).toEqual([
      { path: "existing.ts", kind: "modified" },
    ]);
    await rm(path.join(root, "new.ts"));
    activity.record("new.ts");
    activity.record("temporary.tmp");
    expect(await activity.flush()).toEqual([
      { path: "new.ts", kind: "deleted" },
    ]);
  });
  it("reports every file in a new commit, but never flashes the initial snapshot or an empty commit", async () => {
    const git = vi.fn(
      async () => "A\0new file.ts\0M\0src/app.ts\0D\0old\nfile.ts\0",
    );
    const activity = new WorktreeFileActivity("/repo", git);
    expect(await activity.observeHead("a".repeat(40))).toEqual([]);
    expect(await activity.observeHead("b".repeat(40))).toEqual([
      { path: "new file.ts", kind: "added" },
      { path: "src/app.ts", kind: "modified" },
      { path: "old\nfile.ts", kind: "deleted" },
    ]);
    expect(git).toHaveBeenCalledWith([
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      "a".repeat(40),
      "b".repeat(40),
      "--",
    ]);
    expect(await activity.observeHead("b".repeat(40))).toEqual([]);
    git.mockResolvedValue("");
    expect(await activity.observeHead("c".repeat(40))).toEqual([]);
  });
  it("bounds large batches and parses NUL-delimited names", () => {
    expect(commitFileChanges("D\0old name\0A\0new name\0")).toEqual([
      { path: "old name", kind: "deleted" },
      { path: "new name", kind: "added" },
    ]);
    expect(
      boundedFileChanges(
        Array.from({ length: 2100 }, (_, i) => ({
          path: `file-${i}`,
          kind: "modified" as const,
        })),
      ),
    ).toHaveLength(2000);
    const changes = boundedFileChanges(
      Array.from({ length: 2000 }, (_, i) => ({
        path: `${i}-` + "a".repeat(8000),
        kind: "modified" as const,
      })),
    );
    expect(Buffer.byteLength(JSON.stringify(changes))).toBeLessThanOrEqual(
      256 * 1024,
    );
  });
});
