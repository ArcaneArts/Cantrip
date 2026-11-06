import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Publish only a complete, synced private record. No effects may be dispatched
 * until the exclusive admission and its parent directory are durable. */
export async function writeOsOperationRecord(
  file: string,
  record: unknown,
  exclusive = false,
) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${file}.${randomUUID()}.partial`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(record) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive) {
      await link(temporary, file);
      await unlink(temporary);
    } else await rename(temporary, file);
    await syncDirectory(directory);
    await syncDirectory(path.dirname(directory));
    await syncDirectory(path.dirname(path.dirname(directory)));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
