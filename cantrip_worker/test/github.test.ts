import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GithubClient } from "../src/github.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("GitHub project files", () => {
  it("restores the last repository list for the same GitHub login", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-cache-test-"),
    );
    directories.push(dataDirectory);
    const cacheDirectory = path.join(dataDirectory, "github");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(
      path.join(cacheDirectory, "repositories.json"),
      JSON.stringify({
        login: "cantrip-test",
        updatedAt: "2026-08-07T12:00:00.000Z",
        repositories: [
          {
            id: "repository-1",
            name: "Cantrip",
            nameWithOwner: "ArcaneArts/Cantrip",
            description: "Cached repository",
            isPrivate: true,
            isFork: false,
            url: "https://github.com/ArcaneArts/Cantrip",
            defaultBranch: "main",
            updatedAt: "2026-08-07T12:00:00.000Z",
          },
        ],
      }),
    );

    const github = new GithubClient(dataDirectory);
    await expect(github.cachedRepositories("cantrip-test")).resolves.toEqual([
      expect.objectContaining({ nameWithOwner: "ArcaneArts/Cantrip" }),
    ]);
    await expect(github.cachedRepositories("another-user")).resolves.toEqual(
      [],
    );
  });

  it("only deletes repositories inside the managed repository root", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-test-"),
    );
    directories.push(dataDirectory);
    const repository = path.join(
      dataDirectory,
      "repositories",
      "ArcaneArts",
      "Cantrip",
    );
    const outside = path.join(dataDirectory, "outside");
    await mkdir(repository, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(repository, "README.md"), "Cantrip\n");

    const github = new GithubClient(dataDirectory);
    await expect(github.deleteRepository(outside)).rejects.toThrow(
      "only delete repositories it manages",
    );
    await expect(github.deleteRepository(repository)).resolves.toEqual({
      deleted: true,
    });
    await expect(github.deleteRepository(repository)).resolves.toEqual({
      deleted: false,
    });
  });
});
