import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  readGitCommitDetail,
  readGitComparison,
  readGitFileDiff,
  readGitHistory,
  readGitRevisionFileDiff,
  readGitRevisionCandidates,
  readGitStatus,
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
