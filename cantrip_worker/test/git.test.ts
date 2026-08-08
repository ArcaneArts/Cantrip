import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { readGitHistory, readGitStatus, runGitAction } from "../src/git.js";

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
});
