import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  gitHistorySchema,
  type GitHistory,
  type GitRef,
} from "@cantrip/protocol";

const execFileAsync = promisify(execFile);
const GIT_BUFFER = 16 * 1024 * 1024;

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: GIT_BUFFER,
  });
  return stdout.trim();
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
): Promise<GitHistory> {
  const [branch, head, remotes] = await Promise.all([
    gitOutput(cwd, ["branch", "--show-current"]),
    gitOutput(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => ""),
    gitOutput(cwd, ["remote"]).catch(() => ""),
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
    commits,
    hasMore,
    nextCursor: hasMore ? cursor + commits.length : null,
  });
}
