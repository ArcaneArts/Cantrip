import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalProjectSourcePath,
  normalizeProjectSourcePath,
  reconcileProjectObservationPaths,
} from "./project-source-path.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("normalizeProjectSourcePath", () => {
  it.each([
    ["c:\\Users\\Alice\\Cantrip", "C:\\Users\\Alice\\Cantrip"],
    ["c:/Users/Alice/../Cantrip", "C:\\Users\\Cantrip"],
    ["\\\\?\\C:\\Users\\Alice\\Cantrip", "C:\\Users\\Alice\\Cantrip"],
    [
      "\\\\?\\UNC\\winterhold\\Projects\\Cantrip",
      "\\\\winterhold\\Projects\\Cantrip",
    ],
    ["file:///C:/Users/Alice/Cantrip", "C:\\Users\\Alice\\Cantrip"],
    ["file://winterhold/Projects/Cantrip", "\\\\winterhold\\Projects\\Cantrip"],
  ])("normalizes Windows path %s", (input, expected) => {
    expect(normalizeProjectSourcePath(input, "win32")).toBe(expected);
  });

  it("rejects drive-relative, incomplete UNC, and non-file URL paths", () => {
    expect(() => normalizeProjectSourcePath("C:Cantrip", "win32")).toThrow(
      /absolute Windows path/u,
    );
    expect(() => normalizeProjectSourcePath("\\\\winterhold", "win32")).toThrow(
      /absolute Windows path/u,
    );
    expect(() =>
      normalizeProjectSourcePath("https://example.test/Cantrip", "win32"),
    ).toThrow(/unsupported URL scheme/u);
  });
});

describe("canonicalProjectSourcePath", () => {
  it("accepts a file URL and verifies that it resolves to a directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-source-path-"));
    temporaryDirectories.push(root);
    const project = path.join(root, "project");
    await mkdir(project);
    const canonicalProject = await canonicalProjectSourcePath(project);

    await expect(
      canonicalProjectSourcePath(pathToFileURL(project).href),
    ).resolves.toBe(canonicalProject);
  });

  it("reconciles observation paths while leaving missing targets unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-source-path-"));
    temporaryDirectories.push(root);
    const project = path.join(root, "project");
    await mkdir(project);
    const fileUrl = pathToFileURL(project).href;
    const missing = path.join(root, "missing");
    const canonicalProject = await canonicalProjectSourcePath(project);

    await expect(
      reconcileProjectObservationPaths([
        {
          projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb349",
          worktreeId: "primary",
          sourcePath: fileUrl,
          worktreePath: fileUrl,
        },
        {
          projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb350",
          worktreeId: "missing",
          sourcePath: missing,
          worktreePath: missing,
        },
      ]),
    ).resolves.toEqual({
      paths: [
        {
          projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb349",
          worktreeId: "primary",
          sourcePath: canonicalProject,
          worktreePath: canonicalProject,
        },
      ],
      targets: [
        {
          projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb349",
          worktreeId: "primary",
          sourcePath: canonicalProject,
          worktreePath: canonicalProject,
        },
        {
          projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb350",
          worktreeId: "missing",
          sourcePath: missing,
          worktreePath: missing,
        },
      ],
    });
  });

  it("rejects a missing source directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-source-path-"));
    temporaryDirectories.push(root);

    await expect(
      canonicalProjectSourcePath(path.join(root, "missing")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
