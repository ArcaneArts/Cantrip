import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  gitChangeSummarySchema,
  type GitChangeSummary,
} from "@cantrip/protocol";

const exec = promisify(execFile);
const COMMIT_LIMIT = 1_000;
const UNTRACKED_LIMIT = 10_000;
const TEXT_BYTES_LIMIT = 32 * 1_024 * 1_024;
const FILE_BYTES_LIMIT = 8 * 1_024 * 1_024;
type Stat = {
  path: string;
  originalPath: string | null;
  added: number;
  removed: number;
  binary: boolean;
};

/** NUL records preserve tabs/newlines in filenames and Git's rename path pair. */
function numstat(output: string): { stats: Stat[]; commits: number } {
  const fields = output.split("\0");
  const result: Stat[] = [];
  let commits = 0;
  for (let index = 0; index < fields.length; index++) {
    const record = fields[index]!.replace(/^\n/u, "");
    if (/^commit:[0-9a-f]{40,64}$/u.test(record)) {
      commits += 1;
      continue;
    }
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(record);
    if (!match) continue;
    const originalPath = match[3] ? null : (fields[++index] ?? null);
    const filePath = match[3] || fields[++index];
    if (!filePath) continue;
    result.push({
      path: filePath,
      originalPath,
      added: match[1] === "-" ? 0 : Number(match[1]),
      removed: match[2] === "-" ? 0 : Number(match[2]),
      binary: match[1] === "-" || match[2] === "-",
    });
  }
  return { stats: result, commits };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1_024 * 1_024,
    timeout: 30_000,
  });
  return stdout;
}

type History = { commits: number; partial: boolean; stats: Stat[] };
const historyCache = new Map<string, Promise<History>>();
async function history(
  root: string,
  head: string | null,
  since: string,
  until: string | null,
): Promise<History> {
  if (!head) return { commits: 0, partial: false, stats: [] };
  const key = JSON.stringify([root, head, since, until]);
  const cached = historyCache.get(key);
  if (cached) return cached;
  const result = (async () => {
    // First-parent merge diffs include the incoming changes once. Walking every
    // parent would count both the branch's edits and their merge a second time.
    const output = await git(root, [
      "log",
      "--first-parent",
      "--diff-merges=first-parent",
      "--root",
      "--format=%x00commit:%H%x00",
      "--no-color",
      "--numstat",
      "-z",
      "--find-renames",
      "--no-ext-diff",
      "--no-textconv",
      `--since-as-filter=${since}`,
      ...(until ? [`--until=${until}`] : []),
      `--max-count=${COMMIT_LIMIT + 1}`,
      head,
      "--",
    ]);
    const { stats, commits } = numstat(output);
    return { commits, partial: commits > COMMIT_LIMIT, stats };
  })();
  historyCache.set(key, result);
  if (historyCache.size > 128)
    historyCache.delete(historyCache.keys().next().value!);
  try {
    return await result;
  } catch (error) {
    historyCache.delete(key);
    throw error;
  }
}

export async function readGitChangeSummary(
  cwd: string,
  input: { since: string; until: string | null },
): Promise<GitChangeSummary> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).replace(
    /\r?\n$/u,
    "",
  );
  let head: string | null;
  try {
    head = (
      await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])
    ).trim();
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
    head = null; // An unborn branch still has staged and untracked changes.
  }
  const [committed, staged, unstaged, untrackedText] = await Promise.all([
    history(root, head, input.since, input.until),
    git(root, [
      "diff",
      "--cached",
      "--numstat",
      "-z",
      "--find-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--",
    ]),
    git(root, [
      "diff",
      "--numstat",
      "-z",
      "--find-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--",
    ]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const files = new Set<string>();
  const binaries = new Set<string>();
  const dirty = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let partial = committed.partial;
  const add = (stat: Stat, working: boolean) => {
    files.add(stat.path);
    if (working) dirty.add(stat.path);
    if (stat.binary) binaries.add(stat.path);
    additions += stat.added;
    deletions += stat.removed;
  };
  for (const stat of committed.stats) add(stat, false);
  for (const stat of [...numstat(staged).stats, ...numstat(unstaged).stats])
    add(stat, true);
  const untracked = untrackedText.split("\0").filter(Boolean);
  let bytes = 0;
  for (const [index, filePath] of untracked.entries()) {
    files.add(filePath);
    dirty.add(filePath);
    if (index >= UNTRACKED_LIMIT) {
      partial = true;
      continue;
    }
    const absolute = path.resolve(root, filePath);
    try {
      const metadata = await lstat(absolute);
      if (
        metadata.size > FILE_BYTES_LIMIT ||
        bytes + metadata.size > TEXT_BYTES_LIMIT
      ) {
        partial = true;
        continue;
      }
      bytes += metadata.size;
      const content = metadata.isSymbolicLink()
        ? Buffer.from(await readlink(absolute))
        : metadata.isFile()
          ? await readFile(absolute)
          : null;
      if (!content) {
        partial = true;
        continue;
      }
      if (content.includes(0)) {
        binaries.add(filePath);
        continue;
      }
      if (content.length)
        additions += content.reduce(
          (count, byte) => count + (byte === 10 ? 1 : 0),
          content.at(-1) === 10 ? 0 : 1,
        );
    } catch {
      partial = true;
    }
  }
  return gitChangeSummarySchema.parse({
    filesChanged: files.size,
    additions,
    deletions,
    commits: committed.commits,
    uncommittedFiles: dirty.size,
    binaryFiles: binaries.size,
    partial,
    observedAt: new Date().toISOString(),
  });
}
