import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyGitPartialPatch,
  applyGitStashAction,
  createGitStash,
  previewGitPartialPatch,
  previewGitStashAction,
  readGitCommitDetail,
  readGitComparison,
  readGitFileDiff,
  readGitHistory,
  readGitRevisionFileDiff,
  readGitRevisionCandidates,
  readGitStatus,
  readGitStashes,
  readGitStashFileDiff,
  runGitAction,
} from "../src/git.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Git history", () => {
  it("creates, lists, previews, applies, and drops scoped stashes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "staged.txt"), "base\n");
    await writeFile(path.join(directory, "working.txt"), "base\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);

    await writeFile(path.join(directory, "staged.txt"), "staged\n");
    await execFileAsync("git", ["-C", directory, "add", "staged.txt"]);
    await writeFile(path.join(directory, "working.txt"), "working\n");
    await writeFile(path.join(directory, "untracked.txt"), "untracked\n");
    const created = await createGitStash(directory, {
      message: "Working shelf",
      includeStaged: false,
      includeUnstaged: true,
      includeUntracked: true,
    });
    expect(created.stash).toMatchObject({
      message: "Working shelf",
      includesUntracked: true,
    });
    expect(created.stash?.files.map(({ path }) => path).sort()).toEqual([
      "untracked.txt",
      "working.txt",
    ]);
    expect(await readFile(path.join(directory, "working.txt"), "utf8")).toBe(
      "base\n",
    );
    await expect(
      readFile(path.join(directory, "untracked.txt")),
    ).rejects.toThrow();
    expect((await readGitStatus(directory)).files).toEqual([
      expect.objectContaining({ path: "staged.txt", staged: true }),
    ]);

    const untrackedDiff = await readGitStashFileDiff(
      directory,
      created.stash!.hash,
      "untracked.txt",
    );
    expect(untrackedDiff.patch).toContain("+untracked");
    const applyAction = {
      type: "apply" as const,
      ref: created.stash!.ref,
      hash: created.stash!.hash,
    };
    const applyPreview = await previewGitStashAction(directory, applyAction);
    expect(applyPreview.destructive).toBe(false);
    expect(applyPreview.warnings).toHaveLength(1);
    const applied = await applyGitStashAction(
      directory,
      applyAction,
      applyPreview.token,
    );
    expect(applied.conflictedPaths).toEqual([]);
    expect(await readFile(path.join(directory, "working.txt"), "utf8")).toBe(
      "working\n",
    );
    expect(await readFile(path.join(directory, "untracked.txt"), "utf8")).toBe(
      "untracked\n",
    );

    const dropAction = {
      type: "drop" as const,
      ref: created.stash!.ref,
      hash: created.stash!.hash,
    };
    const dropPreview = await previewGitStashAction(directory, dropAction);
    expect(dropPreview.destructive).toBe(true);
    await applyGitStashAction(directory, dropAction, dropPreview.token);
    expect((await readGitStashes(directory)).stashes).toEqual([]);
    await execFileAsync("git", ["-C", directory, "reset", "--hard", "HEAD"]);
    await execFileAsync("git", ["-C", directory, "clean", "-fd"]);
    await expect(
      createGitStash(directory, {
        message: "Nothing",
        includeStaged: true,
        includeUnstaged: false,
        includeUntracked: false,
      }),
    ).rejects.toThrow(/did not create|no local changes/u);
    await expect(
      readGitStashFileDiff(directory, created.stash!.hash, "../secret"),
    ).rejects.toThrow(/invalid stash diff path/iu);
  });

  it("keeps conflicted stashes recoverable and rejects stale clear previews", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "conflict.txt"), "base\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);

    await writeFile(path.join(directory, "conflict.txt"), "stash\n");
    const stash = (
      await createGitStash(directory, {
        message: "Conflict shelf",
        includeStaged: true,
        includeUnstaged: true,
        includeUntracked: false,
      })
    ).stash!;
    await writeFile(path.join(directory, "conflict.txt"), "branch\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Diverge"]);
    const popAction = {
      type: "pop" as const,
      ref: stash.ref,
      hash: stash.hash,
    };
    const popPreview = await previewGitStashAction(directory, popAction);
    const result = await applyGitStashAction(
      directory,
      popAction,
      popPreview.token,
    );
    expect(result.conflictedPaths).toEqual(["conflict.txt"]);
    expect((await readGitStashes(directory)).stashes).toEqual([
      expect.objectContaining({ hash: stash.hash }),
    ]);

    await execFileAsync("git", ["-C", directory, "reset", "--hard", "HEAD"]);
    const clearAction = { type: "clear" as const };
    const stalePreview = await previewGitStashAction(directory, clearAction);
    await writeFile(path.join(directory, "second.txt"), "second\n");
    await createGitStash(directory, {
      message: "Second shelf",
      includeStaged: true,
      includeUnstaged: true,
      includeUntracked: true,
    });
    await expect(
      applyGitStashAction(directory, clearAction, stalePreview.token),
    ).rejects.toThrow(/no longer match/u);
    const clearPreview = await previewGitStashAction(directory, clearAction);
    await applyGitStashAction(directory, clearAction, clearPreview.token);
    expect((await readGitStashes(directory)).stashes).toEqual([]);
  });

  it("creates staged-only stashes and branches from their base", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "staged.txt"), "base\n");
    await writeFile(path.join(directory, "working.txt"), "base\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);

    await writeFile(path.join(directory, "staged.txt"), "staged\n");
    await execFileAsync("git", ["-C", directory, "add", "staged.txt"]);
    await writeFile(path.join(directory, "working.txt"), "working\n");
    const stash = (
      await createGitStash(directory, {
        message: "Staged shelf",
        includeStaged: true,
        includeUnstaged: false,
        includeUntracked: false,
      })
    ).stash!;
    expect(stash.files.map(({ path }) => path)).toEqual(["staged.txt"]);
    expect(await readFile(path.join(directory, "working.txt"), "utf8")).toBe(
      "working\n",
    );
    expect((await readGitStatus(directory)).files).toEqual([
      expect.objectContaining({ path: "working.txt", unstaged: true }),
    ]);

    await execFileAsync("git", ["-C", directory, "reset", "--hard", "HEAD"]);
    const branchAction = {
      type: "branch" as const,
      ref: stash.ref,
      hash: stash.hash,
      branch: "from-stash",
    };
    const preview = await previewGitStashAction(directory, branchAction);
    const result = await applyGitStashAction(
      directory,
      branchAction,
      preview.token,
    );
    expect(result.status.branch).toBe("from-stash");
    expect(await readFile(path.join(directory, "staged.txt"), "utf8")).toBe(
      "staged\n",
    );
    expect((await readGitStashes(directory)).stashes).toEqual([]);
  });

  it("previews and applies exact line selections for stage, unstage, and discard", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    const filePath = path.join(directory, "lines.txt");
    await writeFile(filePath, "one\ntwo\nthree\nfour\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);
    await writeFile(filePath, "one\nTWO\nthree\nFOUR\n");

    const lineSelection = async (
      scope: "staged" | "unstaged",
      values: string[],
    ) => {
      const patch = (await readGitFileDiff(directory, "lines.txt", scope))
        .patch;
      const lines = patch.split("\n");
      const hunkStart = lines.findIndex((line) => line.startsWith("@@ "));
      return {
        hunkIndex: 0,
        lineIndexes: values.map((value) => {
          const index = lines.findIndex(
            (line, candidate) => candidate > hunkStart && line === value,
          );
          expect(index).toBeGreaterThan(hunkStart);
          return index - hunkStart - 1;
        }),
      };
    };

    const stageRequest = {
      operation: "stage" as const,
      path: "lines.txt",
      hunks: [await lineSelection("unstaged", ["-two", "+TWO"])],
    };
    const stagePreview = await previewGitPartialPatch(directory, stageRequest);
    expect(stagePreview.patch).toContain("+TWO");
    expect(stagePreview.patch).not.toContain("+FOUR");
    let result = await applyGitPartialPatch(
      directory,
      stageRequest,
      stagePreview.token,
    );
    expect(result.status.files[0]).toMatchObject({
      staged: true,
      unstaged: true,
    });
    expect(
      (await readGitFileDiff(directory, "lines.txt", "staged")).patch,
    ).toContain("+TWO");
    expect(
      (await readGitFileDiff(directory, "lines.txt", "staged")).patch,
    ).not.toContain("+FOUR");

    const unstageRequest = {
      operation: "unstage" as const,
      path: "lines.txt",
      hunks: [await lineSelection("staged", ["-two", "+TWO"])],
    };
    const unstagePreview = await previewGitPartialPatch(
      directory,
      unstageRequest,
    );
    result = await applyGitPartialPatch(
      directory,
      unstageRequest,
      unstagePreview.token,
    );
    expect(result.status.files[0]).toMatchObject({
      staged: false,
      unstaged: true,
    });

    const discardRequest = {
      operation: "discard" as const,
      path: "lines.txt",
      hunks: [await lineSelection("unstaged", ["-four", "+FOUR"])],
    };
    const discardPreview = await previewGitPartialPatch(
      directory,
      discardRequest,
    );
    expect(discardPreview.patch).toContain("+FOUR");
    result = await applyGitPartialPatch(
      directory,
      discardRequest,
      discardPreview.token,
    );
    expect(await readFile(filePath, "utf8")).toBe("one\nTWO\nthree\nfour\n");
    expect(result.status.files[0]).toMatchObject({
      staged: false,
      unstaged: true,
    });

    const stalePreview = await previewGitPartialPatch(directory, {
      operation: "stage",
      path: "lines.txt",
      hunks: [{ hunkIndex: 0, lineIndexes: null }],
    });
    await writeFile(filePath, "one\nTWO again\nthree\nfour\n");
    await expect(
      applyGitPartialPatch(
        directory,
        {
          operation: "stage",
          path: "lines.txt",
          hunks: [{ hunkIndex: 0, lineIndexes: null }],
        },
        stalePreview.token,
      ),
    ).rejects.toThrow(/no longer match/u);
  });

  it("partially stages new and deleted files and preserves no-newline markers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "deleted.txt"), "keep\nremove\n");
    await writeFile(path.join(directory, "marker.txt"), "before\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);

    await writeFile(path.join(directory, "new.txt"), "first\nsecond\n");
    const newPatch = await readGitFileDiff(directory, "new.txt", "unstaged");
    const newLines = newPatch.patch.split("\n");
    const newHunk = newLines.findIndex((line) => line.startsWith("@@ "));
    const secondLine = newLines.findIndex(
      (line, index) => index > newHunk && line === "+second",
    );
    const newRequest = {
      operation: "stage" as const,
      path: "new.txt",
      hunks: [{ hunkIndex: 0, lineIndexes: [secondLine - newHunk - 1] }],
    };
    const newPreview = await previewGitPartialPatch(directory, newRequest);
    await applyGitPartialPatch(directory, newRequest, newPreview.token);
    const stagedNew = await execFileAsync("git", [
      "-C",
      directory,
      "show",
      ":new.txt",
    ]);
    expect(stagedNew.stdout).toBe("second\n");
    expect((await readGitStatus(directory)).files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "new.txt",
          staged: true,
          unstaged: true,
        }),
      ]),
    );

    await rm(path.join(directory, "deleted.txt"));
    const deletedPatch = await readGitFileDiff(
      directory,
      "deleted.txt",
      "unstaged",
    );
    const deletedLines = deletedPatch.patch.split("\n");
    const deletedHunk = deletedLines.findIndex((line) =>
      line.startsWith("@@ "),
    );
    const removeLine = deletedLines.findIndex(
      (line, index) => index > deletedHunk && line === "-remove",
    );
    const deleteRequest = {
      operation: "stage" as const,
      path: "deleted.txt",
      hunks: [{ hunkIndex: 0, lineIndexes: [removeLine - deletedHunk - 1] }],
    };
    const deletePreview = await previewGitPartialPatch(
      directory,
      deleteRequest,
    );
    await applyGitPartialPatch(directory, deleteRequest, deletePreview.token);
    const stagedDeleted = await execFileAsync("git", [
      "-C",
      directory,
      "show",
      ":deleted.txt",
    ]);
    expect(stagedDeleted.stdout).toBe("keep\n");
    expect((await readGitStatus(directory)).files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "deleted.txt",
          staged: true,
          unstaged: true,
        }),
      ]),
    );

    await writeFile(path.join(directory, "marker.txt"), "after");
    const markerRequest = {
      operation: "stage" as const,
      path: "marker.txt",
      hunks: [{ hunkIndex: 0, lineIndexes: null }],
    };
    const markerPreview = await previewGitPartialPatch(
      directory,
      markerRequest,
    );
    expect(markerPreview.patch).toContain("\\ No newline at end of file");
    await applyGitPartialPatch(directory, markerRequest, markerPreview.token);
    const stagedMarker = await execFileAsync("git", [
      "-C",
      directory,
      "show",
      ":marker.txt",
    ]);
    expect(stagedMarker.stdout).toBe("after");
  });

  it("partially unstages and discards new and deleted files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "deleted.txt"), "first\nsecond\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);
    const selectedLine = async (
      path: string,
      scope: "staged" | "unstaged",
      text: string,
    ) => {
      const lines = (await readGitFileDiff(directory, path, scope)).patch.split(
        "\n",
      );
      const hunk = lines.findIndex((line) => line.startsWith("@@ "));
      const line = lines.findIndex(
        (candidate, index) => index > hunk && candidate === text,
      );
      expect(line).toBeGreaterThan(hunk);
      return { hunkIndex: 0, lineIndexes: [line - hunk - 1] };
    };

    await writeFile(path.join(directory, "new.txt"), "first\nsecond\n");
    await execFileAsync("git", ["-C", directory, "add", "new.txt"]);
    const unstageNew = {
      operation: "unstage" as const,
      path: "new.txt",
      hunks: [await selectedLine("new.txt", "staged", "+second")],
    };
    let preview = await previewGitPartialPatch(directory, unstageNew);
    await applyGitPartialPatch(directory, unstageNew, preview.token);
    expect(
      (await execFileAsync("git", ["-C", directory, "show", ":new.txt"]))
        .stdout,
    ).toBe("first\n");

    await execFileAsync("git", ["-C", directory, "reset", "--", "new.txt"]);
    const discardNew = {
      operation: "discard" as const,
      path: "new.txt",
      hunks: [await selectedLine("new.txt", "unstaged", "+first")],
    };
    preview = await previewGitPartialPatch(directory, discardNew);
    await applyGitPartialPatch(directory, discardNew, preview.token);
    expect(await readFile(path.join(directory, "new.txt"), "utf8")).toBe(
      "second\n",
    );

    await rm(path.join(directory, "deleted.txt"));
    await execFileAsync("git", ["-C", directory, "add", "deleted.txt"]);
    const unstageDeleted = {
      operation: "unstage" as const,
      path: "deleted.txt",
      hunks: [await selectedLine("deleted.txt", "staged", "-first")],
    };
    preview = await previewGitPartialPatch(directory, unstageDeleted);
    await applyGitPartialPatch(directory, unstageDeleted, preview.token);
    expect(
      (await execFileAsync("git", ["-C", directory, "show", ":deleted.txt"]))
        .stdout,
    ).toBe("first\n");

    await execFileAsync("git", ["-C", directory, "reset", "--hard", "HEAD"]);
    await rm(path.join(directory, "deleted.txt"));
    const discardDeleted = {
      operation: "discard" as const,
      path: "deleted.txt",
      hunks: [await selectedLine("deleted.txt", "unstaged", "-second")],
    };
    preview = await previewGitPartialPatch(directory, discardDeleted);
    await applyGitPartialPatch(directory, discardDeleted, preview.token);
    expect(await readFile(path.join(directory, "deleted.txt"), "utf8")).toBe(
      "second\n",
    );
  });

  it("rejects partial binary, rename, and mode-only metadata changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "rename.txt"), "rename me\n");
    await writeFile(path.join(directory, "mode.sh"), "#!/bin/sh\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);

    await writeFile(path.join(directory, "image.bin"), Buffer.from([0, 1, 2]));
    await expect(
      previewGitPartialPatch(directory, {
        operation: "stage",
        path: "image.bin",
        hunks: [{ hunkIndex: 0, lineIndexes: null }],
      }),
    ).rejects.toThrow(/binary|no selectable/u);

    await execFileAsync("git", [
      "-C",
      directory,
      "mv",
      "rename.txt",
      "renamed.txt",
    ]);
    await expect(
      previewGitPartialPatch(directory, {
        operation: "unstage",
        path: "renamed.txt",
        hunks: [{ hunkIndex: 0, lineIndexes: null }],
      }),
    ).rejects.toThrow(/rename|metadata|no selectable/u);

    await execFileAsync("chmod", ["+x", path.join(directory, "mode.sh")]);
    await expect(
      previewGitPartialPatch(directory, {
        operation: "stage",
        path: "mode.sh",
        hunks: [{ hunkIndex: 0, lineIndexes: null }],
      }),
    ).rejects.toThrow(/mode|no selectable/u);
  });

  it("lists commit refs and compares direct and merge-base revision ranges", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "base.txt"), "base\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Base"]);
    const base = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await execFileAsync("git", ["-C", directory, "switch", "-c", "feature"]);
    await writeFile(path.join(directory, "feature.txt"), "feature\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", [
      "-C",
      directory,
      "commit",
      "-m",
      "Feature work",
    ]);
    const feature = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await execFileAsync("git", [
      "-C",
      directory,
      "tag",
      "-a",
      "v1",
      "-m",
      "Version one",
    ]);
    await execFileAsync("git", ["-C", directory, "switch", "main"]);
    await writeFile(path.join(directory, "main.txt"), "main\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Main work"]);
    const main = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();

    const candidates = await readGitRevisionCandidates(directory);
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "HEAD", hash: main, kind: "head" }),
        expect.objectContaining({
          name: "main",
          hash: main,
          kind: "local",
          current: true,
        }),
        expect.objectContaining({
          name: "feature",
          hash: feature,
          kind: "local",
        }),
        expect.objectContaining({ name: "v1", hash: feature, kind: "tag" }),
      ]),
    );

    const direct = await readGitComparison(directory, feature, main, "direct");
    expect(direct).toMatchObject({
      left: feature,
      right: main,
      mergeBase: base,
      diffBase: feature,
      leftAhead: 1,
      rightAhead: 1,
      filesChanged: 2,
    });
    expect(direct.leftCommits[0]?.subject).toBe("Feature work");
    expect(direct.rightCommits[0]?.subject).toBe("Main work");
    expect(direct.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "feature.txt", status: "deleted" }),
        expect.objectContaining({ path: "main.txt", status: "added" }),
      ]),
    );

    const mergeBase = await readGitComparison(
      directory,
      feature,
      main,
      "merge-base",
    );
    expect(mergeBase).toMatchObject({
      mergeBase: base,
      diffBase: base,
      filesChanged: 1,
    });
    expect(mergeBase.files[0]).toMatchObject({
      path: "main.txt",
      status: "added",
    });
    await expect(
      readGitComparison(directory, "f".repeat(40), main, "direct"),
    ).rejects.toThrow(/does not exist/u);

    await execFileAsync("git", [
      "-C",
      directory,
      "switch",
      "--orphan",
      "unrelated",
    ]);
    await writeFile(path.join(directory, "unrelated.txt"), "unrelated\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Unrelated"]);
    const unrelated = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(
      await readGitComparison(directory, main, unrelated, "direct"),
    ).toMatchObject({ mergeBase: null, diffBase: main });
    await expect(
      readGitComparison(directory, main, unrelated, "merge-base"),
    ).rejects.toThrow(/do not share a merge base/u);
  });

  it("inspects root, merge, renamed, deleted, and binary commit changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "README.md"), "Cantrip\n");
    await writeFile(
      path.join(directory, "image.bin"),
      Buffer.from([0, 1, 2, 3, 0, 255]),
    );
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", [
      "-C",
      directory,
      "commit",
      "-m",
      "Initial history",
      "-m",
      "A multiline body for the root commit.",
    ]);
    const rootHash = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    const root = await readGitCommitDetail(directory, rootHash);
    expect(root).toMatchObject({
      hash: rootHash,
      parents: [],
      parentIndex: null,
      baseHash: null,
      messageTruncated: false,
      signature: { status: "unsigned" },
      filesChanged: 2,
    });
    expect(root.message).toContain("A multiline body");
    expect(root.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "README.md",
          status: "added",
          additions: 1,
          deletions: 0,
          binary: false,
        }),
        expect.objectContaining({
          path: "image.bin",
          status: "added",
          additions: null,
          deletions: null,
          binary: true,
        }),
      ]),
    );
    const rootPatch = await readGitRevisionFileDiff(
      directory,
      rootHash,
      null,
      "README.md",
    );
    expect(rootPatch.patch).toContain("+Cantrip");

    await execFileAsync("git", ["-C", directory, "switch", "-c", "feature"]);
    await execFileAsync("git", [
      "-C",
      directory,
      "mv",
      "README.md",
      "GUIDE.md",
    ]);
    await execFileAsync("git", ["-C", directory, "rm", "image.bin"]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Move docs"]);
    const featureHash = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    const feature = await readGitCommitDetail(directory, featureHash);
    expect(feature.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "GUIDE.md",
          originalPath: "README.md",
          status: "renamed",
        }),
        expect.objectContaining({ path: "image.bin", status: "deleted" }),
      ]),
    );
    const renamedPatch = await readGitRevisionFileDiff(
      directory,
      featureHash,
      rootHash,
      "GUIDE.md",
    );
    expect(renamedPatch.originalPath).toBe("README.md");
    expect(renamedPatch.patch).toContain("rename from README.md");

    await execFileAsync("git", ["-C", directory, "switch", "main"]);
    await writeFile(path.join(directory, "main.txt"), "main\n");
    await execFileAsync("git", ["-C", directory, "add", "main.txt"]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Main work"]);
    const mainParent = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await execFileAsync("git", [
      "-C",
      directory,
      "merge",
      "--no-ff",
      "feature",
      "-m",
      "Merge feature",
    ]);
    const mergeHash = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    const mergeFirstParent = await readGitCommitDetail(directory, mergeHash, 0);
    const mergeSecondParent = await readGitCommitDetail(
      directory,
      mergeHash,
      1,
    );
    expect(mergeFirstParent.parents).toEqual([mainParent, featureHash]);
    expect(mergeFirstParent.baseHash).toBe(mainParent);
    expect(mergeSecondParent.baseHash).toBe(featureHash);
    expect(
      (await readGitCommitDetail(directory, mainParent)).children,
    ).toContain(mergeHash);
    await expect(readGitCommitDetail(directory, mergeHash, 2)).rejects.toThrow(
      /does not have parent 3/u,
    );
    await expect(
      readGitRevisionFileDiff(directory, mergeHash, mainParent, "../secret"),
    ).rejects.toThrow(/Invalid Git diff path/u);
  });

  it("returns branch and commit metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "README.md"), "Cantrip\n");
    await execFileAsync("git", ["-C", directory, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      directory,
      "commit",
      "-m",
      "Initial history",
    ]);

    const history = await readGitHistory(directory, 20);
    expect(history.branch).toBe("main");
    expect(history.head).toBe(history.commits[0]?.hash);
    expect(history.totalCount).toBe(1);
    expect(history.hasMore).toBe(false);
    expect(history.commits[0]).toMatchObject({
      subject: "Initial history",
      authorName: "Cantrip Test",
      authorEmail: "test@cantrip.art",
      parents: [],
      isHead: true,
    });
    expect(history.commits[0]?.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "HEAD", kind: "head", current: true }),
        expect.objectContaining({ name: "main", kind: "local", current: true }),
      ]),
    );
  });

  it("paginates commits from every branch", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "README.md"), "one\n");
    await execFileAsync("git", ["-C", directory, "add", "README.md"]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "First"]);
    await execFileAsync("git", ["-C", directory, "switch", "-c", "feature"]);
    await writeFile(path.join(directory, "README.md"), "two\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Feature"]);
    await execFileAsync("git", ["-C", directory, "switch", "main"]);

    const firstPage = await readGitHistory(directory, 1);
    const secondPage = await readGitHistory(
      directory,
      1,
      firstPage.nextCursor!,
    );
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.totalCount).toBe(2);
    expect(secondPage.totalCount).toBe(2);
    expect(firstPage.nextCursor).toBe(1);
    expect(
      [...firstPage.commits, ...secondPage.commits].map(
        (commit) => commit.subject,
      ),
    ).toEqual(["Feature", "First"]);
  });

  it("includes explicitly supplied detached worktree revisions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "README.md"), "main\n");
    await execFileAsync("git", ["-C", directory, "add", "README.md"]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Main"]);
    await execFileAsync("git", ["-C", directory, "switch", "--detach"]);
    await writeFile(path.join(directory, "README.md"), "detached\n");
    await execFileAsync("git", [
      "-C",
      directory,
      "commit",
      "-am",
      "Detached worktree",
    ]);
    const { stdout } = await execFileAsync("git", [
      "-C",
      directory,
      "rev-parse",
      "HEAD",
    ]);
    const detachedHead = stdout.trim();
    await execFileAsync("git", ["-C", directory, "switch", "main"]);

    const withoutDetached = await readGitHistory(directory, 20);
    expect(withoutDetached.commits.map(({ hash }) => hash)).not.toContain(
      detachedHead,
    );
    const withDetached = await readGitHistory(directory, 20, 0, [
      detachedHead,
      "f".repeat(40),
    ]);
    expect(withDetached.commits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hash: detachedHead,
          subject: "Detached worktree",
        }),
      ]),
    );
    expect(withDetached.totalCount).toBe(2);
  });

  it("stages, unstages, commits, and switches branches", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "README.md"), "initial\n");
    await execFileAsync("git", ["-C", directory, "add", "README.md"]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);

    await writeFile(path.join(directory, "README.md"), "changed\n");
    await writeFile(path.join(directory, "new.txt"), "new\n");
    let status = await readGitStatus(directory);
    expect(status.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "README.md", unstaged: true }),
        expect.objectContaining({ path: "new.txt", unstaged: true }),
      ]),
    );

    status = (
      await runGitAction(directory, { type: "stage", paths: ["new.txt"] })
    ).status;
    expect(status.files.find((file) => file.path === "new.txt")?.staged).toBe(
      true,
    );
    status = (
      await runGitAction(directory, { type: "unstage", paths: ["new.txt"] })
    ).status;
    expect(status.files.find((file) => file.path === "new.txt")?.staged).toBe(
      false,
    );

    status = (
      await runGitAction(directory, {
        type: "commit",
        message: "Save workspace",
        all: true,
      })
    ).status;
    expect(status.files).toHaveLength(0);
    expect((await readGitHistory(directory, 1)).commits[0]?.subject).toBe(
      "Save workspace",
    );

    await execFileAsync("git", [
      "-C",
      directory,
      "remote",
      "add",
      "origin",
      "https://example.com/cantrip.git",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "update-ref",
      "refs/remotes/origin/remote-feature",
      "HEAD",
    ]);
    status = (
      await runGitAction(directory, {
        type: "checkout",
        branch: "origin/remote-feature",
      })
    ).status;
    expect(status.branch).toBe("remote-feature");
    status = (
      await runGitAction(directory, { type: "checkout", branch: "main" })
    ).status;
    expect(status.branch).toBe("main");

    status = (
      await runGitAction(directory, { type: "createBranch", name: "feature" })
    ).status;
    expect(status.branch).toBe("feature");
    expect(status.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "feature", current: true }),
      ]),
    );
    status = (
      await runGitAction(directory, { type: "checkout", branch: "main" })
    ).status;
    expect(status.branch).toBe("main");
  });

  it("reads staged and unstaged patches and discards only working changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "README.md"), "initial\n");
    await execFileAsync("git", ["-C", directory, "add", "README.md"]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);

    await writeFile(path.join(directory, "README.md"), "staged\n");
    await writeFile(path.join(directory, "scratch.txt"), "scratch\n");
    expect(
      (await readGitFileDiff(directory, "README.md", "unstaged")).patch,
    ).toContain("+staged");
    expect(
      (await readGitFileDiff(directory, "scratch.txt", "unstaged")).patch,
    ).toContain("+scratch");

    await runGitAction(directory, { type: "stage", paths: ["README.md"] });
    await writeFile(path.join(directory, "README.md"), "working\n");
    expect(
      (await readGitFileDiff(directory, "README.md", "staged")).patch,
    ).toContain("+staged");
    expect(
      (await readGitFileDiff(directory, "README.md", "unstaged")).patch,
    ).toContain("+working");

    await runGitAction(directory, { type: "discard", paths: ["README.md"] });
    expect(await readFile(path.join(directory, "README.md"), "utf8")).toBe(
      "staged\n",
    );
    expect(
      (await readGitStatus(directory)).files.find(
        ({ path: filePath }) => filePath === "README.md",
      ),
    ).toMatchObject({ staged: true, unstaged: false });

    await runGitAction(directory, { type: "discardAll" });
    expect(
      (await readGitStatus(directory)).files.some(
        ({ path: filePath }) => filePath === "scratch.txt",
      ),
    ).toBe(false);
    await expect(
      readGitFileDiff(directory, "../outside.txt", "unstaged"),
    ).rejects.toThrow("Invalid Git diff path");
  });

  it("treats discarded filenames as literals instead of Git pathspecs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-git-test-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(directory, "[ab].txt"), "literal\n");
    await writeFile(path.join(directory, "a.txt"), "ordinary\n");
    await execFileAsync("git", ["-C", directory, "add", "-A"]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);

    await writeFile(path.join(directory, "[ab].txt"), "discard me\n");
    await writeFile(path.join(directory, "a.txt"), "keep me\n");
    await runGitAction(directory, { type: "discard", paths: ["[ab].txt"] });

    expect(await readFile(path.join(directory, "[ab].txt"), "utf8")).toBe(
      "literal\n",
    );
    expect(await readFile(path.join(directory, "a.txt"), "utf8")).toBe(
      "keep me\n",
    );
  });
});
