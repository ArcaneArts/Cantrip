import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { readGitHistory } from "../src/git.js";

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
    expect(firstPage.nextCursor).toBe(1);
    expect(
      [...firstPage.commits, ...secondPage.commits].map(
        (commit) => commit.subject,
      ),
    ).toEqual(["Feature", "First"]);
  });
});
