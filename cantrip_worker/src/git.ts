import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { gitHistorySchema, type GitHistory } from "@cantrip/protocol";

const execFileAsync = promisify(execFile);

export async function readGitHistory(
  cwd: string,
  limit: number,
): Promise<GitHistory> {
  const { stdout: branchOutput } = await execFileAsync(
    "git",
    ["-C", cwd, "branch", "--show-current"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  const branch = branchOutput.trim();
  let logOutput = "";
  try {
    const result = await execFileAsync(
      "git",
      [
        "-C",
        cwd,
        "log",
        `--max-count=${limit}`,
        "--date=iso-strict",
        "--pretty=format:%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%D%x1e",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    logOutput = result.stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (!stderr.includes("does not have any commits yet")) throw error;
  }

  const commits = logOutput
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [
        hash,
        shortHash,
        authorName,
        authorEmail,
        authoredAt,
        subject,
        refs,
      ] = record.split("\x00");
      return {
        hash,
        shortHash,
        authorName,
        authorEmail,
        authoredAt,
        subject: subject ?? "",
        refs: (refs ?? "")
          .split(",")
          .map((ref) => ref.trim())
          .filter(Boolean),
      };
    });
  return gitHistorySchema.parse({ branch, commits });
}
