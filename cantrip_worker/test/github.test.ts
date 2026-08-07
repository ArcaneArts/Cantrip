import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GithubClient } from "../src/github.js";

const directories: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("GitHub project files", () => {
  it("lists issue-only results and supports issue detail mutations", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-issues-test-"),
    );
    directories.push(dataDirectory);
    const binDirectory = path.join(dataDirectory, "bin");
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    const issue = JSON.stringify({
      number: 42,
      title: "Issue title",
      state: "open",
      html_url: "https://github.com/ArcaneArts/Cantrip/issues/42",
      user: { login: "author" },
      comments: 1,
      labels: [{ name: "feature", color: "22d3ee" }],
      created_at: "2026-08-07T12:00:00.000Z",
      updated_at: "2026-08-07T13:00:00.000Z",
      closed_at: null,
      body: "Issue body",
    });
    const pullRequest = JSON.stringify({
      ...JSON.parse(issue),
      number: 43,
      pull_request: { url: "https://api.github.com/pulls/43" },
    });
    const comment = JSON.stringify({
      id: 99,
      user: { login: "reviewer" },
      body: "A comment",
      html_url:
        "https://github.com/ArcaneArts/Cantrip/issues/42#issuecomment-99",
      created_at: "2026-08-07T12:30:00.000Z",
      updated_at: "2026-08-07T12:30:00.000Z",
    });
    await writeFile(
      fakeGh,
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *"/issues/42/comments --method GET"*) printf '%s' '${JSON.stringify([[JSON.parse(comment)]])}' ;;`,
        `  *"/issues/42/comments --method POST"*) printf '%s' '${comment}' ;;`,
        `  *"/issues/42 --method PATCH"*) printf '%s' '${issue}' ;;`,
        `  *"/issues/42"*) printf '%s' '${issue}' ;;`,
        `  *"/issues --method GET"*) printf '%s' '${JSON.stringify([[JSON.parse(issue), JSON.parse(pullRequest)]])}' ;;`,
        "  *) exit 1 ;;",
        "esac",
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;

    const github = new GithubClient(dataDirectory);
    await expect(
      github.listIssues("ArcaneArts/Cantrip", "open"),
    ).resolves.toMatchObject({ total: 1, issues: [{ number: 42 }] });
    await expect(
      github.getIssue("ArcaneArts/Cantrip", 42),
    ).resolves.toMatchObject({
      body: "Issue body",
      comments: [{ author: "reviewer", body: "A comment" }],
    });
    await expect(
      github.commentOnIssue("ArcaneArts/Cantrip", 42, "New comment"),
    ).resolves.toMatchObject({ number: 42 });
    await expect(
      github.closeIssue("ArcaneArts/Cantrip", 42, "Closing"),
    ).resolves.toMatchObject({ number: 42 });
  });

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
