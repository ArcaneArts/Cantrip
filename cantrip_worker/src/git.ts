import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import {
  gitActionResultSchema,
  gitComparisonSchema,
  gitCommitDetailSchema,
  gitFileDiffSchema,
  gitHistorySchema,
  gitPartialPatchPreviewSchema,
  gitRevisionFileDiffSchema,
  gitRevisionCandidateListSchema,
  gitStatusSchema,
  type GitAction,
  type GitActionResult,
  type GitComparison,
  type GitComparisonCommit,
  type GitComparisonMode,
  type GitCommitDetail,
  type GitCommitFile,
  type GitDiffScope,
  type GitFileDiff,
  type GitHistory,
  type GitPartialPatchPreview,
  type GitPartialPatchRequest,
  type GitRef,
  type GitRevisionFileDiff,
  type GitRevisionCandidate,
  type GitSignature,
  type GitStatus,
} from "@cantrip/protocol";

const execFileAsync = promisify(execFile);
const GIT_BUFFER = 16 * 1024 * 1024;
const DIFF_CHARACTER_LIMIT = 2_000_000;
const COMMIT_MESSAGE_CHARACTER_LIMIT = 1_000_000;
const COMMIT_FILE_LIMIT = 100_000;

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

async function runGitWithInput(
  cwd: string,
  args: string[],
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputLength = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
      outputLength += chunk.length;
      if (outputLength > GIT_BUFFER) {
        child.kill();
        fail(new Error("Git patch output exceeded the safety limit."));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(`${stdout}${stderr}`.trim());
      else
        reject(
          new Error(stderr.trim() || stdout.trim() || "Git patch failed."),
        );
    });
    child.stdin.end(input);
  });
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

function signatureStatus(code: string): GitSignature["status"] {
  switch (code) {
    case "G":
      return "valid";
    case "U":
      return "valid-unknown";
    case "B":
      return "invalid";
    case "X":
    case "Y":
      return "expired";
    case "R":
      return "revoked";
    case "E":
      return "unverifiable";
    default:
      return "unsigned";
  }
}

function commitFileStatus(code: string): GitCommitFile["status"] {
  switch (code[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
}

function parseNameStatus(output: string): Array<{
  path: string;
  originalPath: string | null;
  status: GitCommitFile["status"];
}> {
  const fields = output.split("\0");
  const files: Array<{
    path: string;
    originalPath: string | null;
    status: GitCommitFile["status"];
  }> = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++] ?? "";
    if (!code) continue;
    const renamed = code.startsWith("R") || code.startsWith("C");
    const originalPath = renamed ? (fields[index++] ?? null) : null;
    const path = fields[index++] ?? "";
    if (!path || !safeGitPath(path)) continue;
    files.push({ path, originalPath, status: commitFileStatus(code) });
  }
  return files;
}

function parseNumstat(output: string): Map<
  string,
  {
    additions: number | null;
    deletions: number | null;
    originalPath: string | null;
  }
> {
  const fields = output.split("\0");
  const stats = new Map<
    string,
    {
      additions: number | null;
      deletions: number | null;
      originalPath: string | null;
    }
  >();
  for (let index = 0; index < fields.length;) {
    const record = fields[index++] ?? "";
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsText = record.slice(0, firstTab);
    const deletionsText = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    let originalPath: string | null = null;
    if (!path) {
      originalPath = fields[index++] ?? null;
      path = fields[index++] ?? "";
    }
    if (!path || !safeGitPath(path)) continue;
    stats.set(path, {
      additions:
        additionsText === "-" ? null : Number.parseInt(additionsText, 10) || 0,
      deletions:
        deletionsText === "-" ? null : Number.parseInt(deletionsText, 10) || 0,
      originalPath,
    });
  }
  return stats;
}

function commitDiffArguments(
  baseHash: string | null,
  hash: string,
  format: "name-status" | "numstat",
): string[] {
  const formatArguments = [
    format === "name-status" ? "--name-status" : "--numstat",
    "-z",
    "-M",
    "-C",
  ];
  return baseHash
    ? ["diff", ...formatArguments, baseHash, hash]
    : ["diff-tree", "--root", "--no-commit-id", "-r", ...formatArguments, hash];
}

async function readCommitFiles(
  cwd: string,
  baseHash: string | null,
  hash: string,
): Promise<{ files: GitCommitFile[]; total: number; truncated: boolean }> {
  const [names, numstat] = await Promise.all([
    gitRaw(cwd, commitDiffArguments(baseHash, hash, "name-status")),
    gitRaw(cwd, commitDiffArguments(baseHash, hash, "numstat")),
  ]);
  const stats = parseNumstat(numstat);
  const parsed = parseNameStatus(names);
  return {
    files: parsed.slice(0, COMMIT_FILE_LIMIT).map((file) => {
      const stat = stats.get(file.path);
      const additions = stat?.additions ?? null;
      const deletions = stat?.deletions ?? null;
      return {
        ...file,
        originalPath: file.originalPath ?? stat?.originalPath ?? null,
        additions,
        deletions,
        binary: additions === null || deletions === null,
      };
    }),
    total: parsed.length,
    truncated: parsed.length > COMMIT_FILE_LIMIT,
  };
}

async function resolveCommit(cwd: string, revision: string): Promise<string> {
  const hash = await gitOutput(cwd, [
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]).catch(() => "");
  if (!/^[0-9a-f]{40,64}$/u.test(hash)) {
    throw new Error(`Commit ${revision} does not exist.`);
  }
  return hash;
}

async function commitChildren(
  cwd: string,
  hash: string,
  revisions: string[],
): Promise<string[]> {
  const verified = (
    await Promise.all(
      [...new Set(revisions)].map(async (revision) => ({
        revision,
        valid: await gitSucceeds(cwd, [
          "cat-file",
          "-e",
          `${revision}^{commit}`,
        ]),
      })),
    )
  )
    .filter(({ valid }) => valid)
    .map(({ revision }) => revision);
  const output = await gitRaw(cwd, [
    "rev-list",
    "--children",
    "--all",
    ...verified,
  ]).catch(() => "");
  const children = new Set<string>();
  for (const line of output.split("\n")) {
    const [commit, ...values] = line.trim().split(/\s+/u);
    if (commit !== hash) continue;
    for (const child of values) {
      if (/^[0-9a-f]{40,64}$/u.test(child)) children.add(child);
    }
  }
  return [...children].slice(0, 10_000);
}

export async function readGitCommitDetail(
  cwd: string,
  revision: string,
  parentIndex = 0,
  revisions: string[] = [],
): Promise<GitCommitDetail> {
  const hash = await resolveCommit(cwd, revision);
  const metadata = await gitRaw(cwd, [
    "show",
    "-s",
    "--date=iso-strict",
    "--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%B%x00%D%x00%G?%x00%GS%x00%GK%x00%GF",
    hash,
  ]);
  const [
    fullHash,
    shortHash,
    parentText,
    authorName,
    authorEmail,
    authoredAt,
    committerName,
    committerEmail,
    committedAt,
    subject,
    fullMessage = "",
    decorations = "",
    signatureCode = "N",
    signatureSigner = "",
    signatureKey = "",
    signatureFingerprint = "",
  ] = metadata.trimEnd().split("\0");
  const parents = (parentText ?? "").split(" ").filter(Boolean);
  if (parents.length > 0 && parentIndex >= parents.length) {
    throw new Error(
      `Commit ${revision} does not have parent ${parentIndex + 1}.`,
    );
  }
  const selectedParentIndex = parents.length > 0 ? parentIndex : null;
  const baseHash = selectedParentIndex === null ? null : parents[parentIndex]!;
  const branch = await gitOutput(cwd, ["branch", "--show-current"]);
  const remotes = new Set(
    (await gitOutput(cwd, ["remote"]).catch(() => ""))
      .split("\n")
      .filter(Boolean),
  );
  const [{ files, total, truncated }, children] = await Promise.all([
    readCommitFiles(cwd, baseHash, hash),
    commitChildren(cwd, hash, revisions),
  ]);
  const messageTruncated = fullMessage.length > COMMIT_MESSAGE_CHARACTER_LIMIT;
  return gitCommitDetailSchema.parse({
    hash: fullHash,
    shortHash,
    subject,
    message: fullMessage.slice(0, COMMIT_MESSAGE_CHARACTER_LIMIT),
    messageTruncated,
    parents,
    children,
    parentIndex: selectedParentIndex,
    baseHash,
    author: { name: authorName, email: authorEmail, date: authoredAt },
    committer: {
      name: committerName,
      email: committerEmail,
      date: committedAt,
    },
    signature: {
      status: signatureStatus(signatureCode),
      signer: signatureSigner || null,
      key: signatureKey || null,
      fingerprint: signatureFingerprint || null,
    },
    refs: parseRefs(decorations, branch, remotes),
    files,
    filesTruncated: truncated,
    filesChanged: total,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  });
}

export async function readGitRevisionCandidates(
  cwd: string,
): Promise<GitRevisionCandidate[]> {
  const [head, refs] = await Promise.all([
    resolveCommit(cwd, "HEAD").catch(() => ""),
    gitRaw(cwd, [
      "for-each-ref",
      "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(HEAD)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]),
  ]);
  const candidates: GitRevisionCandidate[] = [];
  if (head) {
    candidates.push({
      revision: head,
      hash: head,
      shortHash: head.slice(0, 10),
      name: "HEAD",
      kind: "head",
      current: true,
      worktreeId: null,
      worktreeName: null,
    });
  }
  for (const line of refs.split("\n")) {
    if (!line) continue;
    const [
      refName,
      shortName,
      objectHash,
      objectType,
      peeledHash,
      peeledType,
      current,
    ] = line.split("\0");
    const hash = peeledType === "commit" ? peeledHash : objectHash;
    if (
      !refName ||
      !shortName ||
      (peeledType !== "commit" && objectType !== "commit") ||
      !hash ||
      !/^[0-9a-f]{40,64}$/u.test(hash)
    ) {
      continue;
    }
    candidates.push({
      revision: hash,
      hash,
      shortHash: hash.slice(0, 10),
      name: shortName,
      kind: refName.startsWith("refs/tags/")
        ? "tag"
        : refName.startsWith("refs/remotes/")
          ? "remote"
          : "local",
      current: current === "*",
      worktreeId: null,
      worktreeName: null,
    });
    if (candidates.length >= 20_000) break;
  }
  return gitRevisionCandidateListSchema.parse(candidates);
}

async function readComparisonCommits(
  cwd: string,
  include: string,
  exclude: string,
): Promise<{ commits: GitComparisonCommit[]; truncated: boolean }> {
  const output = await gitRaw(cwd, [
    "log",
    "--topo-order",
    "--date=iso-strict",
    "--max-count=101",
    "--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s%x1e",
    include,
    `^${exclude}`,
  ]);
  const parsed = output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .flatMap((record): GitComparisonCommit[] => {
      const [hash, shortHash, authorName, authoredAt, subject = ""] =
        record.split("\0");
      return hash && shortHash && authorName && authoredAt
        ? [{ hash, shortHash, authorName, authoredAt, subject }]
        : [];
    });
  return {
    commits: parsed.slice(0, 100),
    truncated: parsed.length > 100,
  };
}

export async function readGitComparison(
  cwd: string,
  leftRevision: string,
  rightRevision: string,
  mode: GitComparisonMode,
): Promise<GitComparison> {
  const [left, right] = await Promise.all([
    resolveCommit(cwd, leftRevision),
    resolveCommit(cwd, rightRevision),
  ]);
  const mergeBase = await gitOutput(cwd, ["merge-base", left, right]).catch(
    () => "",
  );
  const hasMergeBase = /^[0-9a-f]{40,64}$/u.test(mergeBase);
  if (mode === "merge-base" && !hasMergeBase) {
    throw new Error("The selected revisions do not share a merge base.");
  }
  const diffBase = mode === "merge-base" ? mergeBase : left;
  const [counts, leftRange, rightRange, fileResult] = await Promise.all([
    gitOutput(cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `${left}...${right}`,
    ]),
    readComparisonCommits(cwd, left, right),
    readComparisonCommits(cwd, right, left),
    readCommitFiles(cwd, diffBase, right),
  ]);
  const [leftAheadText, rightAheadText] = counts.split(/\s+/u);
  const additions = fileResult.files.reduce(
    (sum, file) => sum + (file.additions ?? 0),
    0,
  );
  const deletions = fileResult.files.reduce(
    (sum, file) => sum + (file.deletions ?? 0),
    0,
  );
  return gitComparisonSchema.parse({
    mode,
    left,
    right,
    mergeBase: hasMergeBase ? mergeBase : null,
    diffBase,
    leftAhead: Number.parseInt(leftAheadText ?? "0", 10) || 0,
    rightAhead: Number.parseInt(rightAheadText ?? "0", 10) || 0,
    leftCommits: leftRange.commits,
    rightCommits: rightRange.commits,
    leftCommitsTruncated: leftRange.truncated,
    rightCommitsTruncated: rightRange.truncated,
    files: fileResult.files,
    filesTruncated: fileResult.truncated,
    filesChanged: fileResult.total,
    additions,
    deletions,
  });
}

export async function readGitRevisionFileDiff(
  cwd: string,
  revision: string,
  baseRevision: string | null,
  filePath: string,
): Promise<GitRevisionFileDiff> {
  if (!safeGitPath(filePath)) throw new Error("Invalid Git diff path.");
  const hash = await resolveCommit(cwd, revision);
  const baseHash = baseRevision ? await resolveCommit(cwd, baseRevision) : null;
  const { files } = await readCommitFiles(cwd, baseHash, hash);
  const file = files.find(({ path }) => path === filePath);
  if (!file) throw new Error(`No revision change exists for ${filePath}.`);
  const commonArguments = [
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=3",
    "-M",
    "-C",
  ];
  const arguments_ = baseHash
    ? [
        "diff",
        ...commonArguments,
        baseHash,
        hash,
        "--",
        file.originalPath ?? file.path,
        file.path,
      ]
    : [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "-r",
        "-p",
        ...commonArguments,
        hash,
        "--",
        file.path,
      ];
  const result = await gitDiffOutput(cwd, arguments_, false);
  const truncated =
    result.truncated || result.output.length > DIFF_CHARACTER_LIMIT;
  return gitRevisionFileDiffSchema.parse({
    revision: hash,
    baseRevision: baseHash,
    path: file.path,
    originalPath: file.originalPath,
    patch: result.output.slice(0, DIFF_CHARACTER_LIMIT),
    truncated,
    binary: file.binary,
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
    "-M",
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
            ...(change.originalPath ? [change.originalPath] : []),
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

interface ParsedPatchHunk {
  header: string;
  lines: string[];
}

function parsePatchHunks(patch: string): {
  header: string[];
  hunks: ParsedPatchHunk[];
} {
  const header: string[] = [];
  const hunks: ParsedPatchHunk[] = [];
  let current: ParsedPatchHunk | null = null;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      current = { header: line, lines: [] };
      hunks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else if (line) {
      header.push(line);
    }
  }
  return { header, hunks };
}

function partialPatch(
  patch: string,
  request: GitPartialPatchRequest,
): { patch: string; selectedLines: number; warnings: string[] } {
  const parsed = parsePatchHunks(patch);
  if (parsed.hunks.length === 0) {
    throw new Error(
      "This binary, rename-only, or mode-only change does not contain selectable text hunks. Use the file-level action instead.",
    );
  }
  if (
    parsed.header.some(
      (line) =>
        line.startsWith("rename from ") ||
        line.startsWith("rename to ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode "),
    )
  ) {
    throw new Error(
      "Partial actions are disabled for renames and mode changes. Use the file-level action so repository metadata stays consistent.",
    );
  }
  const selections = new Map<number, Set<number> | null>();
  for (const selection of request.hunks) {
    if (selections.has(selection.hunkIndex)) {
      throw new Error(
        `Hunk ${selection.hunkIndex + 1} was selected more than once.`,
      );
    }
    selections.set(
      selection.hunkIndex,
      selection.lineIndexes === null ? null : new Set(selection.lineIndexes),
    );
  }
  const changedLines = parsed.hunks.reduce(
    (count, hunk) =>
      count +
      hunk.lines.filter((line) => line.startsWith("+") || line.startsWith("-"))
        .length,
    0,
  );
  let requestedLines = 0;
  for (const [hunkIndex, lineSelection] of selections) {
    const hunk = parsed.hunks[hunkIndex];
    if (!hunk) throw new Error(`Hunk ${hunkIndex + 1} does not exist.`);
    const changedIndexes = new Set(
      hunk.lines.flatMap((line, lineIndex) =>
        line.startsWith("+") || line.startsWith("-") ? [lineIndex] : [],
      ),
    );
    if (lineSelection === null) {
      requestedLines += changedIndexes.size;
      continue;
    }
    const invalidLines = [...lineSelection].filter(
      (lineIndex) => !changedIndexes.has(lineIndex),
    );
    if (invalidLines.length > 0) {
      throw new Error(
        `Hunk ${hunkIndex + 1} selected context or missing line indexes.`,
      );
    }
    requestedLines += lineSelection.size;
  }
  const fullSelection =
    selections.size === parsed.hunks.length && requestedLines === changedLines;
  const newFile = parsed.header.some((line) =>
    line.startsWith("new file mode "),
  );
  const deletedFile = parsed.header.some((line) =>
    line.startsWith("deleted file mode "),
  );
  const normalizeNewFile =
    newFile && !fullSelection && request.operation !== "stage";
  const normalizeDeletedFile =
    deletedFile && !fullSelection && request.operation === "stage";
  let outputHeader = [...parsed.header];
  const output: string[] = [];
  let selectedLines = 0;
  const reverse =
    request.operation === "unstage" || request.operation === "discard";
  for (const [hunkIndex, lineSelection] of [...selections].sort(
    ([left], [right]) => left - right,
  )) {
    const hunk = parsed.hunks[hunkIndex];
    if (!hunk) throw new Error(`Hunk ${hunkIndex + 1} does not exist.`);
    if (lineSelection === null) {
      output.push(hunk.header, ...hunk.lines);
      selectedLines += hunk.lines.filter(
        (line) => line.startsWith("+") || line.startsWith("-"),
      ).length;
      continue;
    }
    if (lineSelection.size === 0) {
      throw new Error(`Hunk ${hunkIndex + 1} has no selected lines.`);
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(
      hunk.header,
    );
    if (!match) throw new Error(`Hunk ${hunkIndex + 1} has an invalid header.`);
    const parsedOldStart = Number.parseInt(match[1]!, 10);
    const parsedNewStart = Number.parseInt(match[3]!, 10);
    const oldStart = normalizeNewFile ? parsedNewStart : parsedOldStart;
    const newStart = normalizeDeletedFile ? parsedOldStart : parsedNewStart;
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let previousIncluded = false;
    for (const [lineIndex, line] of hunk.lines.entries()) {
      const prefix = line[0];
      if (prefix === " ") {
        body.push(line);
        oldCount += 1;
        newCount += 1;
        previousIncluded = true;
      } else if (prefix === "-") {
        if (lineSelection.has(lineIndex)) {
          body.push(line);
          oldCount += 1;
          selectedLines += 1;
          previousIncluded = true;
        } else if (!reverse) {
          body.push(` ${line.slice(1)}`);
          oldCount += 1;
          newCount += 1;
          previousIncluded = true;
        } else {
          previousIncluded = false;
        }
      } else if (prefix === "+") {
        if (lineSelection.has(lineIndex)) {
          body.push(line);
          newCount += 1;
          selectedLines += 1;
          previousIncluded = true;
        } else if (reverse) {
          body.push(` ${line.slice(1)}`);
          oldCount += 1;
          newCount += 1;
          previousIncluded = true;
        } else {
          previousIncluded = false;
        }
      } else if (prefix === "\\") {
        if (previousIncluded) body.push(line);
      } else if (line) {
        body.push(line);
        previousIncluded = true;
      }
    }
    const range = (start: number, count: number) =>
      count === 1 ? `${start}` : `${start},${count}`;
    output.push(
      `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@${match[5] ?? ""}`,
      ...body,
    );
  }
  if (selectedLines === 0)
    throw new Error("The selection contains no changed lines.");
  if (normalizeNewFile || normalizeDeletedFile) {
    const oldMarker = outputHeader.find((line) => line.startsWith("--- "));
    const newMarker = outputHeader.find((line) => line.startsWith("+++ "));
    const swapPrefix = (marker: string, from: "a" | "b", to: "a" | "b") =>
      marker.replace(`${from}/`, `${to}/`).replace(`\"${from}/`, `\"${to}/`);
    outputHeader = outputHeader
      .filter(
        (line) =>
          !line.startsWith("new file mode ") &&
          !line.startsWith("deleted file mode ") &&
          !line.startsWith("index "),
      )
      .map((line) => {
        if (normalizeNewFile && line === oldMarker && newMarker) {
          return swapPrefix(newMarker.replace(/^\+\+\+ /u, "--- "), "b", "a");
        }
        if (normalizeDeletedFile && line === newMarker && oldMarker) {
          return swapPrefix(oldMarker.replace(/^--- /u, "+++ "), "a", "b");
        }
        return line;
      });
  }
  return {
    patch: `${[...outputHeader, ...output].join("\n")}\n`,
    selectedLines,
    warnings: [],
  };
}

function partialPatchArguments(
  operation: GitPartialPatchRequest["operation"],
  check: boolean,
): string[] {
  return [
    "apply",
    ...(check ? ["--check"] : []),
    ...(operation === "stage" || operation === "unstage" ? ["--cached"] : []),
    ...(operation === "unstage" || operation === "discard"
      ? ["--reverse"]
      : []),
    "--recount",
    "-",
  ];
}

export async function previewGitPartialPatch(
  cwd: string,
  request: GitPartialPatchRequest,
): Promise<GitPartialPatchPreview> {
  const scope: GitDiffScope =
    request.operation === "unstage" ? "staged" : "unstaged";
  const source = await readGitFileDiff(cwd, request.path, scope);
  if (source.truncated) {
    throw new Error("This patch is truncated and cannot be applied partially.");
  }
  const selected = partialPatch(source.patch, request);
  await runGitWithInput(
    cwd,
    partialPatchArguments(request.operation, true),
    selected.patch,
  );
  const token = createHash("sha256")
    .update(request.operation)
    .update("\0")
    .update(request.path)
    .update("\0")
    .update(selected.patch)
    .digest("hex");
  return gitPartialPatchPreviewSchema.parse({
    operation: request.operation,
    path: request.path,
    scope,
    patch: selected.patch,
    token,
    selectedHunks: request.hunks.length,
    selectedLines: selected.selectedLines,
    warnings: selected.warnings,
  });
}

export async function applyGitPartialPatch(
  cwd: string,
  request: GitPartialPatchRequest,
  token: string,
): Promise<GitActionResult> {
  const preview = await previewGitPartialPatch(cwd, request);
  if (preview.token !== token) {
    throw new Error(
      "The working changes no longer match this preview. Review the selection again.",
    );
  }
  const output = await runGitWithInput(
    cwd,
    partialPatchArguments(request.operation, false),
    preview.patch,
  );
  return gitActionResultSchema.parse({
    output,
    status: await readGitStatus(cwd),
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
