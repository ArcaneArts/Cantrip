import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { discoverWorkspaceRepositories } from "./workspace-repository-discovery.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-discovery-"));
  temporaryDirectories.push(root);
  return root;
}

async function initializeRepository(repository: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", repository]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("discoverWorkspaceRepositories", () => {
  it("finds primary repositories through depth three and stops at repository roots", async () => {
    const root = await temporaryRoot();
    const rootRepository = path.join(root, "root-repository");
    const depthThreeRepository = path.join(root, "one", "two", "repository");
    const tooDeepRepository = path.join(
      root,
      "one",
      "two",
      "three",
      "repository",
    );
    const nestedRepository = path.join(rootRepository, "vendor", "nested");
    await initializeRepository(rootRepository);
    await initializeRepository(depthThreeRepository);
    await initializeRepository(tooDeepRepository);
    await initializeRepository(nestedRepository);

    const result = await discoverWorkspaceRepositories(root);

    expect(result.candidates.map(({ relativePath }) => relativePath)).toEqual([
      "one/two/repository",
      "root-repository",
    ]);
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repositoryFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
      ]),
    );
    expect(result.truncated).toBe(true);
  });

  it("does not follow directory symlinks outside the attached root", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await initializeRepository(path.join(outside, "repository"));
    await symlink(outside, path.join(root, "outside-link"), "dir");

    const result = await discoverWorkspaceRepositories(root);

    expect(result.candidates).toEqual([]);
    expect(result.skippedSymlinks).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("recognizes git marker files but excludes linked worktrees", async () => {
    const root = await temporaryRoot();
    const primary = path.join(root, "primary");
    const linked = path.join(root, "linked");
    await initializeRepository(primary);
    await execFileAsync("git", [
      "-C",
      primary,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await execFileAsync("git", [
      "-C",
      primary,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await writeFile(path.join(primary, "README.md"), "test");
    await execFileAsync("git", ["-C", primary, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      primary,
      "commit",
      "--quiet",
      "-m",
      "initial",
    ]);
    await execFileAsync("git", [
      "-C",
      primary,
      "worktree",
      "add",
      "--quiet",
      linked,
    ]);

    const result = await discoverWorkspaceRepositories(root);

    expect(result.candidates.map(({ relativePath }) => relativePath)).toEqual([
      "primary",
    ]);
    expect(result.rejectedRepositories).toBe(1);
  });

  it("applies candidate and entry bounds", async () => {
    const root = await temporaryRoot();
    await initializeRepository(path.join(root, "a"));
    await initializeRepository(path.join(root, "b"));

    const result = await discoverWorkspaceRepositories(root, {
      maxCandidates: 1,
      maxEntries: 100,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.scannedEntries).toBeGreaterThan(0);
    expect(await realpath(result.canonicalRoot)).toBe(await realpath(root));
  });

  it("rejects relative roots and ignores ordinary non-Git directories", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "ordinary", "nested"), { recursive: true });

    await expect(
      discoverWorkspaceRepositories("relative/workspace"),
    ).rejects.toThrow(/absolute root/iu);
    await expect(discoverWorkspaceRepositories(root)).resolves.toMatchObject({
      candidates: [],
    });
  });
});
