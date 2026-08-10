import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  amendGitManagedOperation,
  applyGitForcePush,
  applyGitBranchAction,
  applyGitCommitAction,
  applyGitConflictResolution,
  applyGitPartialPatch,
  applyGitRemoteAction,
  applyGitStashAction,
  applyGitTagAction,
  controlGitManagedOperation,
  createGitStash,
  gitForcePushArguments,
  previewGitBranchAction,
  previewGitCommitAction,
  previewGitConflictResolution,
  previewGitPartialPatch,
  previewGitRemoteAction,
  previewGitStashAction,
  previewGitTagAction,
  previewGitManagedOperation,
  previewGitForcePush,
  readGitCommitDetail,
  readGitConflict,
  readGitBranches,
  readGitComparison,
  readGitFileDiff,
  readGitFileBlame,
  readGitFileHistory,
  readGitHistory,
  listGitConflicts,
  readGitRemotes,
  readGitRevisionFileDiff,
  readGitRevisionCandidates,
  readGitStatus,
  readGitStashes,
  readGitStashFileDiff,
  readGitTagDetail,
  readGitTags,
  runGitAction,
  searchGitCommits,
  startGitManagedOperation,
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
  it("previews, persists, and continues a conflicting merge", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-merge-test-"));
    directories.push(root);
    const directory = path.join(root, "repo");
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
    await writeFile(path.join(directory, "shared.txt"), "base\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Base"]);
    await execFileAsync("git", ["-C", directory, "switch", "-c", "feature"]);
    await writeFile(path.join(directory, "shared.txt"), "feature\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Feature"]);
    await execFileAsync("git", ["-C", directory, "switch", "main"]);
    await writeFile(path.join(directory, "shared.txt"), "main\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Main"]);

    const action = { type: "merge" as const, sourceRef: "feature" };
    const preview = await previewGitManagedOperation(directory, action);
    expect(preview).toMatchObject({
      action,
      destructive: false,
      wouldConflict: true,
      context: { type: "merge", targetRef: "refs/heads/main" },
    });
    await writeFile(
      path.join(directory, "scratch.txt"),
      "changed after preview\n",
    );
    await execFileAsync("git", ["-C", directory, "add", "scratch.txt"]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Move HEAD"]);
    await expect(
      startGitManagedOperation(directory, action, preview.token),
    ).rejects.toThrow("changed after this preview");
    const currentPreview = await previewGitManagedOperation(directory, action);
    const started = await startGitManagedOperation(
      directory,
      action,
      currentPreview.token,
    );
    expect(started).toMatchObject({
      state: "conflicted",
      conflictedPaths: ["shared.txt"],
    });
    await writeFile(path.join(directory, "shared.txt"), "resolved\n");
    await execFileAsync("git", ["-C", directory, "add", "shared.txt"]);
    const completed = await controlGitManagedOperation(
      directory,
      currentPreview.context,
      "continue",
    );
    expect(completed.state).toBe("completed");
    expect(completed.pendingCommits).toEqual([]);
    expect(
      (
        await execFileAsync("git", [
          "-C",
          directory,
          "rev-list",
          "--parents",
          "-n",
          "1",
          "HEAD",
        ])
      ).stdout
        .trim()
        .split(" "),
    ).toHaveLength(3);
  });

  it("previews, applies, stages, and verifies conflict resolutions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-conflict-test-"));
    directories.push(root);
    const directory = path.join(root, "repo");
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
    await writeFile(path.join(directory, "shared.txt"), "base\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Base"]);
    await execFileAsync("git", ["-C", directory, "switch", "-c", "feature"]);
    await writeFile(path.join(directory, "shared.txt"), "feature\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Feature"]);
    await execFileAsync("git", ["-C", directory, "switch", "main"]);
    await writeFile(path.join(directory, "shared.txt"), "main\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Main"]);

    const operation = await previewGitManagedOperation(directory, {
      type: "merge",
      sourceRef: "feature",
    });
    await startGitManagedOperation(
      directory,
      { type: "merge", sourceRef: "feature" },
      operation.token,
    );
    expect(await listGitConflicts(directory)).toMatchObject({
      files: [
        {
          path: "shared.txt",
          code: "UU",
          kind: "both-modified",
          baseAvailable: true,
          oursAvailable: true,
          theirsAvailable: true,
        },
      ],
      truncated: false,
    });
    const detail = await readGitConflict(directory, "shared.txt");
    expect(detail.base.content).toBe("base\n");
    expect(detail.ours.content).toBe("main\n");
    expect(detail.theirs.content).toBe("feature\n");
    await expect(readGitConflict(directory, "../outside")).rejects.toThrow(
      "Invalid conflict path",
    );

    const request = {
      path: "shared.txt",
      strategy: "manual" as const,
      content: "resolved\n",
    };
    let preview = await previewGitConflictResolution(directory, request);
    await writeFile(path.join(directory, "shared.txt"), "changed\n");
    await expect(
      applyGitConflictResolution(directory, request, preview.token),
    ).rejects.toThrow("changed after this preview");
    preview = await previewGitConflictResolution(directory, request);
    const applied = await applyGitConflictResolution(
      directory,
      request,
      preview.token,
    );
    expect(applied).toMatchObject({
      path: "shared.txt",
      resolved: true,
      remainingPaths: [],
    });
    expect(await readFile(path.join(directory, "shared.txt"), "utf8")).toBe(
      "resolved\n",
    );
    expect(
      (await execFileAsync("git", ["-C", directory, "ls-files", "-u"])).stdout,
    ).toBe("");
  });

  it("creates a rebase checkpoint and supports skip and abort", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-rebase-test-"));
    directories.push(root);
    const directory = path.join(root, "repo");
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
    await writeFile(path.join(directory, "shared.txt"), "base\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Base"]);
    await execFileAsync("git", ["-C", directory, "switch", "-c", "feature"]);
    await writeFile(path.join(directory, "shared.txt"), "feature\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Feature"]);
    const featureHead = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await execFileAsync("git", ["-C", directory, "switch", "main"]);
    await writeFile(path.join(directory, "shared.txt"), "main\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Main"]);
    await execFileAsync("git", ["-C", directory, "switch", "feature"]);

    const action = { type: "rebase" as const, sourceRef: "main" };
    let preview = await previewGitManagedOperation(directory, action);
    expect(preview.context.checkpointRef).toMatch(
      /^refs\/cantrip\/checkpoints\/rebase-/u,
    );
    let started = await startGitManagedOperation(
      directory,
      action,
      preview.token,
    );
    expect(started.state).toBe("conflicted");
    const skipped = await controlGitManagedOperation(
      directory,
      preview.context,
      "skip",
    );
    expect(skipped.state).toBe("completed");
    expect(
      (
        await execFileAsync("git", [
          "-C",
          directory,
          "rev-parse",
          preview.context.checkpointRef!,
        ])
      ).stdout.trim(),
    ).toBe(featureHead);

    await execFileAsync("git", [
      "-C",
      directory,
      "reset",
      "--hard",
      featureHead,
    ]);
    preview = await previewGitManagedOperation(directory, action);
    started = await startGitManagedOperation(directory, action, preview.token);
    expect(started.state).toBe("conflicted");
    const aborted = await controlGitManagedOperation(
      directory,
      preview.context,
      "abort",
    );
    expect(aborted.state).toBe("aborted");
    expect(aborted.currentHead).toBe(featureHead);
  });

  it("validates and executes an exact interactive rebase todo", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-rewrite-test-"));
    directories.push(root);
    const directory = path.join(root, "repo");
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
    const upstream = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    const revisions: string[] = [];
    for (const name of ["A", "B", "C", "D", "E"]) {
      await writeFile(path.join(directory, `${name}.txt`), `${name}\n`);
      await execFileAsync("git", ["-C", directory, "add", "."]);
      await execFileAsync("git", ["-C", directory, "commit", "-m", name]);
      revisions.push(
        (
          await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
        ).stdout.trim(),
      );
    }
    const originalHead = revisions.at(-1)!;
    const initial = await previewGitManagedOperation(directory, {
      type: "interactiveRebase",
      upstreamRef: upstream,
      todo: [],
    });
    expect(initial.todo.map(({ revision }) => revision)).toEqual(revisions);
    expect(initial.todo.every(({ action }) => action === "pick")).toBe(true);
    const action = {
      type: "interactiveRebase" as const,
      upstreamRef: upstream,
      todo: [
        { action: "pick" as const, revision: revisions[1]!, message: null },
        { action: "squash" as const, revision: revisions[2]!, message: null },
        { action: "fixup" as const, revision: revisions[3]!, message: null },
        { action: "drop" as const, revision: revisions[4]!, message: null },
        {
          action: "reword" as const,
          revision: revisions[0]!,
          message: "A rewritten",
        },
      ],
    };
    const preview = await previewGitManagedOperation(directory, action);
    expect(
      preview.todoText.split("\n").map((line) => line.split(" ")[0]),
    ).toEqual(["pick", "squash", "fixup", "drop", "reword"]);
    expect(preview.context).toMatchObject({
      type: "rebase",
      originalHead,
      sourceRef: upstream,
    });
    expect(preview.context.checkpointRef).toMatch(
      /^refs\/cantrip\/checkpoints\/rewrite-/u,
    );
    const completed = await startGitManagedOperation(
      directory,
      action,
      preview.token,
    );
    expect(completed.state).toBe("completed");
    expect(
      (
        await execFileAsync("git", [
          "-C",
          directory,
          "log",
          "--format=%s",
          "--reverse",
          `${upstream}..HEAD`,
        ])
      ).stdout
        .trim()
        .split("\n"),
    ).toEqual(["B", "A rewritten"]);
    await expect(
      readFile(path.join(directory, "E.txt"), "utf8"),
    ).rejects.toThrow();
    expect(
      (
        await execFileAsync("git", [
          "-C",
          directory,
          "rev-parse",
          preview.context.checkpointRef!,
        ])
      ).stdout.trim(),
    ).toBe(originalHead);

    await expect(
      previewGitManagedOperation(directory, {
        type: "interactiveRebase",
        upstreamRef: upstream,
        todo: [action.todo[1]!],
      }),
    ).rejects.toThrow("every selected commit");
  });

  it("warns about published rewrites and force-pushes with an exact lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-force-lease-"));
    directories.push(root);
    const directory = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    await execFileAsync("git", ["init", "--bare", "-b", "main", remote]);
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
    await writeFile(path.join(directory, "file.txt"), "base\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Base"]);
    const base = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await execFileAsync("git", [
      "-C",
      directory,
      "remote",
      "add",
      "origin",
      remote,
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "push",
      "-u",
      "origin",
      "main",
    ]);
    await writeFile(path.join(directory, "file.txt"), "published\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Published"]);
    const published = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await execFileAsync("git", ["-C", directory, "push"]);
    await expect(previewGitForcePush(directory)).rejects.toThrow(
      "Use a normal push",
    );

    const rewrite = await previewGitManagedOperation(directory, {
      type: "interactiveRebase",
      upstreamRef: base,
      todo: [
        {
          action: "reword",
          revision: published,
          message: "Published rewritten",
        },
      ],
    });
    expect(rewrite.publishedRefs).toContain("origin/main");
    expect(rewrite.warnings.join(" ")).toContain("force-with-lease");

    await execFileAsync("git", ["-C", directory, "reset", "--hard", base]);
    await writeFile(path.join(directory, "file.txt"), "rewritten\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Rewritten"]);
    const localHead = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    const preview = await previewGitForcePush(directory);
    expect(preview).toMatchObject({
      remote: "origin",
      remoteBranch: "main",
      expectedRemoteHead: published,
      localHead,
      localCommitCount: 1,
      remoteCommitCount: 1,
    });
    expect(gitForcePushArguments(preview)).toEqual([
      "push",
      `--force-with-lease=refs/heads/main:${published}`,
      "origin",
      "HEAD:refs/heads/main",
    ]);
    const applied = await applyGitForcePush(directory, preview.token);
    expect(applied.status).toMatchObject({ ahead: 0, behind: 0 });
    expect(
      (
        await execFileAsync("git", [
          "--git-dir",
          remote,
          "rev-parse",
          "refs/heads/main",
        ])
      ).stdout.trim(),
    ).toBe(localHead);

    await execFileAsync("git", ["-C", directory, "reset", "--hard", base]);
    await writeFile(path.join(directory, "file.txt"), "second rewrite\n");
    await execFileAsync("git", [
      "-C",
      directory,
      "commit",
      "-am",
      "Second rewrite",
    ]);
    const stalePreview = await previewGitForcePush(directory);
    const other = path.join(root, "other");
    await execFileAsync("git", ["clone", remote, other]);
    await execFileAsync("git", [
      "-C",
      other,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      other,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(other, "other.txt"), "remote moved\n");
    await execFileAsync("git", ["-C", other, "add", "."]);
    await execFileAsync("git", ["-C", other, "commit", "-m", "Remote moved"]);
    await execFileAsync("git", ["-C", other, "push"]);
    await expect(
      applyGitForcePush(directory, stalePreview.token),
    ).rejects.toThrow("moved after this preview");
  });

  it("pauses an interactive edit step and amends it before continuing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-edit-test-"));
    directories.push(root);
    const directory = path.join(root, "repo");
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
    await writeFile(path.join(directory, "file.txt"), "base\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Base"]);
    const upstream = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await writeFile(path.join(directory, "file.txt"), "first\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "First"]);
    const revision = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    const action = {
      type: "interactiveRebase" as const,
      upstreamRef: upstream,
      todo: [{ action: "edit" as const, revision, message: null }],
    };
    const preview = await previewGitManagedOperation(directory, action);
    const paused = await startGitManagedOperation(
      directory,
      action,
      preview.token,
    );
    expect(paused).toMatchObject({
      state: "awaiting-user-action",
      pausedAction: "edit",
    });
    await writeFile(path.join(directory, "file.txt"), "edited\n");
    await execFileAsync("git", ["-C", directory, "add", "file.txt"]);
    const completed = await amendGitManagedOperation(
      directory,
      preview.context,
      "Edited commit",
    );
    expect(completed.state).toBe("completed");
    expect(await readFile(path.join(directory, "file.txt"), "utf8")).toBe(
      "edited\n",
    );
    expect(
      (
        await execFileAsync("git", [
          "-C",
          directory,
          "log",
          "-1",
          "--format=%s",
        ])
      ).stdout.trim(),
    ).toBe("Edited commit");
  });

  it("resumes a queued reword after an interactive rebase conflict", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-rewrite-resume-"));
    directories.push(root);
    const directory = path.join(root, "repo");
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
    await writeFile(path.join(directory, "shared.txt"), "base\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Base"]);
    const upstream = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await writeFile(path.join(directory, "shared.txt"), "feature\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Feature A"]);
    const first = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await writeFile(path.join(directory, "shared.txt"), "later\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Feature B"]);
    const second = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    const action = {
      type: "interactiveRebase" as const,
      upstreamRef: upstream,
      todo: [
        { action: "pick" as const, revision: second, message: null },
        {
          action: "reword" as const,
          revision: first,
          message: "Feature A rewritten after conflict",
        },
      ],
    };
    const preview = await previewGitManagedOperation(directory, action);
    expect(preview.wouldConflict).toBe(true);
    const conflicted = await startGitManagedOperation(
      directory,
      action,
      preview.token,
    );
    expect(conflicted.state).toBe("conflicted");
    await expect(
      amendGitManagedOperation(directory, preview.context, "Wrong step"),
    ).rejects.toThrow("not paused at an edit step");
    await writeFile(path.join(directory, "shared.txt"), "later\n");
    await execFileAsync("git", ["-C", directory, "add", "shared.txt"]);
    let resumed = conflicted;
    for (
      let attempt = 0;
      attempt < 4 && resumed.state !== "completed";
      attempt += 1
    ) {
      if (resumed.state === "conflicted") {
        await writeFile(
          path.join(directory, "shared.txt"),
          attempt === 0 ? "later\n" : "feature\n",
        );
        await execFileAsync("git", ["-C", directory, "add", "shared.txt"]);
      }
      resumed = await controlGitManagedOperation(
        directory,
        preview.context,
        "continue",
      );
    }
    expect(resumed.state, resumed.output).toBe("completed");
    expect(
      (
        await execFileAsync("git", [
          "-C",
          directory,
          "log",
          "-1",
          "--format=%s",
        ])
      ).stdout.trim(),
    ).toBe("Feature A rewritten after conflict");
  });

  it("previews and cherry-picks ordered commit ranges on the explicit worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-pick-test-"));
    directories.push(root);
    const directory = path.join(root, "repo");
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
    await execFileAsync("git", ["-C", directory, "switch", "-c", "source"]);
    await writeFile(path.join(directory, "one.txt"), "one\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "One"]);
    const first = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await writeFile(path.join(directory, "two.txt"), "two\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Two"]);
    const last = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await writeFile(path.join(directory, "three.txt"), "three\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Three"]);
    const third = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await execFileAsync("git", ["-C", directory, "switch", "main"]);

    const action = {
      type: "cherryPick" as const,
      selection: {
        type: "range" as const,
        fromRevision: first,
        toRevision: last,
      },
    };
    const preview = await previewGitCommitAction(directory, action);
    expect(preview.resolvedRevisions).toEqual([first, last]);
    expect(preview.patch).toContain("one.txt");
    expect(preview.patch).toContain("two.txt");
    expect(preview.wouldConflict).toBe(false);
    const result = await applyGitCommitAction(directory, action, preview.token);
    expect(result.operation).toMatchObject({
      type: "cherry-pick",
      state: "completed",
      currentStep: 2,
      totalSteps: 2,
    });
    expect(await readFile(path.join(directory, "two.txt"), "utf8")).toBe(
      "two\n",
    );
    const staleAction = {
      type: "cherryPick" as const,
      selection: { type: "commits" as const, revisions: [third] },
    };
    const stalePreview = await previewGitCommitAction(directory, staleAction);
    await writeFile(path.join(directory, "main-only.txt"), "main\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Main only"]);
    await expect(
      applyGitCommitAction(directory, staleAction, stalePreview.token),
    ).rejects.toThrow("changed after this preview");
  });

  it("keeps conflicting cherry-picks resumable and blocks dirty previews", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-pick-conflict-"));
    directories.push(root);
    const directory = path.join(root, "repo");
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
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Base"]);
    await execFileAsync("git", ["-C", directory, "switch", "-c", "source"]);
    await writeFile(path.join(directory, "conflict.txt"), "source\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Source"]);
    const source = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await execFileAsync("git", ["-C", directory, "switch", "main"]);
    await writeFile(path.join(directory, "conflict.txt"), "main\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Main"]);
    const action = {
      type: "cherryPick" as const,
      selection: { type: "commits" as const, revisions: [source] },
    };
    const preview = await previewGitCommitAction(directory, action);
    expect(preview.wouldConflict).toBe(true);
    const result = await applyGitCommitAction(directory, action, preview.token);
    expect(result.operation).toMatchObject({
      state: "conflicted",
      conflictedPaths: ["conflict.txt"],
    });
    await execFileAsync("git", ["-C", directory, "cherry-pick", "--abort"]);
    await writeFile(path.join(directory, "dirty.txt"), "dirty\n");
    await expect(previewGitCommitAction(directory, action)).rejects.toThrow(
      "requires a clean selected worktree",
    );
  });

  it("requires a mainline to preview and revert merge commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-revert-test-"));
    directories.push(root);
    const directory = path.join(root, "repo");
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
    await execFileAsync("git", ["-C", directory, "switch", "-c", "feature"]);
    await writeFile(path.join(directory, "feature.txt"), "feature\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Feature"]);
    await execFileAsync("git", ["-C", directory, "switch", "main"]);
    await writeFile(path.join(directory, "main.txt"), "main\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Main"]);
    await execFileAsync("git", [
      "-C",
      directory,
      "merge",
      "--no-ff",
      "feature",
      "-m",
      "Merge feature",
    ]);
    const merge = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await expect(
      previewGitCommitAction(directory, {
        type: "revert",
        revision: merge,
        mainlineParent: null,
      }),
    ).rejects.toThrow("requires a mainline parent");
    const action = {
      type: "revert" as const,
      revision: merge,
      mainlineParent: 1,
    };
    const preview = await previewGitCommitAction(directory, action);
    expect(preview.destructive).toBe(true);
    const result = await applyGitCommitAction(directory, action, preview.token);
    expect(result.operation?.state).toBe("completed");
    await expect(
      readFile(path.join(directory, "feature.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("creates fixup commits and checkpoints amended HEAD", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-amend-test-"));
    directories.push(root);
    const directory = path.join(root, "repo");
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
    await writeFile(path.join(directory, "large.txt"), "x".repeat(2_010_000));
    await execFileAsync("git", ["-C", directory, "add", "large.txt"]);
    const largePreview = await previewGitCommitAction(directory, {
      type: "fixup",
      revision: base,
    });
    expect(largePreview.patchTruncated).toBe(true);
    expect(largePreview.patch.length).toBeLessThanOrEqual(2_000_000);
    await execFileAsync("git", [
      "-C",
      directory,
      "reset",
      "HEAD",
      "--",
      "large.txt",
    ]);
    await rm(path.join(directory, "large.txt"));
    await writeFile(path.join(directory, "fix.txt"), "fix\n");
    await execFileAsync("git", ["-C", directory, "add", "fix.txt"]);
    const fixup = { type: "fixup" as const, revision: base };
    let preview = await previewGitCommitAction(directory, fixup);
    await applyGitCommitAction(directory, fixup, preview.token);
    const fixupSubject = (
      await execFileAsync("git", ["-C", directory, "show", "-s", "--format=%s"])
    ).stdout.trim();
    expect(fixupSubject).toBe("fixup! Base");

    await writeFile(path.join(directory, "amend.txt"), "amend\n");
    await execFileAsync("git", ["-C", directory, "add", "amend.txt"]);
    const amend = { type: "amend" as const, message: "Amended fixup" };
    preview = await previewGitCommitAction(directory, amend);
    expect(preview.checkpointRef).toMatch(/^refs\/cantrip\/checkpoints\//u);
    const amended = await applyGitCommitAction(directory, amend, preview.token);
    expect(amended.checkpointRef).toBe(preview.checkpointRef);
    expect(
      (
        await execFileAsync("git", [
          "-C",
          directory,
          "rev-parse",
          preview.checkpointRef!,
        ])
      ).stdout.trim(),
    ).toBe(amended.headBefore);
  });

  it("manages sanitized remotes, defaults, fetch, edit, and removal through reviewed actions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-remote-test-"));
    directories.push(root);
    const directory = path.join(root, "repo");
    const firstRemote = path.join(root, "first.git");
    const secondRemote = path.join(root, "second.git");
    await execFileAsync("git", ["init", "--bare", firstRemote]);
    await execFileAsync("git", ["init", "--bare", secondRemote]);
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
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);

    const add = {
      type: "add" as const,
      name: "upstream",
      fetchUrl: firstRemote,
      pushUrl: null,
    };
    let preview = await previewGitRemoteAction(directory, add);
    expect(preview.destructive).toBe(false);
    let result = await applyGitRemoteAction(directory, add, preview.token);
    expect(result.remotes.remotes).toEqual([
      expect.objectContaining({
        name: "upstream",
        fetchUrl: firstRemote,
        defaultFetch: true,
        defaultPush: true,
      }),
    ]);

    const edit = {
      type: "edit" as const,
      name: "upstream",
      fetchUrl: secondRemote,
      pushUrl: firstRemote,
    };
    preview = await previewGitRemoteAction(directory, edit);
    result = await applyGitRemoteAction(directory, edit, preview.token);
    expect(result.remotes.remotes[0]).toMatchObject({
      fetchUrl: secondRemote,
      pushUrl: firstRemote,
    });
    const defaults = {
      type: "setDefaults" as const,
      fetchRemote: "upstream",
      pushRemote: "upstream",
    };
    preview = await previewGitRemoteAction(directory, defaults);
    await applyGitRemoteAction(directory, defaults, preview.token);
    const fetch = { type: "fetch" as const, remote: "upstream", prune: true };
    preview = await previewGitRemoteAction(directory, fetch);
    expect(preview.destructive).toBe(true);
    await applyGitRemoteAction(directory, fetch, preview.token);

    const staleRemove = { type: "remove" as const, name: "upstream" };
    const stalePreview = await previewGitRemoteAction(directory, staleRemove);
    await execFileAsync("git", [
      "-C",
      directory,
      "remote",
      "add",
      "backup",
      firstRemote,
    ]);
    await expect(
      applyGitRemoteAction(directory, staleRemove, stalePreview.token),
    ).rejects.toThrow(/changed after this preview/iu);
    const removePreview = await previewGitRemoteAction(directory, staleRemove);
    await applyGitRemoteAction(directory, staleRemove, removePreview.token);

    await execFileAsync("git", [
      "-C",
      directory,
      "remote",
      "add",
      "credentialed",
      "https://user:top-secret@example.invalid/repo.git?access_token=hidden",
    ]);
    const credentialed = (await readGitRemotes(directory)).remotes.find(
      ({ name }) => name === "credentialed",
    );
    expect(credentialed).toMatchObject({
      fetchUrlRedacted: true,
      pushUrlRedacted: true,
    });
    expect(JSON.stringify(credentialed)).not.toContain("top-secret");
    expect(JSON.stringify(credentialed)).not.toContain("hidden");
    const credentialEdit = {
      type: "edit" as const,
      name: "credentialed",
      fetchUrl: "https://user:replacement@example.invalid/repo.git",
      pushUrl: null,
    };
    const credentialPreview = await previewGitRemoteAction(
      directory,
      credentialEdit,
    );
    await execFileAsync("git", [
      "-C",
      directory,
      "remote",
      "set-url",
      "credentialed",
      "https://user:changed@example.invalid/repo.git?access_token=other",
    ]);
    await expect(
      applyGitRemoteAction(directory, credentialEdit, credentialPreview.token),
    ).rejects.toThrow("changed after this preview");
  });

  it("creates, inspects, publishes, and safely deletes lightweight and annotated tags", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-tag-test-"));
    directories.push(root);
    const directory = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    await execFileAsync("git", ["init", "--bare", remote]);
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
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);
    await execFileAsync("git", [
      "-C",
      directory,
      "remote",
      "add",
      "origin",
      remote,
    ]);

    const lightweight = {
      type: "create" as const,
      name: "v1.0.0",
      target: null,
      annotated: false,
      message: null,
    };
    let preview = await previewGitTagAction(directory, lightweight);
    await applyGitTagAction(directory, lightweight, preview.token);
    const annotated = {
      type: "create" as const,
      name: "v1.1.0",
      target: "HEAD",
      annotated: true,
      message: "Cantrip 1.1\n\nRelease notes",
    };
    preview = await previewGitTagAction(directory, annotated);
    await applyGitTagAction(directory, annotated, preview.token);
    let tags = await readGitTags(directory);
    expect(tags.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "v1.0.0", annotated: false }),
        expect.objectContaining({
          name: "v1.1.0",
          annotated: true,
          signature: {
            status: "unsigned",
            signer: null,
            key: null,
            fingerprint: null,
          },
        }),
      ]),
    );
    expect((await readGitTagDetail(directory, "v1.1.0")).message).toContain(
      "Release notes",
    );

    const push = { type: "push" as const, name: "v1.1.0", remote: "origin" };
    preview = await previewGitTagAction(directory, push);
    tags = (await applyGitTagAction(directory, push, preview.token)).tags;
    expect(
      tags.tags.find(({ name }) => name === "v1.1.0")?.publishedRemotes,
    ).toEqual(["origin"]);

    const deleteRemote = {
      type: "deleteRemote" as const,
      name: "v1.1.0",
      remote: "origin",
    };
    preview = await previewGitTagAction(directory, deleteRemote);
    expect(preview.destructive).toBe(true);
    await applyGitTagAction(directory, deleteRemote, preview.token);
    const deleteLocal = { type: "deleteLocal" as const, name: "v1.1.0" };
    preview = await previewGitTagAction(directory, deleteLocal);
    tags = (await applyGitTagAction(directory, deleteLocal, preview.token))
      .tags;
    expect(tags.tags.some(({ name }) => name === "v1.1.0")).toBe(false);

    const stale = { ...lightweight, name: "stale-tag" };
    const stalePreview = await previewGitTagAction(directory, stale);
    await execFileAsync("git", ["-C", directory, "tag", "changed-tag"]);
    await expect(
      applyGitTagAction(directory, stale, stalePreview.token),
    ).rejects.toThrow(/changed after this preview/iu);
  });

  it("manages local, tracked, published, renamed, and remote branches through reviewed actions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-branch-test-"));
    directories.push(root);
    const directory = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    await execFileAsync("git", ["init", "--bare", remote]);
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
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);
    await execFileAsync("git", [
      "-C",
      directory,
      "remote",
      "add",
      "origin",
      remote,
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "push",
      "-u",
      "origin",
      "main",
    ]);

    let inventory = await readGitBranches(directory);
    expect(inventory).toMatchObject({
      currentBranch: "main",
      defaultRemote: "origin",
      pullStrategy: { mode: "fast-forward-only" },
    });
    expect(
      inventory.branches.find(({ name }) => name === "main"),
    ).toMatchObject({
      upstream: "origin/main",
      remoteAvailable: true,
      ahead: 0,
      behind: 0,
    });

    const create = {
      type: "create" as const,
      name: "topic",
      startPoint: null,
      checkout: false,
    };
    let preview = await previewGitBranchAction(directory, create);
    expect(preview.destructive).toBe(false);
    await applyGitBranchAction(directory, create, preview.token);
    const switchTopic = {
      type: "switch" as const,
      name: "topic",
      kind: "local" as const,
    };
    preview = await previewGitBranchAction(directory, switchTopic);
    expect(
      (await applyGitBranchAction(directory, switchTopic, preview.token)).status
        .branch,
    ).toBe("topic");
    const switchMain = {
      type: "switch" as const,
      name: "main",
      kind: "local" as const,
    };
    preview = await previewGitBranchAction(directory, switchMain);
    await applyGitBranchAction(directory, switchMain, preview.token);

    const publish = {
      type: "publish" as const,
      name: "topic",
      remote: "origin",
    };
    preview = await previewGitBranchAction(directory, publish);
    inventory = (await applyGitBranchAction(directory, publish, preview.token))
      .branches;
    expect(
      inventory.branches.find(({ name }) => name === "topic"),
    ).toMatchObject({
      upstream: "origin/topic",
      remoteAvailable: true,
    });

    const rename = {
      type: "rename" as const,
      name: "topic",
      newName: "renamed",
    };
    preview = await previewGitBranchAction(directory, rename);
    expect(preview.warnings.join(" ")).toMatch(/upstream remains/iu);
    await applyGitBranchAction(directory, rename, preview.token);
    const unset = {
      type: "setUpstream" as const,
      name: "renamed",
      upstream: null,
    };
    preview = await previewGitBranchAction(directory, unset);
    await applyGitBranchAction(directory, unset, preview.token);

    const deleteRemote = {
      type: "deleteRemote" as const,
      remote: "origin",
      name: "topic",
    };
    preview = await previewGitBranchAction(directory, deleteRemote);
    expect(preview.destructive).toBe(true);
    await applyGitBranchAction(directory, deleteRemote, preview.token);
    const remove = {
      type: "deleteLocal" as const,
      name: "renamed",
      force: false,
    };
    preview = await previewGitBranchAction(directory, remove);
    inventory = (await applyGitBranchAction(directory, remove, preview.token))
      .branches;
    expect(inventory.branches.some(({ name }) => name === "renamed")).toBe(
      false,
    );

    const fetch = { type: "fetch" as const, remote: null, prune: true };
    preview = await previewGitBranchAction(directory, fetch);
    expect(preview.destructive).toBe(true);
    await expect(
      applyGitBranchAction(directory, fetch, preview.token),
    ).resolves.toMatchObject({
      status: { branch: "main" },
    });
  });

  it("blocks branch mutations owned by another worktree and rejects stale previews", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "cantrip-branch-worktree-test-"),
    );
    directories.push(root);
    const directory = path.join(root, "repo");
    const other = path.join(root, "other-lane");
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
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);
    await execFileAsync("git", ["-C", directory, "branch", "owned"]);
    await execFileAsync("git", [
      "-C",
      directory,
      "worktree",
      "add",
      other,
      "owned",
    ]);

    const owned = (await readGitBranches(directory)).branches.find(
      ({ name }) => name === "owned",
    );
    expect(owned?.worktree).toEqual({ label: "other-lane", current: false });
    await expect(
      previewGitBranchAction(directory, {
        type: "switch",
        name: "owned",
        kind: "local",
      }),
    ).rejects.toThrow(/other-lane/u);
    await expect(
      previewGitBranchAction(directory, {
        type: "deleteLocal",
        name: "owned",
        force: true,
      }),
    ).rejects.toThrow(/other-lane/u);

    const create = {
      type: "create" as const,
      name: "stale",
      startPoint: null,
      checkout: false,
    };
    const preview = await previewGitBranchAction(directory, create);
    await execFileAsync("git", [
      "-C",
      directory,
      "branch",
      "changed-after-preview",
    ]);
    await expect(
      applyGitBranchAction(directory, create, preview.token),
    ).rejects.toThrow(/changed after this preview/iu);
  });

  it("reports unmerged branches and requires force for destructive deletion", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-branch-test-"),
    );
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
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);
    await execFileAsync("git", ["-C", directory, "switch", "-c", "unmerged"]);
    await writeFile(path.join(directory, "topic.txt"), "topic\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Topic"]);
    await execFileAsync("git", ["-C", directory, "switch", "main"]);

    const branch = (await readGitBranches(directory)).branches.find(
      ({ name }) => name === "unmerged",
    );
    expect(branch?.mergedIntoHead).toBe(false);
    const safeAction = {
      type: "deleteLocal" as const,
      name: "unmerged",
      force: false,
    };
    const safePreview = await previewGitBranchAction(directory, safeAction);
    await expect(
      applyGitBranchAction(directory, safeAction, safePreview.token),
    ).rejects.toThrow(/not fully merged/iu);
    const forceAction = { ...safeAction, force: true };
    const forcePreview = await previewGitBranchAction(directory, forceAction);
    expect(forcePreview.warnings.join(" ")).toMatch(/not merged/iu);
    await applyGitBranchAction(directory, forceAction, forcePreview.token);
  });

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
    expect(result.operation).toMatchObject({
      type: "stash",
      state: "conflicted",
      sourceRevision: stash.hash,
      targetRef: "refs/heads/main",
    });
    expect((await readGitStashes(directory)).stashes).toEqual([
      expect.objectContaining({ hash: stash.hash }),
    ]);

    await writeFile(path.join(directory, "conflict.txt"), "resolved\n");
    await execFileAsync("git", ["-C", directory, "add", "conflict.txt"]);
    const completed = await controlGitManagedOperation(
      directory,
      {
        type: "stash",
        originalHead: result.operation!.originalHead,
        sourceRef: result.operation!.sourceRef,
        sourceRevision: result.operation!.sourceRevision,
        targetRef: result.operation!.targetRef,
        targetRevision: result.operation!.targetRevision,
        pendingCommits: result.operation!.pendingCommits,
        totalSteps: 1,
        checkpointRef: result.operation!.checkpointRef,
      },
      "continue",
    );
    expect(completed.state).toBe("completed");
    expect((await readGitStashes(directory)).stashes).toEqual([]);

    await execFileAsync("git", ["-C", directory, "reset", "--hard", "HEAD"]);
    await writeFile(path.join(directory, "first.txt"), "first\n");
    await createGitStash(directory, {
      message: "First shelf",
      includeStaged: true,
      includeUnstaged: true,
      includeUntracked: true,
    });
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

  it("aborts a conflicted stash and restores staged and untracked work", async () => {
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
    await writeFile(path.join(directory, "keep.txt"), "base\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Initial"]);
    await writeFile(path.join(directory, "conflict.txt"), "stash\n");
    const stash = (
      await createGitStash(directory, {
        message: "Abort shelf",
        includeStaged: true,
        includeUnstaged: true,
        includeUntracked: false,
      })
    ).stash!;
    await writeFile(path.join(directory, "conflict.txt"), "branch\n");
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Diverge"]);
    await writeFile(path.join(directory, "keep.txt"), "preexisting\n");
    await execFileAsync("git", ["-C", directory, "add", "keep.txt"]);
    await writeFile(path.join(directory, "untracked.txt"), "preserve\n");
    const action = { type: "apply" as const, ref: stash.ref, hash: stash.hash };
    const preview = await previewGitStashAction(directory, action);
    const applied = await applyGitStashAction(directory, action, preview.token);
    expect(applied.operation?.checkpointRef).toMatch(/-dirty$/u);

    const aborted = await controlGitManagedOperation(
      directory,
      {
        type: "stash",
        originalHead: applied.operation!.originalHead,
        sourceRef: applied.operation!.sourceRef,
        sourceRevision: applied.operation!.sourceRevision,
        targetRef: applied.operation!.targetRef,
        targetRevision: applied.operation!.targetRevision,
        pendingCommits: applied.operation!.pendingCommits,
        totalSteps: 1,
        checkpointRef: applied.operation!.checkpointRef,
      },
      "abort",
    );
    expect(aborted.state).toBe("aborted");
    expect(await readFile(path.join(directory, "conflict.txt"), "utf8")).toBe(
      "branch\n",
    );
    expect(await readFile(path.join(directory, "keep.txt"), "utf8")).toBe(
      "preexisting\n",
    );
    expect(await readFile(path.join(directory, "untracked.txt"), "utf8")).toBe(
      "preserve\n",
    );
    expect((await readGitStatus(directory)).files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "keep.txt", staged: true }),
        expect.objectContaining({ path: "untracked.txt", unstaged: true }),
      ]),
    );
    expect((await readGitStashes(directory)).stashes).toEqual([
      expect.objectContaining({ hash: stash.hash }),
    ]);
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

  it("follows file renames and paginates blame without reading the whole file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-file-log-"));
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
    await writeFile(path.join(directory, "old.txt"), "one\ntwo\nthree\n");
    await execFileAsync("git", ["-C", directory, "add", "old.txt"]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "Add old"]);
    await execFileAsync("git", ["-C", directory, "mv", "old.txt", "new.txt"]);
    await execFileAsync("git", ["-C", directory, "commit", "-am", "Rename"]);
    await writeFile(path.join(directory, "new.txt"), "first\ntwo\nthree\n");
    await execFileAsync("git", [
      "-C",
      directory,
      "commit",
      "-am",
      "Edit first",
    ]);

    const firstHistory = await readGitFileHistory(
      directory,
      "new.txt",
      "HEAD",
      1,
    );
    const remainingHistory = await readGitFileHistory(
      directory,
      "new.txt",
      "HEAD",
      10,
      firstHistory.nextCursor!,
    );
    expect(firstHistory).toMatchObject({
      path: "new.txt",
      hasMore: true,
      commits: [{ subject: "Edit first" }],
    });
    expect(remainingHistory.commits.map(({ subject }) => subject)).toEqual([
      "Rename",
      "Add old",
    ]);

    const firstBlame = await readGitFileBlame(directory, "new.txt", "HEAD", 2);
    expect(firstBlame.hasMore).toBe(true);
    expect(firstBlame.nextCursor).toBe(2);
    expect(firstBlame.ranges.flatMap(({ lines }) => lines)).toEqual([
      "first",
      "two",
    ]);
    const finalBlame = await readGitFileBlame(
      directory,
      "new.txt",
      "HEAD",
      2,
      firstBlame.nextCursor!,
    );
    expect(finalBlame.hasMore).toBe(false);
    expect(finalBlame.ranges).toMatchObject([
      { startLine: 3, endLine: 3, lines: ["three"] },
    ]);
    await expect(
      readGitFileHistory(directory, "../secret", "HEAD", 10),
    ).rejects.toThrow("Invalid Git history path");
  });

  it("searches commits with combined bounded filters and exact ref scopes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-search-"));
    directories.push(directory);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await execFileAsync("git", ["-C", directory, "config", "user.name", "Ada"]);
    await writeFile(path.join(directory, "README.md"), "Cantrip\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "docs: base"]);
    const base = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await execFileAsync("git", ["-C", directory, "tag", "v1"]);
    await execFileAsync("git", ["-C", directory, "config", "user.name", "Bob"]);
    await writeFile(path.join(directory, "src.ts"), "fixed\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", [
      "-C",
      directory,
      "commit",
      "-m",
      "fix: race condition",
    ]);
    const fix = (
      await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await execFileAsync("git", ["-C", directory, "switch", "-c", "feature"]);
    await execFileAsync("git", ["-C", directory, "config", "user.name", "Ada"]);
    await writeFile(path.join(directory, "feature.ts"), "feature\n");
    await execFileAsync("git", ["-C", directory, "add", "."]);
    await execFileAsync("git", [
      "-C",
      directory,
      "commit",
      "-m",
      "feat: search",
    ]);

    expect(
      (
        await searchGitCommits(
          directory,
          {
            message: "race condition",
            author: "Bob",
            hash: null,
            dateFrom: null,
            dateTo: null,
            path: "src.ts",
            branch: "main",
            tag: null,
          },
          100,
        )
      ).commits.map(({ hash }) => hash),
    ).toEqual([fix]);
    expect(
      (
        await searchGitCommits(
          directory,
          {
            message: null,
            author: null,
            hash: base.slice(0, 8),
            dateFrom: null,
            dateTo: null,
            path: null,
            branch: null,
            tag: null,
          },
          100,
        )
      ).commits.map(({ hash }) => hash),
    ).toEqual([base]);
    const firstPage = await searchGitCommits(
      directory,
      {
        message: null,
        author: "Ada",
        hash: null,
        dateFrom: null,
        dateTo: null,
        path: null,
        branch: null,
        tag: null,
      },
      1,
    );
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBe(1);
    expect(
      (
        await searchGitCommits(
          directory,
          firstPage.query,
          1,
          firstPage.nextCursor!,
        )
      ).commits,
    ).toHaveLength(1);
    expect(
      (
        await searchGitCommits(
          directory,
          { ...firstPage.query, author: null, tag: "v1" },
          100,
        )
      ).commits.map(({ hash }) => hash),
    ).toEqual([base]);
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
