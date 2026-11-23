import {
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Kill the actual isolated native tree, including separately grouped helpers.
 * This does not send graceful shutdown or fabricate a suspended rollout. */
export async function killNativeTree(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  if (process.platform === "win32") {
    await execute("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  } else {
    const { stdout } = await execute("ps", ["-axo", "pid=,ppid="]);
    const rows = stdout
      .trim()
      .split("\n")
      .map((row) => row.trim().split(/\s+/).map(Number));
    const owned = new Set<number>([child.pid!]);
    for (;;) {
      const before = owned.size;
      for (const [pid, parent] of rows) if (owned.has(parent!)) owned.add(pid!);
      if (owned.size === before) break;
    }
    // Stop the root first so its supervisors cannot restart known descendants.
    for (const pid of owned) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
  await closed;
}
