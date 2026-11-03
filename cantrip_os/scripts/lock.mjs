import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// A populated owner file is linked atomically, so a crashed writer cannot
// leave an empty lock that no subsequent invocation can recover.
export async function withInstanceLock(
  name,
  action,
  { signal, wait = true } = {},
) {
  const key = createHash("sha256").update(name).digest("hex").slice(0, 20);
  const path = join(tmpdir(), `cantrip-os-${key}.lock`);
  const candidate = `${path}.${randomUUID()}`;
  const owner = `${process.pid} ${randomUUID()}`;
  await writeFile(candidate, owner, { mode: 0o600 });
  try {
    while (true) {
      signal?.throwIfAborted();
      try {
        await link(candidate, path);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const current = await readFile(path, "utf8");
          const pid = Number(current.split(" ")[0]);
          if (!Number.isInteger(pid) || pid <= 0)
            throw new Error(`Invalid instance lock: ${path}`);
          try {
            process.kill(pid, 0);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
            if ((await readFile(path, "utf8")) === current) await unlink(path);
            continue;
          }
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        if (!wait)
          throw new Error(
            `A CantripOS session for ${name} is already running. Stop it first or use CANTRIP_OS_NAME and different ports.`,
          );
        await delay(250, undefined, { signal });
      }
    }
    try {
      return await action();
    } finally {
      if ((await readFile(path, "utf8")) === owner) await unlink(path);
    }
  } finally {
    await unlink(candidate);
  }
}
