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

  it("loads a bounded pull request review surface from the selected worktree", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-pr-detail-"),
    );
    directories.push(dataDirectory);
    const repository = path.join(dataDirectory, "repository");
    await execFileAsync("git", ["init", "-b", "feature/review", repository]);
    const head = "1".repeat(40);
    const base = "2".repeat(40);
    const pullRequest = {
      number: 44,
      title: "Review pull requests",
      state: "open",
      html_url: "https://github.com/ArcaneArts/Cantrip/pull/44",
      user: { login: "author" },
      comments: 1,
      labels: [{ name: "feature", color: "22d3ee" }],
      created_at: "2026-08-10T12:00:00.000Z",
      updated_at: "2026-08-10T13:00:00.000Z",
      closed_at: null,
      body: "Please review.",
      draft: false,
      merged: false,
      head: { ref: "feature/review", sha: head },
      base: { ref: "main", sha: base },
      requested_reviewers: [{ login: "second-reviewer" }],
      mergeable: false,
      mergeable_state: "blocked",
      additions: 12,
      deletions: 3,
      changed_files: 101,
      commits: 101,
    };
    const comments = [
      {
        id: 9,
        user: { login: "commenter" },
        body: "General feedback",
        html_url:
          "https://github.com/ArcaneArts/Cantrip/pull/44#issuecomment-9",
        created_at: "2026-08-10T12:10:00.000Z",
        updated_at: "2026-08-10T12:10:00.000Z",
      },
    ];
    const commits = [
      {
        sha: head,
        html_url: `https://github.com/ArcaneArts/Cantrip/commit/${head}`,
        author: { login: "author" },
        commit: {
          message: "feat: review pull requests\n\nDetails",
          author: {
            name: "Cantrip Author",
            date: "2026-08-10T12:00:00.000Z",
          },
        },
      },
    ];
    const files = [
      {
        sha: "3".repeat(40),
        filename: "src/review.ts",
        previous_filename: "src/old-review.ts",
        status: "renamed",
        additions: 12,
        deletions: 3,
        changes: 15,
        blob_url:
          "https://github.com/ArcaneArts/Cantrip/blob/feature/review/src/review.ts",
        raw_url: null,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ];
    const checkRuns = {
      total_count: 1,
      check_runs: [
        {
          id: 10,
          name: "test",
          status: "completed",
          conclusion: "failure",
          details_url: "https://github.com/ArcaneArts/Cantrip/actions/runs/10",
          started_at: "2026-08-10T12:01:00.000Z",
          completed_at: "2026-08-10T12:03:00.000Z",
          output: { title: "Tests failed", summary: "One failure" },
        },
      ],
    };
    const statuses = {
      statuses: [
        {
          id: 11,
          context: "deploy",
          state: "pending",
          description: "Waiting",
          target_url: "https://github.com/ArcaneArts/Cantrip/deployments/11",
          created_at: "2026-08-10T12:02:00.000Z",
          updated_at: "2026-08-10T12:02:00.000Z",
        },
      ],
    };
    const reviews = [
      {
        id: 12,
        user: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        body: "Please revise this.",
        commit_id: head,
        html_url:
          "https://github.com/ArcaneArts/Cantrip/pull/44#pullrequestreview-12",
        submitted_at: "2026-08-10T12:30:00.000Z",
      },
    ];
    const reviewComments = [
      {
        id: 20,
        pull_request_review_id: 12,
        user: { login: "reviewer" },
        body: "Rename this symbol.",
        html_url:
          "https://github.com/ArcaneArts/Cantrip/pull/44#discussion_r20",
        path: "src/review.ts",
        line: 4,
        side: "RIGHT",
        start_line: null,
        start_side: null,
        diff_hunk: "@@ -3,2 +3,2 @@",
        in_reply_to_id: null,
        created_at: "2026-08-10T12:31:00.000Z",
        updated_at: "2026-08-10T12:31:00.000Z",
      },
      {
        id: 21,
        pull_request_review_id: 12,
        user: { login: "author" },
        body: "Done.",
        html_url:
          "https://github.com/ArcaneArts/Cantrip/pull/44#discussion_r21",
        path: "src/review.ts",
        line: 4,
        side: "RIGHT",
        start_line: null,
        start_side: null,
        diff_hunk: "@@ -3,2 +3,2 @@",
        in_reply_to_id: 20,
        created_at: "2026-08-10T12:32:00.000Z",
        updated_at: "2026-08-10T12:32:00.000Z",
      },
    ];
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
        'const route = args[1] || "";',
        `if (route.endsWith("/pulls/44")) process.stdout.write(${JSON.stringify(JSON.stringify(pullRequest))});`,
        `else if (route.endsWith("/issues/44/comments")) process.stdout.write(${JSON.stringify(JSON.stringify(comments))});`,
        `else if (route.endsWith("/pulls/44/commits")) process.stdout.write(${JSON.stringify(JSON.stringify(commits))});`,
        `else if (route.endsWith("/pulls/44/files")) process.stdout.write(${JSON.stringify(JSON.stringify(files))});`,
        `else if (route.endsWith("/check-runs")) process.stdout.write(${JSON.stringify(JSON.stringify(checkRuns))});`,
        `else if (route.endsWith("/status")) process.stdout.write(${JSON.stringify(JSON.stringify(statuses))});`,
        `else if (route.endsWith("/pulls/44/reviews")) process.stdout.write(${JSON.stringify(JSON.stringify(reviews))});`,
        `else if (route.endsWith("/pulls/44/comments")) process.stdout.write(${JSON.stringify(JSON.stringify(reviewComments))});`,
        'else process.stdout.write("{}");',
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;

    const github = new GithubClient(dataDirectory);
    await expect(
      github.getPullRequest("ArcaneArts/Cantrip", repository, 44),
    ).resolves.toMatchObject({
      number: 44,
      mergeable: false,
      reviewDecision: "changes-requested",
      checksState: "failure",
      commitCount: 101,
      commitsTruncated: true,
      changedFileCount: 101,
      filesTruncated: true,
      comments: [{ author: "commenter" }],
      commits: [{ author: "Cantrip Author" }],
      files: [{ path: "src/review.ts", previousPath: "src/old-review.ts" }],
      checks: [
        { name: "test", conclusion: "failure" },
        { name: "deploy", status: "in-progress" },
      ],
      reviews: [{ author: "reviewer", state: "changes-requested" }],
      reviewThreads: [
        {
          path: "src/review.ts",
          line: 4,
          comments: [{ id: 20 }, { id: 21, inReplyToId: 20 }],
        },
      ],
    });
    const invocations = await readFile(logPath, "utf8");
    expect(invocations).toContain(`/commits/${head}/check-runs`);
    expect(invocations).toContain("per_page=100");
    await github.commentOnPullRequest(
      "ArcaneArts/Cantrip",
      repository,
      44,
      "General feedback",
    );
    await github.submitPullRequestReview("ArcaneArts/Cantrip", repository, 44, {
      event: "request-changes",
      body: "Please revise.",
    });
    await github.commentOnPullRequestLine(
      "ArcaneArts/Cantrip",
      repository,
      44,
      {
        body: "Inline feedback",
        path: "src/review.ts",
        line: 4,
        side: "RIGHT",
        startLine: null,
        startSide: null,
      },
    );
    await github.replyToPullRequestReview(
      "ArcaneArts/Cantrip",
      repository,
      44,
      20,
      "Updated.",
    );
    const mutationInvocations = await readFile(logPath, "utf8");
    expect(mutationInvocations).toContain("body=General feedback");
    expect(mutationInvocations).toContain("event=REQUEST_CHANGES");
    expect(mutationInvocations).toContain(`commit_id=${head}`);
    expect(mutationInvocations).toContain("path=src/review.ts");
    expect(mutationInvocations).toContain("line=4");
    expect(mutationInvocations).toContain("/comments/20/replies");
    await expect(
      github.getPullRequest("ArcaneArts/Cantrip", "/missing/worktree", 44),
    ).rejects.toThrow();
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
