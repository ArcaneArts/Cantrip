import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  WorkspaceSnapshot,
  WorkspaceSnapshotMetadataReader,
} from "./event-types.js";
import type { ActiveTurn } from "./runtime-types.js";

const execFileAsync = promisify(execFile);

const WORKSPACE_SNAPSHOT_METADATA_CONCURRENCY = 16;

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (values.length === 0) return [];
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function workspaceSnapshotFromPorcelainRecords(
  cwd: string,
  records: readonly string[],
  readMetadata: WorkspaceSnapshotMetadataReader = lstat,
): Promise<WorkspaceSnapshot> {
  const entries: Array<{ filePath: string; status: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) {
      continue;
    }
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
    entries.push({ filePath, status });
  }

  const snapshotEntries = await mapWithConcurrency(
    entries,
    WORKSPACE_SNAPSHOT_METADATA_CONCURRENCY,
    async ({ filePath, status }) => {
      let fingerprint = "missing";
      if (status !== " D") {
        try {
          const file = await readMetadata(path.join(cwd, filePath));
          fingerprint = `${file.size}:${file.mtimeMs}:${file.mode}`;
        } catch {
          // Deleted or concurrently removed files have no filesystem fingerprint.
        }
      }
      return [filePath, { fingerprint, status }] as const;
    },
  );
  return new Map(snapshotEntries);
}

export async function workspaceSnapshot(
  cwd: string,
): Promise<WorkspaceSnapshot> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    return await workspaceSnapshotFromPorcelainRecords(
      cwd,
      stdout.split("\0").filter(Boolean),
    );
  } catch {
    return new Map();
  }
}

export async function workspaceChanges(
  active: ActiveTurn,
): Promise<ActiveTurn["diffChanges"]> {
  const observedAtMs = Date.now();
  const after = await workspaceSnapshot(active.cwd);
  const paths = new Set([...active.baseline.keys(), ...after.keys()]);
  const changes = new Map(
    active.diffChanges.map((change) => [change.path, change]),
  );
  for (const filePath of paths) {
    const beforeState = active.baseline.get(filePath);
    const afterState = after.get(filePath);
    if (
      beforeState?.status === afterState?.status &&
      beforeState?.fingerprint === afterState?.fingerprint
    ) {
      continue;
    }
    const status = afterState?.status ?? "D ";
    const kind =
      (status === "??" || status.includes("A")) && !beforeState
        ? "add"
        : status.includes("D")
          ? "delete"
          : "update";
    changes.set(filePath, {
      path: filePath,
      kind,
      lastActivityAtMs: observedAtMs,
    });
  }
  return [...changes.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}
