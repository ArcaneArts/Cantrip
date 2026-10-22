import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readGitChangeSummary } from "./git-change-summary.js";

const exec = promisify(execFile);
const roots: string[] = [];
const since = "2026-10-22T10:00:00Z";
const window = { since, until: null };
async function git(cwd: string, args: string[], date?: string) {
  return (
    await exec("git", ["-C", cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date ?? "2026-10-22T10:01:00Z",
        GIT_COMMITTER_DATE: date ?? "2026-10-22T10:01:00Z",
      },
    })
  ).stdout;
}
async function fixture(initial: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-task-changes-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Task Test"]);
  await git(root, ["config", "user.email", "task@example.invalid"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  for (const [file, text] of Object.entries(initial))
    await writeFile(path.join(root, file), text);
  if (Object.keys(initial).length) {
    await git(root, ["add", "--all"]);
    await git(root, ["commit", "-m", "Before Task"], "2020-01-01T00:00:00Z");
  }
  return root;
}
async function commit(root: string, date = "2026-10-22T10:01:00Z") {
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-m", "Task changes"], date);
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("Task worktree Git change totals", () => {
  it("sums commits and current staged, unstaged, untracked, and binary files without relying on edit messages", async () => {
    const root = await fixture({
      "a.txt": "before\n",
      ".gitignore": "ignored\n",
    });
    await writeFile(path.join(root, "a.txt"), "after\nextra\n");
    await writeFile(path.join(root, "b.txt"), "new\n");
    await commit(root);
    await writeFile(path.join(root, "a.txt"), "after\nextra\nthird\n");
    await rm(path.join(root, "b.txt"));
    await commit(root, "2026-10-22T10:02:00Z");
    expect(await readGitChangeSummary(root, window)).toMatchObject({
      commits: 2,
      filesChanged: 2,
      additions: 4,
      deletions: 2,
      uncommittedFiles: 0,
    });
    await writeFile(path.join(root, "a.txt"), "updated\nextra\nthird\n");
    await git(root, ["add", "a.txt"]);
    await writeFile(
      path.join(root, "a.txt"),
      "updated\nextra\nthird\nfourth\n",
    );
    await writeFile(path.join(root, "new.txt"), "one\ntwo");
    await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, "ignored"), "not counted\n");
    expect(await readGitChangeSummary(root, window)).toMatchObject({
      commits: 2,
      filesChanged: 4,
      additions: 8,
      deletions: 3,
      uncommittedFiles: 3,
      binaryFiles: 1,
      partial: false,
    });
    expect(
      await readGitChangeSummary(root, {
        since,
        until: "2026-10-22T10:01:30Z",
      }),
    ).toMatchObject({ commits: 1, additions: 7, deletions: 2 });
  });

  it("counts rename numstats with tabs and newlines in the filename", async () => {
    // Windows forbids tabs/newlines in names; spaces still exercise NUL parsing there.
    const original =
      process.platform === "win32" ? "old name.txt" : "old\tname\n.txt";
    const next =
      process.platform === "win32" ? "new name.txt" : "new\tname\n.txt";
    const root = await fixture({ [original]: "retained\n" });
    await rename(path.join(root, original), path.join(root, next));
    await commit(root);
    expect(await readGitChangeSummary(root, window)).toMatchObject({
      commits: 1,
      filesChanged: 1,
      additions: 0,
      deletions: 0,
    });
  });

  it("does not mistake rename paths that look like commit headers for extra commits", async () => {
    const original = "a".repeat(40);
    const next = `commit:${"b".repeat(40)}`;
    // Colons are not legal in Windows filenames, but a bare hash exercises its path parser too.
    const destination = process.platform === "win32" ? "b".repeat(40) : next;
    const root = await fixture({ [original]: "retained\n" });
    await rename(path.join(root, original), path.join(root, destination));
    await commit(root);
    expect(await readGitChangeSummary(root, window)).toMatchObject({
      commits: 1,
      filesChanged: 1,
    });
  });

  it("includes merged work once rather than counting its branch and merge twice", async () => {
    const root = await fixture({ "base.txt": "base\n" });
    await git(root, ["checkout", "-b", "topic"]);
    await writeFile(path.join(root, "topic.txt"), "one\n");
    await commit(root);
    await writeFile(path.join(root, "topic.txt"), "one\ntwo\n");
    await commit(root, "2026-10-22T10:02:00Z");
    await git(root, ["checkout", "main"]);
    await writeFile(path.join(root, "main.txt"), "main\n");
    await commit(root, "2026-10-22T10:03:00Z");
    await git(
      root,
      ["merge", "--no-ff", "topic", "-m", "Merge Task work"],
      "2026-10-22T10:04:00Z",
    );
    expect(await readGitChangeSummary(root, window)).toMatchObject({
      commits: 2,
      filesChanged: 2,
      additions: 3,
      deletions: 0,
    });
  });

  it("reads the bound linked worktree and excludes other branches and checkout changes", async () => {
    const root = await fixture({ "base.txt": "base\n" });
    const linked = path.join(root, "linked");
    await git(root, ["worktree", "add", "-b", "task", linked]);
    await writeFile(path.join(linked, "task.txt"), "task\n");
    await commit(linked);
    await writeFile(path.join(root, "elsewhere.txt"), "other\n");
    // Ignore the linked checkout from Primary's untracked files.
    await writeFile(path.join(root, ".git", "info", "exclude"), "linked/\n");
    expect(await readGitChangeSummary(linked, window)).toMatchObject({
      commits: 1,
      filesChanged: 1,
      additions: 1,
      uncommittedFiles: 0,
    });
    expect(await readGitChangeSummary(root, window)).toMatchObject({
      commits: 0,
      filesChanged: 1,
      additions: 1,
      uncommittedFiles: 1,
    });
  });

  it("counts staged and untracked files in an unborn repository", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "staged.txt"), "staged\n");
    await git(root, ["add", "staged.txt"]);
    await writeFile(path.join(root, "new.txt"), "untracked");
    expect(await readGitChangeSummary(root, window)).toMatchObject({
      commits: 0,
      filesChanged: 2,
      additions: 2,
      uncommittedFiles: 2,
    });
  });

  it("marks bounded untracked line totals partial rather than reporting exact zero", async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, "large.txt"),
      "x".repeat(8 * 1_024 * 1_024 + 1),
    );
    expect(await readGitChangeSummary(root, window)).toMatchObject({
      filesChanged: 1,
      partial: true,
    });
  });

  it("propagates actual Git errors for execution folders without a repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-task-no-git-"));
    roots.push(root);
    await mkdir(path.join(root, "folder"));
    await expect(readGitChangeSummary(root, window)).rejects.toThrow();
  });
});
