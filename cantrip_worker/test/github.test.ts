import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GithubClient, readProjectWorktreePolicy } from "../src/github.js";

const directories: string[] = [];
const originalPath = process.env.PATH;
const execFileAsync = promisify(execFile);

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("GitHub project files", () => {
  it("reads an optional repository worktree policy without trusting invalid files", async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), "cantrip-project-policy-test-"),
    );
    directories.push(repository);
    const policyDirectory = path.join(repository, ".cantrip");
    await mkdir(policyDirectory);
    const policyPath = path.join(policyDirectory, "project.json");
    await writeFile(
      policyPath,
      JSON.stringify({ worktreePolicy: "required-for-writes" }),
    );
    await expect(readProjectWorktreePolicy(repository)).resolves.toEqual({
      policy: "required-for-writes",
      warning: null,
    });

    await writeFile(policyPath, JSON.stringify({ worktreePolicy: "unsafe" }));
    await expect(readProjectWorktreePolicy(repository)).resolves.toEqual({
      policy: null,
      warning: expect.stringContaining("worktreePolicy is invalid"),
    });
  });
  it("lists issues and pull requests separately and supports issue detail mutations", async () => {
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
        `  *"/issues --method GET -f per_page=50 -f page=2"*) printf '%s' '${JSON.stringify([JSON.parse(issue), JSON.parse(pullRequest)])}' ;;`,
        "  *) exit 1 ;;",
        "esac",
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;

    const github = new GithubClient(dataDirectory);
    await expect(
      github.listIssues("ArcaneArts/Cantrip", "issue", "open", 2, 50),
    ).resolves.toMatchObject({
      kind: "issue",
      total: 1,
      issues: [{ number: 42 }],
      nextPage: null,
    });
    await expect(
      github.listIssues("ArcaneArts/Cantrip", "pull-request", "open", 2, 50),
    ).resolves.toMatchObject({
      kind: "pull-request",
      total: 1,
      issues: [{ number: 43 }],
      nextPage: null,
    });
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

  it("creates pull requests only from an exactly published local branch", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-pr-create-"),
    );
    directories.push(dataDirectory);
    const repository = path.join(dataDirectory, "repository");
    await execFileAsync("git", ["init", "-b", "feature/pr-ui", repository]);
    await execFileAsync("git", [
      "-C",
      repository,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      repository,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(repository, "README.md"), "Cantrip\n");
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "Feature"]);
    const head = (
      await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])
    ).stdout.trim();
    const base = "2".repeat(40);
    const pullRequest = {
      number: 44,
      title: "Add PR creation",
      state: "open",
      html_url: "https://github.com/ArcaneArts/Cantrip/pull/44",
      user: { login: "author" },
      comments: 0,
      labels: [],
      created_at: "2026-08-10T12:00:00.000Z",
      updated_at: "2026-08-10T12:00:00.000Z",
      closed_at: null,
      body: "Ready for review.\n\nCloses #42",
      draft: true,
      merged: false,
      head: { ref: "feature/pr-ui", sha: head },
      base: { ref: "main", sha: base },
    };
    const binDirectory = path.join(dataDirectory, "bin");
    const logPath = path.join(dataDirectory, "gh.log");
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const log = ${JSON.stringify(logPath)};`,
        'const args = process.argv.slice(2); fs.appendFileSync(log, args.join("\\0") + "\\n");',
        'const path = args[1] || "";',
        `if (path.includes("/git/ref/heads/feature/pr-ui")) process.stdout.write(${JSON.stringify(JSON.stringify({ object: { sha: head } }))});`,
        `else if (path.endsWith("/pulls")) process.stdout.write(${JSON.stringify(JSON.stringify(pullRequest))});`,
        'else process.stdout.write("{}");',
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;

    const github = new GithubClient(dataDirectory);
    const created = await github.createPullRequest(
      "ArcaneArts/Cantrip",
      repository,
      {
        base: "main",
        head: "feature/pr-ui",
        title: "Add PR creation",
        body: "Ready for review.",
        draft: true,
        labels: ["feature", "feature"],
        reviewers: ["reviewer"],
        linkedIssueNumbers: [42, 42],
      },
    );
    expect(created).toMatchObject({
      pullRequest: {
        number: 44,
        draft: true,
        headRef: "feature/pr-ui",
        baseRef: "main",
      },
      warnings: [],
    });
    const invocations = await readFile(logPath, "utf8");
    expect(invocations).toContain("body=Ready for review.\n\nCloses #42");
    expect(invocations).toContain("draft=true");
    expect(invocations.match(/labels\[\]=feature/gu)).toHaveLength(1);
    expect(invocations).toContain("reviewers[]=reviewer");

    await writeFile(path.join(repository, "README.md"), "Changed locally\n");
    await execFileAsync("git", [
      "-C",
      repository,
      "commit",
      "-am",
      "Local only",
    ]);
    await expect(
      github.createPullRequest("ArcaneArts/Cantrip", repository, {
        base: "main",
        head: "feature/pr-ui",
        title: "Stale head",
        body: "",
        draft: false,
        labels: [],
        reviewers: [],
        linkedIssueNumbers: [],
      }),
    ).rejects.toThrow("local and GitHub branch tips must match");
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
