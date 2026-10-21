import { lstat } from "node:fs/promises";
import path from "node:path";
import type { WorkerNotification } from "@cantrip/protocol";

type FileChange = NonNullable<
  Extract<
    WorkerNotification,
    {
      type: "worktree.filesystem.changed";
    }
  >["changes"]
>[number];
type GitReader = (args: string[]) => Promise<string>;
const MAX_CHANGES = 2_000;
const MAX_CHANGE_BYTES = 256 * 1_024;

export function activityPath(filename: string): string | null {
  const normalized = filename.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.length > 8_192 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === ".git")
  )
    return null;
  return normalized.replace(/^\.\//, "").replace(/\/$/, "");
}

export function boundedFileChanges(
  changes: Iterable<FileChange>,
): FileChange[] {
  const result: FileChange[] = [];
  const seen = new Set<string>();
  let bytes = 2;
  for (const change of changes) {
    if (!activityPath(change.path) || seen.has(change.path)) continue;
    const size = Buffer.byteLength(JSON.stringify(change)) + 1;
    if (result.length >= MAX_CHANGES || bytes + size > MAX_CHANGE_BYTES) break;
    seen.add(change.path);
    result.push(change);
    bytes += size;
  }
  return result;
}

export function commitFileChanges(output: string): FileChange[] {
  const tokens = output.split("\0");
  const changes: FileChange[] = [];
  // --no-renames makes every record a status/path pair, including paths with
  // spaces, tabs, or newlines. A rename is a deletion plus an addition.
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const status = tokens[index];
    const file = tokens[index + 1]!;
    if (!status || !activityPath(file)) continue;
    changes.push({
      path: file,
      kind: status === "A" ? "added" : status === "D" ? "deleted" : "modified",
    });
  }
  return boundedFileChanges(changes);
}

export class WorktreeFileActivity {
  private readonly known = new Set<string>();
  private readonly pending = new Set<string>();
  private head: string | null | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly git: GitReader,
  ) {}

  async initialize(): Promise<void> {
    // Seed existing paths so atomic saves of tracked files remain modifications.
    // Failure only loses creation classification; it never prevents watching.
    const files = await this.git([
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]).catch(() => "");
    for (const file of files.split("\0")) {
      if (!activityPath(file)) continue;
      this.known.add(file);
      let parent = path.posix.dirname(file);
      while (parent !== ".") {
        this.known.add(parent);
        parent = path.posix.dirname(parent);
      }
    }
  }

  record(filename: string | Buffer | null): void {
    if (filename === null || this.pending.size >= MAX_CHANGES) return;
    const file = activityPath(filename.toString());
    if (file) this.pending.add(file);
  }

  flush(): Promise<FileChange[]> {
    const files = [...this.pending];
    this.pending.clear();
    const result = this.queue.then(async () => {
      const changes: FileChange[] = [];
      const directories = new Set<string>();
      for (const file of files) {
        try {
          const stat = await lstat(path.join(this.root, file));
          if (stat.isDirectory()) directories.add(file);
          changes.push({
            path: file,
            kind: this.known.has(file) ? "modified" : "added",
          });
          this.known.add(file);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "ENOENT" &&
            (error as NodeJS.ErrnoException).code !== "ENOTDIR"
          )
            continue;
          // Ignore temporary paths created and removed within the same batch.
          if (this.known.delete(file))
            changes.push({ path: file, kind: "deleted" });
          for (const known of this.known) {
            if (known.startsWith(`${file}/`)) this.known.delete(known);
          }
        }
      }
      // A directory mtime event accompanies child creation/deletion. Prefer
      // the child event so a new file in a collapsed folder stays green.
      return boundedFileChanges(
        changes.filter(
          (change) =>
            !directories.has(change.path) ||
            !changes.some((child) => child.path.startsWith(`${change.path}/`)),
        ),
      );
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  async observeHead(head: string | null): Promise<FileChange[]> {
    const previous = this.head;
    this.head = head;
    if (previous === undefined || previous === head || !head) return [];
    const args = previous
      ? ["diff", "--name-status", "--no-renames", "-z", previous, head, "--"]
      : [
          "diff-tree",
          "--root",
          "-r",
          "--no-commit-id",
          "--name-status",
          "--no-renames",
          "-z",
          head,
          "--",
        ];
    const output = await this.git(args).catch(() => "");
    return commitFileChanges(output);
  }
}
