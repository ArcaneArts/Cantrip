import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  gitActionResultSchema,
  gitFileDiffSchema,
  gitHistorySchema,
  gitStatusSchema,
  type GitAction,
  type GitActionResult,
  type GitDiffScope,
  type GitFileDiff,
  type GitHistory,
  type GitRef,
  type GitStatus,
} from "@cantrip/protocol";

const execFileAsync = promisify(execFile);
const GIT_BUFFER = 16 * 1024 * 1024;
const DIFF_CHARACTER_LIMIT = 2_000_000;

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: GIT_BUFFER,
  });
  return stdout.trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: GIT_BUFFER,
  });
  return stdout;
}

async function gitDiffOutput(
  cwd: string,
  args: string[],
  allowDifferenceExit: boolean,
): Promise<{ output: string; truncated: boolean }> {
  try {
    return { output: await gitRaw(cwd, args), truncated: false };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
    };
    if (allowDifferenceExit && failure.code === 1) {
      return { output: failure.stdout ?? "", truncated: false };
    }
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { output: failure.stdout ?? "", truncated: true };
    }
    throw error;
  }
}

function safeGitPath(candidate: string): boolean {
  return (
    candidate.length > 0 &&
    !candidate.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/u.test(candidate) &&
    !candidate.split(/[\\/]/u).includes("..") &&
    !candidate.includes("\0")
  );
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", maxBuffer: GIT_BUFFER },
    );
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    const failure = error as {
      message?: string;
      stderr?: string;
      stdout?: string;
    };
    throw new Error(
      failure.stderr?.trim() ||
        failure.stdout?.trim() ||
        failure.message ||
        "Git command failed.",
    );
  }
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: GIT_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

function parseRefs(
  decorations: string,
  branch: string,
  remoteNames: Set<string>,
): GitRef[] {
  const refs = new Map<string, GitRef>();
  const add = (name: string, kind: GitRef["kind"], current = false) => {
    const key = `${kind}:${name}`;
    refs.set(key, {
      name,
      kind,
      current: current || refs.get(key)?.current === true,
    });
  };
  const classify = (name: string): GitRef["kind"] =>
    remoteNames.has(name.split("/")[0] ?? "") ? "remote" : "local";

  for (const rawDecoration of decorations.split(",")) {
    const decoration = rawDecoration.trim();
    if (!decoration) continue;
    if (decoration.startsWith("tag: ")) {
      add(decoration.slice(5), "tag");
      continue;
    }
    if (decoration === "HEAD") {
      add("HEAD", "head", true);
      continue;
    }
    if (decoration.startsWith("HEAD -> ")) {
      const name = decoration.slice(8);
      add("HEAD", "head", true);
      add(name, "local", name === branch);
      continue;
    }
    const arrow = decoration.indexOf(" -> ");
    if (arrow >= 0) {
      const source = decoration.slice(0, arrow);
      const target = decoration.slice(arrow + 4);
      add(source, classify(source));
      add(target, classify(target));
      continue;
    }
    add(decoration, classify(decoration), decoration === branch);
  }
  return [...refs.values()];
}

export async function readGitHistory(
  cwd: string,
  limit: number,
  cursor = 0,
  revisions: string[] = [],
): Promise<GitHistory> {
  const verifiedRevisions = (
    await Promise.all(
      [...new Set(revisions)].map(async (revision) => ({
        revision,
        exists: await gitSucceeds(cwd, [
          "cat-file",
          "-e",
          `${revision}^{commit}`,
        ]),
      })),
    )
  )
    .filter(({ exists }) => exists)
    .map(({ revision }) => revision);
  const revisionArgs = ["--all", ...verifiedRevisions];
  const [branch, head, remotes, totalCountText] = await Promise.all([
    gitOutput(cwd, ["branch", "--show-current"]),
    gitOutput(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => ""),
    gitOutput(cwd, ["remote"]).catch(() => ""),
    gitOutput(cwd, ["rev-list", "--count", ...revisionArgs]).catch(() => "0"),
  ]);
  const remoteNames = new Set(remotes.split("\n").filter(Boolean));
  let logOutput = "";
  try {
    logOutput = await gitOutput(cwd, [
      "log",
      "--all",
      "--topo-order",
      "--date-order",
      `--skip=${cursor}`,
      `--max-count=${limit + 1}`,
      "--date=iso-strict",
      "--pretty=format:%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%D%x1e",
      ...revisionArgs,
    ]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (!stderr.includes("does not have any commits yet")) throw error;
  }

  const parsed = logOutput
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [
        hash,
        shortHash,
        parents,
        authorName,
        authorEmail,
        authoredAt,
        subject,
        decorations,
      ] = record.split("\x00");
      return {
        hash,
        shortHash,
        parents: (parents ?? "").split(" ").filter(Boolean),
        authorName,
        authorEmail,
        authoredAt,
        subject: subject ?? "",
        refs: parseRefs(decorations ?? "", branch, remoteNames),
        isHead: hash === head,
      };
    });
  const hasMore = parsed.length > limit;
  const commits = parsed.slice(0, limit);
  return gitHistorySchema.parse({
    branch,
    head: head || null,
    totalCount: Number.parseInt(totalCountText, 10) || 0,
    commits,
    hasMore,
    nextCursor: hasMore ? cursor + commits.length : null,
  });
}

export async function readGitStatus(cwd: string): Promise<GitStatus> {
  const [branch, head, upstream, porcelain, branchOutput] = await Promise.all([
    gitOutput(cwd, ["branch", "--show-current"]),
    gitOutput(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => ""),
    gitOutput(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]).catch(() => ""),
    gitRaw(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    gitRaw(cwd, [
      "for-each-ref",
      "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(symref)",
      "refs/heads",
      "refs/remotes",
    ]),
  ]);

  let ahead = 0;
  let behind = 0;
  if (head && upstream) {
    const counts = await gitOutput(cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${upstream}`,
    ]).catch(() => "0\t0");
    const [aheadText, behindText] = counts.split(/\s+/);
    ahead = Number.parseInt(aheadText ?? "0", 10) || 0;
    behind = Number.parseInt(behindText ?? "0", 10) || 0;
  }

  const records = porcelain.split("\0");
  const files: GitStatus["files"] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const indexStatus = record[0]!;
    const worktreeStatus = record[1]!;
    const path = record.slice(3);
    let originalPath: string | null = null;
    if (/[RC]/.test(`${indexStatus}${worktreeStatus}`)) {
      originalPath = records[index + 1] || null;
      index += 1;
    }
    const conflicted =
      /U/.test(`${indexStatus}${worktreeStatus}`) ||
      ["DD", "AA"].includes(`${indexStatus}${worktreeStatus}`);
    files.push({
      path,
      originalPath,
      indexStatus,
      worktreeStatus,
      staged: conflicted || (indexStatus !== " " && indexStatus !== "?"),
      unstaged: conflicted || worktreeStatus !== " ",
    });
  }

  const branches = branchOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [refName, name, hash, branchUpstream, current, symbolicTarget] =
        line.split("\0");
      if (!refName || !name || !hash || symbolicTarget) return [];
      return [
        {
          name,
          kind: refName.startsWith("refs/remotes/")
            ? ("remote" as const)
            : ("local" as const),
          current: current === "*",
          hash,
          upstream: branchUpstream || null,
        },
      ];
    })
    .sort((left, right) => {
      if (left.current !== right.current) return left.current ? -1 : 1;
      if (left.kind !== right.kind) return left.kind === "local" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  return gitStatusSchema.parse({
    branch,
    head: head || null,
    upstream: upstream || null,
    ahead,
    behind,
    files,
    branches,
  });
}

export async function readGitFileDiff(
  cwd: string,
  filePath: string,
  scope: GitDiffScope,
): Promise<GitFileDiff> {
  if (!safeGitPath(filePath)) throw new Error("Invalid Git diff path.");
  const status = await readGitStatus(cwd);
  const change = status.files.find(({ path }) => path === filePath);
  if (!change || (scope === "staged" ? !change.staged : !change.unstaged)) {
    throw new Error(`No ${scope} change exists for ${filePath}.`);
  }

  const commonArguments = [
    "--literal-pathspecs",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=3",
  ];
  const untracked = change.indexStatus === "?" && change.worktreeStatus === "?";
  const result =
    scope === "unstaged" && untracked
      ? await gitDiffOutput(
          cwd,
          [...commonArguments, "--no-index", "--", "/dev/null", filePath],
          true,
        )
      : await gitDiffOutput(
          cwd,
          [
            ...commonArguments,
            ...(scope === "staged" ? ["--cached"] : []),
            "--",
            filePath,
          ],
          false,
        );
  const truncated =
    result.truncated || result.output.length > DIFF_CHARACTER_LIMIT;
  return gitFileDiffSchema.parse({
    path: filePath,
    scope,
    patch: result.output.slice(0, DIFF_CHARACTER_LIMIT),
    truncated,
  });
}

async function unstage(cwd: string, paths: string[] | null): Promise<string> {
  const hasHead = await gitSucceeds(cwd, ["rev-parse", "--verify", "HEAD"]);
  if (hasHead) {
    return runGit(
      cwd,
      paths
        ? ["reset", "--quiet", "HEAD", "--", ...paths]
        : ["reset", "--quiet", "HEAD"],
    );
  }
  return runGit(cwd, [
    "rm",
    "--cached",
    "-r",
    "--ignore-unmatch",
    "--",
    ...(paths ?? ["."]),
  ]);
}

async function discardUnstaged(
  cwd: string,
  paths: string[] | null,
): Promise<string> {
  const status = await readGitStatus(cwd);
  const requested = paths ? new Set(paths) : null;
  const changes = status.files.filter(
    (change) => change.unstaged && (!requested || requested.has(change.path)),
  );
  if (requested) {
    const found = new Set(changes.map(({ path }) => path));
    const missing = (paths ?? []).filter((candidate) => !found.has(candidate));
    if (missing.length > 0) {
      throw new Error(`No unstaged change exists for ${missing.join(", ")}.`);
    }
  }
  if (
    changes.some(
      (change) =>
        /U/u.test(`${change.indexStatus}${change.worktreeStatus}`) ||
        ["DD", "AA"].includes(`${change.indexStatus}${change.worktreeStatus}`),
    )
  ) {
    throw new Error("Resolve conflicts before discarding unstaged changes.");
  }
  const untracked = changes
    .filter(
      (change) => change.indexStatus === "?" && change.worktreeStatus === "?",
    )
    .map(({ path }) => path);
  const tracked = changes
    .filter(
      (change) =>
        !(change.indexStatus === "?" && change.worktreeStatus === "?"),
    )
    .map(({ path }) => path);
  const output: string[] = [];
  if (tracked.length > 0) {
    output.push(
      await runGit(cwd, [
        "--literal-pathspecs",
        "restore",
        "--worktree",
        "--",
        ...tracked,
      ]),
    );
  }
  if (untracked.length > 0) {
    output.push(
      await runGit(cwd, [
        "--literal-pathspecs",
        "clean",
        "-f",
        "--",
        ...untracked,
      ]),
    );
  }
  return output.filter(Boolean).join("\n");
}

export async function runGitAction(
  cwd: string,
  action: GitAction,
): Promise<GitActionResult> {
  let output = "";
  switch (action.type) {
    case "stage":
      output = await runGit(cwd, ["add", "--", ...action.paths]);
      break;
    case "unstage":
      output = await unstage(cwd, action.paths);
      break;
    case "discard":
      output = await discardUnstaged(cwd, action.paths);
      break;
    case "stageAll":
      output = await runGit(cwd, ["add", "-A"]);
      break;
    case "unstageAll":
      output = await unstage(cwd, null);
      break;
    case "discardAll":
      output = await discardUnstaged(cwd, null);
      break;
    case "commit":
      if (action.all) await runGit(cwd, ["add", "-A"]);
      output = await runGit(cwd, ["commit", "-m", action.message]);
      break;
    case "pull":
      output = [
        await runGit(cwd, ["fetch", "--all", "--prune"]),
        await runGit(cwd, ["pull", "--ff-only"]),
      ]
        .filter(Boolean)
        .join("\n");
      break;
    case "push": {
      const upstream = await gitOutput(cwd, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]).catch(() => "");
      if (upstream) {
        output = await runGit(cwd, ["push"]);
        break;
      }
      const branch = await gitOutput(cwd, ["branch", "--show-current"]);
      if (!branch) throw new Error("Cannot push a detached HEAD.");
      const remotes = (await gitOutput(cwd, ["remote"]))
        .split("\n")
        .filter(Boolean);
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      if (!remote) throw new Error("This repository has no Git remote.");
      output = await runGit(cwd, ["push", "--set-upstream", remote, branch]);
      break;
    }
    case "checkout": {
      await runGit(cwd, ["check-ref-format", "--branch", action.branch]);
      const local = await gitSucceeds(cwd, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${action.branch}`,
      ]);
      const remote = await gitSucceeds(cwd, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/remotes/${action.branch}`,
      ]);
      if (!local && remote) {
        const localName = action.branch.split("/").slice(1).join("/");
        const trackingBranchExists =
          Boolean(localName) &&
          (await gitSucceeds(cwd, [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${localName}`,
          ]));
        output = await runGit(
          cwd,
          trackingBranchExists
            ? ["switch", localName]
            : ["switch", "--track", action.branch],
        );
      } else {
        output = await runGit(cwd, ["switch", action.branch]);
      }
      break;
    }
    case "createBranch":
      await runGit(cwd, ["check-ref-format", "--branch", action.name]);
      output = await runGit(cwd, ["switch", "-c", action.name]);
      break;
  }

  return gitActionResultSchema.parse({
    status: await readGitStatus(cwd),
    output,
  });
}
