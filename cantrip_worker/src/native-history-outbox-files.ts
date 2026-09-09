import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

/** Flush newly created directory links as well as their existing parent. */
export async function ensureHistoryDirectory(directory: string): Promise<void> {
  const firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!firstCreated) return;
  const parent = path.dirname(firstCreated);
  for (let current = directory; ; current = path.dirname(current)) {
    await flushHistoryDirectory(current);
    if (current === parent) break;
  }
}

export async function flushHistoryDirectory(
  directoryPath: string,
): Promise<void> {
  // Windows does not support opening directories for fsync. File contents
  // are still flushed; directory-entry power-loss durability is POSIX-only.
  if (process.platform === "win32") return;
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Flush before publication; an existing committed filename is never replaced. */
export async function writeImmutableHistoryFile(
  destination: string,
  content: string,
): Promise<boolean> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await flushHistoryDirectory(path.dirname(destination));
      return false;
    }
    await flushHistoryDirectory(path.dirname(destination));
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readHistoryJson(filename: string): Promise<unknown> {
  // A malformed or missing committed record is an actual storage error. Never
  // interpret it as an empty journal or mint a replacement stream identity.
  return JSON.parse(await readFile(filename, "utf8"));
}

const operations = new Map<string, Promise<void>>();

/** Also serializes separately opened handles in this worker, without caching disk state. */
export function serializeHistoryOperation<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const result = (operations.get(directory) ?? Promise.resolve()).then(
    operation,
  );
  const settled = result.then(
    () => {},
    () => {},
  );
  operations.set(directory, settled);
  void settled.then(() => {
    if (operations.get(directory) === settled) operations.delete(directory);
  });
  return result;
}
