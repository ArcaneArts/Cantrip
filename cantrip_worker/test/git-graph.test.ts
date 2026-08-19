import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearGitGraphAnalysisCache,
  createGitGraphCommitOverlay,
  readGitGraphMetrics,
  readGitGraphSnapshot,
} from "../src/git-graph.js";
import { readGitCommitDetail } from "../src/git.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function createRepository(prefix = "cantrip-graph-"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  await execFileAsync("git", ["init", "-b", "main", directory]);
  await execFileAsync("git", [
    "-C",
    directory,
    "config",
    "user.name",
    "Cantrip Graph",
  ]);
  await execFileAsync("git", [
    "-C",
    directory,
    "config",
    "user.email",
    "graph@cantrip.test",
  ]);
  return directory;
}

async function commitAll(directory: string, message: string): Promise<string> {
  await execFileAsync("git", ["-C", directory, "add", "."]);
  await execFileAsync("git", ["-C", directory, "commit", "-m", message]);
  return (
    await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
  ).stdout.trim();
}

beforeEach(() => clearGitGraphAnalysisCache());

afterEach(async () => {
  clearGitGraphAnalysisCache();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Git repository graph analysis", () => {
  it("returns a usable root for an unborn repository", async () => {
    const directory = await createRepository();

    const snapshot = await readGitGraphSnapshot(directory);
    const metrics = await readGitGraphMetrics(directory);

    expect(snapshot).toMatchObject({
      revision: null,
      branch: "main",
      rootPath: null,
      totalNodes: 1,
      truncated: false,
      analysis: {
        structure: "ready",
        lines: "ready",
        history: "ready",
        blame: "unavailable",
      },
    });
    expect(snapshot.nodes).toEqual([
      expect.objectContaining({
        id: "directory:.",
        kind: "directory",
        path: null,
      }),
    ]);
    expect(metrics).toMatchObject({
      revision: null,
      historyScope: "none",
      nodes: [{ nodeId: "directory:.", lineCount: 0 }],
    });
  });

  it("builds scoped trees and progressive line and history metrics", async () => {
    const directory = await createRepository();
    await mkdir(path.join(directory, "src"));
    await writeFile(path.join(directory, "README.md"), "one\n\ntwo\n");
    await writeFile(path.join(directory, "src", "index.ts"), "export {};\n");
    await writeFile(
      path.join(directory, "src", "binary.dat"),
      Buffer.from([0, 1, 2, 3]),
    );
    await commitAll(directory, "Initial tree");
    await writeFile(
      path.join(directory, "src", "index.ts"),
      "export const value = 1;\nexport default value;\n",
    );
    await commitAll(directory, "Expand source");

    const snapshot = await readGitGraphSnapshot(directory);
    expect(snapshot.analysis).toMatchObject({
      structure: "ready",
      lines: "pending",
      history: "pending",
      blame: "deferred",
    });
    expect(snapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "directory:src",
          parentId: "directory:.",
          kind: "directory",
        }),
        expect.objectContaining({
          id: "file:src/index.ts",
          parentId: "directory:src",
          language: "TypeScript",
        }),
      ]),
    );

    const metrics = await readGitGraphMetrics(directory);
    const byPath = new Map(metrics.nodes.map((node) => [node.path, node]));
    expect(metrics).toMatchObject({
      revision: snapshot.revision,
      historyScope: "current-branch",
      renameAware: false,
      analysis: {
        lines: "ready",
        history: "ready",
        blame: "deferred",
      },
    });
    expect(byPath.get("src/index.ts")).toMatchObject({
      lineCount: 2,
      binary: false,
      commitTouches: 2,
      additions: 3,
      deletions: 1,
      churn: 4,
    });
    expect(byPath.get("src/binary.dat")).toMatchObject({
      lineCount: null,
      binary: true,
      commitTouches: 1,
      binaryCommitTouches: 1,
    });
    expect(byPath.get("src")).toMatchObject({
      lineCount: 2,
      commitTouches: 2,
    });
    expect(byPath.get(null)).toMatchObject({
      lineCount: 5,
      commitTouches: 2,
    });

    const scoped = await readGitGraphSnapshot(directory, "HEAD", "src");
    expect(scoped.rootPath).toBe("src");
    expect(scoped.nodes[0]).toMatchObject({
      id: "directory:src",
      path: "src",
      parentId: null,
    });
    expect(
      scoped.nodes.every(
        (node) => node.path === "src" || node.path?.startsWith("src/"),
      ),
    ).toBe(true);
    await expect(
      readGitGraphSnapshot(directory, "HEAD", "README.md"),
    ).rejects.toThrow("not a directory");
    await expect(
      readGitGraphSnapshot(directory, "--output=/tmp/escape"),
    ).rejects.toThrow("safe Git graph revision");
    await expect(
      readGitGraphSnapshot(directory, "HEAD", null, 0),
    ).rejects.toThrow("maxNodes");
  });

  it("bounds large trees and invalidates cached snapshots when HEAD moves", async () => {
    const directory = await createRepository();
    await mkdir(path.join(directory, "wide"));
    await Promise.all(
      Array.from({ length: 140 }, (_, index) =>
        writeFile(
          path.join(directory, "wide", `file-${index}.txt`),
          `${index}\n`,
        ),
      ),
    );
    const firstRevision = await commitAll(directory, "Wide tree");

    const first = await readGitGraphSnapshot(directory, "HEAD", null, 25);
    const cached = await readGitGraphSnapshot(directory, "HEAD", null, 25);
    expect(cached).toBe(first);
    expect(first).toMatchObject({
      revision: firstRevision,
      truncated: true,
      totalNodes: 142,
    });
    expect(first.nodes).toHaveLength(25);

    await writeFile(path.join(directory, "new.txt"), "new\n");
    const secondRevision = await commitAll(directory, "Move head");
    const second = await readGitGraphSnapshot(directory, "HEAD", null, 25);
    expect(second).not.toBe(first);
    expect(second.revision).toBe(secondRevision);
  });

  it("represents submodules and creates scoped rename and delete overlays", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-graph-submodule-"));
    directories.push(root);
    const child = path.join(root, "child");
    const directory = path.join(root, "parent");
    await execFileAsync("git", ["init", "-b", "main", child]);
    await execFileAsync("git", ["-C", child, "config", "user.name", "Child"]);
    await execFileAsync("git", [
      "-C",
      child,
      "config",
      "user.email",
      "child@cantrip.test",
    ]);
    await writeFile(path.join(child, "child.txt"), "child\n");
    await execFileAsync("git", ["-C", child, "add", "."]);
    await execFileAsync("git", ["-C", child, "commit", "-m", "Child"]);
    await execFileAsync("git", ["init", "-b", "main", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.name",
      "Parent",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "config",
      "user.email",
      "parent@cantrip.test",
    ]);
    await execFileAsync("git", [
      "-c",
      "protocol.file.allow=always",
      "-C",
      directory,
      "submodule",
      "add",
      child,
      "vendor/child",
    ]);
    await commitAll(directory, "Add submodule");

    const snapshot = await readGitGraphSnapshot(directory);
    expect(snapshot.nodes).toContainEqual(
      expect.objectContaining({
        path: "vendor/child",
        kind: "submodule",
        byteSize: null,
      }),
    );

    await mkdir(path.join(directory, "src"));
    await writeFile(path.join(directory, "src", "old.ts"), "old\n");
    await writeFile(path.join(directory, "outside.txt"), "outside\n");
    await commitAll(directory, "Add overlay files");
    await execFileAsync("git", [
      "-C",
      directory,
      "mv",
      "src/old.ts",
      "src/new.ts",
    ]);
    await writeFile(path.join(directory, "src", "deleted.ts"), "gone\n");
    const renameRevision = await commitAll(directory, "Prepare deletion");
    const renameOverlay = createGitGraphCommitOverlay(
      await readGitCommitDetail(directory, renameRevision),
      "src",
    );
    expect(renameOverlay.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/new.ts",
          originalPath: "src/old.ts",
          status: "renamed",
          ghost: false,
        }),
      ]),
    );
    await rm(path.join(directory, "src", "deleted.ts"));
    const revision = await commitAll(directory, "Delete source file");
    const detail = await readGitCommitDetail(directory, revision);
    const overlay = createGitGraphCommitOverlay(detail, "src");

    expect(overlay.nodes).toEqual([
      expect.objectContaining({
        path: "src/deleted.ts",
        status: "deleted",
        ghost: true,
        weight: 1,
      }),
    ]);
    expect(overlay.filesChanged).toBe(1);
  });
});
