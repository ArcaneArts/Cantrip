import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  gitActionResultSchema,
  gitBranchActionPreviewSchema,
  gitBranchListSchema,
  gitBranchMutationResultSchema,
  gitCommitActionPreviewSchema,
  gitCommitActionResultSchema,
  gitConflictDetailSchema,
  gitConflictListSchema,
  gitConflictResolutionPreviewSchema,
  gitConflictResolutionResultSchema,
  gitManagedOperationPreviewSchema,
  gitManagedOperationWorkerStateSchema,
  gitComparisonSchema,
  gitCommitDetailSchema,
  gitCommitSearchResultSchema,
  gitFileDiffSchema,
  gitFileHistorySchema,
  gitBlameSchema,
  gitForcePushPreviewSchema,
  gitHistorySchema,
  gitLfsActionPreviewSchema,
  gitLfsMutationResultSchema,
  gitLfsStatusSchema,
  gitPartialPatchPreviewSchema,
  gitRemoteActionPreviewSchema,
  gitRemoteListSchema,
  gitRemoteMutationResultSchema,
  gitSubmoduleActionPreviewSchema,
  gitSubmoduleListSchema,
  gitSubmoduleMutationResultSchema,
  gitRecoveryCandidateListSchema,
  gitRecoveryPreviewSchema,
  gitRecoveryResultSchema,
  gitStashActionPreviewSchema,
  gitStashFileDiffSchema,
  gitStashListSchema,
  gitStashMutationResultSchema,
  gitRevisionFileDiffSchema,
  gitRevisionCandidateListSchema,
  gitStatusSchema,
  gitTagActionPreviewSchema,
  gitTagDetailSchema,
  gitTagListSchema,
  gitTagMutationResultSchema,
  type GitAction,
  type GitActionResult,
  type GitBranchAction,
  type GitBranchActionPreview,
  type GitBranchList,
  type GitBranchMutationResult,
  type GitCommitAction,
  type GitCommitActionPreview,
  type GitCommitActionResult,
  type GitConflictDetail,
  type GitConflictKind,
  type GitConflictList,
  type GitConflictResolutionPreview,
  type GitConflictResolutionRequest,
  type GitConflictResolutionResult,
  type GitConflictStage,
  type GitDiffFileSide,
  type GitManagedOperationContext,
  type GitManagedOperationAction,
  type GitManagedOperationPreview,
  type GitManagedOperationWorkerState,
  type GitMergeRebaseAction,
  type GitInteractiveRebaseTodoItem,
  type GitInteractiveRebaseTodoAction,
  type GitComparisonCommit,
  type GitManagedBranch,
  type GitLfsAction,
  type GitLfsActionPreview,
  type GitLfsLock,
  type GitLfsMutationResult,
  type GitLfsStatus,
  type GitComparison,
  type GitComparisonMode,
  type GitCommitDetail,
  type GitCommitSearchQuery,
  type GitCommitSearchResult,
  type GitCommitFile,
  type GitDiffScope,
  type GitFileDiff,
  type GitFileHistory,
  type GitBlame,
  type GitForcePushPreview,
  type GitHistory,
  type GitPartialPatchPreview,
  type GitPartialPatchRequest,
  type GitRemoteAction,
  type GitRemoteActionPreview,
  type GitRemoteList,
  type GitRemoteMutationResult,
  type GitSubmoduleAction,
  type GitSubmoduleActionPreview,
  type GitSubmoduleList,
  type GitSubmoduleMutationResult,
  type GitSubmoduleSummary,
  type GitRecoveryAction,
  type GitRecoveryCandidate,
  type GitRecoveryCandidateList,
  type GitRecoveryPreview,
  type GitRecoveryResult,
  type GitStashAction,
  type GitStashActionPreview,
  type GitStashCreate,
  type GitStashFile,
  type GitStashFileDiff,
  type GitStashList,
  type GitStashMutationResult,
  type GitStashSummary,
  type GitRef,
  type GitRevisionFileDiff,
  type GitRevisionCandidate,
  type GitSignature,
  type GitStatus,
  type GitTagAction,
  type GitTagActionPreview,
  type GitTagDetail,
  type GitTagList,
  type GitTagMutationResult,
  type GitTagSummary,
  explorerMediaTypeForPath,
} from "@cantrip/protocol";

const execFileAsync = promisify(execFile);
const GIT_BUFFER = 16 * 1024 * 1024;
const DIFF_CHARACTER_LIMIT = 2_000_000;
const DIFF_IMAGE_BYTES_LIMIT = 2 * 1_024 * 1_024;
const COMMIT_MESSAGE_CHARACTER_LIMIT = 1_000_000;
const COMMIT_FILE_LIMIT = 100_000;
const BRANCH_LIMIT = 20_000;
const TAG_LIMIT = 10_000;
const REMOTE_TIMEOUT_MS = 30_000;
const FORCE_PUSH_COMMIT_LIMIT = 100;
const COMMIT_SIGNATURE_CACHE_LIMIT = 256;
const COMMIT_SIGNATURE_CACHE_TTL_MS = 10 * 60_000;

function missingDiffFileSide(): GitDiffFileSide {
  return {
    kind: "missing",
    size: null,
    mimeType: null,
    base64: null,
    truncated: false,
  };
}

function diffImageMimeType(filePath: string): string | null {
  const media = explorerMediaTypeForPath(filePath);
  return media?.kind === "image" && media.mimeType !== "image/svg+xml"
    ? media.mimeType
    : null;
}

function patchContainsBinaryChange(patch: string): boolean {
  return (
    patch.includes("GIT binary patch") ||
    patch.split("\n").some((line) => line.startsWith("Binary files "))
  );
}

async function readObjectDiffFileSide(
  cwd: string,
  objectPath: string | null,
  filePath: string,
  binary: boolean,
): Promise<GitDiffFileSide> {
  if (
    !objectPath ||
    !(await gitSucceeds(cwd, ["cat-file", "-e", objectPath]))
  ) {
    return missingDiffFileSide();
  }
  const size = Number.parseInt(
    await gitOutput(cwd, ["cat-file", "-s", objectPath]),
    10,
  );
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Git returned an invalid diff file size.");
  }
  const mimeType = diffImageMimeType(filePath);
  if (!mimeType) {
    return {
      kind: binary ? "binary" : "text",
      size,
      mimeType: null,
      base64: null,
      truncated: false,
    };
  }
  if (size > DIFF_IMAGE_BYTES_LIMIT) {
    return {
      kind: "image",
      size,
      mimeType,
      base64: null,
      truncated: true,
    };
  }
  return {
    kind: "image",
    size,
    mimeType,
    base64: (await gitBuffer(cwd, ["show", objectPath])).toString("base64"),
    truncated: false,
  };
}

async function readWorkingDiffFileSide(
  cwd: string,
  filePath: string,
  binary: boolean,
): Promise<GitDiffFileSide> {
  const root = await realpath(cwd);
  const absolute = path.resolve(root, filePath);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid Git diff path.");
  }
  const metadata = await lstat(absolute).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!metadata) return missingDiffFileSide();
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return {
      kind: "binary",
      size: metadata.size,
      mimeType: null,
      base64: null,
      truncated: false,
    };
  }
  const mimeType = diffImageMimeType(filePath);
  if (!mimeType) {
    return {
      kind: binary ? "binary" : "text",
      size: metadata.size,
      mimeType: null,
      base64: null,
      truncated: false,
    };
  }
  if (metadata.size > DIFF_IMAGE_BYTES_LIMIT) {
    return {
      kind: "image",
      size: metadata.size,
      mimeType,
      base64: null,
      truncated: true,
    };
  }
  const canonical = await realpath(absolute);
  if (canonical === root || !canonical.startsWith(`${root}${path.sep}`)) {
    throw new Error("Git diff image escapes the selected worktree.");
  }
  return {
    kind: "image",
    size: metadata.size,
    mimeType,
    base64: (await readFile(canonical)).toString("base64"),
    truncated: false,
  };
}

interface CommitSignatureCacheEntry {
  expiresAt: number;
  value: Promise<GitSignature>;
}

const commitSignatureCache = new Map<string, CommitSignatureCacheEntry>();

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

async function runGit(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", env: environment, maxBuffer: GIT_BUFFER },
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
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      env: environment,
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

async function gitRawWithEnvironment(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: environment,
    maxBuffer: GIT_BUFFER,
  });
  return stdout;
}

async function runGitOutcome(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; output: string }> {
  try {
    return { code: 0, output: await runGit(cwd, args, environment) };
  } catch (error) {
    const failure = error as Error;
    return { code: 1, output: failure.message };
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

export async function readGitFileHistory(
  cwd: string,
  filePath: string,
  revision: string,
  limit: number,
  cursor = 0,
): Promise<GitFileHistory> {
  if (!safeGitPath(filePath)) throw new Error("Invalid Git history path.");
  const hash = await resolveCommit(cwd, revision);
  const output = await gitRaw(cwd, [
    "log",
    "--follow",
    "--date=iso-strict",
    `--skip=${cursor}`,
    `--max-count=${limit + 1}`,
    "--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x1e",
    hash,
    "--",
    filePath,
  ]);
  const parsed = output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .flatMap((record) => {
      const [commit, shortHash, authorName, authorEmail, authoredAt, subject] =
        record.split("\0");
      return commit && shortHash && authorName && authoredAt
        ? [
            {
              hash: commit,
              shortHash,
              subject: subject ?? "",
              authorName,
              authorEmail: authorEmail ?? "",
              authoredAt,
            },
          ]
        : [];
    });
  const hasMore = parsed.length > limit;
  const commits = parsed.slice(0, limit);
  return gitFileHistorySchema.parse({
    path: filePath,
    revision: hash,
    commits,
    hasMore,
    nextCursor: hasMore ? cursor + commits.length : null,
  });
}

interface ParsedBlameLine {
  commit: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  summary: string;
  line: number;
  content: string;
}

function parseBlamePorcelain(output: string): ParsedBlameLine[] {
  const lines = output.split("\n");
  const parsed: ParsedBlameLine[] = [];
  for (let index = 0; index < lines.length;) {
    const header = /^([0-9a-f]{40,64})\s+\d+\s+(\d+)(?:\s+\d+)?$/u.exec(
      lines[index++] ?? "",
    );
    if (!header) continue;
    let authorName = "Unknown";
    let authorEmail = "";
    let authoredAt = new Date(0).toISOString();
    let summary = "";
    let content = "";
    while (index < lines.length) {
      const line = lines[index++] ?? "";
      if (line.startsWith("\t")) {
        content = line.slice(1);
        break;
      }
      if (line.startsWith("author ")) authorName = line.slice(7) || "Unknown";
      else if (line.startsWith("author-mail ")) {
        authorEmail = line.slice(12).replace(/^<|>$/gu, "");
      } else if (line.startsWith("author-time ")) {
        const seconds = Number.parseInt(line.slice(12), 10);
        if (Number.isFinite(seconds)) {
          authoredAt = new Date(seconds * 1_000).toISOString();
        }
      } else if (line.startsWith("summary ")) summary = line.slice(8);
    }
    parsed.push({
      commit: header[1]!,
      authorName,
      authorEmail,
      authoredAt,
      summary,
      line: Number.parseInt(header[2]!, 10),
      content,
    });
  }
  return parsed;
}

export async function readGitFileBlame(
  cwd: string,
  filePath: string,
  revision: string,
  limit: number,
  cursor = 0,
): Promise<GitBlame> {
  if (!safeGitPath(filePath)) throw new Error("Invalid Git blame path.");
  const hash = await resolveCommit(cwd, revision);
  const parsed = parseBlamePorcelain(
    await gitRaw(cwd, [
      "blame",
      "--line-porcelain",
      "-L",
      `${cursor + 1},+${limit + 1}`,
      hash,
      "--",
      filePath,
    ]),
  );
  const hasMore = parsed.length > limit;
  const visible = parsed.slice(0, limit);
  const ranges: GitBlame["ranges"] = [];
  for (const line of visible) {
    const previous = ranges.at(-1);
    if (
      previous &&
      previous.commit === line.commit &&
      previous.endLine + 1 === line.line
    ) {
      previous.endLine = line.line;
      previous.lines.push(line.content);
      continue;
    }
    ranges.push({
      commit: line.commit,
      shortCommit: line.commit.slice(0, 10),
      authorName: line.authorName,
      authorEmail: line.authorEmail,
      authoredAt: line.authoredAt,
      summary: line.summary,
      startLine: line.line,
      endLine: line.line,
      lines: [line.content],
    });
  }
  return gitBlameSchema.parse({
    path: filePath,
    revision: hash,
    ranges,
    hasMore,
    nextCursor: hasMore ? cursor + visible.length : null,
  });
}

function escapeGitRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

export async function searchGitCommits(
  cwd: string,
  query: GitCommitSearchQuery,
  limit: number,
  cursor = 0,
): Promise<GitCommitSearchResult> {
  const parsedQuery = gitCommitSearchResultSchema.shape.query.parse(query);
  let revision = "--all";
  if (parsedQuery.hash) {
    revision = await resolveCommit(cwd, parsedQuery.hash);
  } else if (parsedQuery.branch) {
    revision = await resolveCommit(
      cwd,
      `refs/heads/${parsedQuery.branch}`,
    ).catch(() => resolveCommit(cwd, `refs/remotes/${parsedQuery.branch}`));
  } else if (parsedQuery.tag) {
    revision = await resolveCommit(cwd, `refs/tags/${parsedQuery.tag}`);
  }
  const branch = await gitOutput(cwd, ["branch", "--show-current"]);
  const remoteNames = new Set(
    (await gitOutput(cwd, ["remote"]).catch(() => ""))
      .split("\n")
      .filter(Boolean),
  );
  const args = [
    "log",
    "--topo-order",
    "--date-order",
    `--skip=${cursor}`,
    `--max-count=${limit + 1}`,
    "--date=iso-strict",
    "--regexp-ignore-case",
    "--pretty=format:%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%D%x1e",
  ];
  if (parsedQuery.message) {
    args.push("--fixed-strings", `--grep=${parsedQuery.message}`);
  }
  if (parsedQuery.author) {
    args.push(`--author=${escapeGitRegex(parsedQuery.author)}`);
  }
  if (parsedQuery.dateFrom) args.push(`--since=${parsedQuery.dateFrom}`);
  if (parsedQuery.dateTo) args.push(`--until=${parsedQuery.dateTo} 23:59:59`);
  args.push(revision);
  if (parsedQuery.path) args.push("--", parsedQuery.path);
  const output = await gitRaw(cwd, args);
  const parsed = output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .flatMap((record) => {
      const [
        hash,
        shortHash,
        parents,
        authorName,
        authorEmail,
        authoredAt,
        subject,
        decorations,
      ] = record.split("\0");
      return hash && shortHash && authorName && authoredAt
        ? [
            {
              hash,
              shortHash,
              parents: (parents ?? "").split(" ").filter(Boolean),
              subject: subject ?? "",
              authorName,
              authorEmail: authorEmail ?? "",
              authoredAt,
              refs: parseRefs(decorations ?? "", branch, remoteNames),
              isHead: false,
            },
          ]
        : [];
    });
  const head = await resolveCommit(cwd, "HEAD").catch(() => "");
  const commits = parsed.slice(0, limit).map((commit) => ({
    ...commit,
    isHead: commit.hash === head,
  }));
  const hasMore = parsed.length > limit;
  return gitCommitSearchResultSchema.parse({
    query: parsedQuery,
    commits,
    hasMore,
    nextCursor: hasMore ? cursor + commits.length : null,
  });
}

function recoveryExplanation(subject: string): {
  action: string;
  explanation: string;
} {
  const separator = subject.indexOf(":");
  const action = (separator >= 0 ? subject.slice(0, separator) : subject)
    .trim()
    .toLowerCase();
  const detail = (
    separator >= 0 ? subject.slice(separator + 1) : subject
  ).trim();
  if (action === "checkout") {
    return {
      action,
      explanation: detail.startsWith("moving from ")
        ? `The worktree switched ${detail}.`
        : "The worktree changed its checked-out revision.",
    };
  }
  if (action === "reset") {
    return {
      action,
      explanation: detail
        ? `HEAD or its branch was reset (${detail}).`
        : "HEAD or its branch was reset to another revision.",
    };
  }
  if (action.startsWith("commit")) {
    return {
      action,
      explanation: detail
        ? `A commit was recorded: ${detail}`
        : "A commit moved the current branch forward.",
    };
  }
  if (action.startsWith("rebase")) {
    return {
      action,
      explanation: detail
        ? `A rebase moved this reference (${detail}).`
        : "A rebase rewrote or moved this reference.",
    };
  }
  if (action === "merge") {
    return {
      action,
      explanation: detail
        ? `A merge moved this reference (${detail}).`
        : "A merge moved this reference.",
    };
  }
  if (action === "pull") {
    return {
      action,
      explanation: detail
        ? `A pull updated this reference (${detail}).`
        : "A pull updated this reference from a remote.",
    };
  }
  return {
    action: action || "reflog",
    explanation: subject
      ? `Git recorded this reference movement: ${subject}`
      : "Git recorded a reference movement to this commit.",
  };
}

function parseRawReflogDate(selector: string): string | null {
  const match = /@\{(\d+)\s+[+-]\d{4}\}$/u.exec(selector);
  if (!match) return null;
  const seconds = Number.parseInt(match[1]!, 10);
  return Number.isFinite(seconds)
    ? new Date(seconds * 1_000).toISOString()
    : null;
}

export async function readGitRecoveryCandidates(
  cwd: string,
  kind: "reflog" | "dangling",
  limit: number,
  cursor = 0,
): Promise<GitRecoveryCandidateList> {
  let parsed: GitRecoveryCandidate[];
  if (kind === "reflog") {
    const output = await gitRaw(cwd, [
      "log",
      "-g",
      "--all",
      "--date=raw",
      `--skip=${cursor}`,
      `--max-count=${limit + 1}`,
      "--format=%H%x00%h%x00%gD%x00%gs%x00%gn%x00%ge%x1e",
    ]).catch((error) => {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (stderr.includes("does not have any commits yet")) return "";
      throw error;
    });
    parsed = output
      .split("\x1e")
      .map((record) => record.trim())
      .filter(Boolean)
      .flatMap((record): GitRecoveryCandidate[] => {
        const [hash, shortHash, selector, subject = "", actorName, actorEmail] =
          record.split("\0");
        if (!hash || !shortHash || !selector) return [];
        const movement = recoveryExplanation(subject);
        return [
          {
            kind,
            selector,
            hash,
            shortHash,
            subject,
            ...movement,
            actorName: actorName || null,
            actorEmail: actorEmail || null,
            occurredAt: parseRawReflogDate(selector),
          },
        ];
      });
  } else {
    const output = await gitRaw(cwd, [
      "fsck",
      "--no-reflogs",
      "--unreachable",
      "--no-progress",
    ]).catch((error) => (error as { stdout?: string }).stdout ?? "");
    const hashes = output
      .split("\n")
      .flatMap((line) => {
        const match =
          /^(?:dangling|unreachable) commit ([0-9a-f]{40,64})$/u.exec(
            line.trim(),
          );
        return match ? [match[1]!] : [];
      })
      .sort()
      .slice(cursor, cursor + limit + 1);
    parsed = await Promise.all(
      hashes.map(async (hash): Promise<GitRecoveryCandidate> => {
        const output = await gitRaw(cwd, [
          "show",
          "-s",
          "--date=iso-strict",
          "--format=%h%x00%s%x00%an%x00%ae%x00%aI",
          hash,
        ]);
        const [shortHash, subject = "", actorName, actorEmail, occurredAt] =
          output.trimEnd().split("\0");
        return {
          kind,
          selector: hash,
          hash,
          shortHash: shortHash || hash.slice(0, 10),
          action: "unreachable",
          subject,
          explanation:
            "This commit is not reachable from a current ref or reflog and may be recoverable until Git prunes it.",
          actorName: actorName || null,
          actorEmail: actorEmail || null,
          occurredAt: occurredAt || null,
        };
      }),
    );
  }
  const hasMore = parsed.length > limit;
  const entries = parsed.slice(0, limit);
  return gitRecoveryCandidateListSchema.parse({
    kind,
    entries,
    hasMore,
    nextCursor: hasMore ? cursor + entries.length : null,
  });
}

function recoveryCheckpointRef(
  action: GitRecoveryAction,
  revision: string,
  token: string,
): string | null {
  if (action.type === "createBranch") return null;
  const scope = action.type === "reset" ? "reset" : "branch";
  return `refs/cantrip/recovery/${scope}-${revision.slice(0, 12)}-${token.slice(0, 12)}`;
}

export async function previewGitRecoveryAction(
  cwd: string,
  action: GitRecoveryAction,
): Promise<GitRecoveryPreview> {
  await assertNoInProgressGitOperation(cwd);
  const [currentHead, targetRevision, status, fingerprint] = await Promise.all([
    resolveCommit(cwd, "HEAD"),
    resolveCommit(cwd, action.target),
    readGitStatus(cwd),
    workspaceFingerprint(cwd),
  ]);
  const warnings: string[] = [];
  let branchBefore: string | null = null;
  if (action.type === "createBranch") {
    await runGit(cwd, ["check-ref-format", "--branch", action.branch]);
    if (
      await gitSucceeds(cwd, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${action.branch}`,
      ])
    ) {
      throw new Error(`Local branch ${action.branch} already exists.`);
    }
  } else if (action.type === "restoreBranch") {
    await runGit(cwd, ["check-ref-format", "--branch", action.branch]);
    branchBefore = await resolveCommit(
      cwd,
      `refs/heads/${action.branch}`,
    ).catch(() => null);
    if (!branchBefore) {
      throw new Error(`Local branch ${action.branch} does not exist.`);
    }
    const owner = (await readBranchWorktreeOwners(cwd)).get(action.branch);
    if (owner) {
      throw new Error(
        owner.current
          ? `${action.branch} is checked out in this worktree. Use a reset to restore its HEAD.`
          : `${action.branch} is checked out in worktree ${owner.label} and cannot be moved here.`,
      );
    }
    warnings.push(
      `The branch ref moves from ${branchBefore.slice(0, 10)} to ${targetRevision.slice(0, 10)} without changing this worktree.`,
    );
  } else {
    if (action.mode === "hard" && status.files.length > 0) {
      warnings.push(
        `Hard reset overwrites tracked changes in ${status.files.length} changed path${status.files.length === 1 ? "" : "s"}; untracked files remain.`,
      );
    } else if (
      action.mode === "mixed" &&
      status.files.some(({ staged }) => staged)
    ) {
      warnings.push(
        "Mixed reset removes staged changes from the index but keeps their working-tree content.",
      );
    } else if (action.mode === "soft") {
      warnings.push(
        "Soft reset moves HEAD while preserving the index and working tree.",
      );
    }
  }
  const comparisonBase =
    action.type === "restoreBranch" ? branchBefore! : currentHead;
  const [removed, fileResult] = await Promise.all([
    readComparisonCommits(cwd, comparisonBase, targetRevision),
    readCommitFiles(cwd, targetRevision, comparisonBase),
  ]);
  if (removed.commits.length > 0) {
    warnings.push(
      `${removed.commits.length}${removed.truncated ? "+" : ""} commit${removed.commits.length === 1 ? "" : "s"} would no longer be reachable from the moved ref.`,
    );
  }
  const token = createHash("sha256")
    .update(
      JSON.stringify({ action, currentHead, targetRevision, branchBefore }),
    )
    .update("\0")
    .update(fingerprint)
    .digest("hex");
  const checkpointRef = recoveryCheckpointRef(action, comparisonBase, token);
  const confirmation =
    action.type === "createBranch"
      ? `CREATE ${action.branch} AT ${targetRevision.slice(0, 10)}`
      : action.type === "restoreBranch"
        ? `RESTORE ${action.branch} TO ${targetRevision.slice(0, 10)}`
        : `RESET --${action.mode.toUpperCase()} TO ${targetRevision.slice(0, 10)}`;
  const summary =
    action.type === "createBranch"
      ? `Create recovery branch ${action.branch} at ${targetRevision.slice(0, 10)}.`
      : action.type === "restoreBranch"
        ? `Restore local branch ${action.branch} to ${targetRevision.slice(0, 10)}.`
        : `Reset this worktree from ${currentHead.slice(0, 10)} to ${targetRevision.slice(0, 10)} using --${action.mode}.`;
  return gitRecoveryPreviewSchema.parse({
    action,
    token,
    destructive: action.type !== "createBranch",
    summary,
    warnings,
    confirmation,
    targetRevision,
    currentHead,
    branchBefore,
    checkpointRef,
    commitsRemoved: removed.commits,
    commitsRemovedTruncated: removed.truncated,
    files: fileResult.files,
    filesTruncated: fileResult.truncated,
    status,
  });
}

export async function applyGitRecoveryAction(
  cwd: string,
  action: GitRecoveryAction,
  token: string,
  confirmation: string,
): Promise<GitRecoveryResult> {
  const preview = await previewGitRecoveryAction(cwd, action);
  if (preview.token !== token) {
    throw new Error(
      "The worktree or selected revision changed after this preview. Review the recovery action again.",
    );
  }
  if (preview.confirmation !== confirmation) {
    throw new Error(
      `Type ${preview.confirmation} exactly to confirm this recovery action.`,
    );
  }
  if (preview.checkpointRef) {
    const checkpointTarget =
      action.type === "restoreBranch"
        ? preview.branchBefore!
        : preview.currentHead;
    const existing = await resolveCommit(cwd, preview.checkpointRef).catch(
      () => null,
    );
    if (existing && existing !== checkpointTarget) {
      throw new Error(
        "The generated recovery checkpoint already points elsewhere.",
      );
    }
    if (!existing) {
      await runGit(cwd, [
        "update-ref",
        preview.checkpointRef,
        checkpointTarget,
        "",
      ]);
    }
  }
  let output: string;
  if (action.type === "createBranch") {
    output = await runGit(cwd, [
      "branch",
      action.branch,
      preview.targetRevision,
    ]);
  } else if (action.type === "restoreBranch") {
    output = await runGit(cwd, [
      "update-ref",
      `refs/heads/${action.branch}`,
      preview.targetRevision,
      preview.branchBefore!,
    ]);
  } else {
    output = await runGit(cwd, [
      "reset",
      `--${action.mode}`,
      preview.targetRevision,
    ]);
  }
  const headAfter = await resolveCommit(cwd, "HEAD");
  return gitRecoveryResultSchema.parse({
    action,
    output,
    checkpointRef: preview.checkpointRef,
    headBefore: preview.currentHead,
    headAfter,
    status: await readGitStatus(cwd),
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
    case "N":
      return "unsigned";
    default:
      return "unverifiable";
  }
}

export function detectGitSignatureFormat(
  value: string,
): GitSignature["format"] {
  if (/-----BEGIN PGP SIGNATURE-----/u.test(value)) return "gpg";
  if (/-----BEGIN SSH SIGNATURE-----/u.test(value)) return "ssh";
  if (/-----BEGIN (?:SIGNED MESSAGE|CMS|PKCS7|X509)-----/u.test(value)) {
    return "x509";
  }
  return /-----BEGIN [^-]+ SIGNATURE-----/u.test(value) ? "unknown" : null;
}

function signatureVerification(
  code: string,
  message: string,
): GitSignature["verification"] {
  if (code === "N") return "not-applicable";
  if (["G", "U", "B", "X", "Y", "R"].includes(code)) return "available";
  if (/no public key|unknown key|could not find.*key/iu.test(message)) {
    return "missing-key";
  }
  if (
    /allowedsignersfile|allowed signers|principal.*not found/iu.test(message)
  ) {
    return "missing-config";
  }
  if (/cannot run|not found|no such file|failed to execute/iu.test(message)) {
    return "missing-tool";
  }
  return "error";
}

function signatureDetails(
  code: string,
  signer: string,
  key: string,
  fingerprint: string,
  signedObject: string,
  verificationMessage = "",
): GitSignature {
  const format = detectGitSignatureFormat(signedObject);
  const reportedCode = code || (format ? "E" : "N");
  const effectiveCode = reportedCode === "N" && format ? "E" : reportedCode;
  const status = signatureStatus(effectiveCode);
  const message = verificationMessage.trim().slice(0, 10_000);
  return {
    status,
    signer: signer || null,
    key: key || null,
    fingerprint: fingerprint || null,
    format: status === "unsigned" ? null : format,
    verification: signatureVerification(effectiveCode, message),
    verificationMessage: status === "unsigned" ? null : message || null,
  };
}

async function signatureVerificationContext(cwd: string): Promise<string> {
  const configuration = await gitRaw(cwd, [
    "config",
    "--null",
    "--get-regexp",
    "^(gpg\\.|user\\.signingkey$)",
  ]).catch(() => "");
  return createHash("sha256").update(configuration).digest("hex");
}

async function loadGitCommitSignature(
  cwd: string,
  hash: string,
): Promise<GitSignature> {
  const [verification, signedObject] = await Promise.all([
    execFileAsync(
      "git",
      [
        "-C",
        cwd,
        "show",
        "-s",
        "--format=%G?%x00%GS%x00%GK%x00%GF%x00%GG",
        hash,
      ],
      { encoding: "utf8", maxBuffer: GIT_BUFFER },
    ),
    gitRaw(cwd, ["cat-file", "commit", hash]),
  ]);
  const [
    signatureCode = "N",
    signatureSigner = "",
    signatureKey = "",
    signatureFingerprint = "",
    signatureVerificationMessage = "",
  ] = verification.stdout.trimEnd().split("\0");
  const verificationMessage = [
    signatureVerificationMessage,
    verification.stderr,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  return signatureDetails(
    signatureCode,
    signatureSigner,
    signatureKey,
    signatureFingerprint,
    signedObject,
    verificationMessage,
  );
}

export async function readGitCommitSignature(
  cwd: string,
  revision: string,
): Promise<GitSignature> {
  const [hash, verificationContext] = await Promise.all([
    resolveCommit(cwd, revision),
    signatureVerificationContext(cwd),
  ]);
  const key = `${path.resolve(cwd)}\0${hash}\0${verificationContext}`;
  const now = Date.now();
  const cached = commitSignatureCache.get(key);
  if (cached && cached.expiresAt > now) {
    commitSignatureCache.delete(key);
    commitSignatureCache.set(key, cached);
    return cached.value;
  }
  if (cached) commitSignatureCache.delete(key);
  while (commitSignatureCache.size >= COMMIT_SIGNATURE_CACHE_LIMIT) {
    const oldest = commitSignatureCache.keys().next().value;
    if (oldest === undefined) break;
    commitSignatureCache.delete(oldest);
  }
  const entry: CommitSignatureCacheEntry = {
    expiresAt: now + COMMIT_SIGNATURE_CACHE_TTL_MS,
    value: loadGitCommitSignature(cwd, hash),
  };
  commitSignatureCache.set(key, entry);
  void entry.value.catch(() => {
    if (commitSignatureCache.get(key) === entry) {
      commitSignatureCache.delete(key);
    }
  });
  return entry.value;
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
    "--end-of-options",
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
    "--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%B%x00%D",
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
    signature: null,
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
  contextLines = 3,
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
    `--unified=${contextLines}`,
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
  const [oldFile, newFile] = await Promise.all([
    readObjectDiffFileSide(
      cwd,
      baseHash ? `${baseHash}:${file.originalPath ?? file.path}` : null,
      file.originalPath ?? file.path,
      file.binary,
    ),
    readObjectDiffFileSide(cwd, `${hash}:${file.path}`, file.path, file.binary),
  ]);
  return gitRevisionFileDiffSchema.parse({
    revision: hash,
    baseRevision: baseHash,
    path: file.path,
    originalPath: file.originalPath,
    patch: result.output.slice(0, DIFF_CHARACTER_LIMIT),
    truncated,
    binary: file.binary,
    oldFile,
    newFile,
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
  contextLines = 3,
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
    `--unified=${contextLines}`,
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
  const binary = patchContainsBinaryChange(result.output);
  const oldPath = change.originalPath ?? filePath;
  const [oldFile, newFile] = await Promise.all([
    readObjectDiffFileSide(
      cwd,
      scope === "staged"
        ? `${status.head ?? "HEAD"}:${oldPath}`
        : untracked
          ? null
          : `:${oldPath}`,
      oldPath,
      binary,
    ),
    scope === "staged"
      ? readObjectDiffFileSide(cwd, `:${filePath}`, filePath, binary)
      : readWorkingDiffFileSide(cwd, filePath, binary),
  ]);
  return gitFileDiffSchema.parse({
    path: filePath,
    originalPath: change.originalPath,
    scope,
    patch: result.output.slice(0, DIFF_CHARACTER_LIMIT),
    truncated,
    binary,
    oldFile,
    newFile,
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

const STASH_LIMIT = 200;
const STASH_FILE_LIMIT = 2_000;

function stashMessage(subject: string): string {
  const separator = subject.indexOf(": ");
  return separator >= 0 ? subject.slice(separator + 2) : subject;
}

function parseStashNumstat(output: string): {
  files: GitStashFile[];
  total: number;
} {
  const stats = parseNumstat(output);
  const files = [...stats.entries()]
    .slice(0, STASH_FILE_LIMIT)
    .map(([filePath, stat]) => ({
      path: filePath,
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.additions === null || stat.deletions === null,
    }));
  return { files, total: stats.size };
}

async function readStashSummary(
  cwd: string,
  input: {
    ref: string;
    hash: string;
    shortHash: string;
    parents: string;
    createdAt: string;
    subject: string;
  },
): Promise<GitStashSummary> {
  const numstat = parseStashNumstat(
    await gitRaw(cwd, [
      "stash",
      "show",
      "--include-untracked",
      "--numstat",
      "-z",
      input.hash,
    ]),
  );
  const parents = input.parents.split(" ").filter(Boolean);
  return {
    ref: input.ref,
    hash: input.hash,
    shortHash: input.shortHash,
    message: stashMessage(input.subject),
    createdAt: input.createdAt,
    baseHash: parents[0] ?? null,
    files: numstat.files,
    filesChanged: numstat.total,
    filesTruncated: numstat.total > STASH_FILE_LIMIT,
    additions: numstat.files.reduce(
      (total, file) => total + (file.additions ?? 0),
      0,
    ),
    deletions: numstat.files.reduce(
      (total, file) => total + (file.deletions ?? 0),
      0,
    ),
    includesUntracked: parents.length >= 3,
  };
}

export async function readGitStashes(cwd: string): Promise<GitStashList> {
  const output = await gitRaw(cwd, [
    "stash",
    "list",
    `--max-count=${STASH_LIMIT + 1}`,
    "--format=%gd%x00%H%x00%h%x00%P%x00%aI%x00%gs%x1e",
  ]);
  const records = output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .flatMap((record) => {
      const [ref, hash, shortHash, parents, createdAt, subject] =
        record.split("\0");
      return ref && hash && shortHash && parents && createdAt && subject
        ? [{ ref, hash, shortHash, parents, createdAt, subject }]
        : [];
    });
  const stashes: GitStashSummary[] = [];
  for (const record of records.slice(0, STASH_LIMIT)) {
    stashes.push(await readStashSummary(cwd, record));
  }
  return gitStashListSchema.parse({
    stashes,
    truncated: records.length > STASH_LIMIT,
  });
}

async function createUnstagedShelf(
  cwd: string,
  request: GitStashCreate,
): Promise<string> {
  const status = await readGitStatus(cwd);
  const trackedPaths = status.files
    .filter((file) => file.unstaged && file.indexStatus !== "?")
    .map(({ path }) => path);
  const untrackedPaths = request.includeUntracked
    ? status.files
        .filter(
          (file) => file.indexStatus === "?" && file.worktreeStatus === "?",
        )
        .map(({ path }) => path)
    : [];
  if (trackedPaths.length === 0 && untrackedPaths.length === 0) {
    throw new Error("No matching unstaged or untracked changes to stash.");
  }
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-stash-index-"),
  );
  const temporaryIndex = path.join(temporaryDirectory, "index");
  const environment = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  try {
    const head = await resolveCommit(cwd, "HEAD");
    await gitRawWithEnvironment(cwd, ["read-tree", "HEAD"], environment);
    if (trackedPaths.length > 0) {
      const patch = await gitRaw(cwd, [
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        ...trackedPaths,
      ]);
      try {
        await runGitWithInput(
          cwd,
          ["apply", "--cached", "--binary", "-"],
          patch,
          environment,
        );
      } catch (error) {
        throw new Error(
          `The unstaged changes overlap staged content and cannot be shelved independently: ${(error as Error).message}`,
        );
      }
    }
    const worktreeTree = (
      await gitRawWithEnvironment(cwd, ["write-tree"], environment)
    ).trim();
    await gitRawWithEnvironment(cwd, ["read-tree", "HEAD"], environment);
    const baseTree = (
      await gitRawWithEnvironment(cwd, ["write-tree"], environment)
    ).trim();
    const indexCommit = (
      await gitRaw(cwd, [
        "commit-tree",
        baseTree,
        "-p",
        head,
        "-m",
        `index on ${head.slice(0, 12)}`,
      ])
    ).trim();
    const parents = ["-p", head, "-p", indexCommit];
    if (untrackedPaths.length > 0) {
      await gitRawWithEnvironment(cwd, ["read-tree", "--empty"], environment);
      await gitRawWithEnvironment(
        cwd,
        ["add", "--", ...untrackedPaths],
        environment,
      );
      const untrackedTree = (
        await gitRawWithEnvironment(cwd, ["write-tree"], environment)
      ).trim();
      const untrackedCommit = (
        await gitRaw(cwd, [
          "commit-tree",
          untrackedTree,
          "-p",
          head,
          "-m",
          `untracked files on ${head.slice(0, 12)}`,
        ])
      ).trim();
      parents.push("-p", untrackedCommit);
    }
    const stashCommit = (
      await gitRaw(cwd, [
        "commit-tree",
        worktreeTree,
        ...parents,
        "-m",
        `On ${await gitOutput(cwd, ["branch", "--show-current"])}: ${request.message}`,
      ])
    ).trim();
    await runGit(cwd, ["stash", "store", "-m", request.message, stashCommit]);
    if (trackedPaths.length > 0) {
      await runGit(cwd, ["checkout", "--", ...trackedPaths]);
    }
    if (untrackedPaths.length > 0) {
      await runGit(cwd, ["clean", "-f", "--", ...untrackedPaths]);
    }
    return "Saved selected unstaged changes";
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

export async function createGitStash(
  cwd: string,
  request: GitStashCreate,
): Promise<GitStashMutationResult> {
  const before = await readGitStashes(cwd);
  let output: string;
  if (!request.includeStaged) {
    output = await createUnstagedShelf(cwd, request);
  } else {
    const args = ["stash", "push", "-m", request.message];
    if (!request.includeUnstaged) args.push("--staged");
    if (request.includeUntracked) args.push("--include-untracked");
    output = await runGit(cwd, args);
  }
  const after = await readGitStashes(cwd);
  const stash = after.stashes.find(
    ({ hash }) => !before.stashes.some((existing) => existing.hash === hash),
  );
  if (!stash) throw new Error("Git did not create a stash for this selection.");
  return gitStashMutationResultSchema.parse({
    output,
    status: await readGitStatus(cwd),
    stash,
    conflictedPaths: [],
  });
}

export async function readGitStashFileDiff(
  cwd: string,
  hash: string,
  filePath: string,
  contextLines = 3,
): Promise<GitStashFileDiff> {
  if (!safeGitPath(filePath)) throw new Error("Invalid stash diff path.");
  const list = await readGitStashes(cwd);
  const stash = list.stashes.find((candidate) => candidate.hash === hash);
  const file = stash?.files.find((candidate) => candidate.path === filePath);
  if (!stash || !file)
    throw new Error(`No stash change exists for ${filePath}.`);
  const untracked = stash.includesUntracked
    ? await gitSucceeds(cwd, ["cat-file", "-e", `${hash}^3:${filePath}`])
    : false;
  const base = `${hash}^1`;
  const target = untracked ? `${hash}^3` : hash;
  const result = await gitDiffOutput(
    cwd,
    [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      `--unified=${contextLines}`,
      base,
      target,
      "--",
      filePath,
    ],
    false,
  );
  const truncated =
    result.truncated || result.output.length > DIFF_CHARACTER_LIMIT;
  const [oldFile, newFile] = await Promise.all([
    readObjectDiffFileSide(cwd, `${base}:${filePath}`, filePath, file.binary),
    readObjectDiffFileSide(cwd, `${target}:${filePath}`, filePath, file.binary),
  ]);
  return gitStashFileDiffSchema.parse({
    hash,
    path: filePath,
    patch: result.output.slice(0, DIFF_CHARACTER_LIMIT),
    truncated,
    binary: file.binary,
    oldFile,
    newFile,
  });
}

function stashActionToken(
  action: GitStashAction,
  stashes: GitStashSummary[],
  workspaceFingerprint: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify(action))
    .update("\0")
    .update(stashes.map(({ ref, hash }) => `${ref}:${hash}`).join("\0"))
    .update("\0")
    .update(workspaceFingerprint)
    .digest("hex");
}

async function workspaceFingerprint(cwd: string): Promise<string> {
  const [status, patch] = await Promise.all([
    gitRaw(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    gitRaw(cwd, ["diff", "--binary", "HEAD"]),
  ]);
  return createHash("sha256")
    .update(status)
    .update("\0")
    .update(patch)
    .digest("hex");
}

export async function previewGitStashAction(
  cwd: string,
  action: GitStashAction,
): Promise<GitStashActionPreview> {
  const list = await readGitStashes(cwd);
  if (action.type === "clear" && list.truncated) {
    throw new Error(
      "The stash list exceeds the bounded preview. Drop stashes individually before clearing all.",
    );
  }
  const selected =
    action.type === "clear"
      ? list.stashes
      : list.stashes.filter(
          ({ ref, hash }) => ref === action.ref && hash === action.hash,
        );
  if (selected.length === 0) {
    throw new Error(
      action.type === "clear"
        ? "There are no stashes to clear."
        : "The selected stash no longer exists at that position.",
    );
  }
  if (action.type === "branch") {
    await runGit(cwd, ["check-ref-format", "--branch", action.branch]);
  }
  const fingerprint = await workspaceFingerprint(cwd);
  const status = await readGitStatus(cwd);
  const warnings = status.files.length
    ? [
        "The selected worktree has local changes; applying this stash may conflict.",
      ]
    : [];
  return gitStashActionPreviewSchema.parse({
    action,
    stashes: selected,
    destructive: ["pop", "drop", "clear", "branch"].includes(action.type),
    token: stashActionToken(action, selected, fingerprint),
    warnings,
  });
}

export async function applyGitStashAction(
  cwd: string,
  action: GitStashAction,
  token: string,
): Promise<GitStashMutationResult> {
  const preview = await previewGitStashAction(cwd, action);
  if (preview.token !== token) {
    throw new Error(
      "The stash or working changes no longer match this preview. Review the action again.",
    );
  }
  const resumable = ["apply", "pop", "branch"].includes(action.type);
  const originalHead = resumable ? await resolveCommit(cwd, "HEAD") : null;
  const targetRef = resumable
    ? await gitOutput(cwd, ["symbolic-ref", "-q", "HEAD"]).catch(() => null)
    : null;
  const checkpointRef = resumable
    ? await createStashOperationCheckpoint(cwd, originalHead!, preview.token)
    : null;
  let outcome: Awaited<ReturnType<typeof runGitOutcome>>;
  if (action.type === "clear") {
    outcome = await runGitOutcome(cwd, ["stash", "clear"]);
  } else if (action.type === "drop") {
    outcome = await runGitOutcome(cwd, ["stash", "drop", action.ref]);
  } else if (action.type === "branch") {
    const create = await runGitOutcome(cwd, [
      "branch",
      action.branch,
      `${action.hash}^1`,
    ]);
    if (create.code !== 0) {
      await restoreStashOperationCheckpoint(cwd, {
        originalHead: originalHead!,
        targetRef,
        checkpointRef: checkpointRef!,
        branch: action.branch,
      });
      throw new Error(create.output);
    }
    const switched = await runGitOutcome(cwd, ["switch", action.branch]);
    outcome =
      switched.code === 0
        ? await runGitOutcome(cwd, ["stash", "apply", action.hash])
        : switched;
  } else {
    outcome = await runGitOutcome(cwd, ["stash", "apply", action.hash]);
  }
  const status = await readGitStatus(cwd);
  const conflictedPaths = status.files
    .filter(
      (file) =>
        file.indexStatus === "U" ||
        file.worktreeStatus === "U" ||
        ["DD", "AA"].includes(`${file.indexStatus}${file.worktreeStatus}`),
    )
    .map(({ path }) => path);
  if (outcome.code !== 0 && conflictedPaths.length === 0) {
    if (resumable) {
      await restoreStashOperationCheckpoint(cwd, {
        originalHead: originalHead!,
        targetRef,
        checkpointRef: checkpointRef!,
        branch: action.type === "branch" ? action.branch : null,
      });
    }
    throw new Error(outcome.output || "Git stash action failed.");
  }
  if (
    outcome.code === 0 &&
    (action.type === "pop" || action.type === "branch")
  ) {
    await dropStashByHash(cwd, action.hash);
  }
  if (outcome.code === 0 && checkpointRef) {
    await runGit(cwd, ["update-ref", "-d", checkpointRef]);
  }
  const stash =
    action.type === "apply"
      ? ((await readGitStashes(cwd)).stashes.find(
          ({ hash }) => hash === action.hash,
        ) ?? null)
      : null;
  return gitStashMutationResultSchema.parse({
    output: outcome.output,
    status,
    stash,
    conflictedPaths,
    operation:
      conflictedPaths.length && originalHead && checkpointRef
        ? {
            type: "stash",
            state: "conflicted",
            originalHead,
            currentHead: await resolveCommit(cwd, "HEAD"),
            sourceRef: stashOperationSource(action),
            sourceRevision:
              action.type === "clear" ? originalHead : action.hash,
            targetRef,
            targetRevision: originalHead,
            pendingCommits: [
              action.type === "clear" ? originalHead : action.hash,
            ],
            currentStep: 1,
            totalSteps: 1,
            checkpointRef,
            conflictedPaths,
          }
        : null,
  });
}

async function dropStashByHash(cwd: string, hash: string): Promise<string> {
  const stash = (await readGitStashes(cwd)).stashes.find(
    (candidate) => candidate.hash === hash,
  );
  if (!stash) return "The source stash was already absent.";
  return runGit(cwd, ["stash", "drop", stash.ref]);
}

function stashOperationSource(action: GitStashAction): string {
  if (action.type === "apply" || action.type === "pop") {
    return `${action.type}:${action.ref}`;
  }
  if (action.type === "branch") {
    return `branch:${action.branch}:${action.ref}`;
  }
  throw new Error("This stash action cannot create a resumable operation.");
}

function parseStashOperationSource(source: string | null): {
  action: "apply" | "pop" | "branch";
  branch: string | null;
} {
  if (source?.startsWith("apply:")) return { action: "apply", branch: null };
  if (source?.startsWith("pop:")) return { action: "pop", branch: null };
  if (source?.startsWith("branch:")) {
    const branch = source.slice("branch:".length).split(":", 1)[0];
    if (!branch) throw new Error("The stash branch operation is invalid.");
    return { action: "branch", branch };
  }
  throw new Error("The durable stash operation metadata is invalid.");
}

async function createStashOperationCheckpoint(
  cwd: string,
  originalHead: string,
  token: string,
): Promise<string> {
  const dirty = (await readGitStatus(cwd)).files.length > 0;
  const checkpointRef = `refs/cantrip/checkpoints/stash-${originalHead.slice(0, 12)}-${token.slice(0, 12)}-${dirty ? "dirty" : "clean"}`;
  if (!dirty) {
    await runGit(cwd, ["update-ref", checkpointRef, originalHead, ""]);
    return checkpointRef;
  }
  const before = await readGitStashes(cwd);
  await runGit(cwd, [
    "stash",
    "push",
    "--include-untracked",
    "--message",
    `Cantrip recovery ${token.slice(0, 12)}`,
  ]);
  const created = (await readGitStashes(cwd)).stashes.find(
    ({ hash }) => !before.stashes.some((stash) => stash.hash === hash),
  );
  if (!created) throw new Error("Git did not create the stash recovery point.");
  await runGit(cwd, ["update-ref", checkpointRef, created.hash, ""]);
  await runGit(cwd, ["stash", "apply", "--index", checkpointRef]);
  await dropStashByHash(cwd, created.hash);
  return checkpointRef;
}

async function restoreStashOperationCheckpoint(
  cwd: string,
  input: {
    originalHead: string;
    targetRef: string | null;
    checkpointRef: string;
    branch: string | null;
  },
): Promise<string> {
  const output: string[] = [];
  output.push(await runGit(cwd, ["reset", "--hard", input.originalHead]));
  output.push(await runGit(cwd, ["clean", "-fd"]));
  if (input.branch) {
    output.push(
      await runGit(
        cwd,
        input.targetRef
          ? ["switch", input.targetRef.replace(/^refs\/heads\//u, "")]
          : ["switch", "--detach", input.originalHead],
      ),
    );
    output.push(await runGit(cwd, ["reset", "--hard", input.originalHead]));
    output.push(await runGit(cwd, ["clean", "-fd"]));
    if (
      await gitSucceeds(cwd, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${input.branch}`,
      ])
    ) {
      output.push(await runGit(cwd, ["branch", "-D", input.branch]));
    }
  }
  if (input.checkpointRef.endsWith("-dirty")) {
    output.push(
      await runGit(cwd, ["stash", "apply", "--index", input.checkpointRef]),
    );
  }
  return output.filter(Boolean).join("\n");
}

function parseTrackingCounts(track: string): {
  ahead: number;
  behind: number;
  gone: boolean;
} {
  const ahead = Number.parseInt(/ahead (\d+)/u.exec(track)?.[1] ?? "0", 10);
  const behind = Number.parseInt(/behind (\d+)/u.exec(track)?.[1] ?? "0", 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
    gone: track.includes("gone"),
  };
}

async function readBranchWorktreeOwners(
  cwd: string,
): Promise<Map<string, { label: string; current: boolean }>> {
  const output = await gitRaw(cwd, ["worktree", "list", "--porcelain", "-z"]);
  const owners = new Map<string, { label: string; current: boolean }>();
  let worktreePath = "";
  const currentPath = await realpath(cwd).catch(() => path.resolve(cwd));
  for (const record of output.split("\0")) {
    if (record.startsWith("worktree ")) {
      worktreePath = record.slice("worktree ".length);
      continue;
    }
    if (record.startsWith("branch refs/heads/") && worktreePath) {
      const resolvedWorktreePath = await realpath(worktreePath).catch(() =>
        path.resolve(worktreePath),
      );
      owners.set(record.slice("branch refs/heads/".length), {
        label: path.basename(worktreePath) || worktreePath,
        current: resolvedWorktreePath === currentPath,
      });
    }
  }
  return owners;
}

function pullStrategyDescription(): GitBranchList["pullStrategy"] {
  return {
    mode: "fast-forward-only",
    description:
      "Cantrip pulls with --ff-only after fetching, so it never creates an implicit merge or rebase.",
  };
}

export async function readGitBranches(cwd: string): Promise<GitBranchList> {
  const head = await gitOutput(cwd, ["rev-parse", "--verify", "HEAD"]).catch(
    () => "",
  );
  const [currentBranch, remoteOutput, refOutput, owners, mergedOutput] =
    await Promise.all([
      gitOutput(cwd, ["branch", "--show-current"]),
      gitOutput(cwd, ["remote"]),
      gitRaw(cwd, [
        "for-each-ref",
        "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(authorname)%00%(authordate:iso-strict)%00%(subject)",
        "refs/heads",
        "refs/remotes",
      ]),
      readBranchWorktreeOwners(cwd),
      head
        ? Promise.all([
            gitOutput(cwd, [
              "branch",
              "--format=%(refname:short)",
              "--merged",
              "HEAD",
            ]),
            gitOutput(cwd, [
              "branch",
              "-r",
              "--format=%(refname:short)",
              "--merged",
              "HEAD",
            ]),
          ])
        : Promise.resolve(["", ""]),
    ]);
  const remotes = remoteOutput.split("\n").filter(Boolean).sort();
  const remoteSet = new Set(remotes);
  const merged = new Set(
    mergedOutput.flatMap((value) => value.split("\n")).filter(Boolean),
  );
  const parsed = refOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line): GitManagedBranch[] => {
      const [
        fullRef,
        name,
        hash,
        upstream = "",
        track = "",
        authorName = "Unknown",
        authoredAt = "",
        subject = "",
      ] = line.split("\0");
      if (!fullRef || !name || !hash || !authoredAt) return [];
      if (fullRef.endsWith("/HEAD")) return [];
      const kind = fullRef.startsWith("refs/remotes/") ? "remote" : "local";
      const remoteName =
        kind === "remote"
          ? (name.split("/")[0] ?? null)
          : upstream
            ? (upstream.split("/")[0] ?? null)
            : null;
      const counts = parseTrackingCounts(track);
      return [
        {
          name,
          fullRef,
          kind,
          current: kind === "local" && name === currentBranch,
          hash,
          upstream: upstream || null,
          upstreamGone: counts.gone,
          ahead: counts.ahead,
          behind: counts.behind,
          mergedIntoHead: head ? merged.has(name) : null,
          remoteName,
          remoteAvailable:
            kind === "remote"
              ? Boolean(remoteName && remoteSet.has(remoteName))
              : Boolean(upstream && !counts.gone),
          trackingLocalBranches: [],
          worktree: kind === "local" ? (owners.get(name) ?? null) : null,
          lastCommit: {
            hash,
            shortHash: hash.slice(0, 8),
            subject,
            authorName: authorName || "Unknown",
            authoredAt,
          },
        },
      ];
    });
  const localBranches = parsed.filter(({ kind }) => kind === "local");
  for (const branch of parsed) {
    if (branch.kind === "remote") {
      branch.trackingLocalBranches = localBranches
        .filter(({ upstream }) => upstream === branch.name)
        .map(({ name }) => name);
    }
  }
  const branches = parsed
    .sort((left, right) => {
      if (left.current !== right.current) return left.current ? -1 : 1;
      if (left.kind !== right.kind) return left.kind === "local" ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .slice(0, BRANCH_LIMIT);
  const configuredRemote = currentBranch
    ? await gitOutput(cwd, [
        "config",
        "--get",
        `branch.${currentBranch}.remote`,
      ]).catch(() => "")
    : "";
  const defaultRemote =
    configuredRemote && configuredRemote !== "."
      ? configuredRemote
      : remotes.includes("origin")
        ? "origin"
        : (remotes[0] ?? null);
  return gitBranchListSchema.parse({
    currentBranch: currentBranch || null,
    head: head || null,
    detached: !currentBranch,
    defaultRemote,
    remotes,
    pullStrategy: pullStrategyDescription(),
    branches,
    truncated: parsed.length > BRANCH_LIMIT,
    generatedAt: new Date().toISOString(),
  });
}

function branchActionToken(
  action: GitBranchAction,
  inventory: GitBranchList,
  workspace: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action,
        head: inventory.head,
        refs: inventory.branches.map(
          ({ fullRef, hash, upstream, worktree }) => ({
            fullRef,
            hash,
            upstream,
            worktree,
          }),
        ),
        workspace,
      }),
    )
    .digest("hex");
}

function branchByName(
  inventory: GitBranchList,
  name: string,
  kind?: "local" | "remote",
): GitManagedBranch | null {
  return (
    inventory.branches.find(
      (branch) => branch.name === name && (!kind || branch.kind === kind),
    ) ?? null
  );
}

async function validateBranchAction(
  cwd: string,
  action: GitBranchAction,
  inventory: GitBranchList,
): Promise<{
  branch: GitManagedBranch | null;
  summary: string;
  warnings: string[];
}> {
  const warnings: string[] = [];
  let branch: GitManagedBranch | null = null;
  const requireRemote = (name: string) => {
    if (!inventory.remotes.includes(name)) {
      throw new Error(`Git remote ${name} does not exist.`);
    }
  };
  const requireLocal = (name: string) => {
    const selected = branchByName(inventory, name, "local");
    if (!selected) throw new Error(`Local branch ${name} does not exist.`);
    return selected;
  };
  if ("name" in action && action.type !== "switch") {
    await runGit(cwd, ["check-ref-format", "--branch", action.name]);
  }
  switch (action.type) {
    case "create": {
      if (branchByName(inventory, action.name, "local")) {
        throw new Error(`Local branch ${action.name} already exists.`);
      }
      if (!action.startPoint && !inventory.head) {
        throw new Error(
          "An unborn repository needs an existing start point before a branch can be created.",
        );
      }
      if (action.startPoint) {
        await runGit(cwd, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${action.startPoint}^{commit}`,
        ]);
      }
      if (action.checkout && (await readGitStatus(cwd)).files.length > 0) {
        warnings.push(
          "Local changes will remain in the worktree while switching to the new branch.",
        );
      }
      return {
        branch: null,
        summary: `${action.checkout ? "Create and switch to" : "Create"} local branch ${action.name}${action.startPoint ? ` at ${action.startPoint}` : " at the current HEAD"}.`,
        warnings,
      };
    }
    case "switch": {
      await runGit(cwd, ["check-ref-format", "--branch", action.name]);
      branch = branchByName(inventory, action.name, action.kind);
      if (!branch) throw new Error(`Branch ${action.name} does not exist.`);
      if (
        branch.kind === "local" &&
        branch.worktree &&
        !branch.worktree.current
      ) {
        throw new Error(
          `${action.name} is checked out in worktree ${branch.worktree.label}. Switch to that worktree instead.`,
        );
      }
      if ((await readGitStatus(cwd)).files.length > 0) {
        warnings.push(
          "Local changes must be compatible with the target branch or Git will refuse the switch.",
        );
      }
      return {
        branch,
        summary: `Switch this worktree to ${action.name}.`,
        warnings,
      };
    }
    case "publish":
      branch = requireLocal(action.name);
      requireRemote(action.remote);
      return {
        branch,
        summary: `Push ${action.name} to ${action.remote} and set ${action.remote}/${action.name} as its upstream.`,
        warnings,
      };
    case "rename":
      branch = requireLocal(action.name);
      await runGit(cwd, ["check-ref-format", "--branch", action.newName]);
      if (branchByName(inventory, action.newName, "local")) {
        throw new Error(`Local branch ${action.newName} already exists.`);
      }
      if (branch.worktree && !branch.worktree.current) {
        throw new Error(
          `${action.name} is checked out in worktree ${branch.worktree.label} and cannot be renamed here.`,
        );
      }
      if (branch.upstream) {
        warnings.push(
          `The upstream remains ${branch.upstream}; renaming does not rename the remote branch.`,
        );
      }
      return {
        branch,
        summary: `Rename local branch ${action.name} to ${action.newName}.`,
        warnings,
      };
    case "deleteLocal":
      branch = requireLocal(action.name);
      if (branch.current)
        throw new Error("The current branch cannot be deleted.");
      if (branch.worktree) {
        throw new Error(
          `${action.name} is checked out in worktree ${branch.worktree.label} and cannot be deleted.`,
        );
      }
      if (!branch.mergedIntoHead && action.force) {
        warnings.push(
          "This branch is not merged into the current HEAD. Its commits may become reachable only through the reflog.",
        );
      }
      return {
        branch,
        summary: `Delete local branch ${action.name}${action.force ? " even though it is unmerged" : " if it is merged"}.`,
        warnings,
      };
    case "deleteRemote": {
      requireRemote(action.remote);
      await runGit(cwd, ["check-ref-format", "--branch", action.name]);
      branch = branchByName(
        inventory,
        `${action.remote}/${action.name}`,
        "remote",
      );
      if (!branch) {
        throw new Error(
          `Remote branch ${action.remote}/${action.name} does not exist locally. Fetch before retrying.`,
        );
      }
      warnings.push(
        "This deletes the branch for every collaborator using this remote.",
      );
      return {
        branch,
        summary: `Delete remote branch ${action.remote}/${action.name}.`,
        warnings,
      };
    }
    case "setUpstream":
      branch = requireLocal(action.name);
      if (action.upstream) {
        const upstream = branchByName(inventory, action.upstream, "remote");
        if (!upstream)
          throw new Error(`Remote branch ${action.upstream} does not exist.`);
      } else if (!branch.upstream) {
        throw new Error(`${action.name} does not have an upstream to unset.`);
      }
      return {
        branch,
        summary: action.upstream
          ? `Set ${action.upstream} as the upstream for ${action.name}.`
          : `Unset the upstream for ${action.name}.`,
        warnings,
      };
    case "fetch":
      if (action.remote) requireRemote(action.remote);
      if (action.prune) {
        warnings.push(
          "Prune removes local remote-tracking refs that no longer exist on the remote.",
        );
      }
      return {
        branch: null,
        summary: `${action.prune ? "Fetch and prune" : "Fetch"} ${action.remote ?? "all remotes"}.`,
        warnings,
      };
  }
}

export async function previewGitBranchAction(
  cwd: string,
  action: GitBranchAction,
): Promise<GitBranchActionPreview> {
  const inventory = await readGitBranches(cwd);
  const validation = await validateBranchAction(cwd, action, inventory);
  const workspace = await workspaceFingerprint(cwd);
  return gitBranchActionPreviewSchema.parse({
    action,
    token: branchActionToken(action, inventory, workspace),
    destructive:
      action.type === "deleteLocal" ||
      action.type === "deleteRemote" ||
      (action.type === "fetch" && action.prune),
    ...validation,
  });
}

export async function applyGitBranchAction(
  cwd: string,
  action: GitBranchAction,
  token: string,
): Promise<GitBranchMutationResult> {
  const preview = await previewGitBranchAction(cwd, action);
  if (preview.token !== token) {
    throw new Error(
      "The branches or worktree changed after this preview. Review the action again.",
    );
  }
  let args: string[];
  switch (action.type) {
    case "create":
      args = action.checkout
        ? [
            "switch",
            "-c",
            action.name,
            ...(action.startPoint ? [action.startPoint] : []),
          ]
        : [
            "branch",
            action.name,
            ...(action.startPoint ? [action.startPoint] : []),
          ];
      break;
    case "switch": {
      const selected = preview.branch!;
      if (selected.kind === "local") args = ["switch", selected.name];
      else {
        const localName = selected.name.split("/").slice(1).join("/");
        if (!localName)
          throw new Error("The remote branch has no local branch name.");
        args = ["switch", "--track", "-c", localName, selected.name];
      }
      break;
    }
    case "publish":
      args = ["push", "--set-upstream", action.remote, action.name];
      break;
    case "rename":
      args = preview.branch?.current
        ? ["branch", "-m", action.newName]
        : ["branch", "-m", action.name, action.newName];
      break;
    case "deleteLocal":
      args = ["branch", action.force ? "-D" : "-d", action.name];
      break;
    case "deleteRemote":
      args = ["push", action.remote, "--delete", action.name];
      break;
    case "setUpstream":
      args = action.upstream
        ? ["branch", `--set-upstream-to=${action.upstream}`, action.name]
        : ["branch", "--unset-upstream", action.name];
      break;
    case "fetch":
      args = [
        "fetch",
        ...(action.remote ? [action.remote] : ["--all"]),
        ...(action.prune ? ["--prune"] : []),
      ];
      break;
  }
  const output = await runGit(cwd, args);
  return gitBranchMutationResultSchema.parse({
    output,
    status: await readGitStatus(cwd),
    branches: await readGitBranches(cwd),
  });
}

function sanitizeRemoteText(value: string): {
  redacted: boolean;
  value: string;
} {
  let redacted = false;
  let sanitized = value;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      redacted = true;
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(?:token|key|auth|password|secret)/iu.test(key)) {
        parsed.searchParams.set(key, "REDACTED");
        redacted = true;
      }
    }
    sanitized = parsed.toString();
  } catch {
    const withoutUserInfo = sanitized.replace(
      /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu,
      "$1",
    );
    redacted ||= withoutUserInfo !== sanitized;
    sanitized = withoutUserInfo.replace(
      /([?&](?:token|key|auth|password|secret)[^=]*=)[^&\s]+/giu,
      "$1REDACTED",
    );
    redacted ||= sanitized !== withoutUserInfo;
  }
  return { redacted, value: sanitized };
}

async function runGitOutcomeBounded(
  cwd: string,
  args: string[],
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", cwd, ...args],
      {
        encoding: "utf8",
        maxBuffer: GIT_BUFFER,
        timeout: REMOTE_TIMEOUT_MS,
      },
    );
    return { code: 0, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const failure = error as {
      message?: string;
      stderr?: string;
      stdout?: string;
    };
    const output =
      failure.stderr?.trim() ||
      failure.stdout?.trim() ||
      failure.message ||
      "Git command failed.";
    return { code: 1, output: sanitizeRemoteText(output).value };
  }
}

export async function readGitRemotes(cwd: string): Promise<GitRemoteList> {
  const names = (await gitOutput(cwd, ["remote"]))
    .split("\n")
    .filter(Boolean)
    .sort();
  const currentBranch = await gitOutput(cwd, ["branch", "--show-current"]);
  const configuredFetch = await gitOutput(cwd, [
    "config",
    "--get",
    "cantrip.defaultFetchRemote",
  ]).catch(() => "");
  const branchRemote = currentBranch
    ? await gitOutput(cwd, [
        "config",
        "--get",
        `branch.${currentBranch}.remote`,
      ]).catch(() => "")
    : "";
  const configuredPush = await gitOutput(cwd, [
    "config",
    "--get",
    "remote.pushDefault",
  ]).catch(() => "");
  const defaultFetch =
    (configuredFetch && names.includes(configuredFetch)
      ? configuredFetch
      : branchRemote && branchRemote !== "." && names.includes(branchRemote)
        ? branchRemote
        : names.includes("origin")
          ? "origin"
          : names[0]) ?? null;
  const defaultPush =
    (configuredPush && names.includes(configuredPush)
      ? configuredPush
      : defaultFetch) ?? null;
  const remotes = await Promise.all(
    names.map(async (name) => {
      const [fetchValue, pushValue] = await Promise.all([
        gitOutput(cwd, ["remote", "get-url", name]),
        gitOutput(cwd, ["remote", "get-url", "--push", name]).catch(() => ""),
      ]);
      const fetchUrl = sanitizeRemoteText(fetchValue);
      const pushUrl = sanitizeRemoteText(pushValue || fetchValue);
      return {
        name,
        fetchUrl: fetchUrl.value,
        fetchUrlRedacted: fetchUrl.redacted,
        pushUrl: pushUrl.value,
        pushUrlRedacted: pushUrl.redacted,
        defaultFetch: name === defaultFetch,
        defaultPush: name === defaultPush,
      };
    }),
  );
  return gitRemoteListSchema.parse({
    remotes,
    generatedAt: new Date().toISOString(),
  });
}

function remoteActionToken(
  action: GitRemoteAction,
  remotes: GitRemoteList,
  workspace: string,
  configuration: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action,
        remotes: remotes.remotes,
        workspace,
        configuration,
      }),
    )
    .digest("hex");
}

async function remoteConfigurationFingerprint(cwd: string): Promise<string> {
  const raw = await gitRaw(cwd, [
    "config",
    "--null",
    "--get-regexp",
    "^(remote\\..*\\.(url|pushurl)|remote\\.pushDefault|cantrip\\.defaultFetchRemote)$",
  ]).catch(() => "");
  return createHash("sha256").update(raw).digest("hex");
}

export async function previewGitRemoteAction(
  cwd: string,
  action: GitRemoteAction,
): Promise<GitRemoteActionPreview> {
  const remotes = await readGitRemotes(cwd);
  const remote =
    "name" in action
      ? (remotes.remotes.find(({ name }) => name === action.name) ?? null)
      : action.type === "fetch"
        ? (remotes.remotes.find(({ name }) => name === action.remote) ?? null)
        : null;
  const requireRemote = (name: string) => {
    const selected = remotes.remotes.find(
      (candidate) => candidate.name === name,
    );
    if (!selected) throw new Error(`Git remote ${name} does not exist.`);
    return selected;
  };
  let summary: string;
  const warnings: string[] = [];
  switch (action.type) {
    case "add":
      await runGit(cwd, [
        "check-ref-format",
        `refs/remotes/${action.name}/probe`,
      ]);
      if (remote) throw new Error(`Git remote ${action.name} already exists.`);
      summary = `Add remote ${action.name} with fetch URL ${sanitizeRemoteText(action.fetchUrl).value}.`;
      break;
    case "edit":
      requireRemote(action.name);
      summary = `Replace the fetch and push URLs for remote ${action.name}.`;
      if (remote?.fetchUrlRedacted || remote?.pushUrlRedacted) {
        warnings.push(
          "The existing URL contains hidden credentials. Saving replaces the complete URL, including those credentials.",
        );
      }
      break;
    case "remove":
      requireRemote(action.name);
      summary = `Remove remote ${action.name} and its remote-tracking refs.`;
      warnings.push(
        "Local branches and commits remain, but upstream configuration may become invalid.",
      );
      break;
    case "setDefaults":
      if (action.fetchRemote) requireRemote(action.fetchRemote);
      if (action.pushRemote) requireRemote(action.pushRemote);
      summary = `Use ${action.fetchRemote ?? "Git's automatic choice"} for fetch and ${action.pushRemote ?? "Git's automatic choice"} for push by default.`;
      break;
    case "fetch":
      requireRemote(action.remote);
      summary = `${action.prune ? "Fetch and prune" : "Fetch"} remote ${action.remote}.`;
      if (action.prune)
        warnings.push(
          "Prune removes remote-tracking refs deleted from the remote.",
        );
      break;
  }
  const [workspace, configuration] = await Promise.all([
    workspaceFingerprint(cwd),
    remoteConfigurationFingerprint(cwd),
  ]);
  return gitRemoteActionPreviewSchema.parse({
    action,
    token: remoteActionToken(action, remotes, workspace, configuration),
    destructive:
      action.type === "remove" || (action.type === "fetch" && action.prune),
    summary,
    warnings,
    remote,
  });
}

export async function applyGitRemoteAction(
  cwd: string,
  action: GitRemoteAction,
  token: string,
): Promise<GitRemoteMutationResult> {
  const preview = await previewGitRemoteAction(cwd, action);
  if (preview.token !== token) {
    throw new Error(
      "The remotes or worktree changed after this preview. Review the action again.",
    );
  }
  const output: string[] = [];
  switch (action.type) {
    case "add":
      output.push(
        await runGit(cwd, ["remote", "add", action.name, action.fetchUrl]),
      );
      if (action.pushUrl && action.pushUrl !== action.fetchUrl) {
        output.push(
          await runGit(cwd, [
            "remote",
            "set-url",
            "--push",
            action.name,
            action.pushUrl,
          ]),
        );
      }
      break;
    case "edit":
      output.push(
        await runGit(cwd, ["remote", "set-url", action.name, action.fetchUrl]),
      );
      output.push(
        await runGit(cwd, [
          "remote",
          "set-url",
          "--push",
          action.name,
          action.pushUrl ?? action.fetchUrl,
        ]),
      );
      break;
    case "remove":
      output.push(await runGit(cwd, ["remote", "remove", action.name]));
      break;
    case "setDefaults":
      if (action.fetchRemote) {
        output.push(
          await runGit(cwd, [
            "config",
            "cantrip.defaultFetchRemote",
            action.fetchRemote,
          ]),
        );
      } else {
        await runGitOutcome(cwd, [
          "config",
          "--unset",
          "cantrip.defaultFetchRemote",
        ]);
      }
      if (action.pushRemote) {
        output.push(
          await runGit(cwd, [
            "config",
            "remote.pushDefault",
            action.pushRemote,
          ]),
        );
      } else {
        await runGitOutcome(cwd, ["config", "--unset", "remote.pushDefault"]);
      }
      break;
    case "fetch": {
      const result = await runGitOutcomeBounded(cwd, [
        "fetch",
        action.remote,
        ...(action.prune ? ["--prune"] : []),
      ]);
      if (result.code !== 0) throw new Error(result.output);
      output.push(result.output);
      break;
    }
  }
  return gitRemoteMutationResultSchema.parse({
    output: output.filter(Boolean).join("\n"),
    status: await readGitStatus(cwd),
    remotes: await readGitRemotes(cwd),
  });
}

type SubmoduleConfiguration = {
  name: string;
  path: string;
  localPath: string;
  parentPath: string;
  url: string;
  branch: string | null;
};

function safeSubmodulePath(cwd: string, candidate: string): string | null {
  const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized === ".") return null;
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, normalized);
  if (!absolute.startsWith(`${root}${path.sep}`)) return null;
  return normalized;
}

async function readSubmoduleConfigurationFile(
  cwd: string,
  filePath: string,
  parentPath: string,
): Promise<SubmoduleConfiguration[]> {
  const metadata = await lstat(path.resolve(cwd, filePath)).catch(() => null);
  if (!metadata?.isFile()) return [];
  const output = await gitOutput(cwd, [
    "config",
    "-f",
    filePath,
    "--get-regexp",
    "^submodule\\..*\\.(path|url|branch)$",
  ]).catch(() => "");
  const sections = new Map<
    string,
    { branch?: string; path?: string; url?: string }
  >();
  for (const line of output.split("\n")) {
    const separator = line.indexOf(" ");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const match = /^submodule\.(.*)\.(path|url|branch)$/u.exec(key);
    if (!match) continue;
    const sectionName = match[1];
    const field = match[2] as "branch" | "path" | "url" | undefined;
    if (!sectionName || !field) continue;
    const section = sections.get(sectionName) ?? {};
    section[field] = value;
    sections.set(sectionName, section);
  }
  const configurations: SubmoduleConfiguration[] = [];
  for (const [name, section] of sections) {
    if (!section.path || !section.url) continue;
    const localPath = safeSubmodulePath(cwd, section.path);
    const fullPath = safeSubmodulePath(
      cwd,
      parentPath ? `${parentPath}/${section.path}` : section.path,
    );
    if (!localPath || !fullPath) continue;
    configurations.push({
      name: parentPath ? `${parentPath}:${name}` : name,
      path: fullPath,
      localPath,
      parentPath,
      url: sanitizeRemoteText(section.url).value,
      branch: section.branch || null,
    });
  }
  return configurations;
}

function parseSubmoduleStatus(
  output: string,
): Map<string, { hash: string; marker: " " | "+" | "-" | "U" }> {
  const statuses = new Map<
    string,
    { hash: string; marker: " " | "+" | "-" | "U" }
  >();
  for (const line of output.split("\n")) {
    const match = /^([ +\-U])([0-9a-f]{40,64})\s+(.+?)(?:\s+\(.*\))?$/u.exec(
      line,
    );
    if (!match) continue;
    const submodulePath = match[3];
    const hash = match[2];
    if (!submodulePath || !hash) continue;
    statuses.set(submodulePath, {
      marker: match[1] as " " | "+" | "-" | "U",
      hash,
    });
  }
  return statuses;
}

async function expectedSubmoduleHash(
  cwd: string,
  configuration: SubmoduleConfiguration,
): Promise<string | null> {
  const parent = configuration.parentPath
    ? path.resolve(cwd, configuration.parentPath)
    : cwd;
  const output = await gitOutput(parent, [
    "ls-files",
    "--stage",
    "--",
    configuration.localPath,
  ]).catch(() => "");
  return /^160000\s+([0-9a-f]{40,64})\s/u.exec(output)?.[1] ?? null;
}

export async function readGitSubmodules(
  cwd: string,
): Promise<GitSubmoduleList> {
  const rawStatus = await gitRaw(cwd, [
    "-c",
    "core.quotePath=false",
    "submodule",
    "status",
    "--recursive",
  ]).catch(() => "");
  const statuses = parseSubmoduleStatus(rawStatus);
  const configurationFiles = new Map<string, string>([["", ".gitmodules"]]);
  for (const [submodulePath, status] of statuses) {
    if (status.marker !== "-") {
      configurationFiles.set(submodulePath, `${submodulePath}/.gitmodules`);
    }
  }
  const configured = (
    await Promise.all(
      [...configurationFiles].map(([parentPath, filePath]) =>
        readSubmoduleConfigurationFile(cwd, filePath, parentPath),
      ),
    )
  )
    .flat()
    .sort((left, right) => left.path.localeCompare(right.path));
  const bounded = configured.slice(0, 10_000);
  const submodules = await Promise.all(
    bounded.map(async (configuration): Promise<GitSubmoduleSummary> => {
      const observed = statuses.get(configuration.path);
      const initialized = Boolean(observed && observed.marker !== "-");
      const [expectedHash, dirty] = await Promise.all([
        expectedSubmoduleHash(cwd, configuration),
        initialized
          ? gitOutput(path.resolve(cwd, configuration.path), [
              "status",
              "--porcelain=v1",
              "--untracked-files=normal",
            ])
              .then(Boolean)
              .catch(() => false)
          : false,
      ]);
      const state: GitSubmoduleSummary["state"] = !observed
        ? "missing"
        : observed.marker === "-"
          ? "uninitialized"
          : observed.marker === "U"
            ? "conflicted"
            : observed.marker === "+" || dirty
              ? "changed"
              : "clean";
      return {
        name: configuration.name,
        path: configuration.path,
        url: configuration.url,
        branch: configuration.branch,
        expectedHash,
        currentHash: initialized ? (observed?.hash ?? null) : null,
        initialized,
        dirty,
        nested: Boolean(configuration.parentPath),
        state,
      };
    }),
  );
  return gitSubmoduleListSchema.parse({
    submodules,
    truncated: configured.length > bounded.length,
    generatedAt: new Date().toISOString(),
  });
}

function selectedSubmodules(
  list: GitSubmoduleList,
  action: GitSubmoduleAction,
): GitSubmoduleSummary[] {
  if (action.type === "deinitialize") {
    const selected = list.submodules.find(({ path }) => path === action.path);
    if (!selected) throw new Error(`Submodule ${action.path} does not exist.`);
    return [selected];
  }
  if (!action.path) {
    return action.recursive
      ? list.submodules
      : list.submodules.filter(({ nested }) => !nested);
  }
  const selected = list.submodules.filter(
    ({ path }) =>
      path === action.path ||
      (action.recursive && path.startsWith(`${action.path}/`)),
  );
  if (!selected.some(({ path }) => path === action.path)) {
    throw new Error(`Submodule ${action.path} does not exist.`);
  }
  return selected;
}

function submoduleActionToken(
  action: GitSubmoduleAction,
  list: GitSubmoduleList,
  workspace: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ action, submodules: list.submodules, workspace }))
    .digest("hex");
}

export async function previewGitSubmoduleAction(
  cwd: string,
  action: GitSubmoduleAction,
): Promise<GitSubmoduleActionPreview> {
  const [submodules, workspace] = await Promise.all([
    readGitSubmodules(cwd),
    workspaceFingerprint(cwd),
  ]);
  const targets = selectedSubmodules(submodules, action);
  if (targets.length === 0) throw new Error("No submodules match this action.");
  const scope = action.path ?? "all top-level submodules";
  const warnings: string[] = [];
  let summary: string;
  switch (action.type) {
    case "initialize":
      summary = `Initialize ${scope}${action.recursive ? " and nested submodules" : ""} at the commits recorded by the repository.`;
      break;
    case "update":
      summary = `${action.remote ? "Fetch configured remote branches and update" : "Update"} ${scope}${action.recursive ? " and nested submodules" : ""}.`;
      if (action.remote) {
        warnings.push(
          "Remote update can check out commits that differ from the superproject's recorded submodule commits.",
        );
      }
      break;
    case "sync":
      summary = `Synchronize configured URLs for ${scope}${action.recursive ? " and nested submodules" : ""}.`;
      break;
    case "deinitialize":
      summary = `Deinitialize submodule ${action.path} and remove its checked-out worktree.`;
      if (targets[0]?.dirty && !action.force) {
        throw new Error(
          `Submodule ${action.path} has local changes. Review again with force only if those changes may be discarded.`,
        );
      }
      warnings.push(
        "Deinitializing removes the submodule worktree but keeps its Git data and the superproject configuration.",
      );
      if (action.force) {
        warnings.push("Force deinitialize discards local submodule changes.");
      }
      break;
  }
  return gitSubmoduleActionPreviewSchema.parse({
    action,
    token: submoduleActionToken(action, submodules, workspace),
    destructive: action.type === "deinitialize",
    summary,
    warnings,
    targets,
  });
}

export async function applyGitSubmoduleAction(
  cwd: string,
  action: GitSubmoduleAction,
  token: string,
): Promise<GitSubmoduleMutationResult> {
  const preview = await previewGitSubmoduleAction(cwd, action);
  if (preview.token !== token) {
    throw new Error(
      "The submodules or selected worktree changed after this preview. Review the action again.",
    );
  }
  const actionPath = action.path;
  const inventory = actionPath ? await readGitSubmodules(cwd) : null;
  const parentModule = actionPath
    ? inventory?.submodules
        .filter(
          ({ path: candidate }) =>
            candidate !== actionPath && actionPath.startsWith(`${candidate}/`),
        )
        .sort((left, right) => right.path.length - left.path.length)[0]
    : undefined;
  const commandCwd = parentModule ? path.resolve(cwd, parentModule.path) : cwd;
  const commandPath =
    actionPath && parentModule
      ? actionPath.slice(parentModule.path.length + 1)
      : actionPath;
  const args = ["submodule"];
  switch (action.type) {
    case "initialize":
      args.push(
        "update",
        "--init",
        ...(action.recursive ? ["--recursive"] : []),
      );
      break;
    case "update":
      args.push(
        "update",
        ...(action.recursive ? ["--recursive"] : []),
        ...(action.remote ? ["--remote"] : []),
      );
      break;
    case "sync":
      args.push("sync", ...(action.recursive ? ["--recursive"] : []));
      break;
    case "deinitialize":
      args.push("deinit", ...(action.force ? ["--force"] : []));
      break;
  }
  if (commandPath) args.push("--", commandPath);
  const outcome = await runGitOutcomeBounded(commandCwd, args);
  if (outcome.code !== 0) throw new Error(outcome.output);
  return gitSubmoduleMutationResultSchema.parse({
    output: outcome.output,
    status: await readGitStatus(cwd),
    submodules: await readGitSubmodules(cwd),
  });
}

function parseGitLfsPatterns(output: string) {
  const patterns: GitLfsStatus["patterns"] = [];
  let tracked = false;
  for (const line of output.split("\n")) {
    if (line.trim() === "Listing tracked patterns") {
      tracked = true;
      continue;
    }
    if (line.trim() === "Listing excluded patterns") break;
    if (!tracked) continue;
    const match = /^\s{4}(.+?)\s+\((.+)\)$/u.exec(line);
    const pattern = match?.[1];
    const source = match?.[2];
    if (pattern && source && safeSubmodulePath(".", source)) {
      patterns.push({ pattern, source });
    }
  }
  return patterns.slice(0, 10_000);
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseGitLfsFiles(
  output: string,
  pending: Map<string, string>,
): { files: GitLfsStatus["files"]; truncated: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { files: [], truncated: false };
  }
  const rawFiles = jsonRecord(parsed)?.files;
  const entries = Array.isArray(rawFiles) ? rawFiles : [];
  const files: GitLfsStatus["files"] = [];
  for (const raw of entries.slice(0, 10_000)) {
    const file = jsonRecord(raw);
    if (!file) continue;
    const filePath = typeof file.name === "string" ? file.name : null;
    const oid = typeof file.oid === "string" ? file.oid : null;
    if (!filePath || !oid || !safeSubmodulePath(".", filePath)) continue;
    files.push({
      path: filePath,
      oid,
      size:
        typeof file.size === "number" && Number.isSafeInteger(file.size)
          ? Math.max(0, file.size)
          : 0,
      checkedOut: file.checkout === true,
      downloaded: file.downloaded === true,
      status: pending.get(filePath) ?? null,
    });
  }
  return { files, truncated: entries.length > 10_000 };
}

function parseGitLfsPending(output: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return new Map();
  }
  const rawFiles = jsonRecord(jsonRecord(parsed)?.files) ?? {};
  const pending = new Map<string, string>();
  for (const [filePath, raw] of Object.entries(rawFiles).slice(0, 10_000)) {
    const status = jsonRecord(raw)?.status;
    if (
      typeof status === "string" &&
      status &&
      safeSubmodulePath(".", filePath)
    ) {
      pending.set(filePath, status);
    }
  }
  return pending;
}

function parseGitLfsLocks(output: string): {
  locks: GitLfsLock[];
  truncated: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { locks: [], truncated: false };
  }
  const wrapped = jsonRecord(parsed);
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(wrapped?.locks)
      ? wrapped.locks
      : [];
  const locks: GitLfsLock[] = [];
  for (const raw of entries.slice(0, 10_000)) {
    const lock = jsonRecord(raw);
    if (!lock) continue;
    const id = typeof lock.id === "string" ? lock.id : null;
    const lockPath = typeof lock.path === "string" ? lock.path : null;
    if (!id || !lockPath || !safeSubmodulePath(".", lockPath)) continue;
    const owner = jsonRecord(lock.owner);
    const lockedAtValue =
      typeof lock.locked_at === "string"
        ? lock.locked_at
        : typeof lock.lockedAt === "string"
          ? lock.lockedAt
          : null;
    const lockedAt =
      lockedAtValue && !Number.isNaN(Date.parse(lockedAtValue))
        ? new Date(lockedAtValue).toISOString()
        : null;
    locks.push({
      id,
      path: lockPath,
      owner: typeof owner?.name === "string" ? owner.name : null,
      lockedAt,
      ours: lock.ours === true,
    });
  }
  return { locks, truncated: entries.length > 10_000 };
}

export async function readGitLfsStatus(
  cwd: string,
  refreshLocks = false,
): Promise<GitLfsStatus> {
  const version = await runGitOutcomeBounded(cwd, ["lfs", "version"]);
  if (version.code !== 0) {
    return gitLfsStatusSchema.parse({
      available: false,
      version: null,
      message: version.output,
      patterns: [],
      files: [],
      filesTruncated: false,
      missingObjects: 0,
      pendingPaths: [],
      locks: [],
      locksTruncated: false,
      locksCached: true,
      lockError: null,
      generatedAt: new Date().toISOString(),
    });
  }
  const [patternsResult, filesResult, pendingResult, locksResult] =
    await Promise.all([
      runGitOutcomeBounded(cwd, ["lfs", "track"]),
      runGitOutcomeBounded(cwd, ["lfs", "ls-files", "--json", "--all"]),
      runGitOutcomeBounded(cwd, ["lfs", "status", "--json"]),
      runGitOutcomeBounded(cwd, [
        "lfs",
        "locks",
        "--json",
        ...(refreshLocks ? [] : ["--cached"]),
      ]),
    ]);
  const pending =
    pendingResult.code === 0
      ? parseGitLfsPending(pendingResult.output)
      : new Map<string, string>();
  const parsedFiles =
    filesResult.code === 0
      ? parseGitLfsFiles(filesResult.output, pending)
      : { files: [], truncated: false };
  const parsedLocks =
    locksResult.code === 0
      ? parseGitLfsLocks(locksResult.output)
      : { locks: [], truncated: false };
  return gitLfsStatusSchema.parse({
    available: true,
    version: version.output,
    message:
      filesResult.code === 0 && pendingResult.code === 0
        ? null
        : [filesResult.output, pendingResult.output]
            .filter(Boolean)
            .join("\n")
            .slice(0, 10_000),
    patterns:
      patternsResult.code === 0
        ? parseGitLfsPatterns(patternsResult.output)
        : [],
    files: parsedFiles.files,
    filesTruncated: parsedFiles.truncated,
    missingObjects: parsedFiles.files.filter(({ downloaded }) => !downloaded)
      .length,
    pendingPaths: [...pending].map(([filePath, status]) => ({
      path: filePath,
      status,
    })),
    locks: parsedLocks.locks,
    locksTruncated: parsedLocks.truncated,
    locksCached: !refreshLocks,
    lockError: locksResult.code === 0 ? null : locksResult.output,
    generatedAt: new Date().toISOString(),
  });
}

function gitLfsActionToken(
  action: GitLfsAction,
  status: GitLfsStatus,
  workspace: string,
): string {
  const { generatedAt: _generatedAt, ...stableStatus } = status;
  return createHash("sha256")
    .update(JSON.stringify({ action, status: stableStatus, workspace }))
    .digest("hex");
}

export async function previewGitLfsAction(
  cwd: string,
  action: GitLfsAction,
): Promise<GitLfsActionPreview> {
  const [status, workspace] = await Promise.all([
    readGitLfsStatus(cwd),
    workspaceFingerprint(cwd),
  ]);
  if (!status.available) {
    throw new Error(
      status.message ?? "Git LFS is not available on this worker.",
    );
  }
  const warnings: string[] = [];
  let summary: string;
  switch (action.type) {
    case "install":
      summary = "Install Git LFS hooks and filters for this repository only.";
      break;
    case "track":
      summary = `Track ${action.pattern} with Git LFS and update .gitattributes.`;
      break;
    case "untrack":
      summary = `Stop tracking ${action.pattern} with Git LFS and update .gitattributes.`;
      warnings.push(
        "Existing committed LFS objects are not rewritten automatically.",
      );
      break;
    case "fetch":
      summary = `${action.all ? "Fetch every reachable" : "Fetch required"} Git LFS object${action.remote ? ` from ${action.remote}` : ""}.`;
      break;
    case "pull":
      summary = `Fetch and check out Git LFS objects${action.remote ? ` from ${action.remote}` : ""}.`;
      break;
    case "prune":
      summary = "Prune old local Git LFS objects that are no longer required.";
      warnings.push(
        "Pruned local objects may need to be downloaded again later.",
      );
      if (action.verifyRemote) {
        warnings.push(
          "Remote verification can fail when the LFS server is offline.",
        );
      }
      break;
    case "refreshLocks":
      summary = "Refresh lock ownership from the configured Git LFS server.";
      break;
    case "lock":
      summary = `Lock ${action.path} on the configured Git LFS server.`;
      break;
    case "unlock":
      summary = `${action.force ? "Force unlock" : "Unlock"} ${action.path} on the configured Git LFS server.`;
      if (action.force)
        warnings.push("Force unlock may remove another user's lock.");
      break;
  }
  return gitLfsActionPreviewSchema.parse({
    action,
    token: gitLfsActionToken(action, status, workspace),
    destructive:
      action.type === "prune" ||
      action.type === "untrack" ||
      (action.type === "unlock" && action.force),
    summary,
    warnings,
    status,
  });
}

export async function applyGitLfsAction(
  cwd: string,
  action: GitLfsAction,
  token: string,
): Promise<GitLfsMutationResult> {
  const preview = await previewGitLfsAction(cwd, action);
  if (preview.token !== token) {
    throw new Error(
      "Git LFS or the selected worktree changed after this preview. Review the action again.",
    );
  }
  const args = ["lfs"];
  switch (action.type) {
    case "install":
      args.push("install", "--local");
      break;
    case "track":
      args.push("track", action.pattern);
      break;
    case "untrack":
      args.push("untrack", action.pattern);
      break;
    case "fetch":
      args.push(
        "fetch",
        ...(action.all ? ["--all"] : []),
        ...(action.remote ? [action.remote] : []),
      );
      break;
    case "pull":
      args.push("pull", ...(action.remote ? [action.remote] : []));
      break;
    case "prune":
      args.push("prune", ...(action.verifyRemote ? ["--verify-remote"] : []));
      break;
    case "refreshLocks":
      args.push("locks", "--json");
      break;
    case "lock":
      args.push("lock", action.path);
      break;
    case "unlock":
      args.push("unlock", ...(action.force ? ["--force"] : []), action.path);
      break;
  }
  const outcome = await runGitOutcomeBounded(cwd, args);
  if (outcome.code !== 0) throw new Error(outcome.output);
  return gitLfsMutationResultSchema.parse({
    output: sanitizeRemoteText(outcome.output).value,
    status: await readGitStatus(cwd),
    lfs: await readGitLfsStatus(cwd, action.type === "refreshLocks"),
  });
}

function tagTargetType(value: string): GitTagSummary["targetType"] {
  return ["commit", "tree", "blob", "tag"].includes(value)
    ? (value as GitTagSummary["targetType"])
    : "other";
}

async function readRemoteTags(
  cwd: string,
  remotes: string[],
): Promise<{
  checks: GitTagList["remoteChecks"];
  tags: Map<string, Set<string>>;
}> {
  const tags = new Map<string, Set<string>>();
  const checks = await Promise.all(
    remotes.map(async (remote) => {
      const outcome = await runGitOutcomeBounded(cwd, [
        "ls-remote",
        "--tags",
        "--refs",
        remote,
      ]);
      if (outcome.code !== 0) {
        return {
          remote,
          available: false,
          error: outcome.output.slice(0, 1_000),
        };
      }
      for (const line of outcome.output.split("\n")) {
        const [, ref] = line.split(/\s+/u);
        if (!ref?.startsWith("refs/tags/")) continue;
        const name = ref.slice("refs/tags/".length);
        const published = tags.get(name) ?? new Set<string>();
        published.add(remote);
        tags.set(name, published);
      }
      return { remote, available: true, error: null };
    }),
  );
  return { checks, tags };
}

async function tagRefOutput(cwd: string): Promise<string> {
  const signatureFormat =
    "%(refname:short)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(contents:subject)%00%(taggername)%00%(creatordate:iso-strict)%00%(signature:grade)%00%(signature:signer)%00%(signature:key)%00%(signature:fingerprint)%00%(contents:signature)%1e";
  try {
    return await gitRaw(cwd, [
      "for-each-ref",
      `--format=${signatureFormat}`,
      "refs/tags",
    ]);
  } catch {
    return gitRaw(cwd, [
      "for-each-ref",
      "--format=%(refname:short)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(contents:subject)%00%(taggername)%00%(creatordate:iso-strict)%00N%00%00%00%00%(contents:signature)%1e",
      "refs/tags",
    ]);
  }
}

export async function readGitTags(cwd: string): Promise<GitTagList> {
  const [refOutput, remotes] = await Promise.all([
    tagRefOutput(cwd),
    gitOutput(cwd, ["remote"]).then((value) =>
      value.split("\n").filter(Boolean),
    ),
  ]);
  const remoteTags = await readRemoteTags(cwd, remotes);
  const parsed = refOutput
    .split("\x1e")
    .map((line) => line.replace(/^\n/u, "").trimEnd())
    .filter(Boolean)
    .flatMap((line): GitTagSummary[] => {
      const [
        name,
        hash,
        objectType,
        peeledHash = "",
        peeledType = "",
        subject = "",
        taggerName = "",
        createdAt = "",
        signatureCode = "N",
        signatureSigner = "",
        signatureKey = "",
        signatureFingerprint = "",
        signatureBlock = "",
      ] = line.split("\0");
      if (!name || !hash || !objectType) return [];
      const annotated = objectType === "tag";
      return [
        {
          name,
          hash,
          targetHash: annotated && peeledHash ? peeledHash : hash,
          targetType: tagTargetType(annotated ? peeledType : objectType),
          annotated,
          subject,
          taggerName: taggerName || null,
          createdAt: createdAt || null,
          signature: signatureDetails(
            signatureCode,
            signatureSigner,
            signatureKey,
            signatureFingerprint,
            signatureBlock,
          ),
          publishedRemotes: [...(remoteTags.tags.get(name) ?? [])].sort(),
        },
      ];
    })
    .sort(
      (left, right) =>
        (right.createdAt ?? "").localeCompare(left.createdAt ?? "") ||
        left.name.localeCompare(right.name),
    );
  return gitTagListSchema.parse({
    tags: parsed.slice(0, TAG_LIMIT),
    truncated: parsed.length > TAG_LIMIT,
    remoteChecks: remoteTags.checks,
    generatedAt: new Date().toISOString(),
  });
}

export async function readGitTagDetail(
  cwd: string,
  name: string,
): Promise<GitTagDetail> {
  await runGit(cwd, ["check-ref-format", `refs/tags/${name}`]);
  const list = await readGitTags(cwd);
  const tag = list.tags.find((candidate) => candidate.name === name);
  if (!tag) throw new Error(`Tag ${name} does not exist.`);
  const [message, verification] = tag.annotated
    ? await Promise.all([
        gitRaw(cwd, [
          "for-each-ref",
          "--format=%(contents:subject)%0a%0a%(contents:body)",
          `refs/tags/${name}`,
        ]),
        runGitOutcomeBounded(cwd, ["verify-tag", "--raw", name]),
      ])
    : ["", null];
  const verificationMessage = verification?.output.slice(0, 10_000) ?? null;
  const verificationState =
    tag.signature.status === "unsigned"
      ? "not-applicable"
      : ["invalid", "expired", "revoked"].includes(tag.signature.status) ||
          verification?.code === 0
        ? "available"
        : signatureVerification("E", verificationMessage ?? "");
  return gitTagDetailSchema.parse({
    ...tag,
    signature: {
      ...tag.signature,
      status: verification?.code === 0 ? "valid" : tag.signature.status,
      verification: verificationState,
      verificationMessage,
    },
    message: message.slice(0, COMMIT_MESSAGE_CHARACTER_LIMIT),
    messageTruncated: message.length > COMMIT_MESSAGE_CHARACTER_LIMIT,
  });
}

function tagActionToken(
  action: GitTagAction,
  list: GitTagList,
  workspace: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action,
        tags: list.tags.map(({ name, hash, publishedRemotes }) => ({
          name,
          hash,
          publishedRemotes,
        })),
        remoteChecks: list.remoteChecks,
        workspace,
      }),
    )
    .digest("hex");
}

export async function previewGitTagAction(
  cwd: string,
  action: GitTagAction,
): Promise<GitTagActionPreview> {
  const list = await readGitTags(cwd);
  const tag = list.tags.find(({ name }) => name === action.name) ?? null;
  const remotes = await readGitRemotes(cwd);
  const requireRemote = (name: string) => {
    if (!remotes.remotes.some((remote) => remote.name === name)) {
      throw new Error(`Git remote ${name} does not exist.`);
    }
  };
  await runGit(cwd, ["check-ref-format", `refs/tags/${action.name}`]);
  let summary: string;
  const warnings: string[] = [];
  switch (action.type) {
    case "create":
      if (tag) throw new Error(`Tag ${action.name} already exists.`);
      if (
        !action.target &&
        !(await gitSucceeds(cwd, ["rev-parse", "--verify", "HEAD"]))
      ) {
        throw new Error("An unborn repository needs an existing tag target.");
      }
      if (action.target) {
        await runGit(cwd, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${action.target}^{object}`,
        ]);
      }
      summary = `Create ${action.annotated ? "annotated" : "lightweight"} tag ${action.name}${action.target ? ` at ${action.target}` : " at HEAD"}.`;
      break;
    case "push":
      if (!tag) throw new Error(`Tag ${action.name} does not exist.`);
      requireRemote(action.remote);
      if (tag.publishedRemotes.includes(action.remote)) {
        warnings.push(
          `${action.remote} already advertises this tag. Git will refuse a conflicting replacement.`,
        );
      }
      summary = `Push tag ${action.name} to ${action.remote}.`;
      break;
    case "deleteLocal":
      if (!tag) throw new Error(`Tag ${action.name} does not exist.`);
      summary = `Delete local tag ${action.name}.`;
      if (tag.publishedRemotes.length) {
        warnings.push(
          `The tag remains published on ${tag.publishedRemotes.join(", ")}.`,
        );
      }
      break;
    case "deleteRemote": {
      if (!tag) throw new Error(`Tag ${action.name} does not exist locally.`);
      requireRemote(action.remote);
      const check = list.remoteChecks.find(
        ({ remote }) => remote === action.remote,
      );
      if (!check?.available) {
        throw new Error(
          `Cannot verify tags on ${action.remote}: ${check?.error ?? "remote unavailable"}`,
        );
      }
      if (!tag.publishedRemotes.includes(action.remote)) {
        throw new Error(
          `Tag ${action.name} is not published on ${action.remote}.`,
        );
      }
      summary = `Delete tag ${action.name} from remote ${action.remote}.`;
      warnings.push(
        "This removes the tag for every collaborator using this remote.",
      );
      break;
    }
  }
  const workspace = await workspaceFingerprint(cwd);
  return gitTagActionPreviewSchema.parse({
    action,
    token: tagActionToken(action, list, workspace),
    destructive:
      action.type === "deleteLocal" || action.type === "deleteRemote",
    summary,
    warnings,
    tag,
  });
}

export async function applyGitTagAction(
  cwd: string,
  action: GitTagAction,
  token: string,
): Promise<GitTagMutationResult> {
  const preview = await previewGitTagAction(cwd, action);
  if (preview.token !== token) {
    throw new Error(
      "The tags, remotes, or worktree changed after this preview. Review the action again.",
    );
  }
  let args: string[];
  switch (action.type) {
    case "create":
      args = action.annotated
        ? [
            "tag",
            "-a",
            action.name,
            "-m",
            action.message!,
            ...(action.target ? [action.target] : []),
          ]
        : ["tag", action.name, ...(action.target ? [action.target] : [])];
      break;
    case "push":
      args = [
        "push",
        action.remote,
        `refs/tags/${action.name}:refs/tags/${action.name}`,
      ];
      break;
    case "deleteLocal":
      args = ["tag", "-d", action.name];
      break;
    case "deleteRemote":
      args = ["push", action.remote, `:refs/tags/${action.name}`];
      break;
  }
  const outcome =
    action.type === "push" || action.type === "deleteRemote"
      ? await runGitOutcomeBounded(cwd, args)
      : { code: 0, output: await runGit(cwd, args) };
  if (outcome.code !== 0) throw new Error(outcome.output);
  return gitTagMutationResultSchema.parse({
    output: outcome.output,
    status: await readGitStatus(cwd),
    tags: await readGitTags(cwd),
  });
}

async function resolveCherryPickRevisions(
  cwd: string,
  action: Extract<GitCommitAction, { type: "cherryPick" }>,
): Promise<string[]> {
  let revisions: string[];
  if (action.selection.type === "commits") {
    revisions = await Promise.all(
      action.selection.revisions.map((revision) =>
        resolveCommit(cwd, revision),
      ),
    );
  } else {
    const from = await resolveCommit(cwd, action.selection.fromRevision);
    const to = await resolveCommit(cwd, action.selection.toRevision);
    if (from === to) return [from];
    const ancestor = await runGitOutcome(cwd, [
      "merge-base",
      "--is-ancestor",
      from,
      to,
    ]);
    if (ancestor.code !== 0) {
      throw new Error(
        "The first range commit must be an ancestor of the last commit.",
      );
    }
    revisions = [
      from,
      ...(await gitOutput(cwd, [
        "rev-list",
        "--reverse",
        "--ancestry-path",
        `${from}..${to}`,
      ]).then((value) => value.split("\n").filter(Boolean))),
    ];
  }
  revisions = [...new Set(revisions)];
  if (revisions.length > 1_000) {
    throw new Error("Cherry-pick ranges are limited to 1,000 commits.");
  }
  for (const revision of revisions) {
    const parents = (
      await gitOutput(cwd, ["show", "-s", "--format=%P", revision])
    )
      .split(" ")
      .filter(Boolean);
    if (parents.length > 1) {
      throw new Error(
        `Merge commit ${revision.slice(0, 10)} needs an explicit mainline and cannot be included in a cherry-pick range.`,
      );
    }
  }
  return revisions;
}

async function commitActionSummary(
  cwd: string,
  revision: string,
): Promise<GitComparisonCommit> {
  const output = await gitRaw(cwd, [
    "show",
    "-s",
    "--date=iso-strict",
    "--format=%H%x00%h%x00%s%x00%an%x00%aI",
    revision,
  ]);
  const [hash, shortHash, subject, authorName, authoredAt] = output
    .trimEnd()
    .split("\0");
  if (!hash || !shortHash || !authorName || !authoredAt) {
    throw new Error(`Commit ${revision} could not be inspected.`);
  }
  return { hash, shortHash, subject: subject ?? "", authorName, authoredAt };
}

function conflictPaths(status: GitStatus): string[] {
  return status.files
    .filter(({ indexStatus, worktreeStatus }) => {
      const pair = `${indexStatus}${worktreeStatus}`;
      return /U/u.test(pair) || ["AA", "DD"].includes(pair);
    })
    .map(({ path: filePath }) => filePath);
}

async function assertNoInProgressGitOperation(cwd: string): Promise<void> {
  for (const marker of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_HEAD"]) {
    if (await gitSucceeds(cwd, ["rev-parse", "--verify", "-q", marker])) {
      throw new Error(
        "Finish or abort the active Git operation before starting another commit action.",
      );
    }
  }
  if (
    (await readGitPathFile(cwd, "rebase-merge/head-name")) !== null ||
    (await readGitPathFile(cwd, "rebase-apply/head-name")) !== null
  ) {
    throw new Error(
      "Finish or abort the active Git operation before starting another commit action.",
    );
  }
  if ((await readGitPathFile(cwd, "BISECT_START")) !== null) {
    throw new Error(
      "Finish or reset the active Git bisect before starting another operation.",
    );
  }
}

function requireCleanStatus(status: GitStatus, action: string): void {
  if (status.files.length > 0) {
    throw new Error(
      `${action} requires a clean selected worktree. Commit, stash, or discard its changes first.`,
    );
  }
}

async function previewAppliedCommitAction(
  cwd: string,
  head: string,
  args: string[],
): Promise<{
  files: GitStatus["files"];
  patch: string;
  patchTruncated: boolean;
  wouldConflict: boolean;
}> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "cantrip-commit-preview-"),
  );
  const previewPath = path.join(temporaryRoot, "worktree");
  let added = false;
  try {
    await runGit(cwd, ["worktree", "add", "--detach", previewPath, head]);
    added = true;
    const outcome = await runGitOutcome(previewPath, args);
    const status = await readGitStatus(previewPath);
    const conflicts = conflictPaths(status);
    if (outcome.code !== 0 && conflicts.length === 0) {
      throw new Error(outcome.output);
    }
    const diff = await gitDiffOutput(
      previewPath,
      ["diff", "--binary", "--no-ext-diff", "HEAD"],
      false,
    );
    return {
      files: status.files,
      patch: diff.output.slice(0, DIFF_CHARACTER_LIMIT),
      patchTruncated:
        diff.truncated || diff.output.length > DIFF_CHARACTER_LIMIT,
      wouldConflict: conflicts.length > 0,
    };
  } finally {
    if (added) {
      await runGitOutcome(previewPath, ["cherry-pick", "--abort"]);
      await runGitOutcome(previewPath, ["revert", "--abort"]);
      await runGitOutcome(cwd, ["worktree", "remove", "--force", previewPath]);
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function commitActionResolvedRevisions(
  cwd: string,
  action: GitCommitAction,
): Promise<string[]> {
  switch (action.type) {
    case "cherryPick":
      return resolveCherryPickRevisions(cwd, action);
    case "revert":
    case "fixup":
      return [await resolveCommit(cwd, action.revision)];
    case "amend":
      return [await resolveCommit(cwd, "HEAD")];
  }
}

function commitActionToken(
  action: GitCommitAction,
  head: string,
  revisions: string[],
  workspace: string,
  patch: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ action, head, revisions, workspace }))
    .update("\0")
    .update(patch)
    .digest("hex");
}

export async function previewGitCommitAction(
  cwd: string,
  action: GitCommitAction,
): Promise<GitCommitActionPreview> {
  await assertNoInProgressGitOperation(cwd);
  const [status, head] = await Promise.all([
    readGitStatus(cwd),
    resolveCommit(cwd, "HEAD"),
  ]);
  const revisions = await commitActionResolvedRevisions(cwd, action);
  const commits = await Promise.all(
    revisions.map((revision) => commitActionSummary(cwd, revision)),
  );
  const warnings: string[] = [];
  let summary: string;
  let patch: string;
  let patchTruncated: boolean;
  let files: GitStatus["files"];
  let wouldConflict = false;
  if (action.type === "cherryPick") {
    requireCleanStatus(status, "Cherry-pick");
    const effect = await previewAppliedCommitAction(cwd, head, [
      "cherry-pick",
      "--no-commit",
      ...revisions,
    ]);
    ({ files, patch, patchTruncated, wouldConflict } = effect);
    summary = `Cherry-pick ${revisions.length} ${revisions.length === 1 ? "commit" : "commits"} onto ${head.slice(0, 10)}.`;
  } else if (action.type === "revert") {
    requireCleanStatus(status, "Revert");
    const detail = await readGitCommitDetail(cwd, revisions[0]!);
    if (detail.parents.length > 1) {
      if (
        action.mainlineParent === null ||
        action.mainlineParent > detail.parents.length
      ) {
        throw new Error(
          `Merge commit ${detail.shortHash} requires a mainline parent between 1 and ${detail.parents.length}.`,
        );
      }
      warnings.push(
        `Parent ${action.mainlineParent} is treated as the mainline for this merge revert.`,
      );
    } else if (action.mainlineParent !== null) {
      throw new Error("Only merge commits accept a mainline parent.");
    }
    const effect = await previewAppliedCommitAction(cwd, head, [
      "revert",
      "--no-commit",
      ...(action.mainlineParent === null
        ? []
        : ["-m", String(action.mainlineParent)]),
      revisions[0]!,
    ]);
    ({ files, patch, patchTruncated, wouldConflict } = effect);
    summary = `Revert ${commits[0]!.shortHash} on ${head.slice(0, 10)}.`;
  } else {
    const unstaged = status.files.filter(({ unstaged }) => unstaged);
    const staged = status.files.filter(({ staged }) => staged);
    if (unstaged.length > 0) {
      throw new Error(
        `${action.type === "amend" ? "Amend" : "Fixup"} is blocked while the selected worktree has unstaged or conflicted changes.`,
      );
    }
    if (action.type === "fixup" && staged.length === 0) {
      throw new Error("A fixup commit requires staged changes.");
    }
    if (action.type === "amend" && staged.length === 0 && !action.message) {
      throw new Error(
        "Amend requires staged changes or a replacement message.",
      );
    }
    const effect = await gitDiffOutput(
      cwd,
      ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"],
      false,
    );
    files = staged;
    patch = effect.output.slice(0, DIFF_CHARACTER_LIMIT);
    patchTruncated =
      effect.truncated || effect.output.length > DIFF_CHARACTER_LIMIT;
    if (action.type === "amend") {
      warnings.push(
        "Amending replaces HEAD. Cantrip creates a recovery reference before committing.",
      );
      summary = `${action.message ? "Replace the message and amend" : "Amend"} ${head.slice(0, 10)} with ${staged.length} staged ${staged.length === 1 ? "file" : "files"}.`;
    } else {
      summary = `Create a fixup commit for ${commits[0]!.shortHash} from ${staged.length} staged ${staged.length === 1 ? "file" : "files"}.`;
    }
  }
  if (wouldConflict) {
    warnings.push(
      "The preview found conflicts. Applying starts a resumable Git operation and leaves conflicts in Working changes.",
    );
  }
  const workspace = await workspaceFingerprint(cwd);
  const token = commitActionToken(action, head, revisions, workspace, patch);
  return gitCommitActionPreviewSchema.parse({
    action,
    token,
    destructive: action.type === "revert" || action.type === "amend",
    summary,
    warnings,
    resolvedRevisions: revisions,
    commits,
    files,
    patch,
    patchTruncated,
    wouldConflict,
    checkpointRef:
      action.type === "amend"
        ? `refs/cantrip/checkpoints/amend-${head.slice(0, 12)}-${token.slice(0, 12)}`
        : null,
  });
}

export async function applyGitCommitAction(
  cwd: string,
  action: GitCommitAction,
  token: string,
): Promise<GitCommitActionResult> {
  const preview = await previewGitCommitAction(cwd, action);
  if (preview.token !== token) {
    throw new Error(
      "The worktree, selected commits, or staged patch changed after this preview. Review the action again.",
    );
  }
  const headBefore = await resolveCommit(cwd, "HEAD");
  let output = "";
  let operation: GitCommitActionResult["operation"] = null;
  if (action.type === "cherryPick") {
    const outcome = await runGitOutcome(cwd, [
      "cherry-pick",
      ...preview.resolvedRevisions,
    ]);
    output = outcome.output;
    const status = await readGitStatus(cwd);
    const conflicts = conflictPaths(status);
    if (outcome.code !== 0) {
      const resumable = await gitSucceeds(cwd, [
        "rev-parse",
        "--verify",
        "-q",
        "CHERRY_PICK_HEAD",
      ]);
      if (!resumable) throw new Error(outcome.output);
    }
    const currentRevision =
      outcome.code === 0
        ? null
        : await resolveCommit(cwd, "CHERRY_PICK_HEAD").catch(() => null);
    const currentIndex = currentRevision
      ? preview.resolvedRevisions.indexOf(currentRevision)
      : -1;
    operation = {
      type: "cherry-pick",
      state:
        outcome.code === 0
          ? "completed"
          : conflicts.length
            ? "conflicted"
            : "awaiting-user-action",
      originalHead: headBefore,
      currentHead: await resolveCommit(cwd, "HEAD"),
      sourceRevisions: preview.resolvedRevisions,
      currentStep:
        outcome.code === 0
          ? preview.resolvedRevisions.length
          : Math.max(1, currentIndex + 1),
      totalSteps: preview.resolvedRevisions.length,
      conflictedPaths: conflicts,
    };
  } else if (action.type === "revert") {
    const outcome = await runGitOutcome(cwd, [
      "revert",
      "--no-edit",
      ...(action.mainlineParent === null
        ? []
        : ["-m", String(action.mainlineParent)]),
      preview.resolvedRevisions[0]!,
    ]);
    output = outcome.output;
    const status = await readGitStatus(cwd);
    const conflicts = conflictPaths(status);
    if (outcome.code !== 0) {
      const resumable = await gitSucceeds(cwd, [
        "rev-parse",
        "--verify",
        "-q",
        "REVERT_HEAD",
      ]);
      if (!resumable) throw new Error(outcome.output);
    }
    operation = {
      type: "revert",
      state:
        outcome.code === 0
          ? "completed"
          : conflicts.length
            ? "conflicted"
            : "awaiting-user-action",
      originalHead: headBefore,
      currentHead: await resolveCommit(cwd, "HEAD"),
      sourceRevisions: preview.resolvedRevisions,
      currentStep: 1,
      totalSteps: 1,
      conflictedPaths: conflicts,
    };
  } else if (action.type === "amend") {
    await runGit(cwd, ["update-ref", preview.checkpointRef!, headBefore, ""]);
    output = await runGit(cwd, [
      "commit",
      "--amend",
      ...(action.message ? ["-m", action.message] : ["--no-edit"]),
    ]);
  } else {
    output = await runGit(cwd, [
      "commit",
      `--fixup=${preview.resolvedRevisions[0]!}`,
    ]);
  }
  const status = await readGitStatus(cwd);
  return gitCommitActionResultSchema.parse({
    output,
    status,
    headBefore,
    headAfter: await resolveCommit(cwd, "HEAD"),
    checkpointRef: preview.checkpointRef,
    operation,
  });
}

const managedOperationEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
};

type GitInteractiveRebaseAction = Extract<
  GitMergeRebaseAction,
  { type: "interactiveRebase" }
>;

function interactiveRebaseSourceRef(action: GitMergeRebaseAction): string {
  return action.type === "interactiveRebase"
    ? action.upstreamRef
    : action.sourceRef;
}

async function publishedRemoteRefs(
  cwd: string,
  baseRevision: string,
  originalHead: string,
): Promise<string[]> {
  const output = await gitRaw(cwd, [
    "for-each-ref",
    "--format=%(refname:short)%00%(objectname)%00%(symref)",
    "refs/remotes",
  ]).catch(() => "");
  const refs = output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [name, revision, symbolicTarget] = line.split("\0");
      return name && revision && !symbolicTarget ? [{ name, revision }] : [];
    })
    .slice(0, 1_000);
  const published = new Set<string>();
  for (let offset = 0; offset < refs.length; offset += 16) {
    const batch = refs.slice(offset, offset + 16);
    await Promise.all(
      batch.map(async (ref) => {
        const mergeBase = await gitOutput(cwd, [
          "merge-base",
          originalHead,
          ref.revision,
        ]).catch(() => "");
        if (
          mergeBase &&
          mergeBase !== baseRevision &&
          (await gitSucceeds(cwd, [
            "merge-base",
            "--is-ancestor",
            baseRevision,
            mergeBase,
          ]))
        ) {
          published.add(ref.name);
        }
      }),
    );
  }
  return [...published].sort((left, right) => left.localeCompare(right));
}

async function normalizeInteractiveRebaseTodo(
  cwd: string,
  action: GitInteractiveRebaseAction,
  upstreamRevision: string,
  originalHead: string,
): Promise<{
  action: GitInteractiveRebaseAction;
  commits: GitComparisonCommit[];
  todoText: string;
}> {
  if (
    !(await gitSucceeds(cwd, [
      "merge-base",
      "--is-ancestor",
      upstreamRevision,
      originalHead,
    ]))
  ) {
    throw new Error(
      "Interactive rebase requires an upstream commit that is an ancestor of the current HEAD.",
    );
  }
  const revisions = await boundedRevisionRange(
    cwd,
    `${upstreamRevision}..${originalHead}`,
  );
  if (revisions.length === 0) {
    throw new Error(
      "There are no commits after the selected upstream to rewrite.",
    );
  }
  const summaries = await Promise.all(
    revisions.map((revision) => commitActionSummary(cwd, revision)),
  );
  const todo: GitInteractiveRebaseTodoItem[] = action.todo.length
    ? action.todo
    : revisions.map((revision) => ({
        action: "pick" as const,
        revision,
        message: null,
      }));
  if (todo.length !== revisions.length) {
    throw new Error("The rebase todo must contain every selected commit once.");
  }
  const expected = new Set(revisions);
  const seen = new Set<string>();
  let retained = 0;
  for (const [index, item] of todo.entries()) {
    if (!expected.has(item.revision) || seen.has(item.revision)) {
      throw new Error(
        "The rebase todo must contain every selected commit exactly once.",
      );
    }
    seen.add(item.revision);
    if (item.action !== "drop") retained += 1;
    if (
      (item.action === "squash" || item.action === "fixup") &&
      !todo.slice(0, index).some((candidate) => candidate.action !== "drop")
    ) {
      throw new Error(
        `${item.action} cannot be the first retained step in the rebase todo.`,
      );
    }
  }
  if (retained === 0) {
    throw new Error("Interactive rebase must retain at least one commit.");
  }
  const subjects = new Map(
    summaries.map((summary) => [summary.hash, summary.subject]),
  );
  const todoText = todo
    .map((item) =>
      `${item.action} ${item.revision} ${subjects.get(item.revision) ?? ""}`.trimEnd(),
    )
    .join("\n");
  return {
    action: { ...action, todo },
    commits: todo.map((item) =>
      summaries.find(({ hash }) => hash === item.revision)!,
    ),
    todoText,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function gitCommonPath(
  cwd: string,
  relativePath: string,
): Promise<string> {
  const common = await gitOutput(cwd, ["rev-parse", "--git-common-dir"]);
  const root = path.isAbsolute(common) ? common : path.join(cwd, common);
  return path.join(root, relativePath);
}

function rewriteStorageKey(checkpointRef: string): string {
  const key = checkpointRef.split("/").at(-1) ?? "";
  if (!/^rewrite-[0-9a-f-]+$/u.test(key)) {
    throw new Error("The interactive rebase recovery metadata is invalid.");
  }
  return key;
}

async function prepareInteractiveRebaseEnvironment(
  cwd: string,
  action: GitInteractiveRebaseAction,
  checkpointRef: string,
  storageRoot?: string,
): Promise<NodeJS.ProcessEnv> {
  const root =
    storageRoot ??
    (await gitCommonPath(
      cwd,
      path.join("cantrip", "rebases", rewriteStorageKey(checkpointRef)),
    ));
  await mkdir(root, { recursive: true });
  const todoPath = path.join(root, "todo");
  const messagesPath = path.join(root, "reword-messages.json");
  const sequenceEditorPath = path.join(root, "sequence-editor.cjs");
  const messageEditorPath = path.join(root, "message-editor.cjs");
  const rebaseDone = await gitOutput(cwd, [
    "rev-parse",
    "--git-path",
    "rebase-merge/done",
  ]);
  const rebaseDonePath = path.isAbsolute(rebaseDone)
    ? rebaseDone
    : path.join(cwd, rebaseDone);
  await Promise.all([
    writeFile(
      todoPath,
      `${action.todo.map((item) => `${item.action} ${item.revision}`).join("\n")}\n`,
    ),
    writeFile(
      messagesPath,
      JSON.stringify(
        Object.fromEntries(
          action.todo
            .filter((item) => item.action === "reword")
            .map((item) => [item.revision, item.message]),
        ),
      ),
    ),
    writeFile(
      sequenceEditorPath,
      `#!/usr/bin/env node\nrequire("node:fs").copyFileSync(process.env.CANTRIP_REBASE_TODO, process.argv[2]);\n`,
      { mode: 0o700 },
    ),
    writeFile(
      messageEditorPath,
      `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst target = process.argv[2];\nconst current = fs.readFileSync(target, "utf8");\nif (current.includes("# This is a combination of")) process.exit(0);\nlet done = "";\ntry { done = fs.readFileSync(process.env.CANTRIP_REBASE_DONE, "utf8"); } catch { process.exit(0); }\nconst line = done.trim().split("\\n").at(-1) || "";\nconst [action, revision] = line.trim().split(/\\s+/);\nif (action !== "reword" || !revision) process.exit(0);\nconst messages = JSON.parse(fs.readFileSync(process.env.CANTRIP_REWORD_MESSAGES, "utf8"));\nconst match = Object.entries(messages).find(([hash]) => hash.startsWith(revision) || revision.startsWith(hash));\nif (!match) throw new Error("Missing Cantrip reword message");\nfs.writeFileSync(target, String(match[1]) + "\\n");\n`,
      { mode: 0o700 },
    ),
  ]);
  return {
    ...process.env,
    CANTRIP_REBASE_TODO: todoPath,
    CANTRIP_REWORD_MESSAGES: messagesPath,
    CANTRIP_REBASE_DONE: rebaseDonePath,
    GIT_SEQUENCE_EDITOR: shellQuote(sequenceEditorPath),
    GIT_EDITOR: shellQuote(messageEditorPath),
    LC_ALL: "C",
  };
}

async function interactiveRebaseEnvironmentFromContext(
  cwd: string,
  context: GitManagedOperationContext,
): Promise<NodeJS.ProcessEnv> {
  if (!context.checkpointRef) {
    throw new Error(
      "The interactive rebase is missing its recovery reference.",
    );
  }
  const root = await gitCommonPath(
    cwd,
    path.join("cantrip", "rebases", rewriteStorageKey(context.checkpointRef)),
  );
  const sequenceEditorPath = path.join(root, "sequence-editor.cjs");
  const messageEditorPath = path.join(root, "message-editor.cjs");
  const rebaseDone = await gitOutput(cwd, [
    "rev-parse",
    "--git-path",
    "rebase-merge/done",
  ]);
  const rebaseDonePath = path.isAbsolute(rebaseDone)
    ? rebaseDone
    : path.join(cwd, rebaseDone);
  return {
    ...process.env,
    CANTRIP_REBASE_TODO: path.join(root, "todo"),
    CANTRIP_REWORD_MESSAGES: path.join(root, "reword-messages.json"),
    CANTRIP_REBASE_DONE: rebaseDonePath,
    GIT_SEQUENCE_EDITOR: shellQuote(sequenceEditorPath),
    GIT_EDITOR: shellQuote(messageEditorPath),
    LC_ALL: "C",
  };
}

function isInteractiveRebaseContext(
  context: GitManagedOperationContext,
): boolean {
  return (
    context.type === "rebase" &&
    context.checkpointRef?.includes("/rewrite-") === true
  );
}

async function cleanupInteractiveRebaseState(
  cwd: string,
  context: GitManagedOperationContext,
): Promise<void> {
  if (!isInteractiveRebaseContext(context) || !context.checkpointRef) return;
  const root = await gitCommonPath(
    cwd,
    path.join("cantrip", "rebases", rewriteStorageKey(context.checkpointRef)),
  );
  await rm(root, { force: true, recursive: true });
}

async function currentBranchRef(cwd: string): Promise<string> {
  const branch = await gitOutput(cwd, ["symbolic-ref", "-q", "HEAD"]).catch(
    () => "",
  );
  if (!branch.startsWith("refs/heads/")) {
    throw new Error(
      "This Git operation requires the selected worktree to be on a local branch.",
    );
  }
  return branch;
}

async function boundedRevisionRange(
  cwd: string,
  range: string,
): Promise<string[]> {
  const revisions = (await gitOutput(cwd, ["rev-list", "--reverse", range]))
    .split("\n")
    .map((revision) => revision.trim())
    .filter(Boolean);
  if (revisions.length > 10_000) {
    throw new Error(
      "This operation includes more than 10,000 commits. Narrow the selected range first.",
    );
  }
  return revisions;
}

function previewStatusFiles(
  status: GitStatus,
): GitManagedOperationPreview["files"] {
  return status.files.map((file) => ({
    path: file.path,
    originalPath: file.originalPath,
    status: conflictPaths({ ...status, files: [file] }).length
      ? "unmerged"
      : commitFileStatus(
          file.indexStatus !== " " && file.indexStatus !== "?"
            ? file.indexStatus
            : file.worktreeStatus,
        ),
    additions: null,
    deletions: null,
    binary: false,
  }));
}

async function previewManagedOperationEffect(
  cwd: string,
  action: GitMergeRebaseAction,
  head: string,
  sourceRevision: string,
): Promise<{
  files: GitManagedOperationPreview["files"];
  patch: string;
  patchTruncated: boolean;
  wouldConflict: boolean;
}> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "cantrip-operation-preview-"),
  );
  const previewPath = path.join(temporaryRoot, "worktree");
  const rewriteStatePath = path.join(temporaryRoot, "rewrite-state");
  let added = false;
  try {
    await runGit(cwd, ["worktree", "add", "--detach", previewPath, head]);
    added = true;
    const arguments_ = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      ...(action.type === "merge"
        ? ["merge", "--no-edit", sourceRevision]
        : [
            "rebase",
            ...(action.type === "interactiveRebase" ? ["--interactive"] : []),
            sourceRevision,
          ]),
    ];
    const environment =
      action.type === "interactiveRebase"
        ? await prepareInteractiveRebaseEnvironment(
            previewPath,
            action,
            "refs/cantrip/checkpoints/rewrite-preview-preview",
            rewriteStatePath,
          )
        : managedOperationEnvironment;
    let outcome = await runGitOutcome(previewPath, arguments_, environment);
    let status = await readGitStatus(previewPath);
    let conflicts = conflictPaths(status);
    if (action.type === "interactiveRebase") {
      for (
        let step = 0;
        step < action.todo.length && conflicts.length === 0;
        step += 1
      ) {
        if (!(await hasGitOperationMarker(previewPath, "rebase"))) break;
        outcome = await runGitOutcome(
          previewPath,
          ["rebase", "--continue"],
          environment,
        );
        status = await readGitStatus(previewPath);
        conflicts = conflictPaths(status);
      }
    }
    if (outcome.code !== 0 && conflicts.length === 0) {
      throw new Error(outcome.output);
    }
    if (conflicts.length > 0) {
      const diff = await gitDiffOutput(
        previewPath,
        ["diff", "--binary", "--no-ext-diff", "HEAD"],
        false,
      );
      return {
        files: previewStatusFiles(status),
        patch: diff.output.slice(0, DIFF_CHARACTER_LIMIT),
        patchTruncated:
          diff.truncated || diff.output.length > DIFF_CHARACTER_LIMIT,
        wouldConflict: true,
      };
    }
    const previewHead = await resolveCommit(previewPath, "HEAD");
    const [changed, diff] = await Promise.all([
      readCommitFiles(previewPath, head, previewHead),
      gitDiffOutput(
        previewPath,
        ["diff", "--binary", "--no-ext-diff", head, previewHead],
        false,
      ),
    ]);
    return {
      files: changed.files,
      patch: diff.output.slice(0, DIFF_CHARACTER_LIMIT),
      patchTruncated:
        changed.truncated ||
        diff.truncated ||
        diff.output.length > DIFF_CHARACTER_LIMIT,
      wouldConflict: false,
    };
  } finally {
    if (added) {
      await runGitOutcome(previewPath, ["merge", "--abort"]);
      await runGitOutcome(previewPath, ["rebase", "--abort"]);
      await runGitOutcome(cwd, ["worktree", "remove", "--force", previewPath]);
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function managedOperationToken(
  action: GitManagedOperationAction,
  context: GitManagedOperationContext,
  workspace: string,
  patch: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ action, context, workspace }))
    .update("\0")
    .update(patch)
    .digest("hex");
}

async function previewGitBisectOperation(
  cwd: string,
  action: Extract<GitManagedOperationAction, { type: "bisect" }>,
): Promise<GitManagedOperationPreview> {
  const [status, originalHead, targetRef, goodRevision, badRevision] =
    await Promise.all([
      readGitStatus(cwd),
      resolveCommit(cwd, "HEAD"),
      currentBranchRef(cwd),
      resolveCommit(cwd, action.goodRef),
      resolveCommit(cwd, action.badRef),
    ]);
  requireCleanStatus(status, "Bisect");
  if (goodRevision === badRevision) {
    throw new Error("Bisect good and bad revisions must be different.");
  }
  if (
    !(await gitSucceeds(cwd, [
      "merge-base",
      "--is-ancestor",
      goodRevision,
      badRevision,
    ]))
  ) {
    throw new Error(
      "The known-good revision must be an ancestor of the known-bad revision.",
    );
  }
  const pendingCommits = await boundedRevisionRange(
    cwd,
    `${goodRevision}..${badRevision}`,
  );
  if (pendingCommits.length === 0) {
    throw new Error("No commits exist between the selected bisect bounds.");
  }
  const [commits, changed, diff, workspace] = await Promise.all([
    Promise.all(
      pendingCommits.map((revision) => commitActionSummary(cwd, revision)),
    ),
    readCommitFiles(cwd, goodRevision, badRevision),
    gitDiffOutput(
      cwd,
      ["diff", "--binary", "--no-ext-diff", goodRevision, badRevision],
      false,
    ),
    workspaceFingerprint(cwd),
  ]);
  const baseContext: GitManagedOperationContext = {
    type: "bisect",
    originalHead,
    sourceRef: action.goodRef,
    sourceRevision: goodRevision,
    targetRef,
    targetRevision: badRevision,
    pendingCommits,
    totalSteps: pendingCommits.length,
    checkpointRef: null,
  };
  const provisionalToken = managedOperationToken(
    action,
    baseContext,
    workspace,
    diff.output,
  );
  const context: GitManagedOperationContext = {
    ...baseContext,
    checkpointRef: `refs/cantrip/checkpoints/bisect-${originalHead.slice(0, 12)}-${provisionalToken.slice(0, 12)}`,
  };
  return gitManagedOperationPreviewSchema.parse({
    action,
    token: managedOperationToken(action, context, workspace, diff.output),
    destructive: false,
    summary: `Bisect ${pendingCommits.length} candidate ${pendingCommits.length === 1 ? "commit" : "commits"} between known-good ${goodRevision.slice(0, 10)} and known-bad ${badRevision.slice(0, 10)}.`,
    warnings: [
      "Bisect temporarily checks out candidate commits in this worktree. Reset bisect to restore the original branch and HEAD.",
    ],
    context,
    commits,
    files: changed.files,
    patch: diff.output.slice(0, DIFF_CHARACTER_LIMIT),
    patchTruncated:
      changed.truncated ||
      diff.truncated ||
      diff.output.length > DIFF_CHARACTER_LIMIT,
    wouldConflict: false,
    todo: [],
    todoText: "",
    publishedRefs: [],
  });
}

export async function previewGitManagedOperation(
  cwd: string,
  action: GitManagedOperationAction,
): Promise<GitManagedOperationPreview> {
  await assertNoInProgressGitOperation(cwd);
  if (action.type === "bisect") {
    return previewGitBisectOperation(cwd, action);
  }
  const sourceRef = interactiveRebaseSourceRef(action);
  const [status, originalHead, targetRef, sourceRevision] = await Promise.all([
    readGitStatus(cwd),
    resolveCommit(cwd, "HEAD"),
    currentBranchRef(cwd),
    resolveCommit(cwd, sourceRef),
  ]);
  requireCleanStatus(status, action.type === "merge" ? "Merge" : "Rebase");
  if (sourceRevision === originalHead) {
    throw new Error(
      "The selected source already resolves to the current HEAD.",
    );
  }
  let resolvedAction = action;
  let todo: GitInteractiveRebaseTodoItem[] = [];
  let todoText = "";
  let commits: GitComparisonCommit[];
  if (action.type === "interactiveRebase") {
    const normalized = await normalizeInteractiveRebaseTodo(
      cwd,
      action,
      sourceRevision,
      originalHead,
    );
    resolvedAction = normalized.action;
    todo = normalized.action.todo;
    todoText = normalized.todoText;
    commits = normalized.commits;
  } else {
    const revisions = await boundedRevisionRange(
      cwd,
      action.type === "merge"
        ? `${originalHead}..${sourceRevision}`
        : `${sourceRevision}..${originalHead}`,
    );
    commits = await Promise.all(
      revisions.map((revision) => commitActionSummary(cwd, revision)),
    );
  }
  const pendingCommits = commits.map(({ hash }) => hash);
  const effect = await previewManagedOperationEffect(
    cwd,
    resolvedAction,
    originalHead,
    sourceRevision,
  );
  const publishedRefs =
    action.type === "interactiveRebase"
      ? await publishedRemoteRefs(cwd, sourceRevision, originalHead)
      : [];
  const baseContext: GitManagedOperationContext = {
    type: action.type === "merge" ? "merge" : "rebase",
    originalHead,
    sourceRef,
    sourceRevision,
    targetRef,
    targetRevision: originalHead,
    pendingCommits,
    totalSteps: Math.max(1, pendingCommits.length),
    checkpointRef: null,
  };
  const workspace = await workspaceFingerprint(cwd);
  const provisionalToken = managedOperationToken(
    resolvedAction,
    baseContext,
    workspace,
    effect.patch,
  );
  const context = {
    ...baseContext,
    checkpointRef:
      action.type !== "merge"
        ? `refs/cantrip/checkpoints/${action.type === "interactiveRebase" ? "rewrite" : "rebase"}-${originalHead.slice(0, 12)}-${provisionalToken.slice(0, 12)}`
        : null,
  };
  const token = managedOperationToken(
    resolvedAction,
    context,
    workspace,
    effect.patch,
  );
  const branchName = targetRef.replace(/^refs\/heads\//u, "");
  const warnings = effect.wouldConflict
    ? [
        "The preview found conflicts. Starting leaves the operation resumable in the selected worktree.",
      ]
    : [];
  if (action.type !== "merge") {
    warnings.push(
      "Rebase rewrites commit identities. Cantrip creates a recovery reference before it starts.",
    );
  }
  if (publishedRefs.length > 0) {
    warnings.push(
      `This plan rewrites commits already reachable from ${publishedRefs.length === 1 ? "remote-tracking ref" : "remote-tracking refs"} ${publishedRefs.join(", ")}. Updating the remote requires a separately reviewed force-with-lease push.`,
    );
  }
  return gitManagedOperationPreviewSchema.parse({
    action: resolvedAction,
    token,
    destructive: action.type !== "merge",
    summary:
      action.type === "merge"
        ? `Merge ${sourceRef} (${sourceRevision.slice(0, 10)}) into ${branchName}.`
        : action.type === "interactiveRebase"
          ? `Rewrite ${todo.length} commits on ${branchName} after ${sourceRef} (${sourceRevision.slice(0, 10)}).`
          : `Rebase ${branchName} onto ${sourceRef} (${sourceRevision.slice(0, 10)}).`,
    warnings,
    context,
    commits,
    todo,
    todoText,
    publishedRefs,
    ...effect,
  });
}

async function readGitPathFile(
  cwd: string,
  relativePath: string,
): Promise<string | null> {
  const resolved = await gitOutput(cwd, [
    "rev-parse",
    "--git-path",
    relativePath,
  ]);
  try {
    return (
      await readFile(
        path.isAbsolute(resolved) ? resolved : path.join(cwd, resolved),
        "utf8",
      )
    ).trim();
  } catch {
    return null;
  }
}

async function currentInteractiveRebaseAction(
  cwd: string,
  context: GitManagedOperationContext,
): Promise<GitInteractiveRebaseTodoAction | null> {
  if (!isInteractiveRebaseContext(context)) return null;
  const done = await readGitPathFile(cwd, "rebase-merge/done");
  const action = done?.split("\n").at(-1)?.trim().split(/\s+/u)[0];
  return action &&
    ["pick", "reword", "edit", "squash", "fixup", "drop"].includes(action)
    ? (action as GitInteractiveRebaseTodoAction)
    : null;
}

async function hasGitOperationMarker(
  cwd: string,
  type: GitManagedOperationContext["type"],
): Promise<boolean> {
  if (type === "stash") return true;
  if (type === "bisect") {
    return (await readGitPathFile(cwd, "BISECT_START")) !== null;
  }
  if (type === "merge") {
    return gitSucceeds(cwd, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
  }
  if (type === "rebase") {
    return (
      (await readGitPathFile(cwd, "rebase-merge/head-name")) !== null ||
      (await readGitPathFile(cwd, "rebase-apply/head-name")) !== null
    );
  }
  return gitSucceeds(cwd, [
    "rev-parse",
    "--verify",
    "-q",
    type === "cherry-pick" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD",
  ]);
}

async function managedOperationProgress(
  cwd: string,
  context: GitManagedOperationContext,
): Promise<{ currentStep: number; pendingCommits: string[] }> {
  if (context.type === "bisect") {
    const bad = await resolveCommit(cwd, "refs/bisect/bad").catch(
      () => context.targetRevision,
    );
    const goods = (
      await gitRaw(cwd, [
        "for-each-ref",
        "--format=%(objectname)",
        "refs/bisect/good-*",
      ]).catch(() => "")
    )
      .split("\n")
      .filter(Boolean);
    const remaining = (
      await gitOutput(cwd, [
        "rev-list",
        "--max-count=10001",
        bad,
        ...(goods.length ? ["--not", ...goods] : []),
      ]).catch(() => "")
    )
      .split("\n")
      .filter((revision) => context.pendingCommits.includes(revision));
    if (remaining.length > 10_000) {
      throw new Error("Bisect progress exceeds the supported 10,000 commits.");
    }
    const pendingCommits = remaining.length
      ? remaining
      : context.pendingCommits;
    return {
      currentStep: Math.min(
        context.totalSteps,
        Math.max(1, context.totalSteps - pendingCommits.length + 1),
      ),
      pendingCommits,
    };
  }
  if (
    context.type === "merge" ||
    context.type === "revert" ||
    context.type === "stash"
  ) {
    return {
      currentStep: 1,
      pendingCommits: context.pendingCommits,
    };
  }
  const todo =
    context.type === "rebase"
      ? ((await readGitPathFile(cwd, "rebase-merge/git-rebase-todo")) ??
        (await readGitPathFile(cwd, "rebase-apply/git-rebase-todo")))
      : await readGitPathFile(cwd, "sequencer/todo");
  const todoRevisions = (
    await Promise.all(
      (todo ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.split(/\s+/u)[1] ?? "")
        .filter(Boolean)
        .map((revision) => resolveCommit(cwd, revision).catch(() => null)),
    )
  ).filter((revision): revision is string => revision !== null);
  const currentMarker =
    context.type === "rebase" ? "REBASE_HEAD" : "CHERRY_PICK_HEAD";
  const current = await resolveCommit(cwd, currentMarker).catch(() => null);
  const pendingCommits = [current, ...todoRevisions].filter(
    (revision, index, all): revision is string =>
      revision !== null && all.indexOf(revision) === index,
  );
  if (pendingCommits.length === 0)
    pendingCommits.push(...context.pendingCommits);
  const currentStep = Math.min(
    context.totalSteps,
    Math.max(1, context.totalSteps - pendingCommits.length + 1),
  );
  return {
    currentStep,
    pendingCommits,
  };
}

export async function inspectGitManagedOperation(
  cwd: string,
  context: GitManagedOperationContext,
  output = "",
  terminalHint: "completed" | "aborted" | null = null,
): Promise<GitManagedOperationWorkerState> {
  const [status, currentHead, operationMarker, progress, pausedAction] =
    await Promise.all([
      readGitStatus(cwd),
      resolveCommit(cwd, "HEAD"),
      hasGitOperationMarker(cwd, context.type),
      managedOperationProgress(cwd, context),
      currentInteractiveRebaseAction(cwd, context),
    ]);
  const active = terminalHint === null && operationMarker;
  const conflicts = conflictPaths(status);
  const state = active
    ? conflicts.length
      ? "conflicted"
      : "awaiting-user-action"
    : terminalHint
      ? terminalHint
      : currentHead === context.originalHead
        ? "aborted"
        : "completed";
  return gitManagedOperationWorkerStateSchema.parse({
    ...context,
    state,
    currentHead,
    currentStep:
      state === "completed" ? context.totalSteps : progress.currentStep,
    pendingCommits: state === "completed" ? [] : progress.pendingCommits,
    conflictedPaths: conflicts,
    output: output.slice(-1_000_000),
    status,
    pausedAction: active ? pausedAction : null,
  });
}

export async function startGitManagedOperation(
  cwd: string,
  action: GitManagedOperationAction,
  token: string,
): Promise<GitManagedOperationWorkerState> {
  const preview = await previewGitManagedOperation(cwd, action);
  if (preview.token !== token) {
    throw new Error(
      "The worktree or selected revisions changed after this preview. Review the operation again.",
    );
  }
  if (preview.context.checkpointRef) {
    await runGit(cwd, [
      "update-ref",
      preview.context.checkpointRef,
      preview.context.originalHead,
    ]);
  }
  const resolvedAction = preview.action;
  if (resolvedAction.type === "bisect") {
    const outcome = await runGitOutcome(cwd, [
      "bisect",
      "start",
      preview.context.targetRevision,
      preview.context.sourceRevision!,
    ]);
    const stillActive = await hasGitOperationMarker(cwd, "bisect");
    if (outcome.code !== 0 && !stillActive) throw new Error(outcome.output);
    return inspectGitManagedOperation(
      cwd,
      preview.context,
      outcome.output,
      stillActive ? null : "completed",
    );
  }
  const arguments_ =
    resolvedAction.type === "merge"
      ? ["merge", "--no-edit", preview.context.sourceRevision!]
      : [
          "rebase",
          ...(resolvedAction.type === "interactiveRebase"
            ? ["--interactive"]
            : []),
          preview.context.sourceRevision!,
        ];
  const environment =
    resolvedAction.type === "interactiveRebase"
      ? await prepareInteractiveRebaseEnvironment(
          cwd,
          resolvedAction,
          preview.context.checkpointRef!,
        )
      : managedOperationEnvironment;
  const outcome = await runGitOutcome(cwd, arguments_, environment);
  const stillActive = await hasGitOperationMarker(cwd, preview.context.type);
  const state = await inspectGitManagedOperation(
    cwd,
    preview.context,
    outcome.output,
    outcome.code === 0 && !stillActive ? "completed" : null,
  );
  if (outcome.code !== 0 && state.state === "aborted") {
    await cleanupInteractiveRebaseState(cwd, preview.context);
    throw new Error(outcome.output);
  }
  if (["completed", "aborted"].includes(state.state)) {
    await cleanupInteractiveRebaseState(cwd, preview.context);
  }
  return state;
}

export async function controlGitManagedOperation(
  cwd: string,
  context: GitManagedOperationContext,
  action: "continue" | "skip" | "abort" | "good" | "bad" | "reset",
): Promise<GitManagedOperationWorkerState> {
  if (!(await hasGitOperationMarker(cwd, context.type))) {
    return inspectGitManagedOperation(cwd, context);
  }
  const status = await readGitStatus(cwd);
  if (context.type === "bisect") {
    if (!["good", "bad", "skip", "reset", "abort"].includes(action)) {
      throw new Error("Bisect accepts good, bad, skip, or reset controls.");
    }
    const reset = action === "reset" || action === "abort";
    const outcome = await runGitOutcome(cwd, [
      "bisect",
      reset ? "reset" : action,
    ]);
    const stillActive = await hasGitOperationMarker(cwd, "bisect");
    const state = await inspectGitManagedOperation(
      cwd,
      context,
      outcome.output,
      outcome.code === 0 && !stillActive
        ? action === "abort"
          ? "aborted"
          : "completed"
        : null,
    );
    if (outcome.code !== 0) throw new Error(outcome.output);
    return state;
  }
  if (["good", "bad", "reset"].includes(action)) {
    throw new Error(`${action} is only valid for a bisect operation.`);
  }
  if (action === "continue" && conflictPaths(status).length > 0) {
    throw new Error(
      "Resolve and stage every conflicted path before continuing this operation.",
    );
  }
  if (action === "skip" && context.type === "merge") {
    throw new Error("Merge operations cannot skip a commit.");
  }
  if (action === "skip" && context.type === "stash") {
    throw new Error("Stash operations cannot skip a step.");
  }
  if (context.type === "stash") {
    if (!context.checkpointRef || !context.sourceRevision) {
      throw new Error(
        "The durable stash operation is missing recovery metadata and cannot be controlled safely.",
      );
    }
    const source = parseStashOperationSource(context.sourceRef);
    let output = "";
    if (action === "abort") {
      output = await restoreStashOperationCheckpoint(cwd, {
        originalHead: context.originalHead,
        targetRef: context.targetRef,
        checkpointRef: context.checkpointRef,
        branch: source.branch,
      });
    } else {
      if (source.action === "pop" || source.action === "branch") {
        output = await dropStashByHash(cwd, context.sourceRevision);
      }
    }
    return inspectGitManagedOperation(
      cwd,
      context,
      output,
      action === "abort" ? "aborted" : "completed",
    );
  }
  const arguments_ =
    action === "abort"
      ? [context.type, "--abort"]
      : action === "skip"
        ? [context.type, "--skip"]
        : context.type === "merge"
          ? ["merge", "--continue"]
          : [context.type, "--continue"];
  const environment = isInteractiveRebaseContext(context)
    ? await interactiveRebaseEnvironmentFromContext(cwd, context)
    : managedOperationEnvironment;
  const outcome = await runGitOutcome(cwd, arguments_, environment);
  const stillActive = await hasGitOperationMarker(cwd, context.type);
  const state = await inspectGitManagedOperation(
    cwd,
    context,
    outcome.output,
    outcome.code === 0 && !stillActive
      ? action === "abort"
        ? "aborted"
        : "completed"
      : null,
  );
  if (
    outcome.code !== 0 &&
    state.state !== "conflicted" &&
    state.state !== "awaiting-user-action"
  ) {
    throw new Error(outcome.output);
  }
  if (["completed", "aborted"].includes(state.state)) {
    await cleanupInteractiveRebaseState(cwd, context);
  }
  return state;
}

export async function amendGitManagedOperation(
  cwd: string,
  context: GitManagedOperationContext,
  message: string | null,
): Promise<GitManagedOperationWorkerState> {
  if (!isInteractiveRebaseContext(context)) {
    throw new Error(
      "Only an interactive rebase edit step can be amended here.",
    );
  }
  if (!(await hasGitOperationMarker(cwd, "rebase"))) {
    return inspectGitManagedOperation(cwd, context);
  }
  if ((await currentInteractiveRebaseAction(cwd, context)) !== "edit") {
    throw new Error("The interactive rebase is not paused at an edit step.");
  }
  const status = await readGitStatus(cwd);
  if (conflictPaths(status).length > 0) {
    throw new Error(
      "Resolve and stage every conflict before amending the edit step.",
    );
  }
  const hasStagedChanges = !(await gitSucceeds(cwd, [
    "diff",
    "--cached",
    "--quiet",
  ]));
  if (!hasStagedChanges && !message) {
    throw new Error(
      "Stage an edit or enter a replacement commit message before amending.",
    );
  }
  const environment = await interactiveRebaseEnvironmentFromContext(
    cwd,
    context,
  );
  const amended = await runGitOutcome(
    cwd,
    [
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--amend",
      "--no-verify",
      ...(message ? ["--message", message] : ["--no-edit"]),
    ],
    environment,
  );
  if (amended.code !== 0) throw new Error(amended.output);
  const continued = await runGitOutcome(
    cwd,
    ["rebase", "--continue"],
    environment,
  );
  const stillActive = await hasGitOperationMarker(cwd, context.type);
  const state = await inspectGitManagedOperation(
    cwd,
    context,
    [amended.output, continued.output].filter(Boolean).join("\n"),
    continued.code === 0 && !stillActive ? "completed" : null,
  );
  if (
    continued.code !== 0 &&
    state.state !== "conflicted" &&
    state.state !== "awaiting-user-action"
  ) {
    throw new Error(continued.output);
  }
  if (state.state === "completed") {
    await cleanupInteractiveRebaseState(cwd, context);
  }
  return state;
}

const MAX_CONFLICT_FILES = 1_000;
const MAX_CONFLICT_CONTENT_BYTES = 2_000_000;

interface ConflictIndexEntry {
  mode: string;
  oid: string;
  stage: 1 | 2 | 3;
  path: string;
}

function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "buffer", maxBuffer: GIT_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${Buffer.from(stdout).toString("utf8")}${Buffer.from(stderr).toString("utf8")}`.trim() ||
                error.message,
            ),
          );
          return;
        }
        resolve(Buffer.from(stdout));
      },
    );
  });
}

async function conflictIndexEntries(
  cwd: string,
): Promise<ConflictIndexEntry[]> {
  const output = await gitBuffer(cwd, ["ls-files", "-u", "-z"]);
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t([\s\S]+)$/u.exec(
        record,
      );
      if (!match || !safeGitPath(match[4]!)) {
        throw new Error("Git returned an invalid unmerged index entry.");
      }
      return {
        mode: match[1]!,
        oid: match[2]!,
        stage: Number(match[3]!) as 1 | 2 | 3,
        path: match[4]!,
      };
    });
}

function conflictKind(code: string): GitConflictKind {
  return (
    (
      {
        UU: "both-modified",
        AA: "both-added",
        DD: "both-deleted",
        AU: "added-by-ours",
        UA: "added-by-theirs",
        DU: "deleted-by-ours",
        UD: "deleted-by-theirs",
      } as const
    )[code as "UU"] ?? "unknown"
  );
}

async function conflictGroups(cwd: string): Promise<{
  groups: Map<string, ConflictIndexEntry[]>;
  status: GitStatus;
}> {
  const [entries, status] = await Promise.all([
    conflictIndexEntries(cwd),
    readGitStatus(cwd),
  ]);
  const groups = new Map<string, ConflictIndexEntry[]>();
  for (const entry of entries) {
    const current = groups.get(entry.path) ?? [];
    current.push(entry);
    groups.set(entry.path, current);
  }
  return { groups, status };
}

function conflictSummary(
  filePath: string,
  entries: ConflictIndexEntry[],
  status: GitStatus,
) {
  const file = status.files.find(
    ({ path: candidate }) => candidate === filePath,
  );
  const code = file ? `${file.indexStatus}${file.worktreeStatus}` : "UU";
  return {
    path: filePath,
    code,
    kind: conflictKind(code),
    baseAvailable: entries.some(({ stage }) => stage === 1),
    oursAvailable: entries.some(({ stage }) => stage === 2),
    theirsAvailable: entries.some(({ stage }) => stage === 3),
  };
}

export async function listGitConflicts(cwd: string): Promise<GitConflictList> {
  const { groups, status } = await conflictGroups(cwd);
  const paths = [...groups.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  return gitConflictListSchema.parse({
    files: paths
      .slice(0, MAX_CONFLICT_FILES)
      .map((filePath) =>
        conflictSummary(filePath, groups.get(filePath)!, status),
      ),
    truncated: paths.length > MAX_CONFLICT_FILES,
  });
}

async function conflictStage(
  cwd: string,
  entry: ConflictIndexEntry | undefined,
): Promise<GitConflictStage> {
  if (!entry) {
    return {
      available: false,
      oid: null,
      mode: null,
      size: null,
      binary: false,
      content: null,
      truncated: false,
    };
  }
  const size = Number.parseInt(
    await gitOutput(cwd, ["cat-file", "-s", entry.oid]),
    10,
  );
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Git returned an invalid conflict blob size.");
  }
  if (size > MAX_CONFLICT_CONTENT_BYTES) {
    return {
      available: true,
      oid: entry.oid,
      mode: entry.mode,
      size,
      binary: false,
      content: null,
      truncated: true,
    };
  }
  if (entry.mode === "160000") {
    return {
      available: true,
      oid: entry.oid,
      mode: entry.mode,
      size,
      binary: true,
      content: null,
      truncated: false,
    };
  }
  const buffer = await gitBuffer(cwd, ["cat-file", "blob", entry.oid]);
  const binary = buffer.includes(0);
  return {
    available: true,
    oid: entry.oid,
    mode: entry.mode,
    size,
    binary,
    content: binary ? null : buffer.toString("utf8"),
    truncated: false,
  };
}

async function conflictResult(cwd: string, filePath: string) {
  const absolute = path.resolve(cwd, filePath);
  const root = path.resolve(cwd);
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid conflict result path.");
  }
  try {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return {
        exists: true,
        oid: await gitOutput(cwd, [
          "hash-object",
          "--no-filters",
          "--",
          filePath,
        ]),
        size: metadata.size,
        binary: true,
        content: null,
        truncated: false,
      };
    }
    if (metadata.size > MAX_CONFLICT_CONTENT_BYTES) {
      return {
        exists: true,
        oid: await gitOutput(cwd, [
          "hash-object",
          "--no-filters",
          "--",
          filePath,
        ]),
        size: metadata.size,
        binary: false,
        content: null,
        truncated: true,
      };
    }
    const buffer = await readFile(absolute);
    const binary = buffer.includes(0);
    return {
      exists: true,
      oid: await gitOutput(cwd, [
        "hash-object",
        "--no-filters",
        "--",
        filePath,
      ]),
      size: metadata.size,
      binary,
      content: binary ? null : buffer.toString("utf8"),
      truncated: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      exists: false,
      oid: null,
      size: null,
      binary: false,
      content: null,
      truncated: false,
    };
  }
}

export async function readGitConflict(
  cwd: string,
  filePath: string,
): Promise<GitConflictDetail> {
  if (!safeGitPath(filePath)) throw new Error("Invalid conflict path.");
  const { groups, status } = await conflictGroups(cwd);
  const entries = groups.get(filePath);
  if (!entries) throw new Error("This path is no longer conflicted.");
  const [base, ours, theirs, result] = await Promise.all([
    conflictStage(
      cwd,
      entries.find(({ stage }) => stage === 1),
    ),
    conflictStage(
      cwd,
      entries.find(({ stage }) => stage === 2),
    ),
    conflictStage(
      cwd,
      entries.find(({ stage }) => stage === 3),
    ),
    conflictResult(cwd, filePath),
  ]);
  return gitConflictDetailSchema.parse({
    ...conflictSummary(filePath, entries, status),
    base,
    ours,
    theirs,
    result,
  });
}

function joinConflictSides(ours: string, theirs: string): string {
  if (!ours) return theirs;
  if (!theirs) return ours;
  return `${ours}${ours.endsWith("\n") ? "" : "\n"}${theirs}`;
}

function conflictResolutionContent(
  detail: GitConflictDetail,
  request: GitConflictResolutionRequest,
): { deleted: boolean; binary: boolean; content: string | null } {
  if (request.strategy === "delete") {
    return { deleted: true, binary: false, content: null };
  }
  if (request.strategy === "manual") {
    return { deleted: false, binary: false, content: request.content! };
  }
  if (request.strategy === "result") {
    if (!detail.result.exists) {
      throw new Error("The worktree result no longer exists.");
    }
    return {
      deleted: false,
      binary: detail.result.binary,
      content: detail.result.content,
    };
  }
  const stage = request.strategy === "ours" ? detail.ours : detail.theirs;
  if (request.strategy === "ours" || request.strategy === "theirs") {
    if (!stage.available) {
      return { deleted: true, binary: false, content: null };
    }
    return { deleted: false, binary: stage.binary, content: stage.content };
  }
  if (!detail.ours.available || !detail.theirs.available) {
    throw new Error("Both sides are not available for this conflict.");
  }
  if (
    detail.ours.binary ||
    detail.theirs.binary ||
    detail.ours.truncated ||
    detail.theirs.truncated
  ) {
    throw new Error("Both can only be combined for bounded text conflicts.");
  }
  return {
    deleted: false,
    binary: false,
    content: joinConflictSides(detail.ours.content!, detail.theirs.content!),
  };
}

function conflictResolutionToken(
  detail: GitConflictDetail,
  request: GitConflictResolutionRequest,
  result: ReturnType<typeof conflictResolutionContent>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        request,
        stages: [detail.base.oid, detail.ours.oid, detail.theirs.oid],
        currentResult: detail.result,
        result,
      }),
    )
    .digest("hex");
}

export async function previewGitConflictResolution(
  cwd: string,
  request: GitConflictResolutionRequest,
): Promise<GitConflictResolutionPreview> {
  const detail = await readGitConflict(cwd, request.path);
  const result = conflictResolutionContent(detail, request);
  const warnings: string[] = [];
  if (result.deleted) warnings.push("This resolution deletes the path.");
  if (result.binary)
    warnings.push("Binary content cannot be previewed as text.");
  if (request.strategy === "both") {
    warnings.push("Ours is followed by theirs; review the combined result.");
  }
  return gitConflictResolutionPreviewSchema.parse({
    request,
    token: conflictResolutionToken(detail, request, result),
    resultDeleted: result.deleted,
    resultBinary: result.binary,
    resultContent: result.content,
    warnings,
  });
}

async function writeConflictResult(
  cwd: string,
  filePath: string,
  content: string,
): Promise<void> {
  const root = await realpath(cwd);
  const absolute = path.resolve(root, filePath);
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid conflict result path.");
  }
  const parent = await realpath(path.dirname(absolute));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) {
    throw new Error("Conflict result parent escapes the selected worktree.");
  }
  try {
    if ((await lstat(absolute)).isSymbolicLink()) {
      throw new Error("Refusing to overwrite a symbolic-link conflict path.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(absolute, content, "utf8");
}

export async function applyGitConflictResolution(
  cwd: string,
  request: GitConflictResolutionRequest,
  token: string,
): Promise<GitConflictResolutionResult> {
  const preview = await previewGitConflictResolution(cwd, request);
  if (preview.token !== token) {
    throw new Error(
      "The conflict or result changed after this preview. Review it again.",
    );
  }
  if (preview.resultDeleted) {
    await runGit(cwd, ["rm", "-f", "--ignore-unmatch", "--", request.path]);
  } else if (request.strategy === "ours" || request.strategy === "theirs") {
    await runGit(cwd, [
      "checkout",
      `--${request.strategy}`,
      "--",
      request.path,
    ]);
    await runGit(cwd, ["add", "--", request.path]);
  } else if (request.strategy === "result") {
    await runGit(cwd, ["add", "--", request.path]);
  } else {
    if (preview.resultBinary || preview.resultContent === null) {
      throw new Error("This resolution cannot be written as text.");
    }
    await writeConflictResult(cwd, request.path, preview.resultContent);
    await runGit(cwd, ["add", "--", request.path]);
  }
  const unresolved = await conflictIndexEntries(cwd);
  const remainingPaths = [
    ...new Set(unresolved.map(({ path: value }) => value)),
  ].sort((left, right) => left.localeCompare(right));
  const resolved = !remainingPaths.includes(request.path);
  if (!resolved) {
    throw new Error("Git still reports this path as unmerged in the index.");
  }
  return gitConflictResolutionResultSchema.parse({
    path: request.path,
    resolved,
    remainingPaths,
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

async function forcePushCommitRange(
  cwd: string,
  range: string,
): Promise<{
  commits: GitComparisonCommit[];
  count: number;
  truncated: boolean;
}> {
  const [countText, revisionsText] = await Promise.all([
    gitOutput(cwd, ["rev-list", "--count", range]),
    gitOutput(cwd, [
      "rev-list",
      "--reverse",
      `--max-count=${FORCE_PUSH_COMMIT_LIMIT + 1}`,
      range,
    ]).catch(() => ""),
  ]);
  const count = Number.parseInt(countText, 10) || 0;
  const revisions = revisionsText.split("\n").filter(Boolean);
  return {
    commits: await Promise.all(
      revisions
        .slice(0, FORCE_PUSH_COMMIT_LIMIT)
        .map((revision) => commitActionSummary(cwd, revision)),
    ),
    count,
    truncated: count > FORCE_PUSH_COMMIT_LIMIT,
  };
}

async function currentRemotePushTarget(cwd: string): Promise<{
  localBranch: string;
  remote: string;
  remoteBranch: string;
  upstream: string;
}> {
  const status = await readGitStatus(cwd);
  if (!status.branch) throw new Error("Cannot force-push a detached HEAD.");
  if (!status.upstream) {
    throw new Error(
      "This branch has no upstream. Publish it with a normal push first.",
    );
  }
  const remotes = (await gitOutput(cwd, ["remote"]))
    .split("\n")
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const remote = remotes.find((name) =>
    status.upstream!.startsWith(`${name}/`),
  );
  if (!remote) {
    throw new Error(
      `Upstream ${status.upstream} is not owned by a configured remote.`,
    );
  }
  const remoteBranch = status.upstream.slice(remote.length + 1);
  if (!remoteBranch) throw new Error("The upstream branch name is invalid.");
  await Promise.all([
    runGit(cwd, ["check-ref-format", "--branch", status.branch]),
    runGit(cwd, ["check-ref-format", "--branch", remoteBranch]),
  ]);
  return {
    localBranch: status.branch,
    remote,
    remoteBranch,
    upstream: status.upstream,
  };
}

export async function previewGitForcePush(
  cwd: string,
): Promise<GitForcePushPreview> {
  await assertNoInProgressGitOperation(cwd);
  const target = await currentRemotePushTarget(cwd);
  const remoteRef = `refs/heads/${target.remoteBranch}`;
  const trackingRef = `refs/remotes/${target.remote}/${target.remoteBranch}`;
  await runGit(cwd, [
    "fetch",
    "--no-tags",
    target.remote,
    `+${remoteRef}:${trackingRef}`,
  ]);
  const [localHead, expectedRemoteHead] = await Promise.all([
    resolveCommit(cwd, "HEAD"),
    resolveCommit(cwd, trackingRef),
  ]);
  if (
    await gitSucceeds(cwd, [
      "merge-base",
      "--is-ancestor",
      expectedRemoteHead,
      localHead,
    ])
  ) {
    throw new Error(
      "The remote branch is an ancestor of this branch. Use a normal push.",
    );
  }
  if (
    await gitSucceeds(cwd, [
      "merge-base",
      "--is-ancestor",
      localHead,
      expectedRemoteHead,
    ])
  ) {
    throw new Error(
      "This branch has no replacement commits and is only behind its remote. Pull or rebase instead.",
    );
  }
  const [local, remote, commonBase] = await Promise.all([
    forcePushCommitRange(cwd, `${expectedRemoteHead}..${localHead}`),
    forcePushCommitRange(cwd, `${localHead}..${expectedRemoteHead}`),
    gitOutput(cwd, ["merge-base", localHead, expectedRemoteHead]).catch(
      () => "",
    ),
  ]);
  if (remote.count === 0) {
    throw new Error(
      "The remote branch has no commits to replace. Use a normal push.",
    );
  }
  const warnings = [
    `${remote.count} remote ${remote.count === 1 ? "commit" : "commits"} will no longer be reachable from ${target.remote}/${target.remoteBranch}.`,
    `The lease is pinned to remote commit ${expectedRemoteHead.slice(0, 12)}. The push will fail safely if the remote moves after this preview.`,
  ];
  if (!commonBase) {
    warnings.unshift(
      "The local and remote histories are unrelated. This replacement is especially destructive.",
    );
  }
  const token = createHash("sha256")
    .update(
      JSON.stringify({
        localBranch: target.localBranch,
        localHead,
        remote: target.remote,
        remoteBranch: target.remoteBranch,
        expectedRemoteHead,
      }),
    )
    .digest("hex");
  return gitForcePushPreviewSchema.parse({
    token,
    destructive: true,
    summary: `Replace ${target.remote}/${target.remoteBranch} with ${target.localBranch} using force-with-lease.`,
    warnings,
    remote: target.remote,
    localBranch: target.localBranch,
    remoteBranch: target.remoteBranch,
    localHead,
    expectedRemoteHead,
    localCommits: local.commits,
    localCommitCount: local.count,
    localCommitsTruncated: local.truncated,
    remoteCommits: remote.commits,
    remoteCommitCount: remote.count,
    remoteCommitsTruncated: remote.truncated,
  });
}

export async function applyGitForcePush(
  cwd: string,
  token: string,
): Promise<GitActionResult> {
  const preview = await previewGitForcePush(cwd);
  if (preview.token !== token) {
    throw new Error(
      "The local or remote branch moved after this preview. Review the force push again.",
    );
  }
  const output = await runGit(cwd, gitForcePushArguments(preview));
  return gitActionResultSchema.parse({
    status: await readGitStatus(cwd),
    output,
  });
}

export function gitForcePushArguments(
  preview: Pick<
    GitForcePushPreview,
    "expectedRemoteHead" | "remote" | "remoteBranch"
  >,
): string[] {
  const remoteRef = `refs/heads/${preview.remoteBranch}`;
  return [
    "push",
    `--force-with-lease=${remoteRef}:${preview.expectedRemoteHead}`,
    preview.remote,
    `HEAD:${remoteRef}`,
  ];
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
