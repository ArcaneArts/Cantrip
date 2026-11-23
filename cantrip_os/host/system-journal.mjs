import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, open, link, rename, unlink } from "node:fs/promises";

/** Private, durable reservations survive process loss before an Engine reply. */
export async function writeSystemJournal(file, record, exclusive = false) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.partial`;
  try {
    const stream = await open(temporary, "wx", 0o600);
    try {
      await stream.writeFile(JSON.stringify(record) + "\n");
      await stream.sync();
    } finally {
      await stream.close();
    }
    if (exclusive) {
      await link(temporary, file);
      await unlink(temporary);
    } else await rename(temporary, file);
    const directory = await open(dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
